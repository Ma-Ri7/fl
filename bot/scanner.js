// FLASH — venue discovery + state reading for V2 / V3 / DODO.
// All on-chain reads go through Multicall3 (aggregate3) in chunked batches.
const { ethers } = require("ethers");
const { MULTICALL3 } = require("./config");
const cfg = require("./config");

// ------------------------------------------------------------------
// Multicall3 helpers
// ------------------------------------------------------------------
const MC3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
];

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const pairKey = (a, b) => (a.toLowerCase() < b.toLowerCase() ? `${a}|${b}` : `${b}|${a}`);

/** Encode a single call's data (cached per-call object). */
function encodeCall(c) {
  if (c._data) return c._data;
  const iface = new ethers.Interface([c.fragment]);
  const name = c.fragment.split(" ")[1].split("(")[0];
  return (c._data = iface.encodeFunctionData(name, c.args || []));
}

/**
 * Run many eth_calls through Multicall3. Failed calls return success:false.
 * opts.blockTag: dacă e setat, TOATE citirile sunt fixate pe acel block
 * (BLOCK SNAPSHOT — audit item 6: quote-urile unei oportunități trebuie să
 * provină din aceeași stare logică a lanțului).
 */
async function multicall3(provider, calls, opts = {}) {
  const chunkSize = opts.chunkSize || 200;
  const retries = opts.retries || 3;
  const sleepMs = opts.sleepMs || 250;
  const mc3 = new ethers.Contract(MULTICALL3, MC3_ABI, provider);
  const callOpts = opts.blockTag ? { blockTag: opts.blockTag } : {};
  const out = new Array(calls.length);
  let idx = 0;
  for (const batch of chunk(calls, chunkSize)) {
    const tupleCalls = batch.map((c) => ({
      target: c.target,
      allowFailure: c.allowFailure !== false,
      callData: encodeCall(c),
    }));
    let done = false;
    for (let attempt = 0; attempt < retries && !done; attempt++) {
      try {
        const res = await mc3.aggregate3(tupleCalls, callOpts);
        for (const r of res) out[idx++] = { success: r.success, returnData: r.returnData };
        done = true;
      } catch (_) {
        if (attempt === retries - 1) batch.forEach(() => (out[idx++] = { success: false, returnData: "0x" }));
        else await sleep(sleepMs * (attempt + 1));
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Token pairs to scan
// ------------------------------------------------------------------
/** All unordered (base, quote) pairs where at least one token is a quote. */
function buildPairs(tokens, quoteSymbols) {
  if (!tokens || !quoteSymbols) {
    tokens = tokens || cfg.TOKENS;
    quoteSymbols = quoteSymbols || cfg.QUOTES;
  }
  const bySym = new Map(Object.entries(tokens));
  const quotes = quoteSymbols.map((s) => bySym.get(s)).filter(Boolean);
  const all = [...bySym.values()];
  const pairs = [];
  const seen = new Set();
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (!quotes.includes(a) && !quotes.includes(b)) continue;
      const lo = a.address.toLowerCase() < b.address.toLowerCase() ? a : b;
      const hi = a.address.toLowerCase() < b.address.toLowerCase() ? b : a;
      const key = `${lo.address}|${hi.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ key, tokenA: lo, tokenB: hi });
    }
  }
  return pairs;
}

// ------------------------------------------------------------------
// Discovery (one-shot at startup)
// ------------------------------------------------------------------
const V2_FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const DODO_FACTORY_ABI = ["function getDODOPool(address,address) view returns (address[])"];

async function discoverVenues(provider, overrideCfg) {
  const cfg = overrideCfg || require("./config");
  const pairs = buildPairs(cfg.TOKENS, cfg.QUOTES);
  const calls = [];
  const meta = [];

  for (const dex of cfg.DEXES)
    for (const p of pairs) {
      calls.push({ target: dex.factory, fragment: V2_FACTORY_ABI[0], args: [p.tokenA.address, p.tokenB.address] });
      meta.push({ kind: "v2", dex, pair: p });
    }
  for (const fee of cfg.PANCAKE_V3_FEE_TIERS)
    for (const p of pairs) {
      calls.push({ target: cfg.PANCAKE_V3_FACTORY, fragment: V3_FACTORY_ABI[0], args: [p.tokenA.address, p.tokenB.address, fee] });
      meta.push({ kind: "v3", feeUnits: fee, pair: p });
    }
  for (const f of cfg.DODO_FACTORIES)
    for (const p of pairs) {
      calls.push({ target: f.address, fragment: DODO_FACTORY_ABI[0], args: [p.tokenA.address, p.tokenB.address] });
      meta.push({ kind: "dodo", factoryId: f.id, factoryName: f.name, pair: p });
    }

  const res = await multicall3(provider, calls, { chunkSize: 200 });
  const venues = [];
  const byPair = new Map();
  const groupOf = (p) => {
    if (!byPair.has(p.key)) byPair.set(p.key, { tokenA: p.tokenA, tokenB: p.tokenB, venues: [] });
    return byPair.get(p.key);
  };
  const stats = { pairs: pairs.length, calls: calls.length, v2: 0, v3: 0, dodo: 0, total: 0 };

  let i = 0;
  for (const { success, returnData } of res) {
    const m = meta[i++];
    if (!success || returnData === "0x") continue;
    try {
      if (m.kind === "dodo") {
        const pools = ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], returnData)[0];
        for (const pool of pools) {
          if (!pool || pool === ethers.ZeroAddress) continue;
          const v = {
            kind: "dodo", id: `dodo-${m.factoryId}`, name: m.factoryName,
            pairKey: m.pair.key, tokenA: m.pair.tokenA, tokenB: m.pair.tokenB,
            pool, factoryId: m.factoryId,
          };
          venues.push(v); groupOf(m.pair).venues.push(v); stats.dodo++;
        }
        continue;
      }
      const addr = ethers.AbiCoder.defaultAbiCoder().decode(["address"], returnData)[0];
      if (!addr || addr === ethers.ZeroAddress) continue;
      if (m.kind === "v2") {
        const v = {
          kind: "v2", id: m.dex.id, name: m.dex.name,
          pairKey: m.pair.key, tokenA: m.pair.tokenA, tokenB: m.pair.tokenB,
          pair: addr, router: m.dex.router, feeBps: m.dex.feeBps,
          feeN: 10000 - m.dex.feeBps, feeD: 10000,
        };
        venues.push(v); groupOf(m.pair).venues.push(v); stats.v2++;
      } else {
        const v = {
          kind: "v3", id: `pancake-v3-${m.feeUnits}`, name: `PancakeV3-${m.feeUnits}`,
          pairKey: m.pair.key, tokenA: m.pair.tokenA, tokenB: m.pair.tokenB,
          pool: addr, feeUnits: m.feeUnits,
        };
        venues.push(v); groupOf(m.pair).venues.push(v); stats.v3++;
      }
    } catch (_) {}
  }
  stats.total = venues.length;
  return { venues, byPair, stats };
}

// ------------------------------------------------------------------
// State reading (per scan cycle)
// ------------------------------------------------------------------
const V2_PAIR_ABI = ["function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"];
const V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];
const DODO_POOL_ABI = [
  "function _BASE_TOKEN_() view returns (address)",
  "function _QUOTE_TOKEN_() view returns (address)",
  "function _BASE_RESERVE_() view returns (uint256)",
  "function _QUOTE_RESERVE_() view returns (uint256)",
  // PHASE 5: starea PMM exacta (audit: nu modelam DODO deloc).
  // getPMMStateForCall() => (i, K, B, Q, B0, Q0, R) — public pe DVM/DSP (si DPP).
  "function getPMMStateForCall() view returns (uint256 i, uint256 K, uint256 B, uint256 Q, uint256 B0, uint256 Q0, uint256 R)",
  // Fee-urile reale ale pool-ului pentru traderul nostru (LP + maintainer).
  "function getUserFeeRate(address user) view returns (uint256 lpFeeRate, uint256 mtFeeRate)",
];

/**
 * Read on-chain state for every venue. Mutates venue objects in place.
 * opts.blockTag — citește TOT starea la acel block (BLOCK SNAPSHOT).
 * opts.trader   — adresa contractului de arbitraj (pentru mtFeeRate de user).
 */
async function readState(provider, venues, opts = {}) {
  const calls = [];
  const meta = [];
  for (const v of venues) {
    if (v.kind === "v2") {
      calls.push({ target: v.pair, fragment: V2_PAIR_ABI[0] });
      meta.push({ v, field: "reserves" });
    } else if (v.kind === "v3") {
      calls.push({ target: v.pool, fragment: V3_POOL_ABI[0] });
      meta.push({ v, field: "slot0" });
      calls.push({ target: v.pool, fragment: V3_POOL_ABI[1] });
      meta.push({ v, field: "liquidity" });
    } else {
      for (const [frag, field] of DODO_POOL_ABI.slice(0, 4).map((f, k) => [f, ["baseToken", "quoteToken", "baseReserve", "quoteReserve"][k]])) {
        calls.push({ target: v.pool, fragment: frag });
        meta.push({ v, field });
      }
      // Starea PMM (PHASE 5). allowFailure — unele pool-uri (DPP vechi/DSP
      // fără oracol) pot să nu expună getPMMStateForCall.
      calls.push({ target: v.pool, fragment: DODO_POOL_ABI[4] });
      meta.push({ v, field: "pmm" });
      calls.push({
        target: v.pool,
        fragment: DODO_POOL_ABI[5],
        args: [opts.trader || ethers.ZeroAddress],
      });
      meta.push({ v, field: "fees" });
    }
  }
  const res = await multicall3(provider, calls, { chunkSize: 200, ...opts });
  const stats = { ok: 0, empty: 0, fail: 0, pmmOk: 0 };
  let i = 0;
  for (const { success, returnData } of res) {
    const { v, field } = meta[i++];
    if (!success || returnData === "0x") { stats.fail++; continue; }
    try {
      const cod = ethers.AbiCoder.defaultAbiCoder();
      if (v.kind === "v2") {
        const d = cod.decode(["uint112", "uint112", "uint32"], returnData);
        const a0 = v.tokenA.address.toLowerCase() < v.tokenB.address.toLowerCase();
        v.reserveA = a0 ? d[0] : d[1];
        v.reserveB = a0 ? d[1] : d[0];
        if (v.reserveA > 0n && v.reserveB > 0n) stats.ok++; else { v.dead = true; stats.empty++; }
      } else if (v.kind === "v3") {
        if (field === "slot0") {
          v.sqrtPx96 = cod.decode(["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"], returnData)[0];
        } else {
          v.liquidity = cod.decode(["uint128"], returnData)[0];
        }
        if (v.sqrtPx96 !== undefined && v.liquidity !== undefined) {
          if (v.liquidity > 0n && v.sqrtPx96 > 0n) stats.ok++; else { v.dead = true; stats.empty++; }
        }
      } else {
        if (field === "baseToken") v.baseToken = cod.decode(["address"], returnData)[0];
        else if (field === "quoteToken") v.quoteToken = cod.decode(["address"], returnData)[0];
        else if (field === "baseReserve") v.baseReserve = cod.decode(["uint256"], returnData)[0];
        else if (field === "quoteReserve") v.quoteReserve = cod.decode(["uint256"], returnData)[0];
        else if (field === "pmm") {
          const d = cod.decode(["uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"], returnData);
          v.pmm = { i: d[0], K: d[1], B: d[2], Q: d[3], B0: d[4], Q0: d[5], R: d[6] };
          stats.pmmOk++;
        } else if (field === "fees") {
          const d = cod.decode(["uint256", "uint256"], returnData);
          v.lpFeeRate = d[0];
          v.mtFeeRate = d[1];
        }
        if (v.baseReserve !== undefined && v.quoteReserve !== undefined) {
          if (v.baseReserve > 0n && v.quoteReserve > 0n) stats.ok++; else { v.dead = true; stats.empty++; }
        }
      }
    } catch (_) { stats.fail++; }
  }
  // marchează snapshot-ul pe venue-urile vii (audit: BLOCK SNAPSHOT formal)
  if (opts.blockTag) {
    for (const v of venues) if (!v.dead) v.snapshot = opts.blockTag;
  }
  return stats;
}

module.exports = { multicall3, buildPairs, discoverVenues, readState, pairKey, chunk, sleep };


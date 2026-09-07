// FLASH — formal BLOCK SNAPSHOT (audit item 6, PHASE 8) + STATE FINGERPRINT
// (TASK 4.3). Toate citirile de stare ale unui ciclu de scanare sunt fixate pe
// același block (blockTag), astfel încât toate quote-urile unei oportunități
// provin din aceeași stare logică a lanțului.
//
// TASK 4.3 — STATE FINGERPRINT: blockNumber egal NU înseamnă stare egală.
// Pentru fiecare venue se calculează un hash determinist (keccak256) peste o
// reprezentare CANONICĂ a exact stării care afectează quote-ul:
//   V2   → reserveA/reserveB + fee (venueOutput/getAmountOut)
//   V3   → sqrtPriceX96/tick/liquidity/tickSpacing + tickBitmap words +
//          initialized ticks (liquidityNet) — exact consumul
//          getAmountOutV3Exact(); fallback-ul legacy (fără deep state)
//          fingerprintează doar sqrtPx96/liquidity/fee, oglindind quote-ul
//   DODO → PMM (i,K,B,Q,B0,Q0,R) + lpFeeRate + mtFeeRate — exact consumul
//          quoteSellBase/quoteSellQuote
// Fără JSON.stringify pe obiecte — construim explicit reprezentarea canonică.
const { ethers } = require("ethers");

let stateVersionCounter = 0n;

/**
 * Creează un snapshot formal la block-ul cel mai recent cunoscut de provider.
 * @param {ethers.Provider} provider
 * @returns {Promise<{blockNumber:number, blockHash:string, timestamp:number, stateVersion:bigint, createdAt:number}>}
 */
async function createSnapshot(provider) {
  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  const snap = {
    blockNumber,
    blockHash: block.hash,
    timestamp: block.timestamp,
    stateVersion: ++stateVersionCounter,
    createdAt: Date.now(),
    venues: null, // populated by attachVenueFingerprints() (TASK 4.3)
  };
  return snap;
}

/**
 * Cheie stabilă și unică per venue (adresa pair/pool este identitatea on-chain).
 * NU folosim v.id — la V2 id-ul este id-ul DEX-ului (nu unic per pereche).
 */
function venueKey(v) {
  const target = v.kind === "v2" ? v.pair : v.pool;
  return `${String(v.kind)}:${String(target || "").toLowerCase()}`;
}

const addr = (a) => (a == null ? "" : String(a).toLowerCase());
const big = (x) => (x === undefined || x === null ? "" : BigInt(x).toString());

/**
 * Reprezentare CANONICĂ a stării care afectează quote-ul. Ordinea câmpurilor
 * este fixă; array-urile (words/ticks) sunt sortate explicit; valorile numerice
 * sunt reprezentate ca zecimale BigInt (fără ambiguitate de tip).
 * @returns {string|null} null dacă venue-ul nu poate fi fingerprint-uit.
 */
function canonicalVenueState(v) {
  if (!v || typeof v !== "object" || v.dead) return null;

  if (v.kind === "v2") {
    if (v.reserveA === undefined || v.reserveB === undefined) return null;
    return [
      "v2",
      addr(v.pair),
      addr(v.tokenA && v.tokenA.address),
      addr(v.tokenB && v.tokenB.address),
      big(v.reserveA),
      big(v.reserveB),
      String(v.feeBps ?? ""),
    ].join("|");
  }

  if (v.kind === "v3") {
    // Oglindim EXACT selecția de path din profit.venueOutput():
    // deep state (getAmountOutV3Exact) doar când există words nevide.
    const s = v.v3State;
    const deep =
      s && Array.isArray(s.words) && Array.isArray(s.ticks) && s.words.length > 0;
    if (deep) {
      if (
        s.sqrtPriceX96 === undefined ||
        s.liquidity === undefined ||
        s.tick === undefined ||
        !s.tickSpacing
      )
        return null;
      const words = [...s.words]
        .map((w) => `${Number(w.word)}=${BigInt(w.value).toString()}`)
        .sort()
        .join(";");
      const ticks = [...s.ticks]
        .map((t) => `${Number(t.tick)}:${BigInt(t.liquidityNet).toString()}`)
        .sort((a, b) => {
          const ta = BigInt(a.slice(0, a.indexOf(":")));
          const tb = BigInt(b.slice(0, b.indexOf(":")));
          return ta < tb ? -1 : ta > tb ? 1 : 0;
        })
        .join(";");
      return [
        "v3d",
        addr(v.pool),
        String(v.feeTier ?? ""),
        BigInt(s.sqrtPriceX96).toString(),
        String(s.tick),
        BigInt(s.liquidity).toString(),
        String(s.tickSpacing),
        words,
        ticks,
      ].join("|");
    }
    // fallback legacy: quote-ul folosește doar sqrtPx96 + liquidity + fee
    if (v.sqrtPx96 === undefined || v.liquidity === undefined) return null;
    return [
      "v3f",
      addr(v.pool),
      String(v.feeTier ?? ""),
      BigInt(v.sqrtPx96).toString(),
      BigInt(v.liquidity).toString(),
    ].join("|");
  }

  if (v.kind === "dodo") {
    // PMM state exact (lib/dodo.js quoteSellBase/quoteSellQuote):
    // i, K, B, Q + B0/Q0 (citiți on-chain, consumați direct de quote) + R + fee-uri.
    const p = v.pmm;
    if (!p || p.i === undefined || v.lpFeeRate === undefined) return null;
    return [
      "dodo",
      addr(v.pool),
      addr(v.baseToken),
      addr(v.quoteToken),
      big(p.i),
      big(p.K),
      big(p.B),
      big(p.Q),
      big(p.B0),
      big(p.Q0),
      big(p.R),
      big(v.lpFeeRate),
      big(v.mtFeeRate),
    ].join("|");
  }

  return null;
}

/**
 * Fingerprint determinist (keccak256) al stării unui venue.
 * @returns {string|null} null dacă starea nu este (încă) fingerprintabilă.
 */
function venueFingerprint(v) {
  const c = canonicalVenueState(v);
  return c === null ? null : ethers.keccak256(ethers.toUtf8Bytes(c));
}

/**
 * TASK 4.3: atașează fiecărui venue din snapshot amprenta stării citite la
 * block-ul snapshot-ului. snapshot.venues[key] = { type, fingerprint }.
 * NU copiem starea completă (fingerprint-ul este angajamentul determinist).
 */
function attachVenueFingerprints(snapshot, venues) {
  if (!snapshot) return;
  const map = {};
  for (const v of venues || []) {
    if (!v || typeof v !== "object" || v.dead) continue;
    const fp = venueFingerprint(v);
    map[venueKey(v)] = { type: String(v.kind), fingerprint: fp };
  }
  snapshot.venues = map;
  return map;
}

/**
 * TASK 4.3: amprentele de state pe care o oportunitate le transportă cu sine
 * ( OPP → snapshot → venue states → fingerprint ), calculate la momentul
 * construirii oportunității.
 * @returns {Object} { [venueKey]: fingerprint|null }
 */
function opportunityFingerprints(venues) {
  const out = {};
  for (const v of venues || []) {
    if (!v || typeof v !== "object") continue;
    out[venueKey(v)] = venueFingerprint(v);
  }
  return out;
}

/** Verificare de consistență: toate venue-urile au fost citite în același block? */
function isConsistent(snapshot, venues) {
  return venues.every(
    (v) => v.dead || v.snapshot === undefined || v.snapshot === snapshot.blockNumber
  );
}

module.exports = {
  createSnapshot,
  isConsistent,
  venueKey,
  canonicalVenueState,
  venueFingerprint,
  attachVenueFingerprints,
  opportunityFingerprints,
};

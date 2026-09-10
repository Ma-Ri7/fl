// FLASH — builds calldata, simulates (eth_call), requotes and broadcasts txs.
//
// PIPELINE (audit items 7/10/11 — PHASE 7/10/11):
//   opportunity → fresh snapshot → FINAL REQUOTE → exact minProfit (nu "1%")
//   → eth_call simulare → gas economics (gasUsed * gasPrice real) →
//   nonce reservation → submission (privat cu fallback SIGUR) → tracker.
//
// REGULĂ DE SUBMISIE (fix CRITICAL din audit):
//   BloXroute 'unknown' ⇒ NU se trimite public cu același nonce (risc de
//   dublă execuție). Fallback public doar la 'failed' (respins definitiv
//   înainte de acceptare).
const { ethers } = require("ethers");
const abi = require("../artifacts/contracts/FlashLoanArbitrage.sol/FlashLoanArbitrage.json").abi;
const config = require("./config");
const bloxroute = require("./bloxroute");
const { NonceManager } = require("./nonce");
const { TransactionTracker } = require("./tx-tracker");
const scanner = require("./scanner");
const profit = require("./profit");
const dodo = require("../lib/dodo");
const logger = require("./logger");

const iface = new ethers.Interface(abi);
const DEADLINE_PAD = config.bot.deadlinePadSec || 75; // secunde

function buildLeg(venue, tokenIn) {
  const inIsA = tokenIn.toLowerCase() === venue.tokenA?.address?.toLowerCase();
  if (venue.kind === "v2") {
    const tA = venue.tokenA.address, tB = venue.tokenB.address;
    const path = inIsA ? [tA, tB] : [tB, tA];
    return { kind: 0, target: venue.router, zeroForOne: false, path };
  }
  if (venue.kind === "v3") {
    const zeroForOne = tokenIn.toLowerCase() === venue.tokenA.address.toLowerCase();
    return { kind: 1, target: venue.pool, zeroForOne, path: [] };
  }
  const zeroForOne = tokenIn.toLowerCase() === venue.baseToken.toLowerCase();
  return { kind: 2, target: venue.pool, zeroForOne, path: [] };
}

/**
 * Construiește calldata-ul. minProfit vine din FINAL REQUOTE (exact), nu dintr-un
 * buffer arbitrar de 1% (FLASH-CONTRACT-001 — protecția e în quote engine).
 */
function buildCalldata(opp) {
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_PAD;
  const minProfit = opp.minProfit;
  if (!(minProfit > 0n)) throw new Error("minProfit-must-be-positive");

  if (opp.sourceKind === "dodo") {
    const legA = buildLeg(opp.buyVen, opp.borrowToken.address);
    const legB = buildLeg(opp.sellVen, opp.baseToken.address);
    const baseAmt = opp.borrowToken.address.toLowerCase() === opp.sourceVen.baseToken.toLowerCase() ? opp.borrowAmount : 0n;
    const quoteAmt = opp.borrowToken.address.toLowerCase() === opp.sourceVen.quoteToken.toLowerCase() ? opp.borrowAmount : 0n;
    return {
      sig: "dodo",
      data: iface.encodeFunctionData("flashArbitrageDodo", [
        opp.sourceVen.pool, baseAmt, quoteAmt,
        opp.borrowToken.address, opp.baseToken.address,
        opp.sourceVen.baseToken, opp.sourceVen.quoteToken,
        legA, legB, minProfit, deadline,
      ]),
    };
  }

  // V2 flashswap: legs are Leg tuples (kind/target/zeroForOne/path) — aceeași
  // structură ca la DODO (buildLeg). Semnătura reală a contractului:
  //   flashArbitrage(pair, amount0, amount1, legA, legB, minProfit, deadline)
  // BUG fix (descoperit de Testul G1 comportamental): encoding-ul vechi trimitea
  // router+path ca argumente plate (9 args vs 7) → toate oportunitățile V2
  // aruncau "too many arguments" la buildCalldata, înainte de orice submisie.
  const bIsT0 = opp.borrowToken.address.toLowerCase() === opp.sourceVen.tokenA?.address?.toLowerCase();
  const amount0Out = bIsT0 ? opp.borrowAmount : 0n;
  const amount1Out = bIsT0 ? 0n : opp.borrowAmount;
  const legA = buildLeg(opp.buyVen, opp.borrowToken.address);
  const legB = buildLeg(opp.sellVen, opp.baseToken.address);
  return {
    sig: "v2",
    data: iface.encodeFunctionData("flashArbitrage", [
      opp.sourceVen.pair, amount0Out, amount1Out,
      legA, legB, minProfit, deadline,
    ]),
  };
}

function parseCalldata(fn, data) {
  const decoded = iface.decodeFunctionData(fn, data);
  // Convert ethers Result (with named struct fields) to a plain array.
  // BUG fix: staticCall re-encodes the args — passing read-only Result
  // proxies (nested leg tuples) back into ethers throws
  // "Cannot assign to read only property '0'". Deep-plain conversion
  // păstrează BigInt-urile și produce array-uri/obiecte mutabile.
  const toPlain = (v) => {
    if (Array.isArray(v)) return Array.from(v, toPlain);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[k] = toPlain(v[k]);
      return out;
    }
    return v;
  };
  return toPlain(decoded.toArray ? decoded.toArray() : Array.from(decoded));
}

async function simulate(contractAddr, calldata, sig, provider) {
  const res = await provider.call({ to: contractAddr, data: calldata });
  const fn = sig === "dodo" ? "flashArbitrageDodo" : "flashArbitrage";
  return iface.decodeFunctionResult(fn, res);
}

/**
 * PHASE 10 — FINAL REQUOTE:
 * recitește starea PROASPĂTĂ (block nou) doar a venue-urilor implicate și
 * recalculează output-ul, flash fee-ul și profitul net exact.
 * @returns {null | {blockNumber, baseRecv, quoteRecv, flashFee, net, minProfit}}
 */
async function finalRequote(provider, opp, opts = {}) {
  const venues = [opp.buyVen, opp.sellVen];
  if (opp.sourceVen && !venues.includes(opp.sourceVen)) venues.push(opp.sourceVen);
  const live = venues.filter((v) => v && !v.dead);
  if (live.length === 0) return null;
  await scanner.readState(provider, live, { trader: opts.trader });
  const blockNumber = await provider.getBlockNumber();

  const borrow = opp.borrowAmount;
  const baseRecv = profit.venueOutput(opp.buyVen, opp.borrowToken.address, borrow);
  if (!(baseRecv > 0n)) return null;
  const quoteRecv = profit.venueOutput(opp.sellVen, opp.baseToken.address, baseRecv);
  if (!(quoteRecv > borrow)) return null;
  const flashFee = opp.sourceKind === "dodo"
    ? dodo.dodoFlashFee(borrow, config.dodo)
    : (borrow * 25n) / 10000n;
  const net = quoteRecv - borrow - flashFee;
  // Marja de risc se aplică pe quote-ul EXACT (config.bot.slippageBps).
  // NU este un procent arbitrar "de contract" — e marja off-chain declarată.
  const margin = (quoteRecv * BigInt(config.bot.slippageBps)) / 10000n;
  const minProfit = net > margin ? net - margin : 0n;
  return { blockNumber, baseRecv, quoteRecv, flashFee, net, minProfit };
}

/**
 * Execute one opportunity through the full pipeline.
 * opts.shadow (true) → rulează tot pipeline-ul PÂNĂ la broadcast (PHASE 13).
 * opts.nonceManager  → NonceManager partajat între cicluri.
 */
async function executeOpp(opp, contractAddr, wallet, provider, opts = {}) {
  const trader = await wallet.getAddress();

  // ---- 1. FINAL REQUOTE (PHASE 10) -----------------------------------------
  let fq;
  try {
    fq = await finalRequote(provider, opp, { trader });
  } catch (e) {
    return { ok: false, reason: "requote-fail", err: e.message.slice(0, 120) };
  }
  if (!fq) return { ok: false, reason: "requote-empty" };

  const age = opp.snapshot ? fq.blockNumber - opp.snapshot.blockNumber : 0;
  if (age > config.bot.requoteMaxAgeBlocks) {
    return { ok: false, reason: "stale-opportunity", age };
  }
  if (!(fq.minProfit > 0n)) {
    return { ok: false, reason: "no-profit-after-requote" };
  }

  // ---- 2. GAS / COST ECONOMICS (PHASE 7 — minim viabil) ---------------------
  const minProfitBnb = ethers.parseEther(String(config.bot.minProfitBnb));
  const price = profit.tokenPriceInBnb(opp.borrowToken.address, [opp.buyVen, opp.sellVen]);
  if (price.num <= 0n) return { ok: false, reason: "no-bnb-price" };
  const netInBnb = (fq.net * price.num) / price.den;
  if (netInBnb < minProfitBnb) {
    return { ok: false, reason: "below-min-profit-bnb" };
  }
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || 5000000000n;
  // plafon de gas al unui flashloan cu 2 legs (mecanism, nu calcul exact);
  // estimateGas real vine după simulare și este folosit la re-verificare.
  const gasFloor = 500000n * gasPrice;
  if (netInBnb <= (gasFloor * (10000n + BigInt(config.bot.gasReserveBps))) / 10000n) {
    return { ok: false, reason: "profit-below-gas-floor" };
  }

  const fresh = {
    ...opp,
    baseRecv: fq.baseRecv,
    quoteRecv: fq.quoteRecv,
    flashFee: fq.flashFee,
    netProfit: fq.net,
    minProfit: fq.minProfit,
  };
  const { data, sig } = buildCalldata(fresh);
  const fn = sig === "dodo" ? "flashArbitrageDodo" : "flashArbitrage";
  const contract = new ethers.Contract(contractAddr, abi, wallet);

  // ---- 3. SHADOW MODE (PHASE 13): se oprește aici, nu broadcast -------------
  if (opts.shadow) {
    try {
      await contract[fn].staticCall(...parseCalldata(fn, data));
      return { ok: true, shadow: true, estProfit: fq.net, minProfit: fq.minProfit, netInBnb };
    } catch (e) {
      return { ok: false, shadow: true, reason: "shadow-sim-fail", err: e.message.slice(0, 120) };
    }
  }

  // ---- 4. SIMULARE (eth_call) ----------------------------------------------
  try {
    await contract[fn].staticCall(...parseCalldata(fn, data));
  } catch (e) {
    return { ok: false, reason: "sim-fail", err: e.message.slice(0, 120) };
  }

  // ---- 5. ESTIMARE GAS REAL + reverificare economie -------------------------
  let gasLimit;
  try {
    gasLimit = await contract[fn].estimateGas(...parseCalldata(fn, data));
  } catch (e) {
    return { ok: false, reason: "gas-est-fail", err: e.message.slice(0, 120) };
  }
  gasLimit = (gasLimit * 120n) / 100n; // 20% buffer
  const gasCostBnb = gasLimit * gasPrice;
  if (netInBnb <= (gasCostBnb * (10000n + BigInt(config.bot.gasReserveBps))) / 10000n) {
    return { ok: false, reason: "profit-below-gas", gasCostBnb, netInBnb };
  }

  // ---- 6. NONCE RESERVATION (PHASE 11) --------------------------------------
  // TASK 4.2-B — contractul de dependency injection:
  //   opts.nonceManager PREZENT  => se folosește EXACT obiectul injectat (chiar
  //   dacă e mock/din altă implementare); NU se construiește un al doilea
  //   manager (risc de double-reserve pe același wallet).
  //   opts.nonceManager ABSENT   => fallback: NonceManager real.
  // Validare structurală (NU instanceof ca mecanism principal): obiectul
  // injectat trebuie să expose reserve/commit/rollback; altfel eroare
  // explicită — niciodată fallback tăcut care ar ascunde un bug de DI.
  let nonceMgr;
  if (opts.nonceManager != null) {
    const m = opts.nonceManager;
    const structural =
      typeof m.reserve === "function" &&
      typeof m.commit === "function" &&
      typeof m.rollback === "function";
    if (!structural) {
      throw new Error(
        "invalid-nonce-manager: opts.nonceManager must expose reserve/commit/rollback"
      );
    }
    // Wallet identity check: if the manager exposes validateWallet, use it.
    if (typeof m.validateWallet === "function") {
      m.validateWallet(wallet);
    }
    nonceMgr = m;
  } else {
    nonceMgr = new NonceManager(wallet, config.bot.maxNonceGap);
  }
  const nonce = await nonceMgr.reserve();
  if (nonce === null) {
    return { ok: false, reason: "nonce-saturation" };
  }

  // ---- 6b. TRANSACTION TRACKER (TASK 4.5-D §20) -----------------------------
  // Tracker-ul este AUTORITATEA pentru ciclul de viață al tranzacției.
  // Recordul se creează DUPĂ rezervare și ÎNAINTE de orice submisie:
  //   - tracker failure aici => nicio submisie nu a avut loc => rollback SIGUR
  //     (TASK 4.5-D §8);
  //   - după acceptarea relay-ului, erorile tracker-ului NU afectează ownership
  //     nonce-ului (fail-closed, TASK 4.5-D §21) — doar se loghează.
  const tracker = opts.txTracker != null ? opts.txTracker : new TransactionTracker();
  if (
    opts.txTracker != null &&
    (typeof opts.txTracker.create !== "function" ||
      typeof opts.txTracker.markSubmitted !== "function" ||
      typeof opts.txTracker.poll !== "function")
  ) {
    throw new Error("invalid-tx-tracker: opts.txTracker must expose create/markSubmitted/poll");
  }
  let recId = null;
  try {
    recId = tracker.create({ wallet: trader, nonce }).id;
  } catch (e) {
    // Nicio submisie încercată — rollback permis (dovedește: nonce never broadcast).
    try { nonceMgr.rollback(nonce); } catch (_) {}
    return { ok: false, reason: "tracker-create-failed", err: e.message.slice(0, 120), nonce };
  }
  // Tracker failures NEVER change nonce ownership decisions (§21).
  const track = (fn) => {
    try { fn(); } catch (e) { logger.error(`[executor] tracker error: ${e.message}`); }
  };

  // ---- 7. SUBMISIE (privat cu fallback SIGUR) -------------------------------
  const useBloxroute = await bloxroute.isAvailable();
  if (useBloxroute) {
    const result = await bloxroute.sendPrivateTx({
      wallet,
      to: contractAddr,
      data,
      gasLimit,
      maxFeePerGas: feeData.maxFeePerGas || 5000000000n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || 2000000000n,
      targetBlock: opts.targetBlock,
      nonce,
    });
    if (result.ok && result.status === "accepted") {
      // Private submission ACCEPTED — relay acceptance ≠ on-chain success
      // (TASK 4.5-D §18). Track the submission; a missing/malformed hash makes
      // the acceptance AMBIGUOUS → tombstone commit, never a rollback.
      let usableHash = null;
      if (result.txHash) {
        track(() => tracker.markSubmitted(recId, result.txHash, { wallet: trader, mode: "private" }));
        usableHash = result.txHash;
      } else {
        track(() => tracker.transition(recId, "UNKNOWN", { lastError: "relay accepted without usable txHash" }));
      }
      // Commit MUST succeed. FAIL-CLOSED: if commit throws, nonce is blocked
      // forever (never rolled back).
      try {
        nonceMgr.commit(nonce, usableHash);
      } catch (e) {
        logger.error(`[executor] nonce commit failed (private, nonce=${nonce}, txHash=${result.txHash}): ${e.message}`);
        // INVARIANT: txHash exists + commit failure = nonce must remain blocked.
        // NEVER rollback. Return explicit failure.
        return { ok: false, reason: "nonce-commit-failed", nonce, txHash: result.txHash, private: true, err: e.message };
      }
      return { ok: true, txHash: result.txHash, blockNumber: result.block, profit: fq.net, minProfit: fq.minProfit, private: true, nonce, trackerId: recId };
    }
    if (result.status === "unknown") {
      // Private submission UNKNOWN — no txHash, but nonce may still be used.
      // TASK 4.5-D §7: ambiguous submission → tracker UNKNOWN, tombstone commit,
      // NEVER rollback (relay may have accepted the tx).
      track(() => tracker.transition(recId, "UNKNOWN", { lastError: result.error }));
      try {
        nonceMgr.commit(nonce, null);
      } catch (e) {
        logger.error(`[executor] nonce commit-tombstone failed (private, nonce=${nonce}): ${e.message}`);
        // FAIL-CLOSED: commit failure = nonce blocked, never rolled back.
        return { ok: false, reason: "nonce-commit-failed", nonce, txHash: null, private: true, err: e.message };
      }
      logger.warn(`[executor] private submission UNKNOWN (nonce=${nonce}) — NU se face fallback public`);
      return { ok: false, reason: "private-unknown", err: result.error, nonce, txHash: result.txHash || null, trackerId: recId };
    }
    // status 'failed' = respins definitiv ÎNAINTE de acceptare → fallback public
    logger.warn(`[executor] bloxroute failed (definitiv), fallback public: ${result.error}`);
  }

  try {
    const tx = await wallet.sendTransaction({
      to: contractAddr,
      data,
      gasLimit,
      gasPrice,
      nonce,
    });
    // Public broadcast succeeded — txHash exists. Track it, then commit.
    // FAIL-CLOSED: if commit throws, nonce is blocked forever (never rolled back).
    track(() => tracker.markSubmitted(recId, tx.hash, { wallet: trader, mode: "public" }));
    try {
      nonceMgr.commit(nonce, tx.hash);
    } catch (e) {
      logger.error(`[executor] nonce commit failed (public, nonce=${nonce}, txHash=${tx.hash}): ${e.message}`);
      // INVARIANT: txHash exists + commit failure = nonce must remain blocked.
      // NEVER rollback. Return explicit failure.
      return { ok: false, reason: "nonce-commit-failed", nonce, txHash: tx.hash, private: false, err: e.message };
    }
    return { ok: true, txHash: tx.hash, profit: fq.net, minProfit: fq.minProfit, private: false, nonce, trackerId: recId };
  } catch (e) {
    // Broadcast failure BEFORE txHash exists — rollback is safe (semantica
    // acceptată în 4.5-A). Tracker: submission attempt recorded as UNKNOWN
    // (fail-closed; tracker-ul nu eliberează niciodată nonce-ul).
    track(() => tracker.transition(recId, "UNKNOWN", { lastError: `broadcast fail: ${e.message}` }));
    try {
      nonceMgr.rollback(nonce);
    } catch (rbErr) {
      logger.error(`[executor] rollback failed (nonce=${nonce}): ${rbErr.message}`);
    }
    return { ok: false, reason: "broadcast-fail", err: e.message.slice(0, 120), nonce };
  }
}

module.exports = { buildCalldata, buildLeg, simulate, executeOpp, finalRequote };

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
const executionSafety = require("./execution-safety");
const executionCost = require("./execution-cost");
const logger = require("./logger");

const iface = new ethers.Interface(abi);
const DEADLINE_PAD = config.bot.deadlinePadSec || 75; // secunde

function buildLeg(venue, tokenIn, minOut = 0n) {
  const inIsA = tokenIn.toLowerCase() === venue.tokenA?.address?.toLowerCase();
  if (venue.kind === "v2") {
    const tA = venue.tokenA.address, tB = venue.tokenB.address;
    const path = inIsA ? [tA, tB] : [tB, tA];
    // minOut is the per-leg slippage floor (TASK 4.6-B) — NEVER a trivial "1".
    return { kind: 0, target: venue.router, zeroForOne: false, path, minOut };
  }
  if (venue.kind === "v3") {
    const zeroForOne = tokenIn.toLowerCase() === venue.tokenA.address.toLowerCase();
    return { kind: 1, target: venue.pool, zeroForOne, path: [], minOut };
  }
  const zeroForOne = tokenIn.toLowerCase() === venue.baseToken.toLowerCase();
  return { kind: 2, target: venue.pool, zeroForOne, path: [], minOut };
}

/**
 * Construiește calldata-ul. minProfit vine din FINAL REQUOTE (exact), nu dintr-un
 * buffer arbitrar de 1% (FLASH-CONTRACT-001 — protecția e în quote engine).
 */
function buildCalldata(opp) {
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_PAD;
  const minProfit = opp.minProfit;
  if (!(minProfit > 0n)) throw new Error("minProfit-must-be-positive");

  // Per-leg slippage floors (TASK 4.6-B), derived from the FINAL requote.
  const minOutA = opp.minOutA ?? 0n;
  const minOutB = opp.minOutB ?? 0n;

  if (opp.sourceKind === "dodo") {
    const legA = buildLeg(opp.buyVen, opp.borrowToken.address, minOutA);
    const legB = buildLeg(opp.sellVen, opp.baseToken.address, minOutB);
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
  const legA = buildLeg(opp.buyVen, opp.borrowToken.address, minOutA);
  const legB = buildLeg(opp.sellVen, opp.baseToken.address, minOutB);
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
 * recalculează output-ul, flash fee-ul, slippage minOut și profitul net exact.
 * @returns {null | {blockNumber, ok, borrow, expected, final, slippage, economics, rejection}}
 */
async function finalRequote(provider, opp, opts = {}) {
  const venues = [opp.buyVen, opp.sellVen];
  if (opp.sourceVen && !venues.includes(opp.sourceVen)) venues.push(opp.sourceVen);
  const live = venues.filter((v) => v && !v.dead);
  if (live.length === 0) return null;
  await scanner.readState(provider, live, { trader: opts.trader });
  const blockNumber = await provider.getBlockNumber();

  // TASK 4.6-A: delegăm calculele economice la modulul PUR (execution-safety),
  // care recalculează ambele legs + flash fee + slippage minOut + minProfit
  // determinist, fără floating point, pe state-ul fresh citit mai sus.
  const r = executionSafety.finalRequote(opp, { slippageBps: opts.slippageBps });
  return { blockNumber, ...r };
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
  if (fq.ok !== true) {
    return { ok: false, reason: fq.rejection ? fq.rejection.code : "requote-failed" };
  }

  const age = opp.snapshot ? fq.blockNumber - opp.snapshot.blockNumber : 0;
  if (age > config.bot.requoteMaxAgeBlocks) {
    return { ok: false, reason: "stale-opportunity", age };
  }

  // TASK 4.6-A — ECONOMIC GUARD: slippage + min-output + min-profit (fail-closed).
  const guard = executionSafety.validateExecutionEconomics(fq, {
    slippageBps: config.bot.slippageBps,
  });
  if (!guard.ok) {
    return { ok: false, reason: guard.rejection.code, details: guard.rejection.reason };
  }

  // ---- 2. GAS / COST ECONOMICS — VALIDAREA FEE DATA (TASK 4.6-C) ------------
  const minProfitBnb = ethers.parseEther(String(config.bot.minProfitBnb));
  const price = profit.tokenPriceInBnb(opp.borrowToken.address, [opp.buyVen, opp.sellVen]);
  if (price.num <= 0n || price.den <= 0n) {
    return { ok: false, reason: "PROFIT_CONVERSION_UNAVAILABLE", details: "no verified token→BNB conversion" };
  }
  const netInBnb = (fq.final.net * price.num) / price.den;
  if (netInBnb < minProfitBnb) {
    return { ok: false, reason: "below-min-profit-bnb" };
  }
  // TASK 4.6-C — fee data validat FAIL-CLOSED: lipsă/malformed => REJECT
  // (niciodată default-ul vechi „|| 5 gwei" care masca un provider stricat).
  // Worst-case bound = max(gasPrice legacy, maxFeePerGas EIP-1559). ACEEAȘI
  // valoare validată este folosită în modelul de cost ȘI în parametrii tx.
  const feeData = await provider.getFeeData();
  const fee = executionCost.worstCaseGasPriceWei(feeData);
  if (!fee.ok) {
    return { ok: false, reason: fee.rejection.code, details: fee.rejection.reason };
  }
  const gasPrice = fee.priceWei;
  // Pre-filtru grosier cu plafon mecanic (500k gas) al unui flashloan cu 2
  // legs. VERDICTUL REAL se dă la pasul 5, pe estimateGas real, cu același
  // model validat din bot/execution-cost.js (4.6-C).
  const gasFloor = 500000n * gasPrice;
  if (netInBnb <= (gasFloor * (10000n + BigInt(config.bot.gasReserveBps))) / 10000n) {
    return { ok: false, reason: "profit-below-gas-floor" };
  }

  const fresh = {
    ...opp,
    baseRecv: fq.final.baseRecv,
    quoteRecv: fq.final.quoteRecv,
    flashFee: fq.final.flashFee,
    netProfit: fq.final.net,
    minProfit: fq.final.minProfit,
    minOutA: fq.slippage.minOutA,
    minOutB: fq.slippage.minOutB,
  };
  const { data, sig } = buildCalldata(fresh);
  const fn = sig === "dodo" ? "flashArbitrageDodo" : "flashArbitrage";
  const contract = new ethers.Contract(contractAddr, abi, wallet);

  // ---- 3. SHADOW MODE (PHASE 13): se oprește aici, nu broadcast -------------
  if (opts.shadow) {
    try {
      await contract[fn].staticCall(...parseCalldata(fn, data));
      return { ok: true, shadow: true, estProfit: fq.final.net, minProfit: fq.final.minProfit, netInBnb };
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

  // ---- 5. ESTIMARE GAS REAL + EXECUTION-COST GUARD (TASK 4.6-C) -------------
  // estimateGas failure/malformed => REJECT (fail-closed; niciodată un default
  // de genul „gas = 500k"). Buffer și plafon formalizate în bot/execution-cost.js
  // (bps întregi, ceil conservator, ceiling config). Costul folosește worst-case
  // bound-ul fee data (max(gasPrice, maxFeePerGas)), NU effectiveGasPrice
  // (necunoscut pre-execuție). Verdict final: net = gross(token→BNB) - gasCost,
  // verificat contra minProfitBnb și gasReserveBps cu aritmetică BigInt.
  let gasEstimate;
  try {
    gasEstimate = await contract[fn].estimateGas(...parseCalldata(fn, data));
  } catch (e) {
    return { ok: false, reason: "GAS_ESTIMATE_FAILED", err: e.message.slice(0, 120) };
  }
  const cost = executionCost.evaluateExecutionCost({
    profitRaw: fq.final.net,
    settlementToken: opp.borrowToken.address,
    gasEstimate,
    feeData,
    priceBnb: price,
    policy: {
      minProfitBnb,
      gasReserveBps: BigInt(config.bot.gasReserveBps),
      bufferBps: config.bot.gasBufferBps,
      maxGasLimit: config.bot.maxGasLimit,
    },
  });
  if (!cost.ok) {
    return { ok: false, reason: cost.rejection.code, details: cost.rejection.reason,
             costWei: cost.costWei, netBnb: cost.netBnb };
  }
  const gasLimit = cost.gasLimit;

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
  // TASK 4.6-C AUDIT FIX (F1/F2): parametrii de fee către relay sunt derivați
  // DIN BOUND-UL VALIDAT, nu din feeData raw. Astfel gar price == submitted
  // bound garantat: un maxFeePerGas/malformed din feeData nu poate ocoli
  // economic guard-ul ajungând semnat în tranzacție. Tip-ul este sanitizat la
  // un BigInt valid ≤ bound (EIP-1559 plafonează oricum efectiv la maxFeePerGas).
  const useBloxroute = await bloxroute.isAvailable();
  if (useBloxroute) {
    const priorityRaw = executionCost.validateGasUnits(feeData.maxPriorityFeePerGas);
    const priorityTip = priorityRaw !== null && priorityRaw > 0n && priorityRaw <= fee.priceWei ? priorityRaw : 0n;
    const result = await bloxroute.sendPrivateTx({
      wallet,
      to: contractAddr,
      data,
      gasLimit,
      maxFeePerGas: fee.priceWei, // bound-ul worst-case VALIDAT (audit F1)
      maxPriorityFeePerGas: priorityTip, // sanitizat, ≤ bound (audit F2)
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
      return { ok: true, txHash: result.txHash, blockNumber: result.block, profit: fq.final.net, minProfit: fq.final.minProfit, private: true, nonce, trackerId: recId };
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
    return { ok: true, txHash: tx.hash, profit: fq.final.net, minProfit: fq.final.minProfit, private: false, nonce, trackerId: recId };
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

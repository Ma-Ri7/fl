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

  // V2 flashswap: legs must use ROUTERS (not pair addresses)
  const bIsT0 = opp.borrowToken.address.toLowerCase() === opp.sourceVen.tokenA?.address?.toLowerCase();
  const amount0Out = bIsT0 ? opp.borrowAmount : 0n;
  const amount1Out = bIsT0 ? 0n : opp.borrowAmount;
  const pathA = [opp.borrowToken.address, opp.baseToken.address];
  const pathB = [opp.baseToken.address, opp.borrowToken.address];
  return {
    sig: "v2",
    data: iface.encodeFunctionData("flashArbitrage", [
      opp.sourceVen.pair, amount0Out, amount1Out,
      opp.buyVen.router, pathA, opp.sellVen.router, pathB,
      minProfit, deadline,
    ]),
  };
}

function parseCalldata(fn, data) {
  const decoded = iface.decodeFunctionData(fn, data);
  // Convert ethers Result (with named struct fields) to a plain array
  return decoded.toArray ? decoded.toArray() : Array.from(decoded);
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
  const nonceMgr = opts.nonceManager || new NonceManager(wallet, config.bot.maxNonceGap);
  const nonce = await nonceMgr.reserve();
  if (nonce === null) {
    return { ok: false, reason: "nonce-saturation" };
  }

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
      nonceMgr.commit(nonce, result.txHash);
      return { ok: true, txHash: result.txHash, blockNumber: result.block, profit: fq.net, minProfit: fq.minProfit, private: true, nonce };
    }
    if (result.status === "unknown") {
      // CRITICAL: nu cunoaștem starea — nicio a doua submisie cu acest nonce.
      // NonceManager păstrează un tombstone până la reap.
      nonceMgr.commit(nonce, null);
      logger.warn(`[executor] private submission UNKNOWN (nonce=${nonce}) — NU se face fallback public`);
      return { ok: false, reason: "private-unknown", err: result.error, nonce, txHash: result.txHash || null };
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
    nonceMgr.commit(nonce, tx.hash);
    return { ok: true, txHash: tx.hash, profit: fq.net, minProfit: fq.minProfit, private: false, nonce };
  } catch (e) {
    nonceMgr.rollback(nonce);
    return { ok: false, reason: "broadcast-fail", err: e.message.slice(0, 120), nonce };
  }
}

module.exports = { buildCalldata, buildLeg, simulate, executeOpp, finalRequote };

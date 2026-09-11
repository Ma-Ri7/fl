// FLASH — Economic execution safety (TASK 4.6-A).
//
// Strat formal între oportunitatea scanată și broadcast. Răspunde la:
//   „Poate botul ajunge la broadcast cu o oportunitate care era profitabilă
//    la scan, dar care NU mai este profitabilă conform stării fresh și
//    quote-ului final?"  Răspunsul acceptabil trebuie să fie NU.
//
// Principii:
//   - expected ≠ final ≠ realized (trei valori separate).
//   - final requote folosește state-ul fresh + amount real + venue/direcție exacte.
//   - slippage explicit, BigInt-only, fără floating point.
//   - min-output derivat din politica de slippage, NU un guard trivial (ex. 1).
//   - min-profit este o limită de siguranță separată de expected/realized.
//   - FAIL-CLOSED: stare lipsă / quote eșuat / profit insuficient => REJECT.
//   - nu modifică opp / snapshot / expected quote (imutabilitate).
//   - deterministic și machine-readable (rejection codes).
//
// Modul PUR (fără provider/ethers), testabil independent.
const profit = require("./profit");
const dodo = require("../lib/dodo");
const config = require("./config");

const FLASH_FEE_V2_BPS = 25n;
const BPS_DENOMINATOR = 10000n;

const REJECTION_CODES = Object.freeze({
  STALE_STATE: "STALE_STATE",
  QUOTE_FAILED: "QUOTE_FAILED",
  MISSING_STATE: "MISSING_STATE",
  MISSING_BITMAP: "MISSING_BITMAP",
  MISSING_TICK: "MISSING_TICK",
  INVALID_SLIPPAGE: "INVALID_SLIPPAGE",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_FEE: "INVALID_FEE",
  MIN_OUTPUT_FAILED: "MIN_OUTPUT_FAILED",
  MIN_PROFIT_FAILED: "MIN_PROFIT_FAILED",
  ECONOMIC_CHECK_FAILED: "ECONOMIC_CHECK_FAILED",
});

function reject(code, reason) {
  return { ok: false, rejection: { code, reason } };
}

function toBigIntOrNull(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v) && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) {
    try { return BigInt(v); } catch (_) { return null; }
  }
  return null;
}

/**
 * Validează slippage (bps). Returnează BigInt sau null. 0 <= bps < 10000.
 */
function validateSlippageBps(bps) {
  const b = toBigIntOrNull(bps);
  if (b === null || b < 0n || b >= BPS_DENOMINATOR) return null;
  return b;
}

/**
 * minOut = floor(expectedOut * (10000 - slippageBps) / 10000). BigInt-only.
 */
function computeMinOut(expectedOut, slippageBps) {
  if (typeof expectedOut !== "bigint" || expectedOut < 0n) {
    throw new Error("invalid-expected-out");
  }
  const b = validateSlippageBps(slippageBps);
  if (b === null) throw new Error("invalid-slippage-bps");
  return (expectedOut * (BPS_DENOMINATOR - b)) / BPS_DENOMINATOR;
}

/**
 * Final requote (pur): recalculează ambele legs pe starea fresh din
 * opp.buyVen / opp.sellVen și calculează economics-ul final.
 */
function finalRequote(opp, opts = {}) {
  if (!opp || typeof opp !== "object") {
    return reject(REJECTION_CODES.MISSING_STATE, "missing opportunity");
  }

  const borrow = toBigIntOrNull(opp.borrowAmount);
  if (borrow === null || borrow <= 0n) {
    return reject(REJECTION_CODES.INVALID_AMOUNT, "invalid borrowAmount");
  }

  if (!opp.borrowToken || !opp.baseToken || !opp.buyVen || !opp.sellVen) {
    return reject(REJECTION_CODES.MISSING_STATE, "missing token/venue");
  }

  const baseRecv = profit.venueOutput(opp.buyVen, opp.borrowToken.address, borrow);
  if (baseRecv <= 0n) {
    return reject(REJECTION_CODES.QUOTE_FAILED, "leg A produced no output");
  }

  const quoteRecv = profit.venueOutput(opp.sellVen, opp.baseToken.address, baseRecv);
  if (quoteRecv <= 0n) {
    return reject(REJECTION_CODES.QUOTE_FAILED, "leg B produced no output");
  }

  const flashFee =
    opp.sourceKind === "dodo"
      ? dodo.dodoFlashFee(borrow, config.dodo)
      : (borrow * FLASH_FEE_V2_BPS) / BPS_DENOMINATOR;

  const net = quoteRecv - borrow - flashFee;

  const slippageBps = validateSlippageBps(opts.slippageBps ?? config.bot.slippageBps);
  if (slippageBps === null) {
    return reject(REJECTION_CODES.INVALID_SLIPPAGE, "invalid slippageBps");
  }

  // Per-leg minimum outputs (TASK 4.6-B): each derived from the FINAL requote.
  // minOutA guards Leg A output (baseRecv); minOutB guards Leg B output (quoteRecv).
  const minOutA = computeMinOut(baseRecv, slippageBps);
  const minOutB = computeMinOut(quoteRecv, slippageBps);
  const margin = (quoteRecv * slippageBps) / BPS_DENOMINATOR;
  const minProfit = net > margin ? net - margin : 0n;

  return {
    ok: true,
    borrow,
    expected: {
      baseRecv: toBigIntOrNull(opp.baseRecv),
      quoteRecv: toBigIntOrNull(opp.quoteRecv),
      net: toBigIntOrNull(opp.netProfit),
      profitInBnb: toBigIntOrNull(opp.profitInBnb),
    },
    final: { baseRecv, quoteRecv, flashFee, net, minProfit },
    slippage: { bps: slippageBps, minOutA, minOutB, minOut: minOutB, margin },
    economics: { flashFee, net, minProfit },
    rejection: null,
  };
}

/**
 * Validează rezultatul final requote împotriva politicii economice.
 * FAIL-CLOSED: { ok:false, rejection:{code,reason} } la orice eșec.
 */
function validateExecutionEconomics(requote, policy = {}) {
  if (!requote || requote.ok !== true || !requote.final) {
    return reject(REJECTION_CODES.ECONOMIC_CHECK_FAILED, "missing requote result");
  }

  const slippageBps = validateSlippageBps(policy.slippageBps ?? config.bot.slippageBps);
  if (slippageBps === null) {
    return reject(REJECTION_CODES.INVALID_SLIPPAGE, "invalid slippageBps");
  }

  const { baseRecv, quoteRecv, net, minProfit } = requote.final;

  // BigInt safety: malformed (non-bigint) economics must fail closed, not throw.
  for (const [name, v] of [["baseRecv", baseRecv], ["quoteRecv", quoteRecv], ["net", net], ["minProfit", minProfit]]) {
    if (typeof v !== "bigint") {
      return reject(REJECTION_CODES.ECONOMIC_CHECK_FAILED, `invalid final.${name} (not bigint)`);
    }
  }

  if (baseRecv <= 0n || quoteRecv <= 0n) {
    return reject(REJECTION_CODES.MIN_OUTPUT_FAILED, "zero output");
  }

  const minOut = computeMinOut(quoteRecv, slippageBps);
  if (quoteRecv < minOut) {
    return reject(REJECTION_CODES.MIN_OUTPUT_FAILED, "output below slippage minimum");
  }

  if (net <= 0n) {
    return reject(REJECTION_CODES.ECONOMIC_CHECK_FAILED, "non-positive net");
  }

  if (minProfit <= 0n) {
    return reject(REJECTION_CODES.MIN_PROFIT_FAILED, "minProfit not positive");
  }

  if (policy.minProfit !== undefined && policy.minProfit !== null) {
    const floor = toBigIntOrNull(policy.minProfit);
    if (floor === null || floor < 0n) {
      return reject(REJECTION_CODES.MIN_PROFIT_FAILED, "invalid minProfit floor");
    }
    if (net < floor) {
      return reject(REJECTION_CODES.MIN_PROFIT_FAILED, "net below minProfit floor");
    }
  }

  if (policy.minProfitBnb !== undefined || policy.gasCostWei !== undefined) {
    const netInBnb = toBigIntOrNull(policy.netInBnb);
    if (netInBnb === null) {
      return reject(REJECTION_CODES.ECONOMIC_CHECK_FAILED, "missing netInBnb");
    }

    if (policy.minProfitBnb !== undefined && policy.minProfitBnb !== null) {
      const mp = toBigIntOrNull(policy.minProfitBnb);
      if (mp === null || mp < 0n) {
        return reject(REJECTION_CODES.MIN_PROFIT_FAILED, "invalid minProfitBnb");
      }
      if (netInBnb < mp) {
        return reject(REJECTION_CODES.MIN_PROFIT_FAILED, "netInBnb below minProfitBnb");
      }
    }

    if (policy.gasCostWei !== undefined && policy.gasCostWei !== null) {
      const gas = toBigIntOrNull(policy.gasCostWei);
      if (gas === null || gas < 0n) {
        return reject(REJECTION_CODES.ECONOMIC_CHECK_FAILED, "invalid gasCostWei");
      }
      const reserveBps = toBigIntOrNull(policy.gasReserveBps ?? 0n);
      if (reserveBps === null || reserveBps < 0n) {
        return reject(REJECTION_CODES.ECONOMIC_CHECK_FAILED, "invalid gasReserveBps");
      }
      if (netInBnb <= (gas * (BPS_DENOMINATOR + reserveBps)) / BPS_DENOMINATOR) {
        return reject(REJECTION_CODES.MIN_PROFIT_FAILED, "netInBnb below gas floor");
      }
    }
  }

  return { ok: true, rejection: null };
}

module.exports = {
  REJECTION_CODES,
  validateSlippageBps,
  computeMinOut,
  finalRequote,
  validateExecutionEconomics,
};

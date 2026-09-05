// Shared AMM math helpers (BigInt-safe).
// V2: constant-product. V3: within-tick concentrated liquidity.
// Used by the bot (profit estimation) and the integration tests.

// PancakeSwap V2 fee = 0.25%.
const DEFAULT_FEE_N = 9975n;
const DEFAULT_FEE_D = 10000n;

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;

/**
 * Constant-product output for one swap (exact in -> out).
 */
function getAmountOut(amountIn, reserveIn, reserveOut, feeN = DEFAULT_FEE_N, feeD = DEFAULT_FEE_D) {
  if (amountIn <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = (amountIn * feeN) / feeD;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn + amountInWithFee;
  return numerator / denominator;
}

/**
 * V3 (Uniswap/PancakeSwap v3) exact-in swap output, valid while the swap
 * stays inside the current tick range (deep pools cross few ticks).
 * Candidate generation only - the on-chain eth_call simulation is the
 * authoritative check before broadcasting.
 *
 * Uses the exact Uniswap V3 formula (no approximations).
 * Returns 0 if the swap would move price >5% (formula breaks down).
 *
 * @param {bigint} amountIn   raw input amount (token wei)
 * @param {bigint} sqrtPx96   pool sqrtPriceX96 (slot0)
 * @param {bigint} liquidity  pool in-range liquidity (L units)
 * @param {boolean} zeroForOne true if swapping token0 -> token1
 * @param {bigint} feeUnits   fee in millionths (e.g. 500n for 0.05%)
 * @returns {bigint} raw output amount (token wei)
 */
function getAmountOutV3(amountIn, sqrtPx96, liquidity, zeroForOne, feeUnits = 500n) {
  if (amountIn <= 0n || sqrtPx96 <= 0n || liquidity <= 0n) return 0n;
  const Q96 = 1n << 96n;

  // Apply fee: amountInWithFee = amountIn * (1e6 - feeUnits) / 1e6
  const amountInWithFee = (amountIn * (1000000n - feeUnits)) / 1000000n;
  if (amountInWithFee <= 0n) return 0n;

  if (zeroForOne) {
    // token0 in -> price goes DOWN (sqrtP' < sqrtP)
    // Uniswap V3 math:
    //   L' = L (liquidity constant within tick)
    //   sqrtP' = L*Q96 / (L*Q96/sqrtP + dx) = L*Q96*sqrtP / (L*Q96 + dx*sqrtP)
    //   dy = L*(sqrtP - sqrtP')/Q96
    const dx = amountInWithFee;
    const num = liquidity * Q96 * sqrtPx96;
    const den = liquidity * Q96 + dx * sqrtPx96;
    if (den <= 0n) return 0n;
    const sqrtP2 = num / den;
    if (sqrtP2 >= sqrtPx96 || sqrtP2 <= 0n) return 0n;
    // Safety: reject if price moved >5%
    if (sqrtP2 < (sqrtPx96 * 95n) / 100n) return 0n;
    return (liquidity * (sqrtPx96 - sqrtP2)) / Q96;
  }
  // token1 in -> price goes UP (sqrtP' > sqrtP)
  // Uniswap V3 math:
  //   sqrtP' = sqrtP + dy*Q96/L
  //   dx = L*Q96*(sqrtP' - sqrtP)/(sqrtP*sqrtP')
  const dy = amountInWithFee;
  const sqrtP2 = sqrtPx96 + (dy * Q96) / liquidity;
  if (sqrtP2 <= sqrtPx96 || sqrtP2 <= 0n) return 0n;
  if (sqrtP2 > (sqrtPx96 * 105n) / 100n) return 0n;
  const dxNum = liquidity * Q96 * (sqrtP2 - sqrtPx96);
  const dxDen = sqrtPx96 * sqrtP2;
  if (dxDen <= 0n) return 0n;
  return dxNum / dxDen;
}

/**
 * V3 pool depth (in token wei) for a given token.
 * V3 liquidity L is in sqrt(token0*token1) units, NOT token wei.
 * We convert: token0 ≈ L*Q96/sqrtP, token1 ≈ L*sqrtP/Q96
 * @returns {bigint} approximate depth in token wei
 */
function v3Depth(liquidity, sqrtPx96, zeroForOne) {
  if (liquidity <= 0n || sqrtPx96 <= 0n) return 0n;
  const Q96 = 1n << 96n;
  // Return the depth of the token we're swapping OUT, in token wei.
  // For zeroForOne (token0 in), we want token1 depth ≈ L*sqrtP/Q96
  // For !zeroForOne (token1 in), we want token0 depth ≈ L*Q96/sqrtP
  // These are approximate — real depth depends on tick range, but for
  // ranking purposes this is a reasonable estimate.
  return zeroForOne
    ? (liquidity * sqrtPx96) / Q96
    : (liquidity * Q96) / sqrtPx96;
}

/**
 * Simulate a 2-hop arbitrage with a flashloan (V2 pools):
 *   borrow `amountIn` of quote, buy base on buyDex, sell base on sellDex.
 * @returns {{tokensBought: bigint, quoteOut: bigint, flashFee: bigint, netProfit: bigint}}
 */
function simulateArbitrage(amountIn, buyDex, sellDex, feeN = DEFAULT_FEE_N, feeD = DEFAULT_FEE_D) {
  const boughtBase = getAmountOut(amountIn, buyDex.reserveQuote, buyDex.reserveBase, feeN, feeD);
  const quoteOut = getAmountOut(boughtBase, sellDex.reserveBase, sellDex.reserveQuote, feeN, feeD);
  // Flashloan repayment obligation on a V2 source pair.
  const flashFee = (amountIn * feeD) / feeN - amountIn;
  const netProfit = quoteOut - amountIn - flashFee;
  return { tokensBought: boughtBase, quoteOut, flashFee, netProfit };
}

/** Human price (quote per base) as a rational number num/den, decimals-adjusted. */
function priceRatio(reserveQuote, reserveBase, quoteDec, baseDec) {
  if (reserveBase <= 0n) return { num: 0n, den: 1n };
  return {
    num: reserveQuote * 10n ** BigInt(baseDec),
    den: reserveBase * 10n ** BigInt(quoteDec),
  };
}

/** Compare two rationals: a > b */
function ratioGt(a, b) {
  return a.num * b.den > b.num * a.den;
}

/** a / b as a float (ranking/logging only). */
function ratioDiv(a, b) {
  if (b.num === 0n) return 0;
  return Number((a.num * 10n ** 18n * b.den) / (b.num * a.den)) / 1e18;
}

/**
 * Rounds a token amount (raw BigInt + decimals) into a human readable string.
 */
function format(raw, decimals = 18) {
  let s = raw.toString();
  if (decimals === 0) return s;
  if (s.length <= decimals) s = "0".repeat(decimals - s.length + 1) + s;
  const i = s.length - Number(decimals);
  return `${s.slice(0, i)}.${s.slice(i)}`;
}

module.exports = {
  getAmountOut,
  getAmountOutV3,
  v3Depth,
  simulateArbitrage,
  priceRatio,
  ratioGt,
  ratioDiv,
  format,
  DEFAULT_FEE_N,
  DEFAULT_FEE_D,
};
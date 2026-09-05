// FLASH — profit estimation for V2/V3/DODO venues.
// Finds the best 2-hop arbitrage across all venues sharing a token pair.
const { getAmountOut, getAmountOutV3, v3Depth } = require("../lib/amm");
const { pairKey } = require("./scanner");
const config = require("./config");

const FLASH_FEE_V2_BPS = 25; // PancakeSwap V2 flashswap = 0.25%

function providesToken(venue, tokenAddr) {
  const a = tokenAddr.toLowerCase();
  if (venue.kind === "v2") return venue.tokenA.address.toLowerCase() === a || venue.tokenB.address.toLowerCase() === a;
  if (venue.kind === "v3") return venue.tokenA.address.toLowerCase() === a || venue.tokenB.address.toLowerCase() === a;
  return (venue.baseToken || "").toLowerCase() === a || (venue.quoteToken || "").toLowerCase() === a;
}

function venueOutput(venue, tokenIn, amountIn) {
  if (!amountIn || amountIn <= 0n) return 0n;
  const a = tokenIn.toLowerCase();
  if (venue.kind === "v2") {
    const inIsA = a === venue.tokenA.address.toLowerCase();
    const rIn = inIsA ? venue.reserveA : venue.reserveB;
    const rOut = inIsA ? venue.reserveB : venue.reserveA;
    if (rIn <= 0n || rOut <= 0n) return 0n;
    const feeN = BigInt(10000 - (venue.feeBps || 25));
    return getAmountOut(amountIn, rIn, rOut, feeN, 10000n);
  }
  if (venue.kind === "v3") {
    const zeroForOne = a === venue.tokenA.address.toLowerCase();
    const feeUnits = BigInt(venue.feeTier || 500);
    return getAmountOutV3(amountIn, venue.sqrtPx96, venue.liquidity, zeroForOne, feeUnits);
  }
  // DODO pools are kept ONLY as flashloan sources (free flashloans).
  return 0n;
}

/**
 * Sanity filter: reject opportunities where estimated profit looks fake.
 * Real arbitrage on BSC yields <1% typically; >2% is almost certainly
 * a calculation artifact (wrong formula, bad depth estimate, etc.).
 */
function isPlausible(opp, maxProfitPercent = 2n) {
  return opp.netProfit > 0n && opp.netProfit <= (opp.borrowAmount * maxProfitPercent) / 100n;
}

function venueDepth(venue, quoteAddr) {
  const q = quoteAddr.toLowerCase();
  if (venue.kind === "v2") return q === venue.tokenA.address.toLowerCase() ? venue.reserveA : venue.reserveB;
  if (venue.kind === "v3") {
    // V3 liquidity is in L units (sqrt(token0*token1)), NOT token wei.
    // Convert conservatively: real depth is often 10-50x less than the formula
    // suggests because liquidity is concentrated in a narrow tick range.
    if (!venue.sqrtPx96 || !venue.liquidity) return 0n;
    const liq = BigInt(venue.liquidity);
    const quoteIsA = q === venue.tokenA.address.toLowerCase();
    const zeroForOne = quoteIsA;
    const rawDepth = v3Depth(liq, venue.sqrtPx96, zeroForOne);
    // Conservative factor: 10x reduction to account for tick concentration
    return rawDepth / 10n;
  }
  return q === venue.baseToken.toLowerCase() ? venue.baseReserve : venue.quoteReserve;
}

/**
 * Find the price of a token in BNB terms from the venue list.
 * Looks for a WBNB/token pair (V2 or V3) and returns price as a rational {num, den}
 * where price = num/den (1 token = num/den BNB). Returns {0,1} if not found.
 */
function tokenPriceInBnb(tokenAddr, venues) {
  const t = tokenAddr.toLowerCase();
  const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
  if (t === wbnb) return { num: 1n, den: 1n };
  for (const v of venues) {
    if (v.dead) continue;
    if (v.kind === "v2") {
      const a = v.tokenA.address.toLowerCase();
      const b = v.tokenB.address.toLowerCase();
      let pToken, pWbnb, decToken, decWbnb;
      if (a === t && b === wbnb) { pToken = v.reserveA; pWbnb = v.reserveB; decToken = v.tokenA.decimals||18; decWbnb = v.tokenB.decimals||18; }
      else if (a === wbnb && b === t) { pToken = v.reserveB; pWbnb = v.reserveA; decToken = v.tokenB.decimals||18; decWbnb = v.tokenA.decimals||18; }
      else continue;
      if (pToken > 0n && pWbnb > 0n)
        return { num: pWbnb * 10n**BigInt(decToken), den: pToken * 10n**BigInt(decWbnb) };
    }
    if (v.kind === "v3" && v.sqrtPx96 > 0n) {
      const a = v.tokenA.address.toLowerCase();
      const b = v.tokenB.address.toLowerCase();
      const Q96 = 1n << 96n;
      const sqrtP = BigInt(v.sqrtPx96);
      if (a === t && b === wbnb)
        return { num: sqrtP*sqrtP * 10n**BigInt(v.tokenA.decimals||18), den: Q96*Q96 * 10n**BigInt(v.tokenB.decimals||18) };
      if (a === wbnb && b === t)
        return { num: Q96*Q96 * 10n**BigInt(v.tokenB.decimals||18), den: sqrtP*sqrtP * 10n**BigInt(v.tokenA.decimals||18) };
    }
  }
  return { num: 0n, den: 1n };
}

function findOpportunities(venues, tokens, opts = {}) {
  const maxBorrowBps = BigInt(opts.maxPerPairBorrowBps || config.bot.maxPerPairBorrowBps);
  const minProfitBnb = BigInt(Math.floor((opts.minProfitBnb || config.bot.minProfitBnb) * 1e18));
  // Minimum liquidity required: $10k worth (in BNB terms ~0.016 BNB = 16e15 wei)
  const MIN_DEPTH_WEI = 16000000000000000n; // ~0.016 BNB

  const byPair = new Map();
  for (const v of venues) {
    if (v.dead) continue;
    let key, tok0, tok1;
    if (v.kind === "v2") { key = pairKey(v.tokenA.address, v.tokenB.address); tok0 = v.tokenA; tok1 = v.tokenB; }
    else if (v.kind === "v3") { key = pairKey(v.tokenA.address, v.tokenB.address); tok0 = v.tokenA; tok1 = v.tokenB; }
    else { key = pairKey(v.baseToken, v.quoteToken); tok0 = { address: v.baseToken }; tok1 = { address: v.quoteToken }; }
    if (!byPair.has(key)) byPair.set(key, { tok0, tok1, list: [] });
    byPair.get(key).list.push(v);
  }

  const ops = [];
  for (const { tok0, tok1, list } of byPair.values()) {
    if (list.length < 2) continue;
    for (const [borrowT, baseT] of [[tok0, tok1], [tok1, tok0]]) {
      const dodoSrc = list.filter(v => v.kind === "dodo" && providesToken(v, borrowT.address));
      const v2Src = list.filter(v => v.kind === "v2" && providesToken(v, borrowT.address));
      if (dodoSrc.length === 0 && v2Src.length === 0) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = 0; j < list.length; j++) {
          if (i === j) continue;
          const buyVen = list[i]; const sellVen = list[j];
          const depthBuy = venueDepth(buyVen, borrowT.address);
          const depthSell = venueDepth(sellVen, borrowT.address);
          const maxDepth = depthBuy < depthSell ? depthBuy : depthSell;
          if (maxDepth <= MIN_DEPTH_WEI) continue; // skip illiquid pairs
          const maxBorrow = (maxDepth * maxBorrowBps) / 10000n;
          if (maxBorrow <= 0n) continue;
          let best = null;
          for (let s = 1; s <= 20; s++) {
            const borrow = (maxBorrow * BigInt(s)) / 20n;
            const baseRecv = venueOutput(buyVen, borrowT.address, borrow);
            if (baseRecv <= 0n) continue;
            const quoteRecv = venueOutput(sellVen, baseT.address, baseRecv);
            if (quoteRecv <= borrow) continue;
            const flashFee = dodoSrc.length > 0 ? 0n : (borrow * BigInt(FLASH_FEE_V2_BPS)) / 10000n;
            const net = quoteRecv - borrow - flashFee;
            if (!best || net > best.net) best = { borrow, baseRecv, quoteRecv, flashFee, net };
          }
          if (best) {
            const price = tokenPriceInBnb(borrowT.address, venues);
            let profitInBnb = 0n;
            if (price.num > 0n) profitInBnb = (best.net * price.num) / price.den;
            // Skip if we can't value the profit in BNB (no WBNB pair exists)
            if (profitInBnb <= 0n) continue;
            const opp = {
              borrowToken: borrowT, baseToken: baseT, buyVen, sellVen,
              sourceKind: dodoSrc.length > 0 ? "dodo" : "v2",
              sourceVen: dodoSrc.length > 0 ? dodoSrc[0] : v2Src[0],
              borrowAmount: best.borrow, baseRecv: best.baseRecv, quoteRecv: best.quoteRecv,
              flashFee: best.flashFee, netProfit: best.net, profitInBnb,
            };
            if (isPlausible(opp)) ops.push(opp);
          }
        }
      }
    }
  }
  ops.sort((a, b) => (b.profitInBnb > a.profitInBnb ? 1 : -1));
  return ops;
}

module.exports = { findOpportunities, venueOutput, venueDepth, providesToken, isPlausible };

// FLASH — profit estimation for V2/V3/DODO venues.
// Finds the best 2-hop arbitrage across all venues sharing a token pair.
const { getAmountOut, getAmountOutV3, v3Depth } = require("../lib/amm");
const { getAmountOutV3Exact } = require("../lib/v3"); // TASK 4.4: quote EXACT
const dodo = require("../lib/dodo");
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
    // TASK 4.4: când scannerul a citit starea PROFUNDĂ (tickSpacing + tickBitmap
    // words + initialized ticks cu liquidityNet — vezi scanner.enrichV3Venues),
    // folosim motorul EXACT din lib/v3 (swap-step cu tick crossing), identic
    // cu QuoterV2. Fallback: modelul simplificat cu lichiditate constantă.
    const s = venue.v3State;
    if (s && Array.isArray(s.words) && Array.isArray(s.ticks) && s.words.length > 0) {
      try {
        const words = new Map(s.words.map((w) => [w.word, BigInt(w.value)]));
        const ticks = new Map(s.ticks.map((t) => [t.tick, BigInt(t.liquidityNet)]));
        const r = getAmountOutV3Exact({
          amountIn,
          zeroForOne,
          fee: Number(venue.feeTier || 500),
          tickSpacing: s.tickSpacing,
          words,
          ticks,
          sqrtPx96: s.sqrtPriceX96,
          liquidity: s.liquidity,
          tick: s.tick,
        });
        if (r && r.amountOut > 0n) return r.amountOut;
      } catch (_) {
        // prea multe tick-uri traversate / stare parțială → model simplificat
      }
    }
    // TASK 4.4: fallback-ul legacy cere BigInt; coercie defensivă (venue-ul poate
    // veni din JSON/cache unde BigInt devine string) ca să nu aruncăm TypeError.
    const px = venue.sqrtPx96 != null ? BigInt(venue.sqrtPx96) : 0n;
    const liq = venue.liquidity != null ? BigInt(venue.liquidity) : 0n;
    return getAmountOutV3(BigInt(amountIn), px, liq, zeroForOne, feeUnits);
  }
  // PHASE 5 (audit): DODO PMM EXACT — nu mai returnăm 0. Quote off-chain
  // bit-exact cu DVMTrader.querySellBase/querySellQuote (vezi lib/dodo.js,
  // validat prin paritate Solidity în test/amm.js și pe fork în
  // test/integration/dodo-pmm-parity.js). Fără starea PMM a pool-ului,
  // venue-ul rămâne doar sursă de flashloan.
  if (venue.kind === "dodo") {
    if (!venue.pmm || venue.lpFeeRate === undefined) return 0n;
    try {
      if (a === venue.baseToken.toLowerCase()) {
        return dodo.quoteSellBase(venue.pmm, amountIn, venue.lpFeeRate, venue.mtFeeRate || 0n).out;
      }
      if (a === venue.quoteToken.toLowerCase()) {
        return dodo.quoteSellQuote(venue.pmm, amountIn, venue.lpFeeRate, venue.mtFeeRate || 0n).out;
      }
    } catch (_) {
      return 0n; // ex: trade > target pe DVM → on-chain query ar si reverts
    }
  }
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
            // FLASH FEE POLICY (audit item 4):
            //  - PancakeSwap V2: 0.25% fix (protocol fee real).
            //  - DODO: NU este un fee explicit; costul real vine din mecanismul
            //    de equalizare al pool-ului. Pentru repay EXACT al activelor
            //    imprumutate costul este 0 — dar nu e un adevăr universal:
            //    politica e în config.dodo.flashFeeBps (null = 0) și va fi
            //    validată pe fork în PHASE 2B.
            const flashFee = dodoSrc.length > 0
              ? dodo.dodoFlashFee(borrow, config.dodo)
              : (borrow * BigInt(FLASH_FEE_V2_BPS)) / 10000n;
            const net = quoteRecv - borrow - flashFee;
            if (!best || net > best.net) best = { borrow, baseRecv, quoteRecv, flashFee, net };
          }
          if (best) {
            const price = tokenPriceInBnb(borrowT.address, venues);
            let profitInBnb = 0n;
            if (price.num > 0n) profitInBnb = (best.net * price.num) / price.den;
            // Skip if we can't value the profit in BNB (no WBNB pair exists)
            if (profitInBnb <= 0n) continue;
            // BLOCK SNAPSHOT (audit item 6): oportunitatea duce cu ea block-ul
            // din care provin toate quote-urile sale. Venue-urile citite în
            // block-uri diferite NU sunt combinate.
            const snap = opts.snapshot;
            if (snap) {
              const stale = (v) => v.dead || (v.snapshot !== undefined && v.snapshot !== snap.blockNumber);
              if (stale(buyVen) || stale(sellVen)) continue;
            }
            const opp = {
              borrowToken: borrowT, baseToken: baseT, buyVen, sellVen,
              sourceKind: dodoSrc.length > 0 ? "dodo" : "v2",
              sourceVen: dodoSrc.length > 0 ? dodoSrc[0] : v2Src[0],
              borrowAmount: best.borrow, baseRecv: best.baseRecv, quoteRecv: best.quoteRecv,
              flashFee: best.flashFee, netProfit: best.net, profitInBnb,
              snapshot: snap ? { blockNumber: snap.blockNumber, blockHash: snap.blockHash, timestamp: snap.timestamp, stateVersion: snap.stateVersion } : null,
            };
            // TASK 4.6: isPlausible(>2%) NU MAI ELIMINĂ profiturile mari.
            // Un profit "prea bun" este adesea REAL (pump/recent listing/lag de
            // RPC) — trebuie VERIFICAT on-chain (staticCall în executor), nu
            // aruncat. Keeper-ul trebuie să vadă și să judece, nu să piadă opri.
            // Marcam opp-ul pentru verificare strictă și îl păstrăm în listă.
            opp.needsVerification = !isPlausible(opp);
            if (opp.needsVerification) {
              logger.warn(
                `[profit] large profit flagged for verification: ` +
                `${opp.borrowToken?.symbol || "?"} net=${opp.netProfit?.toString?.() || opp.netProfit}`
              );
            }
            ops.push(opp);
          }
        }
      }
    }
  }
  ops.sort((a, b) => (b.profitInBnb > a.profitInBnb ? 1 : -1));
  return ops;
}

module.exports = { findOpportunities, venueOutput, venueDepth, providesToken, isPlausible, tokenPriceInBnb };

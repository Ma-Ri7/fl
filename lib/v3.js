// ============================================================================
// lib/v3.js — EXACT PancakeSwap/Uniswap V3 multi-tick quote engine.
//
// Port fidel (BigInt) al:
//   - Uniswap v3-core: TickMath.sol, SqrtPriceMath.sol, SwapMath.sol
//     (https://github.com/Uniswap/v3-core)
//   - PancakeSwap V3 folosește aceleași librării (fee-urile de protocol sunt
//     scise din feeAmount, nu schimbă output-ul trader-ului).
//
// Elimină limitarea "current-tick only" din lib/amm.js (PHASE 4 din audit):
// traversează tick-urile inițializate (tickBitmap + liquidityNet), exact ca
// pool-ul on-chain, cu aceleași rotunjiri.
// ============================================================================

const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;

const divRoundingUp = (a, b) => (a + b - 1n) / b; // UnsafeMath.divRoundingUp
const mulDiv = (a, b, c) => (a * b) / c; // FullMath.mulDiv (BigInt: fara overflow)
const mulDivRoundingUp = (a, b, c) => (a * b + c - 1n) / c; // FullMath.mulDivRoundingUp

// ---- TickMath.getSqrtRatioAtTick -------------------------------------------
const TICK_RATIOS = [
  [0x2n, 0xfff97272373d413259a46990580e213an],
  [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];

function getSqrtRatioAtTick(tick) {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error("T");
  const absTick = BigInt(Math.abs(tick));
  let ratio = (absTick & 0x1n) !== 0n
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  for (const [bit, magic] of TICK_RATIOS) {
    if ((absTick & bit) !== 0n) ratio = (ratio * magic) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Q128.128 → Q128.96, rotunjit in sus
  return (ratio >> 32n) + ((ratio & 0xffffffffn) === 0n ? 0n : 1n);
}

// ---- SqrtPriceMath ----------------------------------------------------------
function getAmount0Delta(sqrtA, sqrtB, liquidity, roundUp) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA <= 0n) throw new Error("sqrtA==0");
  const numerator1 = BigInt(liquidity) << 96n;
  const numerator2 = sqrtB - sqrtA;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtB), sqrtA)
    : mulDiv(numerator1, numerator2, sqrtB) / sqrtA;
}

function getAmount1Delta(sqrtA, sqrtB, liquidity, roundUp) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp
    ? mulDivRoundingUp(BigInt(liquidity), sqrtB - sqrtA, Q96)
    : mulDiv(BigInt(liquidity), sqrtB - sqrtA, Q96);
}

function getNextSqrtPriceFromAmount0RoundingUp(sqrtP, liquidity, amount, add) {
  if (amount === 0n) return sqrtP;
  const numerator1 = BigInt(liquidity) << 96n;
  if (add) {
    const product = amount * sqrtP;
    const denominator = numerator1 + product;
    if (product <= MAX_UINT256 && denominator <= MAX_UINT256) {
      return mulDivRoundingUp(numerator1, sqrtP, denominator);
    }
    // Match the uint256-overflow fallback in SqrtPriceMath.sol.
    return divRoundingUp(numerator1, numerator1 / sqrtP + amount);
  }
  const product = amount * sqrtP;
  if (!(numerator1 > product)) throw new Error("overflow/underflow");
  return mulDivRoundingUp(numerator1, sqrtP, numerator1 - product);
}

function getNextSqrtPriceFromAmount1RoundingDown(sqrtP, liquidity, amount, add) {
  if (add) {
    return sqrtP + amount * Q96 / BigInt(liquidity); // rotunjit in jos
  }
  // ramura exactOut (nefolocata de bot): Δ = amount*Q96/L
  const quotient = amount * Q96 / BigInt(liquidity);
  if (!(sqrtP > quotient)) throw new Error("overflow/underflow");
  return sqrtP - quotient;
}

function getNextSqrtPriceFromInput(sqrtP, liquidity, amountIn, zeroForOne) {
  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtP, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtP, liquidity, amountIn, true);
}


// ---- SwapMath.computeSwapStep (exactIn; exactOut nu e folosit de bot) -------
function computeSwapStep(sqrtCurrent, sqrtTarget, liquidity, amountRemaining, feePips) {
  const zeroForOne = sqrtCurrent >= sqrtTarget;
  if (amountRemaining < 0n) throw new Error("exactOut-not-supported");
  const remaining = BigInt(amountRemaining);

  const amountRemainingLessFee = mulDiv(remaining, 1000000n - feePips, 1000000n);
  let amountIn = zeroForOne
    ? getAmount0Delta(sqrtTarget, sqrtCurrent, liquidity, true)
    : getAmount1Delta(sqrtCurrent, sqrtTarget, liquidity, true);
  let sqrtNext;
  if (amountRemainingLessFee >= amountIn) {
    sqrtNext = sqrtTarget;
  } else {
    sqrtNext = getNextSqrtPriceFromInput(sqrtCurrent, liquidity, amountRemainingLessFee, zeroForOne);
  }

  const max = sqrtTarget === sqrtNext;
  if (zeroForOne) {
    amountIn = max ? amountIn : getAmount0Delta(sqrtNext, sqrtCurrent, liquidity, true);
  } else {
    amountIn = max ? amountIn : getAmount1Delta(sqrtCurrent, sqrtNext, liquidity, true);
  }
  const amountOut = zeroForOne
    ? getAmount1Delta(sqrtNext, sqrtCurrent, liquidity, false)
    : getAmount0Delta(sqrtCurrent, sqrtNext, liquidity, false);

  // daca NU am atins target-ul, tot restul input-ului e fee
  const feeAmount = max
    ? mulDivRoundingUp(amountIn, feePips, 1000000n - feePips)
    : remaining - amountIn;
  return { sqrtNext, amountIn, amountOut, feeAmount };
}

// ---- TickBitmap.nextInitializedTickWithinOneWord -----------------------------
// words: Map(wordPos -> BigInt word value) — cum vine din tickBitmap.word(pos)
// Port fidel al Uniswap v3-core TickBitmap.sol:
//   position(compressed): wordPos = int16(compressed >> 8) (arithmetic shift),
//                          bitPos = uint8(compressed % 256) (modul pozitiv).
function compressedPosition(compressed) {
  const wordPos = compressed >> 8; // JS Number >> e arithmetic shift (32-bit), = floor for these ranges
  let bitPos = compressed % 256;
  if (bitPos < 0) bitPos += 256; // uint8(int24(compressed % 256))
  return { wordPos, bitPos };
}

function position(tick, tickSpacing) {
  let compressed = Math.trunc(tick / tickSpacing); // trunc toward zero (Solidity int div)
  if (tick < 0 && tick % tickSpacing !== 0) compressed -= 1;
  const { wordPos, bitPos } = compressedPosition(compressed);
  return { wordPos, bitPos, compressed };
}

function msb(word) {
  let msbV = 0;
  let r = word;
  for (const shift of [128n, 64n, 32n, 16n, 8n, 4n, 2n, 1n]) {
    if (r > (1n << shift) - 1n) { msbV |= Number(shift); r >>= shift; }
  }
  return msbV;
}

function lsb(word) {
  // BitMath.leastSignificantBit port — r=255, scadere doar când chunk-ul jos e nevid
  // (dacă bit-urile jos conțin un 1, LSB este acolo); altfel shift-ăm dreapta.
  let lsbV = 255;
  let r = word;
  for (const shift of [128n, 64n, 32n, 16n, 8n, 4n, 2n, 1n]) {
    if ((r & ((1n << shift) - 1n)) !== 0n) lsbV -= Number(shift);
    else r >>= shift;
  }
  return lsbV;
}

/**
 * TASK 4.4-A-FIX — FAIL-CLOSED pe bitmap word-uri necunoscute.
 *
 * EMPTY ≠ UNKNOWN:
 *   words.get(wordPos) === 0n   → word CITIT, gol      → stare CUNOSCUTĂ, validă
 *   words.has(wordPos) === false → word NECITIT         → stare NECUNOSCUTĂ
 *
 * Un word absent NU este un word gol. Dacă l-am trata ca 0n, engine-ul ar
 * concluziona „aici nu există niciun tick inițializat” și ar produce un quote
 * aparent valid din date care lipsesc — exact clasa de eroare care poate duce
 * la execuție pe bani reali cu o stare incompletă.
 *
 * De aceea lipsa word-ului aruncă, iar bot/profit.js venueOutput() transformă
 * orice aruncare a motorului exact în 0n (oportunitatea se sare), fără niciun
 * fallback la modelul aproximativ.
 */
function requireBitmapWord(words, wordPos) {
  if (!words || typeof words.has !== "function" || !words.has(wordPos)) {
    throw new Error("missing-tickbitmap-word");
  }
  const word = words.get(wordPos);
  // Prezent dar neutilizabil (undefined / string / number) = tot UNKNOWN.
  if (typeof word !== "bigint") throw new Error("missing-tickbitmap-word");
  return word;
}

function nextInitializedTickWithinOneWord(words, tick, tickSpacing, lte) {
  // TickBitmap.sol nextInitializedTickWithinOneWord (port fidel):
  const compressed = Math.trunc(tick / tickSpacing); // trunc toward zero (Solidity int div)
  let cmp = compressed;
  if (tick < 0 && tick % tickSpacing !== 0) cmp -= 1; // round toward -Inf

  if (lte) {
    // (int16 wordPos, uint8 bitPos) = position(compressed)
    const { wordPos, bitPos } = compressedPosition(cmp);
    // FAIL-CLOSED înainte de orice masking: word absent => UNKNOWN => throw.
    const word = requireBitmapWord(words, wordPos);
    // mask = (1 << bitPos) - 1 + (1 << bitPos)  =>  bits 0..bitPos sette
    const mask = (1n << BigInt(bitPos)) - 1n + (1n << BigInt(bitPos));
    const masked = word & mask;
    const initialized = masked !== 0n;
    const next = initialized
      ? (cmp - (bitPos - msb(masked)))
      : (cmp - bitPos);
    return { tickNext: next * tickSpacing, initialized };
  }
  // start from the word of the next tick: position(compressed + 1)
  const { wordPos, bitPos } = compressedPosition(cmp + 1);
  // FAIL-CLOSED înainte de orice masking: word absent => UNKNOWN => throw.
  const word = requireBitmapWord(words, wordPos);
  // mask = ~((1 << bitPos) - 1)  =>  bits bitPos..255 sette
  const masked = word & ~((1n << BigInt(bitPos)) - 1n);
  const initialized = masked !== 0n;
  const next = initialized
    ? (cmp + 1 + (lsb(masked) - bitPos))
    : (cmp + 1 + (255 - bitPos)); // type(uint8).max = 255
  return { tickNext: next * tickSpacing, initialized };
}

// ---- Traversare completa multi-tick (echivalentul Pool.swap) -----------------
/**
 * Quote exact-in printr-un pool V3 real, traversand tick-urile initializate.
 * @param {object} p
 *   amountIn, sqrtPx96, liquidity, tick, fee, tickSpacing, zeroForOne,
 *   words (Map wordPos->BigInt), ticks (Map tick->liquidityNet BigInt signed),
 *   maxCrossTicks (default 64)
 */
function getAmountOutV3Exact(p) {
  const { amountIn, zeroForOne, fee, tickSpacing, words, ticks } = p;
  let sqrtP = BigInt(p.sqrtPx96);
  let liquidity = BigInt(p.liquidity);
  let tick = p.tick;
  const feePips = BigInt(fee);
  let left = BigInt(amountIn);
  let totalOut = 0n;
  let crossed = 0;
  const maxCross = p.maxCrossTicks || 64;

  // Bucla de traversare (echivalentul Pool.swap).
  //
  // Un pas care NU consumă nimic ȘI nu traversează un tick inițializat nu poate
  // aduce lichiditate nouă → ieșim. Fără acest guard, un "phantom tick" (țintă
  // atinsă dar tick-ul nu e în mapa de ticks citite) ar învârti bucla la infinit.
  // Când pasul traversează un tick inițializat, liquidityNet poate reface
  // lichiditatea, deci continuăm — exact ca pool-ul on-chain.
  while (left > 0n) {
    const { tickNext, initialized } = nextInitializedTickWithinOneWord(words, tick, tickSpacing, zeroForOne);
    let sqrtTarget;
    if (zeroForOne) {
      sqrtTarget = tickNext <= MIN_TICK ? MIN_SQRT_RATIO : getSqrtRatioAtTick(tickNext);
      if (sqrtTarget < MIN_SQRT_RATIO) sqrtTarget = MIN_SQRT_RATIO;
    } else {
      sqrtTarget = tickNext >= MAX_TICK ? MAX_SQRT_RATIO : getSqrtRatioAtTick(tickNext);
      if (sqrtTarget > MAX_SQRT_RATIO) sqrtTarget = MAX_SQRT_RATIO;
    }

    const step = computeSwapStep(sqrtP, sqrtTarget, liquidity, left, feePips);
    sqrtP = step.sqrtNext;
    // Progresul pasului = input consumat + fee (identic cu SwapMath).
    const consumed = step.amountIn + step.feeAmount;
    const reachedTarget = sqrtP === sqrtTarget;
    const willCross = reachedTarget && initialized && ticks.has(tickNext);

    // FAIL-CLOSED: bitmap says initialized but tick data is UNKNOWN.
    // initialized=true + ticks.has()=false means the bitmap bit is set but the
    // liquidityNet read failed or is missing -> state is incomplete -> cannot
    // cross. Treat as UNKNOWN (not as a non-initialized tick), otherwise the
    // traversal would skip the liquidityNet adjustment and quote wrong.
    if (reachedTarget && initialized && !ticks.has(tickNext)) {
      throw new Error("missing-initialized-tick");
    }

    if (consumed === 0n && !willCross) break; // progres imposibil

    left -= consumed;
    totalOut += step.amountOut;

    if (reachedTarget) {
      if (willCross) {
        const liquidityNet = ticks.get(tickNext);
        liquidity = zeroForOne ? liquidity - liquidityNet : liquidity + liquidityNet;
        crossed++;
        if (crossed > maxCross) throw new Error("too-many-ticks");
      }
      tick = zeroForOne ? tickNext - 1 : tickNext;
    } else {
      break; // swap-ul s-a consumat in range-ul curent
    }
  }
  return { amountOut: totalOut, sqrtPFinal: sqrtP, tickFinal: tick, crossed };
}

module.exports = {
  MIN_TICK,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  Q96,
  getSqrtRatioAtTick,
  getAmount0Delta,
  getAmount1Delta,
  getNextSqrtPriceFromInput,
  computeSwapStep,
  position,
  nextInitializedTickWithinOneWord,
  getAmountOutV3Exact,
};


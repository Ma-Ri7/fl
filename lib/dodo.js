// ============================================================================
// lib/dodo.js — EXACT DODO V2 (DVM/DSP/DPP) PMM math engine.
//
// Acest fișier este o oglindă BigInt a codului oficial DODO:
//   https://github.com/DODOEX/contractV2 (Apache-2.0)
//   - contracts/lib/PMMPricing.sol
//   - contracts/lib/DODOMath.sol
//   - contracts/lib/DecimalMath.sol
//   - contracts/lib/SafeMath.sol
//   - contracts/DODOVendingMachine/impl/DVMTrader.sol (fee-uri LP + maintainer)
// Toate operațiile întregi și ordinea lor (inclusiv ROTUNJIRILE) sunt păstrate
// identic cu on-chain, pentru ca quote-ul off-chain să fie bit-exact.
//
// Starea PMM (audit PHASE 5): i, K, B, Q, B0, Q0, R + LP fee + maintainer fee.
// NU se folosește niciun fee hardcodat (vezi istoricul DODO_SWAP_FEE_BPS din config).
// ============================================================================

const ONE = 10n ** 18n; // DecimalMath.ONE
const ONE2 = 10n ** 36n; // DecimalMath.ONE2

// RState din PMMPricing.sol: ONE=0, ABOVE_ONE=1, BELOW_ONE=2
const R_ONE = 0n;
const R_ABOVE = 1n;
const R_BELOW = 2n;

// ---- DecimalMath -----------------------------------------------------------
const mulFloor = (a, b) => (a * b) / ONE;
// DecimalMath.divFloor(target, d) = target * 1e18 / d
const divFloor = (a, b) => (a * ONE) / b;
// DecimalMath.divCeil(target, d) = ceil(target * 1e18 / d)  (SafeMath.divCeil)
const divCeilD = (a, b) => (a * ONE + b - 1n) / b;
// DecimalMath.reciprocalFloor(i) = 1e36 / i
const reciprocalFloor = (i) => ONE2 / i;

// ---- SafeMath.sqrt (Babylonian, converge la floor sqrt) --------------------
function isqrt(x) {
  if (x === 0n) return 0n;
  let z = x / 2n + 1n;
  let y = x;
  while (z < y) {
    y = z;
    z = (x / z + z) / 2n;
  }
  return y;
}

// ---- DODOMath._GeneralIntegrate --------------------------------------------
// res = i*delta*(1-k+k(V0^2/V1/V2))   [round down]
function generalIntegrate(V0, V1, V2, i, k) {
  if (V0 <= 0n) throw new Error("TARGET_IS_ZERO");
  if (V1 < V2) throw new Error("SUB_ERROR"); // SafeMath.sub ar reporta
  const fairAmount = i * (V1 - V2);
  if (k === 0n) return fairAmount / ONE;
  const V0V0V1V2 = divFloor((V0 * V0) / V1, V2);
  const penalty = mulFloor(k, V0V0V1V2);
  return ((ONE - k) + penalty) * fairAmount / ONE2;
}


// ---- DODOMath._SolveQuadraticFunctionForTarget ------------------------------
// Given V1, delta and price i, solve V0 (target)  [round down]
function solveQuadraticForTarget(V1, delta, i, k) {
  if (k === 0n) return V1 + mulFloor(i, delta);
  if (V1 === 0n) return 0n;
  let sqrt;
  const ki = 4n * k * i;
  if (ki === 0n) {
    sqrt = ONE;
  } else if ((ki * delta) / ki === delta) {
    sqrt = isqrt((ki * delta) / V1 + ONE2);
  } else {
    sqrt = isqrt((ki / V1) * delta + ONE2);
  }
  const premium = divFloor(sqrt - ONE, 2n * k) + ONE;
  return mulFloor(V1, premium);
}

// ---- DODOMath._SolveQuadraticFunctionForTrade -------------------------------
// Given V0, V1, delta (amount in), price i, K → trade output  [round down]
function solveQuadraticForTrade(V0, V1, delta, i, k) {
  if (V0 <= 0n) throw new Error("TARGET_IS_ZERO");
  if (delta === 0n) return 0n;

  if (k === 0n) {
    const r = mulFloor(i, delta);
    return r > V1 ? V1 : r;
  }

  if (k === ONE) {
    // k==1 → forma degenerata tip constant-product
    let temp;
    const idelta = i * delta;
    if (idelta === 0n) {
      temp = 0n;
    } else if ((idelta * V1) / idelta === V1) {
      temp = (idelta * V1) / (V0 * V0);
    } else {
      temp = ((delta * V1) / V0) * i / V0;
    }
    return (V1 * temp) / (temp + ONE);
  }

  const part2 = ((k * V0) / V1) * V0 + i * delta;
  let bAbs = (ONE - k) * V1;
  let bSig;
  if (bAbs >= part2) {
    bAbs -= part2;
    bSig = false;
  } else {
    bAbs = part2 - bAbs;
    bSig = true;
  }
  bAbs = bAbs / ONE;

  let squareRoot = mulFloor((ONE - k) * 4n, mulFloor(k, V0) * V0);
  squareRoot = isqrt(bAbs * bAbs + squareRoot);

  const denominator = (ONE - k) * 2n;
  let numerator;
  if (bSig) {
    numerator = squareRoot - bAbs;
    if (numerator === 0n) throw new Error("DODOMath: should not be zero");
  } else {
    numerator = bAbs + squareRoot;
  }

  const V2 = divCeilD(numerator, denominator);
  return V2 > V1 ? 0n : V1 - V2;
}

// ---- PMMPricing core --------------------------------------------------------
// PMMState: { i, K, B, Q, B0, Q0, R } — toate BigInt, R ∈ {0,1,2}

function sellBaseToken(state, payBaseAmount) {
  if (state.R === R_ONE) {
    return {
      receive: solveQuadraticForTrade(state.Q0, state.Q0, payBaseAmount, state.i, state.K),
      newR: R_BELOW,
    };
  }
  if (state.R === R_ABOVE) {
    const backToOnePayBase = state.B0 - state.B;
    const backToOneReceiveQuote = state.Q - state.Q0;
    if (payBaseAmount < backToOnePayBase) {
      // case 2.1: R status nu se schimba
      let receive = generalIntegrate(state.B0, state.B + payBaseAmount, state.B, state.i, state.K);
      if (receive > backToOneReceiveQuote) receive = backToOneReceiveQuote; // corner case (comentariu oficial)
      return { receive, newR: R_ABOVE };
    } else if (payBaseAmount === backToOnePayBase) {
      // case 2.2: R → ONE
      return { receive: backToOneReceiveQuote, newR: R_ONE };
    } else {
      // case 2.3: R → BELOW_ONE (pe DVM real Q0=0 → on-chain query reverts "TARGET_IS_ZERO")
      return {
        receive: backToOneReceiveQuote +
          solveQuadraticForTrade(state.Q0, state.Q0, payBaseAmount - backToOnePayBase, state.i, state.K),
        newR: R_BELOW,
      };
    }
  }
  // R = BELOW_ONE
  return {
    receive: solveQuadraticForTrade(state.Q0, state.Q, payBaseAmount, state.i, state.K),
    newR: R_BELOW,
  };
}

function sellQuoteToken(state, payQuoteAmount) {
  if (state.R === R_ONE) {
    return {
      receive: solveQuadraticForTrade(state.B0, state.B0, payQuoteAmount, reciprocalFloor(state.i), state.K),
      newR: R_ABOVE,
    };
  }
  if (state.R === R_ABOVE) {
    return {
      receive: solveQuadraticForTrade(state.B0, state.B, payQuoteAmount, reciprocalFloor(state.i), state.K),
      newR: R_ABOVE,
    };
  }
  // R = BELOW_ONE
  const backToOnePayQuote = state.Q0 - state.Q;
  const backToOneReceiveBase = state.B - state.B0;
  if (payQuoteAmount < backToOnePayQuote) {
    // case 2.1
    let receive = generalIntegrate(state.Q0, state.Q + payQuoteAmount, state.Q, reciprocalFloor(state.i), state.K);
    if (receive > backToOneReceiveBase) receive = backToOneReceiveBase;
    return { receive, newR: R_BELOW };
  } else if (payQuoteAmount === backToOnePayQuote) {
    // case 2.2
    return { receive: backToOneReceiveBase, newR: R_ONE };
  } else {
    // case 2.3
    return {
      receive: backToOneReceiveBase +
        solveQuadraticForTrade(state.B0, state.B0, payQuoteAmount - backToOnePayQuote, reciprocalFloor(state.i), state.K),
      newR: R_ABOVE,
    };
  }
}


// DVMStorage.getPMMState() — DVM nu stocheaza targets; ii deriva din rezerve:
// R = ABOVE_ONE, Q0 = 0, B0 = _SolveQuadraticFunctionForTarget(B, Q, 1/i, K)
function pmmStateFromReserves({ i, K, B, Q }) {
  const state = { i, K, B, Q, B0: 0n, Q0: 0n, R: R_ABOVE };
  if (state.R === R_ABOVE) {
    state.B0 = solveQuadraticForTarget(state.B, state.Q - state.Q0, reciprocalFloor(state.i), state.K);
  }
  return state;
}

// PMMPricing.getMidPrice — util pentru logging / ranking
function getMidPrice(state) {
  if (state.R === R_BELOW) {
    let R = divFloor((state.Q0 * state.Q0) / state.Q, state.Q);
    R = (ONE - state.K) + mulFloor(state.K, R);
    return divFloor(state.i, R);
  }
  let R = divFloor((state.B0 * state.B0) / state.B, state.B);
  R = (ONE - state.K) + mulFloor(state.K, R);
  return mulFloor(state.i, R);
}

// ---- Fee-uri (DVMTrader.querySellBase / querySellQuote) ---------------------
// receive = PMMout - mulFloor(PMMout, lpFeeRate) - mulFloor(PMMout, mtFeeRate)
function quoteSellBase(state, payBase, lpFeeRate, mtFeeRate) {
  const { receive } = sellBaseToken(state, payBase);
  if (receive === 0n) return { out: 0n, mtFee: 0n };
  const lpCut = mulFloor(receive, lpFeeRate);
  const mtFee = mulFloor(receive, mtFeeRate);
  if (lpCut + mtFee > receive) throw new Error("FEE_EXCEEDS_OUTPUT");
  return { out: receive - lpCut - mtFee, mtFee };
}

function quoteSellQuote(state, payQuote, lpFeeRate, mtFeeRate) {
  const { receive } = sellQuoteToken(state, payQuote);
  if (receive === 0n) return { out: 0n, mtFee: 0n };
  const lpCut = mulFloor(receive, lpFeeRate);
  const mtFee = mulFloor(receive, mtFeeRate);
  if (lpCut + mtFee > receive) throw new Error("FEE_EXCEEDS_OUTPUT");
  return { out: receive - lpCut - mtFee, mtFee };
}

// ---- Flashloan fee policy ----------------------------------------------------
// DODO nu are un fee explicit pe flashLoan; costul REAL vine din mecanismul de
// equalizare al pool-ului (querySell* aplicat pe delta injectat in callback).
// Pentru rambursarea EXACTA a activelor imprumutate (cazul nostru — contractul
// returneaza exact baseAmount/quoteAmount si nu injecteaza nimic in pool),
// pool-ul revine in starea initiala si costul net este 0. NU e un adevar
// universal: se valideaza pe fork in PHASE 2B (test/integration/dodo-pmm-parity.js
// + AUDIT.md). Daca se dovedeste altfel, se seteaza dodo.flashFeeBps in config.
function dodoFlashFee(borrowAmount, policy) {
  if (policy && policy.flashFeeBps !== null && policy.flashFeeBps !== undefined) {
    return (borrowAmount * BigInt(policy.flashFeeBps)) / 10000n;
  }
  return 0n;
}

module.exports = {
  ONE,
  R_ONE,
  R_ABOVE,
  R_BELOW,
  mulFloor,
  divFloor,
  divCeilD,
  reciprocalFloor,
  isqrt,
  generalIntegrate,
  solveQuadraticForTarget,
  solveQuadraticForTrade,
  sellBaseToken,
  sellQuoteToken,
  pmmStateFromReserves,
  getMidPrice,
  quoteSellBase,
  quoteSellQuote,
  dodoFlashFee,
};

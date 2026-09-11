// FLASH — Execution cost & gas safety (TASK 4.6-C).
//
// Strat formal între validarea economică 4.6-B (slippage/minOut/minProfit) și
// broadcast. Răspunde la întrebarea:
//   „Oportunitatea care trece de protecția slippage este și economic
//    executabilă după costul estimat al execuției (gas)?”
//
// Dimensiuni care rămân SEPARATE (fără oracle în acest task):
//   - GROSS arbitrage profit  (tokenul de settlement, raw units)
//   - EXECUTION GAS COST      (wei / BNB)
//   - NET economic result     (BNB, doar cu conversie verificată; altfel UNKNOWN)
//
// REGULI:
//   - gas estimate / gas price lipsă sau malformed => REJECT (fail-closed,
//     niciodată un default de genul „5 gwei” care ar masca un provider stricat)
//   - EIP-1559: costul se calculează cu limita superioară (maxFeePerGas),
//     NU cu effectiveGasPrice (necunoscut înainte de execuție)
//   - gasLimit = ceil(estimate * (10000 + bufferBps) / 10000), plafonat la
//     maxGasLimit — aritmetică întreg pe bps, fără floating point
//   - toată aritmetica economică este BigInt; nicio conversie wei→Number→wei
//   - pur (fără provider/wallet), determinist, rejection codes machine-readable.
//   - NU recalculează minOut/minProfit (4.6-B) și NU atinge realized P&L (4.5-E).

const GWEI = 1000000000n;
const ETHER = 1000000000000000000n; // 1 BNB = 1e18 wei
const WBNB_LOWER = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

const REJECTION_CODES = Object.freeze({
  GAS_ESTIMATE_INVALID: "GAS_ESTIMATE_INVALID",
  GAS_LIMIT_TOO_HIGH: "GAS_LIMIT_TOO_HIGH",
  GAS_PRICE_INVALID: "GAS_PRICE_INVALID",
  GAS_COST_INVALID: "GAS_COST_INVALID",
  PROFIT_CONVERSION_UNAVAILABLE: "PROFIT_CONVERSION_UNAVAILABLE",
  NET_PROFIT_BELOW_FLOOR: "NET_PROFIT_BELOW_FLOOR",
  INVALID_FEE_DATA: "INVALID_FEE_DATA",
});

function reject(code, reason) {
  return { ok: false, rejection: { code, reason } };
}

/** Divizare întregă cu ROTUNJIRE ÎN SUS (conservatoare pentru barbă/plafon). */
function ceilDiv(a, b) {
  if (typeof a !== "bigint" || typeof b !== "bigint" || b <= 0n) {
    throw new Error(`ceilDiv: invalid operands (${a}, ${b})`);
  }
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}

/**
 * Validează o cantitate în unități întregi (gas units sau wei).
 * Acceptă DOAR BigInt >= 0 sau Number întreg safe >= 0 (config).
 * Orice altceva (string, fracționar, NaN, Infinity, negativ, unsafe) => null.
 */
function validateGasUnits(v) {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number" && Number.isInteger(v) && Number.isSafeInteger(v)) {
    return v >= 0 ? BigInt(v) : null;
  }
  return null;
}

/**
 * Worst-case gas price (wei/gas unit) din fee data provider-ului.
 * Legacy (gasPrice) și EIP-1559 (maxFeePerGas) suportate; dacă ambele sunt
 * prezente se ia MAXIMUL (limita superioară a costului posibil). Lipsă sau
 * valori malformed => respingere explicită, niciodată un default.
 */
function worstCaseGasPriceWei(feeData) {
  if (!feeData || typeof feeData !== "object") {
    return reject(REJECTION_CODES.INVALID_FEE_DATA, "missing fee data");
  }
  const gasPrice = validateGasUnits(feeData.gasPrice);
  const maxFee = validateGasUnits(feeData.maxFeePerGas);
  if (gasPrice === null && maxFee === null) {
    return reject(REJECTION_CODES.GAS_PRICE_INVALID, "no usable gas price in fee data");
  }
  if (gasPrice !== null && maxFee !== null) {
    return { ok: true, priceWei: gasPrice > maxFee ? gasPrice : maxFee, mode: "worst-case", rejection: null };
  }
  if (maxFee !== null) return { ok: true, priceWei: maxFee, mode: "eip1559", rejection: null };
  return { ok: true, priceWei: gasPrice, mode: "legacy", rejection: null };
}

/**
 * Gas limit formalizat: estimate -> buffer în bps întregi (rotunjire ÎN SUS,
 * conservatoare) -> plafon maxim. estimate zero/malformed => REJECT.
 * Config invalid (bufferBps/maxGasLimit) => throw (eroare de programare, nu
 * condiție economică).
 */
function computeGasLimit(estimateRaw, opts = {}) {
  const bufferBps = opts.bufferBps === undefined ? 2000 : opts.bufferBps;
  const maxGasLimit = opts.maxGasLimit === undefined ? null : opts.maxGasLimit;
  const bps = validateGasUnits(bufferBps);
  if (bps === null || bps > 50000n) throw new Error(`invalid gasBufferBps: ${bufferBps}`);
  let ceiling = null;
  if (maxGasLimit !== null && maxGasLimit !== undefined) {
    ceiling = validateGasUnits(maxGasLimit);
    if (ceiling === null || ceiling <= 0n) throw new Error(`invalid maxGasLimit: ${maxGasLimit}`);
  }
  const estimate = validateGasUnits(estimateRaw);
  if (estimate === null) {
    return reject(REJECTION_CODES.GAS_ESTIMATE_INVALID, "malformed gas estimate");
  }
  if (estimate === 0n) {
    return reject(REJECTION_CODES.GAS_ESTIMATE_INVALID, "zero gas estimate");
  }
  const gasLimit = ceilDiv(estimate * (10000n + bps), 10000n);
  if (ceiling !== null && gasLimit > ceiling) {
    return reject(REJECTION_CODES.GAS_LIMIT_TOO_HIGH, `buffered gas limit ${gasLimit} exceeds ceiling ${ceiling}`);
  }
  return { ok: true, gasLimit, rejection: null };
}

/** Cost execution în wei: gasUnits * priceWei. Zero/malformed => REJECT. */
function executionCostWei(gasUnits, priceWei) {
  const units = validateGasUnits(gasUnits);
  const price = validateGasUnits(priceWei);
  if (units === null || price === null) {
    return reject(REJECTION_CODES.GAS_COST_INVALID, "malformed gas units or price");
  }
  const costWei = units * price;
  if (costWei === 0n) {
    return reject(REJECTION_CODES.GAS_COST_INVALID, "zero gas cost (zero estimate or zero price)");
  }
  return { ok: true, costWei, rejection: null };
}

/**
 * Net economic în BNB: gross(token -> BNB, conversie verificată) - gasCost.
 *  - settlement WBNB => profit deja în wei nativ (fără conversie);
 *  - altfel cere priceBnb = {num, den} rațional BigInt VERIFICAT (ex: din
 *    profit.tokenPriceInBnb); lipsă => PROFIT_CONVERSION_UNAVAILABLE (NU 0).
 */
function netEconomicResult(profitRaw, settlementToken, costWei, priceBnb = null) {
  if (typeof profitRaw !== "bigint") {
    return reject(REJECTION_CODES.PROFIT_CONVERSION_UNAVAILABLE, "invalid profit raw type");
  }
  if (typeof costWei !== "bigint" || costWei < 0n) {
    return reject(REJECTION_CODES.GAS_COST_INVALID, "invalid costWei");
  }
  if (settlementToken && String(settlementToken).toLowerCase() === WBNB_LOWER) {
    // Profit în BNB nativ — dimensiuni identice, conversie trivială (1:1).
    return { ok: true, grossBnb: profitRaw, netBnb: profitRaw - costWei, conversion: "native-bnb", rejection: null };
  }
  const num = priceBnb && typeof priceBnb.num === "bigint" ? priceBnb.num : null;
  const den = priceBnb && typeof priceBnb.den === "bigint" ? priceBnb.den : null;
  if (num === null || den === null || num <= 0n || den <= 0n) {
    return reject(REJECTION_CODES.PROFIT_CONVERSION_UNAVAILABLE, "no verified token→BNB conversion");
  }
  // Floor pe profit = conservator (subestimăm venitul, nu-l supraestimăm).
  const grossBnb = (profitRaw * num) / den;
  return { ok: true, grossBnb, netBnb: grossBnb - costWei, conversion: "venue-rational", rejection: null };
}

/**
 * GUARD-UL ECONOMIC COMPLET PRE-BROADCAST (TASK 4.6-C).
 * Determinist și pur. Ordinea validării (toate fail-closed):
 *   gas estimate -> gas limit (buffer + ceiling) -> gas price -> cost ->
 *   conversie profit -> net > 0 -> minProfitBnb -> gasReserveBps.
 *
 * @param {object} input
 *   profitRaw       - BigInt, profit brut în tokenul de settlement (poate fi
 *                     negativ; net-ul va fi respins de floor, nu e mascât)
 *   settlementToken - adresa tokenului de settlement (lowercase-abilă)
 *   gasEstimate     - estimarea de gas (units) — BigInt sau safe integer
 *   feeData         - { gasPrice?, maxFeePerGas?, ... } răspuns provider
 *   priceBnb        - {num,den} rațional verificat token→BNB (opțional pt WBNB)
 *   policy          - { minProfitBnb?, gasReserveBps?, bufferBps?, maxGasLimit? }
 * @returns {ok:true, gasLimit, priceWei, mode, costWei, grossBnb, netBnb, conversion}
 *          sau {ok:false, rejection:{code,reason}} — niciodată undefined/0.
 */
function evaluateExecutionCost(input) {
  const { profitRaw, settlementToken, gasEstimate, feeData } = input;
  const policy = input.policy || {};

  // 1) gas estimate -> gas limit (buffer + ceiling).
  const gl = computeGasLimit(gasEstimate, { bufferBps: policy.bufferBps, maxGasLimit: policy.maxGasLimit });
  if (!gl.ok) return gl;

  // 2) gas price (worst-case bound; lipsă/malformed => REJECT).
  const fee = worstCaseGasPriceWei(feeData);
  if (!fee.ok) return fee;

  // 3) cost execution.
  const cost = executionCostWei(gl.gasLimit, fee.priceWei);
  if (!cost.ok) return cost;

  // 4) conversie profit (dimensional corectă) + net.
  const net = netEconomicResult(profitRaw, settlementToken, cost.costWei, input.priceBnb);
  if (!net.ok) return net;

  // 5) net trebuie să fie strict pozitiv după costul gas (profit == cost e
  //    respins; profit = cost + 1 wei e acceptat).
  if (net.netBnb <= 0n) {
    return { ...reject(REJECTION_CODES.NET_PROFIT_BELOW_FLOOR, "net not positive after gas cost"),
             gasLimit: gl.gasLimit, priceWei: fee.priceWei, costWei: cost.costWei, netBnb: net.netBnb };
  }

  // 6) minProfitBnb floor (BNB/wei) — inclusive: net == floor => ACCEPT.
  if (policy.minProfitBnb !== undefined && policy.minProfitBnb !== null) {
    const floor = validateGasUnits(policy.minProfitBnb);
    if (floor === null) throw new Error(`invalid policy.minProfitBnb: ${policy.minProfitBnb}`);
    if (net.netBnb < floor) {
      return { ...reject(REJECTION_CODES.NET_PROFIT_BELOW_FLOOR, "net below minProfitBnb floor"),
               gasLimit: gl.gasLimit, priceWei: fee.priceWei, costWei: cost.costWei, netBnb: net.netBnb };
    }
  }

  // 7) rezervă de gas: net trebuie să depășească costul cu cel puțin bps
  //    (bară = ceil(cost*(10000+bps)/10000) — rotunjire în sus, conservatoare).
  if (policy.gasReserveBps !== undefined && policy.gasReserveBps !== null) {
    const bps = validateGasUnits(policy.gasReserveBps);
    if (bps === null || bps > 10000n) throw new Error(`invalid policy.gasReserveBps: ${policy.gasReserveBps}`);
    const required = ceilDiv(cost.costWei * (10000n + bps), 10000n);
    if (net.netBnb <= required) {
      return { ...reject(REJECTION_CODES.NET_PROFIT_BELOW_FLOOR, "net below gas reserve floor"),
               gasLimit: gl.gasLimit, priceWei: fee.priceWei, costWei: cost.costWei, netBnb: net.netBnb };
    }
  }

  return {
    ok: true,
    gasLimit: gl.gasLimit,
    priceWei: fee.priceWei,
    mode: fee.mode,
    costWei: cost.costWei,
    grossBnb: net.grossBnb,
    netBnb: net.netBnb,
    conversion: net.conversion,
    rejection: null,
  };
}

module.exports = {
  REJECTION_CODES,
  GWEI,
  ETHER,
  ceilDiv,
  validateGasUnits,
  worstCaseGasPriceWei,
  computeGasLimit,
  executionCostWei,
  netEconomicResult,
  evaluateExecutionCost,
};
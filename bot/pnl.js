// FLASH — Realized P&L Tracker (TASK 4.5-E).
//
// Contabilitate read/record: răspunde la întrebarea
//   "După ce tranzacția s-a executat efectiv, ce rezultat economic putem
//    demonstra că a produs?"
//
// Principii:
//   - realized P&L se derivează din rezultatul EFECTIV on-chain (receipt,
//     balance delta), NU din expected profit sau quoted profit.
//   - flashloan principal NU este profit.
//   - gas-ul este calculat din receipt-ul REAL (gasUsed × effectiveGasPrice).
//   - BNB gas + USDT profit NU se amestecă fără conversie verificabilă.
//   - toate valorile on-chain sunt BigInt (zero floating point pentru raw).
//   - records sunt imutabile după finalizare.
//   - procesarea duplicatului txHash este idempotentă.
//   - replacement-urile nu dublează P&L (doar tx-ul confirmat).
//
// Scope: read/record only. Nu trimite tx, nu reserve nonce, nu modifică
// executorul. Integrarea cu executorul se face prin API-ul recordPnL().

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/i;
const HEX_HASH_RE = /^0x[0-9a-fA-F]{64}$/i;
const HEX_HASH_PREFIX_RE = /^0x[0-9a-fA-F]+$/i;

function validateTxHash(hash) {
  if (typeof hash !== "string" || !HEX_HASH_RE.test(hash)) {
    throw new Error(`pnl: invalid txHash (${String(hash)})`);
  }
  return hash.toLowerCase();
}

function validateTrackerId(id) {
  if (id === null || id === undefined) return null;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`pnl: invalid trackerId (${String(id)})`);
  }
  return id;
}

function validateWallet(wallet) {
  const addr = typeof wallet === "string" ? wallet : wallet && wallet.address;
  if (typeof addr !== "string" || !HEX_ADDRESS_RE.test(addr)) {
    throw new Error(`pnl: invalid wallet (${String(addr)})`);
  }
  return addr.toLowerCase();
}

function validateTokenAddress(token) {
  if (typeof token !== "string" || !HEX_ADDRESS_RE.test(token)) {
    throw new Error(`pnl: invalid settlement token (${String(token)})`);
  }
  return token.toLowerCase();
}

function validateDecimals(d) {
  if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 18) {
    throw new Error(`pnl: invalid decimals (${String(d)})`);
  }
  return d;
}

function validateBigInt(value, name, { allowNegative = false, allowZero = true } = {}) {
  if (typeof value !== "bigint") {
    throw new Error(`pnl: invalid ${name} (expected bigint, got ${typeof value})`);
  }
  if (!allowNegative && value < 0n) {
    throw new Error(`pnl: invalid ${name} (negative)`);
  }
  if (!allowZero && value === 0n) {
    throw new Error(`pnl: invalid ${name} (zero)`);
  }
  return value;
}

function validateBigIntOrNull(value, name, opts = {}) {
  if (value === null || value === undefined) return null;
  return validateBigInt(value, name, opts);
}

function validateNonNegativeInt(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`pnl: invalid ${name} (${String(value)})`);
  }
  return value;
}

function validateNonNegativeIntOrNull(value, name) {
  if (value === null || value === undefined) return null;
  return validateNonNegativeInt(value, name);
}

function validateBlockHash(hash) {
  if (hash === null || hash === undefined) return null;
  if (typeof hash !== "string" || !HEX_HASH_RE.test(hash)) {
    throw new Error(`pnl: invalid blockHash (${String(hash)})`);
  }
  return hash.toLowerCase();
}

function validateReceipt(receipt) {
  if (receipt === null || receipt === undefined) return null;
  if (typeof receipt !== "object") {
    throw new Error("pnl: invalid receipt (not an object)");
  }
  if (receipt.status !== 0 && receipt.status !== 1) {
    throw new Error(`pnl: invalid receipt status (${String(receipt.status)})`);
  }
  if (typeof receipt.gasUsed !== "bigint") {
    throw new Error(`pnl: invalid receipt.gasUsed (${typeof receipt.gasUsed})`);
  }
  if (typeof receipt.effectiveGasPrice !== "bigint") {
    throw new Error(`pnl: invalid receipt.effectiveGasPrice (${typeof receipt.effectiveGasPrice})`);
  }
  return {
    status: receipt.status,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    blockNumber: validateNonNegativeIntOrNull(receipt.blockNumber, "blockNumber"),
    blockHash: validateBlockHash(receipt.blockHash),
    transactionIndex: validateNonNegativeIntOrNull(receipt.transactionIndex, "transactionIndex"),
  };
}

// ---------------------------------------------------------------------------
// P&L Status
// ---------------------------------------------------------------------------

const PnLStatus = Object.freeze({
  REALIZED: "REALIZED",
  INCOMPLETE: "INCOMPLETE",
  UNKNOWN: "UNKNOWN",
});

const NetProfitStatus = Object.freeze({
  KNOWN: "KNOWN",
  UNKNOWN: "UNKNOWN",
  INCOMPLETE: "INCOMPLETE",
});

// ---------------------------------------------------------------------------
// PnLTracker class
// ---------------------------------------------------------------------------

class PnLTracker {
  constructor() {
    this._records = new Map();
    this._seq = 0;
  }

  recordPnL(data = {}) {
    const txHash = validateTxHash(data.txHash);
    const existing = this._records.get(txHash);
    if (existing) return this._clone(existing);

    const trackerId = validateTrackerId(data.trackerId);
    const wallet = validateWallet(data.wallet);
    const settlementToken = validateTokenAddress(data.settlementToken);
    const settlementDecimals = validateDecimals(data.settlementDecimals);
    const beforeBalanceRaw = validateBigInt(data.beforeBalanceRaw, "beforeBalanceRaw", { allowNegative: false });
    const afterBalanceRaw = validateBigInt(data.afterBalanceRaw, "afterBalanceRaw", { allowNegative: false });
    const borrowedAmountRaw = validateBigIntOrNull(data.borrowedAmountRaw, "borrowedAmountRaw", { allowNegative: false }) || 0n;
    const repaidAmountRaw = validateBigIntOrNull(data.repaidAmountRaw, "repaidAmountRaw", { allowNegative: false }) || 0n;
    const flashloanFeeRaw = validateBigIntOrNull(data.flashloanFeeRaw, "flashloanFeeRaw", { allowNegative: false }) || 0n;
    const externalInflowRaw = validateBigIntOrNull(data.externalInflowRaw, "externalInflowRaw", { allowNegative: false }) || 0n;
    const externalOutflowRaw = validateBigIntOrNull(data.externalOutflowRaw, "externalOutflowRaw", { allowNegative: false }) || 0n;
    const receipt = validateReceipt(data.receipt);
    const blockNumber = validateNonNegativeIntOrNull(
      data.blockNumber !== undefined ? data.blockNumber : (receipt ? receipt.blockNumber : null), "blockNumber");
    const blockHash = validateBlockHash(
      data.blockHash !== undefined ? data.blockHash : (receipt ? receipt.blockHash : null));
    const blockTimestamp = validateNonNegativeIntOrNull(data.blockTimestamp, "blockTimestamp");

    // Gas data: validate direct params first, then use receipt if available
    let gasUsed = null;
    let effectiveGasPrice = null;
    if (data.gasUsed != null) {
      gasUsed = validateBigInt(data.gasUsed, "gasUsed", { allowNegative: false });
    }
    if (data.effectiveGasPrice != null) {
      effectiveGasPrice = validateBigInt(data.effectiveGasPrice, "effectiveGasPrice", { allowNegative: false });
    }
    if (receipt) {
      if (receipt.gasUsed != null) gasUsed = receipt.gasUsed;
      if (receipt.effectiveGasPrice != null) effectiveGasPrice = receipt.effectiveGasPrice;
    }

    const replacesTxHash = data.replacesTxHash != null ? validateTxHash(data.replacesTxHash) : null;

    let txStatus = null;
    let isReverted = false;
    if (receipt) {
      txStatus = receipt.status === 1 ? "CONFIRMED" : "REVERTED";
      isReverted = receipt.status === 0;
    }

    let grossProfitRaw = null;
    let grossProfitStatus = PnLStatus.UNKNOWN;
    if (receipt && receipt.status === 1) {
      // Only calculate gross profit when we have a confirmed receipt
      grossProfitRaw = afterBalanceRaw - beforeBalanceRaw - borrowedAmountRaw + repaidAmountRaw - externalInflowRaw + externalOutflowRaw - flashloanFeeRaw;
      grossProfitStatus = PnLStatus.REALIZED;
    }

    let gasCostWei = null;
    if (gasUsed != null && effectiveGasPrice != null) {
      gasCostWei = gasUsed * effectiveGasPrice;
    }

    let netProfitRaw = null;
    let netProfitStatus = NetProfitStatus.UNKNOWN;
    if (grossProfitStatus === PnLStatus.REALIZED && grossProfitRaw !== null) {
      if (gasCostWei !== null && settlementToken === "0x0000000000000000000000000000000000000000") {
        netProfitRaw = grossProfitRaw - gasCostWei;
        netProfitStatus = NetProfitStatus.KNOWN;
      }
    }

    let pnlStatus;
    if (grossProfitStatus === PnLStatus.REALIZED && (gasCostWei !== null || (gasUsed == null && effectiveGasPrice == null))) {
      pnlStatus = PnLStatus.REALIZED;
    } else if (isReverted && gasCostWei !== null) {
      pnlStatus = PnLStatus.INCOMPLETE;
    } else {
      pnlStatus = PnLStatus.UNKNOWN;
    }

    const now = Date.now();
    const id = `pnl-${++this._seq}`;
    const record = {
      id, txHash, trackerId, wallet, status: pnlStatus,
      blockNumber, blockHash, blockTimestamp,
      settlementToken, settlementDecimals,
      beforeBalanceRaw, afterBalanceRaw,
      borrowedAmountRaw, repaidAmountRaw, flashloanFeeRaw,
      externalInflowRaw, externalOutflowRaw,
      grossProfitRaw, grossProfitStatus,
      txStatus, isReverted,
      gasUsed, effectiveGasPrice, gasCostWei,
      netProfitRaw, netProfitStatus,
      replacesTxHash,
      createdAt: now, finalizedAt: now,
    };
    this._records.set(txHash, record);
    return this._clone(record);
  }

  /**
   * Get a P&L record by txHash.
   * @param {string} txHash
   * @returns {object|null} read-only record or null if not found
   */
  getPnL(txHash) {
    if (typeof txHash !== "string" || !HEX_HASH_PREFIX_RE.test(txHash)) {
      throw new Error(`pnl: invalid txHash (${String(txHash)})`);
    }
    const record = this._records.get(txHash.toLowerCase());
    return record ? this._clone(record) : null;
  }

  /**
   * List P&L records with optional filter.
   * @param {object} [filter] { status, wallet, settlementToken }
   * @returns {object[]} read-only records
   */
  listPnL(filter = {}) {
    const out = [];
    for (const rec of this._records.values()) {
      if (filter.status && rec.status !== filter.status) continue;
      if (filter.wallet && rec.wallet !== validateWallet(filter.wallet)) continue;
      if (filter.settlementToken && rec.settlementToken !== validateTokenAddress(filter.settlementToken)) continue;
      out.push(this._clone(rec));
    }
    return out;
  }

  /**
   * Aggregate P&L totals. Only includes records where values are actually known.
   * UNKNOWN records are excluded from known totals.
   * @param {object} [filter] { wallet, settlementToken }
   * @returns {object} aggregation result
   */
  aggregatePnL(filter = {}) {
    const records = this.listPnL(filter);
    const byToken = new Map();

    for (const rec of records) {
      const key = rec.settlementToken;
      if (!byToken.has(key)) {
        byToken.set(key, {
          settlementToken: key,
          settlementDecimals: rec.settlementDecimals,
          totalGrossProfitRaw: 0n,
          totalGasCostWei: 0n,
          totalNetProfitRaw: 0n,
          grossCount: 0, gasCount: 0, netCount: 0,
          recordCount: 0, realizedCount: 0, incompleteCount: 0, unknownCount: 0,
        });
      }
      const agg = byToken.get(key);
      agg.recordCount++;
      if (rec.status === PnLStatus.REALIZED) agg.realizedCount++;
      else if (rec.status === PnLStatus.INCOMPLETE) agg.incompleteCount++;
      else agg.unknownCount++;

      if (rec.grossProfitStatus === PnLStatus.REALIZED && rec.grossProfitRaw !== null) {
        agg.totalGrossProfitRaw += rec.grossProfitRaw;
        agg.grossCount++;
      }
      if (rec.gasCostWei !== null) {
        agg.totalGasCostWei += rec.gasCostWei;
        agg.gasCount++;
      }
      if (rec.netProfitStatus === NetProfitStatus.KNOWN && rec.netProfitRaw !== null) {
        agg.totalNetProfitRaw += rec.netProfitRaw;
        agg.netCount++;
      }
    }

    const tokens = {};
    for (const [key, agg] of byToken) {
      tokens[key] = {
        settlementToken: agg.settlementToken,
        settlementDecimals: agg.settlementDecimals,
        totalGrossProfitRaw: agg.totalGrossProfitRaw,
        totalGasCostWei: agg.totalGasCostWei,
        totalNetProfitRaw: agg.totalNetProfitRaw,
        grossCount: agg.grossCount, gasCount: agg.gasCount, netCount: agg.netCount,
        recordCount: agg.recordCount, realizedCount: agg.realizedCount,
        incompleteCount: agg.incompleteCount, unknownCount: agg.unknownCount,
      };
    }

    let totalGrossProfitRaw = 0n, totalGasCostWei = 0n, totalNetProfitRaw = 0n;
    let grossCount = 0, gasCount = 0, netCount = 0;
    let totalRecordCount = 0, totalRealizedCount = 0, totalIncompleteCount = 0, totalUnknownCount = 0;
    for (const agg of byToken.values()) {
      totalGrossProfitRaw += agg.totalGrossProfitRaw;
      totalGasCostWei += agg.totalGasCostWei;
      totalNetProfitRaw += agg.totalNetProfitRaw;
      grossCount += agg.grossCount; gasCount += agg.gasCount; netCount += agg.netCount;
      totalRecordCount += agg.recordCount; totalRealizedCount += agg.realizedCount;
      totalIncompleteCount += agg.incompleteCount; totalUnknownCount += agg.unknownCount;
    }

    return {
      tokens, totalGrossProfitRaw, totalGasCostWei, totalNetProfitRaw,
      grossCount, gasCount, netCount,
      totalRecordCount, totalRealizedCount, totalIncompleteCount, totalUnknownCount,
    };
  }

  _clone(record) {
    return { ...record };
  }
}

module.exports = { PnLTracker, PnLStatus, NetProfitStatus };
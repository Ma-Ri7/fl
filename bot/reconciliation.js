// FLASH — Expected vs Realized P&L Reconciliation (TASK 4.5-F).
//
// Observabilitate și analiză: răspunde la întrebarea
//   "Cât profit estima botul înainte de execuție și cât profit a
//    realizat efectiv tranzacția?"
//   și: "Care este diferența dintre estimare și rezultat?"
//
// Principii:
//   - expected ≠ realized (separare strictă)
//   - realized provine EXCLUSIV din PnLTracker (authoritate unică)
//   - nu recalcula realized P&L în a doua instanță
//   - nu modifică strategia de execuție
//   - nu face look-ahead pe prețuri
//   - nu modifică expected retroactiv
//   - BNB gas ≠ USDT profit fără conversie
//   - UNKNOWN nu devine zero
//   - toate raw values sunt BigInt
//   - idempotency: același txHash → același record
//   - records imutabile (defensive copies)
//   - in-memory only (fără persistence)

const { PnLTracker, PnLStatus, NetProfitStatus } = require("./pnl");

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/i;
const HEX_HASH_RE = /^0x[0-9a-fA-F]{64}$/i;
const HEX_HASH_PREFIX_RE = /^0x[0-9a-fA-F]+$/i;

function validateTxHash(hash) {
  if (typeof hash !== "string" || !HEX_HASH_RE.test(hash)) {
    throw new Error(`reconcile: invalid txHash (${String(hash)})`);
  }
  return hash.toLowerCase();
}

function validateWallet(wallet) {
  const addr = typeof wallet === "string" ? wallet : wallet && wallet.address;
  if (typeof addr !== "string" || !HEX_ADDRESS_RE.test(addr)) {
    throw new Error(`reconcile: invalid wallet (${String(addr)})`);
  }
  return addr.toLowerCase();
}

function validateTokenAddress(token) {
  if (typeof token !== "string" || !HEX_ADDRESS_RE.test(token)) {
    throw new Error(`reconcile: invalid settlement token (${String(token)})`);
  }
  return token.toLowerCase();
}

function validateDecimals(d) {
  if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 18) {
    throw new Error(`reconcile: invalid decimals (${String(d)})`);
  }
  return d;
}

function validateBigInt(value, name, { allowNegative = false } = {}) {
  if (typeof value !== "bigint") {
    throw new Error(`reconcile: invalid ${name} (expected bigint, got ${typeof value})`);
  }
  if (!allowNegative && value < 0n) {
    throw new Error(`reconcile: invalid ${name} (negative)`);
  }
  return value;
}

function validateBigIntOrNull(value, name, opts = {}) {
  if (value === null || value === undefined) return null;
  return validateBigInt(value, name, opts);
}

function validateNonNegativeInt(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`reconcile: invalid ${name} (${String(value)})`);
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
    throw new Error(`reconcile: invalid blockHash (${String(hash)})`);
  }
  return hash.toLowerCase();
}

// ---------------------------------------------------------------------------
// Reconciliation Status
// ---------------------------------------------------------------------------

const ReconcileStatus = Object.freeze({
  COMPLETE: "COMPLETE",
  PARTIAL: "PARTIAL",
  UNKNOWN: "UNKNOWN",
  CONFLICT: "CONFLICT",
});

const DeviationDirection = Object.freeze({
  BETTER_THAN_EXPECTED: "BETTER_THAN_EXPECTED",
  WORSE_THAN_EXPECTED: "WORSE_THAN_EXPECTED",
  EXACTLY_AS_EXPECTED: "EXACTLY_AS_EXPECTED",
  UNKNOWN: "UNKNOWN",
});

// ---------------------------------------------------------------------------
// BPS calculation (exact BigInt arithmetic, truncation toward zero)
// ---------------------------------------------------------------------------

function calcBps(realizedRaw, expectedRaw) {
  if (realizedRaw === null || expectedRaw === null) return null;
  if (expectedRaw === 0n) return null;
  const delta = realizedRaw - expectedRaw;
  return (delta * 10000n) / expectedRaw;
}

// ---------------------------------------------------------------------------
// ReconciliationTracker class
// ---------------------------------------------------------------------------

class ReconciliationTracker {
  constructor(pnlTracker = null) {
    this._records = new Map();
    this._seq = 0;
    this._pnlTracker = pnlTracker || new PnLTracker();
  }

  /**
   * Reconcile expected vs realized P&L for a transaction.
   * Idempotent: same txHash returns existing record.
   */
  reconcile(data = {}) {
    const txHash = validateTxHash(data.txHash);
    const existing = this._records.get(txHash);
    if (existing) return this._clone(existing);

    const expected = this._validateExpected(data.expected, data.wallet);
    const wallet = validateWallet(data.wallet);

    let realizedRecord = null;
    if (data.realizedRecord) {
      realizedRecord = data.realizedRecord;
      if (realizedRecord.txHash !== txHash) {
        throw new Error("reconcile: realizedRecord txHash mismatch");
      }
    } else {
      realizedRecord = this._pnlTracker.getPnL(txHash);
    }

        const now = Date.now();
    const id = `rc-${++this._seq}`;
    const result = this._buildReconciliation(txHash, wallet, expected, realizedRecord, data, id, now);
    this._records.set(txHash, result);
    return this._clone(result);
  }

  _validateExpected(expected, wallet) {
    if (!expected || typeof expected !== "object") {
      throw new Error("reconcile: expected must be an object");
    }
    const settlementToken = validateTokenAddress(expected.settlementToken);
    const settlementDecimals = validateDecimals(expected.settlementDecimals);
    const grossRaw = validateBigInt(expected.grossRaw, "expected.grossRaw", { allowNegative: true });
    const gasWei = validateBigIntOrNull(expected.gasWei, "expected.gasWei", { allowNegative: false });
    const netRaw = validateBigIntOrNull(expected.netRaw, "expected.netRaw", { allowNegative: true });
    const source = typeof expected.source === "string" ? expected.source : null;
    const blockNumber = validateNonNegativeIntOrNull(expected.blockNumber, "expected.blockNumber");
    const blockHash = validateBlockHash(expected.blockHash);

    if (expected.wallet !== undefined && expected.wallet !== null) {
      const expectedWallet = validateWallet(expected.wallet);
      const callerWallet = validateWallet(wallet);
      if (expectedWallet !== callerWallet) {
        throw new Error("reconcile: wallet mismatch between caller and expected");
      }
    }

        return { settlementToken, settlementDecimals, grossRaw, gasWei, netRaw, source, blockNumber, blockHash };
  }

  _buildReconciliation(txHash, wallet, expected, realizedRecord, data, id, now) {
    const expectedSource = expected.source || "caller";
    const realizedSource = realizedRecord ? "PnLTracker" : null;

    let realizedGrossRaw = null;
    let realizedGasWei = null;
    let realizedNetRaw = null;
    let realizedNetStatus = NetProfitStatus.UNKNOWN;
    let realizedTxStatus = null;
    let realizedIsReverted = false;
    let realizedBlockNumber = null;
    let realizedBlockHash = null;
    let realizedDecimals = expected.settlementDecimals;
    let realizedToken = null;
    let realizedGrossStatus = PnLStatus.UNKNOWN;

    if (realizedRecord) {
      realizedGrossRaw = realizedRecord.grossProfitRaw;
      realizedGrossStatus = realizedRecord.grossProfitStatus;
      realizedGasWei = realizedRecord.gasCostWei;
      realizedNetRaw = realizedRecord.netProfitRaw;
      realizedNetStatus = realizedRecord.netProfitStatus;
      realizedTxStatus = realizedRecord.txStatus;
      realizedIsReverted = realizedRecord.isReverted;
      realizedBlockNumber = realizedRecord.blockNumber;
      realizedBlockHash = realizedRecord.blockHash;
      realizedDecimals = realizedRecord.settlementDecimals;
      realizedToken = realizedRecord.settlementToken;
    }

    const tokenMatch = realizedToken !== null ? (realizedToken === expected.settlementToken) : false;
    const canCompareGross = tokenMatch && realizedGrossStatus === PnLStatus.REALIZED && realizedGrossRaw !== null;

    let grossDeviationRaw = null;
    let grossDeviationBps = null;
    let grossDirection = DeviationDirection.UNKNOWN;

    if (canCompareGross) {
      grossDeviationRaw = realizedGrossRaw - expected.grossRaw;
      grossDeviationBps = calcBps(realizedGrossRaw, expected.grossRaw);
      if (grossDeviationRaw > 0n) grossDirection = DeviationDirection.BETTER_THAN_EXPECTED;
      else if (grossDeviationRaw < 0n) grossDirection = DeviationDirection.WORSE_THAN_EXPECTED;
      else grossDirection = DeviationDirection.EXACTLY_AS_EXPECTED;
    }

    let gasDeviationWei = null;
    let gasDeviationBps = null;
    let gasDirection = DeviationDirection.UNKNOWN;
    const canCompareGas = expected.gasWei !== null && realizedGasWei !== null;

    if (canCompareGas) {
      gasDeviationWei = realizedGasWei - expected.gasWei;
      gasDeviationBps = calcBps(realizedGasWei, expected.gasWei);
      if (gasDeviationWei > 0n) gasDirection = DeviationDirection.WORSE_THAN_EXPECTED;
      else if (gasDeviationWei < 0n) gasDirection = DeviationDirection.BETTER_THAN_EXPECTED;
      else gasDirection = DeviationDirection.EXACTLY_AS_EXPECTED;
    }

    let netDeviationRaw = null;
    let netDeviationBps = null;
    let netDirection = DeviationDirection.UNKNOWN;
    const canCompareNet = tokenMatch && expected.netRaw !== null && realizedNetRaw !== null && realizedNetStatus === NetProfitStatus.KNOWN;

    if (canCompareNet) {
      netDeviationRaw = realizedNetRaw - expected.netRaw;
      netDeviationBps = calcBps(realizedNetRaw, expected.netRaw);
      if (netDeviationRaw > 0n) netDirection = DeviationDirection.BETTER_THAN_EXPECTED;
      else if (netDeviationRaw < 0n) netDirection = DeviationDirection.WORSE_THAN_EXPECTED;
      else netDirection = DeviationDirection.EXACTLY_AS_EXPECTED;
    }

    let status;
    if (!realizedRecord) status = ReconcileStatus.UNKNOWN;
    else if (realizedIsReverted) status = ReconcileStatus.PARTIAL;
    else if (canCompareGross) status = canCompareNet ? ReconcileStatus.COMPLETE : ReconcileStatus.PARTIAL;
    else status = ReconcileStatus.UNKNOWN;

    return {
      id, txHash, wallet, status,
      expected: {
        settlementToken: expected.settlementToken, settlementDecimals: expected.settlementDecimals,
        grossRaw: expected.grossRaw, gasWei: expected.gasWei, netRaw: expected.netRaw,
        source: expectedSource, blockNumber: expected.blockNumber, blockHash: expected.blockHash,
      },
      realized: {
        settlementToken: realizedToken, settlementDecimals: realizedDecimals,
        grossRaw: realizedGrossRaw, gasWei: realizedGasWei, netRaw: realizedNetRaw,
        txStatus: realizedTxStatus, isReverted: realizedIsReverted,
        source: realizedSource, blockNumber: realizedBlockNumber, blockHash: realizedBlockHash,
      },
      grossDeviationRaw, grossDeviationBps, grossDirection,
      gasDeviationWei, gasDeviationBps, gasDirection,
      netDeviationRaw, netDeviationBps, netDirection,
      tokenDimensionalityMatch: tokenMatch,
      realizedRecordId: realizedRecord ? realizedRecord.id : null,
      createdAt: now, reconciledAt: now,
    };
  }

  getReconciliation(txHash) {
    if (typeof txHash !== "string" || !HEX_HASH_PREFIX_RE.test(txHash)) {
      throw new Error(`reconcile: invalid txHash (${String(txHash)})`);
    }
    const record = this._records.get(txHash.toLowerCase());
    return record ? this._clone(record) : null;
  }

  listReconciliations(filter = {}) {
    const out = [];
    for (const rec of this._records.values()) {
      if (filter.status && rec.status !== filter.status) continue;
      if (filter.wallet && rec.wallet !== validateWallet(filter.wallet)) continue;
      if (filter.settlementToken) {
        const st = validateTokenAddress(filter.settlementToken);
        if (rec.expected.settlementToken !== st) continue;
      }
      out.push(this._clone(rec));
    }
    return out;
  }

  recordPnL(data = {}) {
    return this._pnlTracker.recordPnL(data);
  }

  getPnL(txHash) {
    return this._pnlTracker.getPnL(txHash);
  }

  /**
   * Aggregate reconciliation records.
   *
   * Invariants:
   *   - UNKNOWN ≠ 0: unknown/ambiguous records are counted separately and
   *     never contribute to known totals.
   *   - tokens are never mixed: per-token buckets keyed by lowercase address.
   *   - gas is aggregated independently in wei (single unit).
   *   - net is aggregated only when dimensionally comparable (same token +
   *     known). No BNB→USDT conversion is invented.
   */
  aggregate(filter = {}) {
    const records = this.listReconciliations(filter);
    const tokens = new Map();

    let gasExpectedWei = null;
    let gasRealizedWei = null;
    let knownCount = 0;
    let unknownCount = 0;

    const add = (acc, v) => (acc === null ? v : acc + v);

    const ensure = (token) => {
      let t = tokens.get(token);
      if (!t) {
        t = {
          settlementToken: token,
          count: 0,
          knownCount: 0,
          unknownCount: 0,
          expectedGrossRaw: null,
          realizedGrossRaw: null,
          grossDeviationRaw: null,
          expectedNetRaw: null,
          realizedNetRaw: null,
          netDeviationRaw: null,
        };
        tokens.set(token, t);
      }
      return t;
    };

    for (const rec of records) {
      const token = rec.expected.settlementToken;
      const t = ensure(token);
      t.count += 1;

      // expected gross is always known (validated caller input).
      t.expectedGrossRaw = add(t.expectedGrossRaw, rec.expected.grossRaw);

      if (rec.grossDeviationRaw !== null) {
        // gross fully determinable (same token + realized known)
        t.knownCount += 1;
        knownCount += 1;
        t.realizedGrossRaw = add(t.realizedGrossRaw, rec.realized.grossRaw);
      } else {
        t.unknownCount += 1;
        unknownCount += 1;
      }

      // net: only when dimensionally comparable and known.
      if (rec.netDeviationRaw !== null) {
        t.expectedNetRaw = add(t.expectedNetRaw, rec.expected.netRaw);
        t.realizedNetRaw = add(t.realizedNetRaw, rec.realized.netRaw);
        t.netDeviationRaw = add(t.netDeviationRaw, rec.netDeviationRaw);
      }

      // gas: independent wei aggregation.
      if (rec.expected.gasWei !== null) gasExpectedWei = add(gasExpectedWei, rec.expected.gasWei);
      if (rec.realized.gasWei !== null) gasRealizedWei = add(gasRealizedWei, rec.realized.gasWei);
    }

    // Per-token gross deviation = realized(known) - expected(all).
    for (const t of tokens.values()) {
      if (t.realizedGrossRaw !== null) {
        t.grossDeviationRaw = t.realizedGrossRaw - t.expectedGrossRaw;
      }
    }

    const gasDeviationWei =
      gasRealizedWei !== null && gasExpectedWei !== null
        ? gasRealizedWei - gasExpectedWei
        : null;

    return {
      totalTransactions: records.length,
      knownCount,
      unknownCount,
      gas: {
        expectedWei: gasExpectedWei,
        realizedWei: gasRealizedWei,
        deviationWei: gasDeviationWei,
      },
      tokens,
    };
  }

  _clone(record) {
    return {
      ...record,
      expected: { ...record.expected },
      realized: { ...record.realized },
    };
  }
}

module.exports = {
  ReconciliationTracker,
  ReconcileStatus,
  DeviationDirection,
  calcBps,
};
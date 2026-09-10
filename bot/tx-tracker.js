// FLASH — TransactionTracker (TASK 4.5-C).
// Explicit, fail-closed, deterministic state machine for the lifecycle of a
// transaction AFTER it has been submitted. It answers:
//   "for this execution + nonce, where is the transaction and what can we
//    assert about it with certainty?"
//
// States: RESERVED, SUBMITTED, PENDING, CONFIRMED, REVERTED, DROPPED, UNKNOWN.
//
// Core principles:
//   - UNKNOWN != DROPPED: absence from the mempool is ambiguous, not proof of
//     drop. poll() NEVER produces DROPPED from a simple `null` transaction.
//   - REVERTED / CONFIRMED are terminal and require a VALID receipt.
//   - Receipt is the source of truth for finalization (priority over mempool).
//   - RPC failures are fail-closed → UNKNOWN, preserving lastError.
//   - Tracked state is in-memory only (no persistence). Recovery is a later task.
//   - Nonce ownership stays in NonceManager; this tracker NEVER rolls back a
//     nonce and NEVER calls into NonceManager.
class TransactionTracker {
  constructor() {
    this._records = new Map();   // id -> record
    this._seq = 0;
  }

  // -- validation helpers ----------------------------------------------------

  _validateNonce(nonce) {
    if (nonce === null || nonce === undefined) {
      throw new Error("tracker: invalid nonce (null/undefined)");
    }
    const type = typeof nonce;
    if (type !== "number" && type !== "string" && type !== "bigint") {
      // Rejects booleans, arrays, objects — never silently coerce to 0/1.
      throw new Error(`tracker: invalid nonce (unexpected type ${type})`);
    }
    if (type === "string" && nonce.trim() === "") {
      throw new Error("tracker: invalid nonce (empty string)");
    }
    const n = Number(nonce);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || !Number.isSafeInteger(n)) {
      throw new Error(`tracker: invalid nonce (${String(nonce)})`);
    }
    return n;
  }

  _validateTxHash(hash) {
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]+$/.test(hash)) {
      throw new Error(`tracker: invalid txHash (${String(hash)})`);
    }
    return hash;
  }

  _validateWallet(wallet) {
    const addr = typeof wallet === "string" ? wallet : wallet && wallet.address;
    if (typeof addr !== "string" || addr.length === 0) {
      throw new Error("tracker: invalid wallet");
    }
    return addr.toLowerCase();
  }

  _getRecord(id) {
    const rec = this._records.get(id);
    if (!rec) throw new Error(`tracker: record not found (${id})`);
    return rec;
  }

  _clone(rec) {
    // All record fields are scalars; a shallow copy suffices as a read-only
    // snapshot that cannot be used to corrupt internal state.
    return { ...rec };
  }
// -- state machine ---------------------------------------------------------

  static ALLOWED = Object.freeze({
    RESERVED: Object.freeze(new Set(["SUBMITTED", "UNKNOWN"])),
    SUBMITTED: Object.freeze(new Set(["PENDING", "CONFIRMED", "REVERTED", "UNKNOWN"])),
    PENDING: Object.freeze(new Set(["CONFIRMED", "REVERTED", "UNKNOWN", "DROPPED"])),
    UNKNOWN: Object.freeze(new Set(["PENDING", "CONFIRMED", "REVERTED", "DROPPED"])),
    // Terminal states — no outgoing transitions.
    CONFIRMED: Object.freeze(new Set()),
    REVERTED: Object.freeze(new Set()),
    DROPPED: Object.freeze(new Set()),
  });

  static STATES = Object.freeze([
    "RESERVED", "SUBMITTED", "PENDING", "CONFIRMED", "REVERTED", "DROPPED", "UNKNOWN",
  ]);

  _isValidReceipt(receipt) {
    if (receipt == null || typeof receipt !== "object") return false;
    if (receipt.status !== 1 && receipt.status !== 0) return false;
    if (receipt.blockNumber == null || receipt.blockHash == null) return false;
    return true;
  }

  /**
   * Core state transition. Validates the target state and the legality of the
   * move, then applies it atomically (synchronously — no await between the
   * read and the write, so concurrent polls cannot interleave here).
   *
   * Same-state transitions are idempotent no-ops (they refresh updatedAt but
   * never corrupt the record).
   *
   * @param {string} id
   * @param {string} to target state
   * @param {object} meta optional fields to persist on the record
   * @returns {object} read-only snapshot AFTER the transition
   */
  transition(id, to, meta = {}) {
    const rec = this._getRecord(id);
    if (!TransactionTracker.STATES.includes(to)) {
      throw new Error(`tracker: unknown state (${to})`);
    }
    const from = rec.state;
    if (from === to) {
      // idempotent no-op
      rec.updatedAt = Date.now();
      this._applyMeta(rec, meta);
      return this._clone(rec);
    }
    if (!TransactionTracker.ALLOWED[from].has(to)) {
      throw new Error(`tracker: illegal transition ${from} -> ${to}`);
    }
    rec.state = to;
    rec.updatedAt = Date.now();
    if (to === "CONFIRMED" || to === "REVERTED") {
      rec.receiptStatus = meta.receiptStatus;
      if (meta.blockNumber !== undefined) rec.blockNumber = meta.blockNumber;
      if (meta.blockHash !== undefined) rec.blockHash = meta.blockHash;
      if (meta.transactionIndex !== undefined) rec.transactionIndex = meta.transactionIndex;
    }
    if (to === "CONFIRMED" || to === "REVERTED" || to === "DROPPED") {
      rec.finalizedAt = Date.now();
    }
    this._applyMeta(rec, meta);
    return this._clone(rec);
  }

  _applyMeta(rec, meta) {
    if (!meta || typeof meta !== "object") return;
    if (meta.lastError !== undefined) rec.lastError = meta.lastError;
  }
// -- lifecycle API ---------------------------------------------------------

  /**
   * Create a new tracked transaction in state RESERVED.
   * @param {object} args { wallet, nonce }
   * @returns {object} read-only snapshot of the created record
   */
  create({ wallet, nonce }) {
    const n = this._validateNonce(nonce);
    const w = this._validateWallet(wallet);
    const now = Date.now();
    const id = `tx-${++this._seq}`;
    const rec = {
      id,
      wallet: w,
      nonce: n,
      txHash: null,
      state: "RESERVED",
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      blockNumber: null,
      blockHash: null,
      transactionIndex: null,
      receiptStatus: null,
      finalizedAt: null,
      lastError: null,
    };
    this._records.set(id, rec);
    return this._clone(rec);
  }

  /**
   * Mark the transaction as submitted with a known txHash.
   * RESERVED -> SUBMITTED. Idempotent when the same hash is repeated.
   * @param {string} id
   * @param {string} txHash
   * @returns {object} read-only snapshot
   */
  markSubmitted(id, txHash) {
    const rec = this._getRecord(id);
    if (rec.state !== "RESERVED") {
      if (rec.state === "SUBMITTED" && rec.txHash === txHash) {
        return this.transition(id, "SUBMITTED"); // idempotent
      }
      throw new Error(`tracker: illegal transition ${rec.state} -> SUBMITTED`);
    }
    const h = this._validateTxHash(txHash);
    rec.txHash = h;
    rec.submittedAt = Date.now();
    return this.transition(id, "SUBMITTED");
  }

  /**
   * Mark the transaction as mempool-visible.
   * SUBMITTED -> PENDING (also UNKNOWN -> PENDING; PENDING is idempotent).
   * @param {string} id
   * @returns {object} read-only snapshot
   */
  markPending(id) {
    return this.transition(id, "PENDING");
  }
/**
   * Poll the provider for the current transaction state and transition the
   * record accordingly (fail-closed).
   *
   * Order:
   *   1. receipt (status 1 -> CONFIRMED, status 0 -> REVERTED if valid);
   *   2. transaction visible -> PENDING;
   *   3. neither -> UNKNOWN (NEVER DROPPED);
   *   4. any RPC error -> UNKNOWN with lastError.
   *
   * @param {string} id
   * @param {object} provider { getTransactionReceipt, getTransaction }
   * @returns {object} read-only snapshot AFTER the poll
   */
  async poll(id, provider) {
    const rec = this._getRecord(id);
    // Terminal states are immutable: never query, never regress, never throw on
    // RPC inconsistency. Idempotent poll keeps reporting the terminal state.
    if (rec.state === "CONFIRMED" || rec.state === "REVERTED" || rec.state === "DROPPED") {
      return this._clone(rec);
    }
    if (rec.state === "RESERVED" || rec.txHash == null) {
      throw new Error(`tracker: cannot poll without a txHash (state=${rec.state})`);
    }
    const hash = rec.txHash;

    // PAS 1 — receipt (source of truth for finalization).
    let receipt = null;
    try {
      receipt = await provider.getTransactionReceipt(hash);
    } catch (e) {
      return this.transition(id, "UNKNOWN", { lastError: `receipt RPC error: ${e.message}` });
    }
    if (receipt != null) {
      if (!this._isValidReceipt(receipt)) {
        // Ambiguous receipt shape — fail-closed, never fabricate finality.
        return this.transition(id, "UNKNOWN", { lastError: "invalid receipt" });
      }
      const target = receipt.status === 1 ? "CONFIRMED" : "REVERTED";
      return this.transition(id, target, {
        receiptStatus: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionIndex: receipt.transactionIndex,
      });
    }

    // PAS 2 — transaction visible in mempool.
    try {
      const tx = await provider.getTransaction(hash);
      if (tx != null) {
        return this.transition(id, "PENDING");
      }
    } catch (e) {
      return this.transition(id, "UNKNOWN", { lastError: `tx RPC error: ${e.message}` });
    }

    // PAS 3 — neither receipt nor transaction available: UNKNOWN, never DROPPED.
    return this.transition(id, "UNKNOWN", { lastError: "no receipt and no transaction visible" });
  }

  // -- read-only API ---------------------------------------------------------

  /**
   * @param {string} id
   * @returns {object} read-only snapshot (defensive copy)
   */
  get(id) {
    return this._clone(this._getRecord(id));
  }

  /**
   * @param {object} [filter] { state, wallet }
   * @returns {object[]} read-only snapshots matching the filter
   */
  list(filter = {}) {
    const out = [];
    for (const rec of this._records.values()) {
      if (filter.state && rec.state !== filter.state) continue;
      if (filter.wallet && rec.wallet !== this._validateWallet(filter.wallet)) continue;
      out.push(this._clone(rec));
    }
    return out;
  }
}

module.exports = { TransactionTracker };
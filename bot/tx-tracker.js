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
  transition(id, to, meta = {}, wallet) {
    const rec = this._getRecord(id);
    // Wallet identity (TASK 4.5-D §27): enforced BEFORE any mutation.
    this._checkWallet(rec, wallet);
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
   * @param {object} args { wallet, nonce, mode?, relayId? }
   * @returns {object} read-only snapshot of the created record
   */
  create({ wallet, nonce, mode, relayId }) {
    const n = this._validateNonce(nonce);
    const w = this._validateWallet(wallet);
    const m = this._validateMode(mode);
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
      // TASK 4.5-D — submission context + replacement chain metadata.
      mode: this._validateMode(mode),      // 'private' | 'public' | null
      relayId: relayId || null,            // relay request id (NOT the tx hash)
      replaces: null,                      // id of the transaction this one replaces
      replacedBy: null,                    // id of the replacement transaction
    };
    this._records.set(id, rec);
    return this._clone(rec);
  }

  /**
   * Wallet identity enforcement (TASK 4.5-D §27). When a wallet is provided it
   * must match the record's owner (case-insensitive); otherwise the operation
   * is rejected BEFORE any mutation.
   */
  _checkWallet(rec, wallet) {
    if (wallet === undefined || wallet === null) return;
    const addr = this._validateWallet(wallet);
    if (rec.wallet !== addr) {
      throw new Error(`tracker: wallet-mismatch (record owned by ${rec.wallet}, got ${addr})`);
    }
  }

  _validateMode(mode) {
    if (mode === undefined || mode === null) return null;
    if (mode !== "private" && mode !== "public") {
      throw new Error(`tracker: invalid mode (${String(mode)})`);
    }
    return mode;
  }

  /**
   * Mark the transaction as submitted with a known txHash.
   * RESERVED -> SUBMITTED. Idempotent when the same hash is repeated.
   * @param {string} id
   * @param {string} txHash
   * @returns {object} read-only snapshot
   */
  markSubmitted(id, txHash, opts = {}) {
    const rec = this._getRecord(id);
    // Wallet identity enforced BEFORE any mutation (TASK 4.5-D §27).
    this._checkWallet(rec, opts.wallet);
    const h = this._validateTxHash(txHash);
    const m = this._validateMode(opts.mode);
    if (rec.state !== "RESERVED") {
      if (rec.state === "SUBMITTED" && rec.txHash === txHash) {
        if (m !== null) rec.mode = m;
        if (opts.relayId !== undefined) rec.relayId = opts.relayId || null;
        return this.transition(id, "SUBMITTED"); // idempotent
      }
      throw new Error(`tracker: illegal transition ${rec.state} -> SUBMITTED`);
    }
    rec.txHash = h;
    rec.submittedAt = Date.now();
    if (m !== null) rec.mode = m;
    if (opts.relayId !== undefined) rec.relayId = opts.relayId || null;
    return this.transition(id, "SUBMITTED");
  }

  /**
   * Mark the transaction as mempool-visible.
   * SUBMITTED -> PENDING (also UNKNOWN -> PENDING; PENDING is idempotent).
   * @param {string} id
   * @param {string} [wallet] — optional wallet identity check (case-insensitive)
   * @returns {object} read-only snapshot
   */
  markPending(id, wallet) {
    return this.transition(id, "PENDING", {}, wallet);
  }

  /**
   * TASK 4.5-D — replacement registration.
   *
   * Registers a replacement transaction (same wallet + same nonce, DIFFERENT
   * txHash) without touching the original record's identity. The original and
   * the replacement remain distinct records linked by explicit metadata:
   *   new.replaces   = originalId
   *   old.replacedBy = newId
   *
   * Safety rules:
   *   - the original must NOT be terminal (a confirmed/reverted/dropped tx
   *     cannot be replaced silently);
   *   - the replacement goes through the REAL state machine
   *     (create → RESERVED, then markSubmitted → SUBMITTED);
   *   - atomic: all validation happens before any mutation (synchronous, no
   *     awaits), so a throw can never leave half-registered metadata;
   *   - replacing NEVER frees a nonce (the tracker never touches NonceManager).
   *
   * @param {string} id — original record id
   * @param {object} opts { txHash, wallet?, relayId?, mode? }
   * @returns {object} read-only snapshot of the NEW (replacement) record
   */
  replace(id, opts = {}) {
    const old = this._getRecord(id);
    this._checkWallet(old, opts.wallet);
    if (old.state === "CONFIRMED" || old.state === "REVERTED" || old.state === "DROPPED") {
      throw new Error(`tracker: cannot replace terminal transaction (${old.state})`);
    }
    // Validate EVERYTHING before any mutation (atomicity, TASK 4.5-D §25).
    const h = this._validateTxHash(opts.txHash);
    const m = this._validateMode(opts.mode);
    const snap = this.create({ wallet: old.wallet, nonce: old.nonce, mode: m, relayId: opts.relayId });
    const rec = this._records.get(snap.id);
    rec.replaces = id;
    this.markSubmitted(snap.id, h, { wallet: old.wallet, mode: m, relayId: opts.relayId });
    old.replacedBy = snap.id;
    return this._clone(this._records.get(snap.id));
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
  async poll(id, provider, wallet) {
    const rec = this._getRecord(id);
    // Wallet identity (TASK 4.5-D §27) — enforced BEFORE any provider call.
    this._checkWallet(rec, wallet);
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
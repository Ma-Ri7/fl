// FLASH — NonceManager (audit item 7, PHASE 11).
// Rezervă nonce-uri tranzacțiilor în zbor, împiedică double-submit cu același
// nonce și reapr nonce-urile blocate (tx never mind / dropped).
class NonceManager {
  /**
   * @param {ethers.Wallet} wallet
   * @param {number} maxPending — plafon de tx-uri simultane (audit: maxNonceGap)
   */
  constructor(wallet, maxPending = 5) {
    this.wallet = wallet;
    this.walletAddress = wallet.address.toLowerCase();
    this.maxPending = maxPending;
    this.next = null;          // următorul nonce liber (local)
    this.pending = new Map();  // nonce -> { hash, ts }  (COMMITTED)
    this.reserved = new Set(); // nonce currently RESERVED (not yet committed/rolled back)
    this.blocked = new Set();  // nonce known on-chain but commit failed — NEVER reusable
    this.lastSync = 0;

    // Mutex for atomic reserve(): chains promises so concurrent callers
    // serialize and never read the same this.next value.
    this._reserveChain = Promise.resolve();
  }

  /** Resincronizează contorul local cu nonce-ul 'pending' on-chain. */
  async init(force = false) {
    if (this.next === null || force) {
      this.next = await this.wallet.getNonce("pending");
      this.lastSync = Date.now();
    }
    return this.next;
  }

  /**
   * Rezervă un nonce. Returnează null dacă sunt prea multe tx-uri în zbor
   * (evită blocajul nonce-gap).
   *
   * CONCURRENT-SAFE: uses an internal promise-chain mutex so parallel
   * callers always get unique nonces.
   */
  reserve() {
    // Chain onto the mutex: the body runs only after all prior reserves complete.
    const result = this._reserveChain.then(async () => {
      if (this.next === null) await this.init();
      if (this.pending.size + this.reserved.size >= this.maxPending) return null;
      // Skip blocked nonces (known on-chain, commit failed — NEVER reusable).
      while (this.blocked.has(this.next)) this.next += 1;
      const nonce = this.next;
      this.next += 1;
      this.reserved.add(nonce); // mark RESERVED
      return nonce;
    });
    // Keep the chain alive even if this reserve rejects (shouldn't, but safe).
    this._reserveChain = result.catch(() => {});
    return result;
  }

  /**
   * Tranzacția a fost transmisă cu acest nonce — trece din RESERVED în COMMITTED.
   *  hash poate fi null (submisie privată UNKNOWN — tombstone până la reap).
   *
   * FAIL-CLOSED: if this throws, the nonce is moved to `blocked` (known to be
   * used on-chain but commit could not be recorded). It can NEVER be reused.
   *
   * THROWS if:
   *   - nonce was not reserved by this manager (nonce-not-reserved)
   *   - nonce is already committed (nonce-already-committed)
   */
  commit(nonce, hash) {
    const n = Number(nonce);
    if (!this.reserved.has(n)) {
      if (this.pending.has(n)) {
        // Already committed — ensure it stays blocked (known on-chain).
        this.blocked.add(n);
        throw new Error(`nonce-already-committed: nonce ${n} is already committed`);
      }
      // Completely unknown nonce — no evidence it was used on-chain.
      // DO NOT add to blocked; just throw.
      throw new Error(`nonce-not-reserved: nonce ${n} was not reserved by this manager`);
    }
    this.reserved.delete(n);
    try {
      this.pending.set(n, { hash: hash || null, ts: Date.now() });
    } catch (e) {
      // FAIL-CLOSED: a RESERVED nonce whose commit failed must be blocked —
      // it was already handed out and may already be used on-chain. Never
      // let it become "lost" (neither reserved nor pending nor blocked).
      this.blocked.add(n);
      throw e;
    }
  }

  /**
   * Eliberează un nonce nefolosit. Reutilizează doar dacă:
   *   - nonce is RESERVED (not already committed/rolled back)
   *   - NO tx hash exists (trimiterea nu a ajuns să creeze o tranzacție)
   *   - nu există tranzacții mai noi în zbor (altfel lăsăm un gap)
   *
   * THROWS if:
   *   - nonce was not reserved (nonce-not-reserved)
   *   - nonce is already committed with a tx hash (nonce-already-committed)
   *   - nonce is already rolled back (nonce-already-rolled-back)
   */
  rollback(nonce) {
    const n = Number(nonce);
    if (!this.reserved.has(n)) {
      if (this.pending.has(n)) {
        const entry = this.pending.get(n);
        if (entry.hash) {
          throw new Error(
            `nonce-already-committed: nonce ${n} has tx hash ${entry.hash} — cannot rollback`
          );
        }
        // Committed without hash (tombstone) — treat as committed, no rollback
        throw new Error(`nonce-already-committed: nonce ${n} is already committed (tombstone)`);
      }
      throw new Error(`nonce-not-reserved: nonce ${n} was not reserved by this manager`);
    }
    this.reserved.delete(n);
    // Reuse only if this is the most recent nonce and nothing newer is pending.
    if (this.pending.size === 0 && this.next === n + 1) {
      this.next = n;
    }
  }

  /**
   * Validează că managerul este asociat cu wallet-ul dat.
   * THROWS if wallet address mismatch.
   */
  validateWallet(wallet) {
    const addr = wallet.address || wallet;
    if (this.walletAddress !== String(addr).toLowerCase()) {
      throw new Error(
        `wallet-mismatch: NonceManager belongs to ${this.walletAddress}, ` +
        `but execution wallet is ${String(addr).toLowerCase()}`
      );
    }
  }

/**
   * Validates and normalizes a nonce value returned by the chain.
   * Rejects undefined, null, NaN, ±Infinity, negative, fractional, and any
   * value that is NOT a Number.isSafeInteger(). Never coerces silently.
   * @param {string|number|bigint} value — chain pending nonce
   * @returns {number} the validated nonce
   * @throws {Error} "invalid-chain-pending-nonce: ..." on any invalid value
   */
  _validateNonce(value) {
    if (value === undefined || value === null) {
      throw new Error("invalid-chain-pending-nonce: value is undefined or null");
    }
    if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") {
      throw new Error(`invalid-chain-pending-nonce: unexpected type ${typeof value}`);
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new Error(`invalid-chain-pending-nonce: not finite (${String(value)})`);
    }
    if (!Number.isInteger(n)) {
      throw new Error(`invalid-chain-pending-nonce: non-integer (${String(value)})`);
    }
    if (n < 0) {
      throw new Error(`invalid-chain-pending-nonce: negative (${String(value)})`);
    }
    if (!Number.isSafeInteger(n)) {
      throw new Error(`invalid-chain-pending-nonce: not a safe integer (${String(value)})`);
    }
    return n;
  }

  /**
   * Reconciliază nonce-ul local cu nonce-ul "pending" on-chain.
   *
   * FAIL-CLOSED + MONOTONIC:
   *   - serializat cu reserve() prin ACEEAȘI mutex `_reserveChain`;
   *   - next NON-REGRESEZĂ: newNext = max(currentNext, chainPendingNonce);
   *   - dacă next === null (restart/manager proaspăt), next = chainPendingNonce;
   *   - reserved/pending/blocked NICIODATĂ nu sunt modificate sau șterse;
   *   - reconcile() NU apelează niciodată rollback();
   *   - RPC failure sau nonce invalid → stato local NESCHIMBAT, eroarea se propagă.
   *
   * Prin default nonce-ul este citit cu this.wallet.getNonce("pending").
   * Pentru testare se poate injecta opts.getPendingNonce — state machine-ul
   * rămâNE cel real.
   *
   * @param {object} opts
   *   - {string|object} [wallet]         dacă este dat, identitatea e validată (case-insensitive)
   *   - {function} [getPendingNonce]     async () => nonce  (dependency injection de test)
   * @returns {Promise<number>} next-ul reconcilat
   * @throws {Error} "wallet-mismatch" | "invalid-chain-pending-nonce" | eroare RPC
   */
  async reconcile(opts = {}) {
    if (opts.wallet) this.validateWallet(opts.wallet);

    const fetchPending = opts.getPendingNonce || (() => this.wallet.getNonce("pending"));

    // Encodează întreaga operație pe același lanț de promise ca reserve():
    // reserve() și reconcile() nu pot citi/modifica `next` concurent.
    const result = this._reserveChain.then(async () => {
      const raw = await fetchPending();
      const chainPending = this._validateNonce(raw);
      if (this.next === null) {
        this.next = chainPending;
      } else {
        this.next = Math.max(this.next, chainPending);
      }
      this.lastSync = Date.now();
      return this.next;
    });
    this._reserveChain = result.catch(() => {});
    return result;
  }
  /**
   * Reap: verifică pending-urile; cele confirmate sau dispărute se șterg.
   * Se apelează la fiecare ciclu de scan.
   * @returns {Promise<number>} numărul de tx-uri în continuare pending
   */
  async reap(provider) {
    for (const [nonce, entry] of [...this.pending.entries()]) {
      const hash = entry && typeof entry === "object" ? entry.hash : entry;
      const ts = entry && typeof entry === "object" ? entry.ts : 0;
      if (hash === null || hash === undefined) {
        // tombstone: submisie privată UNKNOWN — slot rămâne blocat 90s ca să
        // nu reutilizăm nonce-ul în timp ce tx-ul poate încă fi inclus.
        if (Date.now() - ts > 90000) this.pending.delete(nonce);
        continue;
      }
      try {
        const receipt = await provider.getTransactionReceipt(hash);
        if (receipt) {
          this.pending.delete(nonce);
          continue;
        }
        const tx = await provider.getTransaction(hash);
        if (!tx) {
          // nu mai există în mempool → dispărută; eliberăm
          this.pending.delete(nonce);
        }
      } catch (_) {
        /* RPC error — reîncercăm la următorul reap */
      }
    }
    // resync periodic ca să ne protejăm de gaps persistente
    if (this.pending.size === 0 || Date.now() - this.lastSync > 60000) {
      try {
        const onchain = await this.wallet.getNonce("pending");
        if (this.pending.size === 0 || onchain !== this.next) {
          if (onchain >= this.next || this.pending.size === 0) this.next = onchain;
          this.lastSync = Date.now();
        }
      } catch (_) { /* ignore */ }
    }
    return this.pending.size;
  }
}

module.exports = { NonceManager };

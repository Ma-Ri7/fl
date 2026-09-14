// FLASH — NonceManager (audit item 7, PHASE 11).
// Rezervă nonce-uri tranzacțiilor în zbor, împiedică double-submit cu același
// nonce și reapr nonce-urile blocate (tx never mind / dropped).
// TASK 4.9-D (LOW-2): import sigur — tx-tracker.js nu are niciun require,
// deci nu există risc de dependență circulară.
const { TransactionTracker } = require("./tx-tracker");

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
   * TASK 4.9-B (LOW-2) — Valid receipt identity check for reap().
   *
   * A nonce slot is considered consumed on-chain ONLY when the receipt returned
   * by the provider provably belongs to the tracked transaction:
   *   - receipt is a non-null object;
   *   - receipt.transactionHash is present AND equals the expected hash
   *     (case-insensitive, hex string);
   *   - receipt.status is exactly 1 (success) or 0 (revert) — BOTH consume the
   *     nonce on-chain, so both allow slot release;
   *   - receipt.blockNumber and receipt.blockHash are present (receipt shape,
   *     mirroring TransactionTracker._isValidReceipt from 4.7).
   *
   * Anything else — null, RPC error handled by caller, malformed object, a
   * receipt WITHOUT transactionHash, a receipt for a DIFFERENT hash — is NOT
   * proof of consumption and the slot MUST remain protected.
   *
   * @param {object|null} receipt
   * @param {string} expectedHash — the tracked transaction hash
   * @returns {boolean}
   */
  _isConsumedReceipt(receipt, expectedHash) {
    if (receipt === null || receipt === undefined || typeof receipt !== "object") return false;
    const rh = receipt.transactionHash;
    if (typeof rh !== "string" || rh.trim() === "") return false;
    if (rh.toLowerCase() !== String(expectedHash).toLowerCase()) return false;
    if (receipt.status !== 1 && receipt.status !== 0) return false;
    if (receipt.blockNumber == null || receipt.blockHash == null) return false;
    return true;
  }

  /**
   * Eliberează EXPLICIT un slot COMMITTED (pending) declarat DROPPED cu dovadă.
   *
   * TASK 4.9-B (LOW-1): de la această versiune, DROPPED evidence brută
   * (reason/source/nonce/chainId/detectedAt) NU este o dovadă suficientă —
   * este doar metadata caller-supplied. O eliberare se autorizează DOAR prin
   * proof care referențiază un transaction lifecycle REAL deja urmărit:
   *
   *   proof = { tracker, recordId }
   *
   * unde `tracker` este o instanță TransactionTracker care expune `get(id)` și
   * `recordId` identifică record-ul. Managerul cere CAZUL-DE-USE la tracker:
   *   - record există (tracker.get(recordId) != null);
   *   - record.state === "DROPPED" (marcat explicit prin markDropped 4.8);
   *   - record.nonce === nonce solicitat;
   *   - record.droppedEvidence există și este legat de BSC chainId === 56
   *     (precum și reason/source/detectedAt non-empty/finit);
   *   - record.txHash este fie null (tombstone 4.5-D), fie un hash hex valid —
   *     identitatea tranzacției este coerentă.
   *
   * Atomic: TOATE validările au loc ÎNAINTE de orice mutare. Dacă orice
   * verificare eșuează, pending/next/blocked rămân intacte (nicio eliberare
   * parțială). Reutilizarea se permite doar dacă slotul este cel mai recent
   * (fără gap): `this.pending.size === 0 && this.next === n + 1`.
   *
   * THROWS if:
   *   - nonce is not a pending COMMITTED slot (release-not-pending)
   *   - proof missing/malformed (release-invalid-proof)
   *   - proof.tracker is NOT a real TransactionTracker instance
   *     (release-invalid-tracker — TASK 4.9-D LOW-2)
   *   - tracker record not found (release-tracker-record-missing)
   *   - tracker record state != DROPPED (release-tracker-not-dropped)
   *   - record nonce != slot nonce (release-nonce-mismatch)
   *   - slot hash != record txHash when the slot is non-tombstone (LOW-1 +
   *     N9E-B1): a live slot committed with hash H requires a DROPPED record
   *     whose txHash is non-null AND equal to H (case-insensitive).
   *     H vs H2 => release-txhash-mismatch; H vs null/missing/empty =>
   *     release-missing-txhash. Tombstone slots (hash null) keep the 4.9-B
   *     allowance.
   *   - droppedEvidence missing/malformed (release-invalid-evidence)
   *   - droppedEvidence chainId != BSC 56 (release-chain-mismatch)
   *   - record txHash malformed (release-invalid-identity)
   *   - wallet identity mismatch (wallet-mismatch)
   */
  releaseDropped(nonce, proof, wallet) {
    if (wallet) this.validateWallet(wallet);
    const n = Number(nonce);
    const entry = this.pending.get(n);
    if (entry === undefined) {
      throw new Error(`release-not-pending: nonce ${String(nonce)} is not a pending slot`);
    }
    // ---- 1. Proof must reference a REAL tracked lifecycle (LOW-1) -----------
    if (proof === null || proof === undefined || typeof proof !== "object") {
      throw new Error("release-invalid-proof: proof must be an object { tracker, recordId }");
    }
    const tracker = proof.tracker;
    // TASK 4.9-D (LOW-2, N9C-L2): proof.tracker must be a REAL
    // TransactionTracker instance. Duck-typed objects that merely expose a
    // compatible get() are rejected BEFORE any record resolution and BEFORE
    // any nonce mutation (fail-closed).
    if (!(tracker instanceof TransactionTracker)) {
      throw new Error("release-invalid-tracker: proof.tracker must be a real TransactionTracker instance");
    }
    if (typeof proof.recordId !== "string" || proof.recordId.trim() === "") {
      throw new Error("release-invalid-proof: proof.recordId required (non-empty string)");
    }
    let record;
    try {
      record = tracker.get(proof.recordId);
    } catch (_) {
      record = null;
    }
    if (record === null || record === undefined || typeof record !== "object") {
      throw new Error("release-tracker-record-missing: tracker record not found");
    }
    // ---- 2. Lifecycle state MUST be DROPPED --------------------------------
    if (record.state !== "DROPPED") {
      throw new Error(`release-tracker-not-dropped: tracker state ${String(record.state)} != DROPPED`);
    }
    // ---- 3. Nonce binding ---------------------------------------------------
    if (Number(record.nonce) !== n) {
      throw new Error(`release-nonce-mismatch: record nonce ${String(record.nonce)} != slot nonce ${n}`);
    }
    // ---- 4. Transaction identity coherence ---------------------------------
    if (record.txHash !== null && record.txHash !== undefined) {
      if (typeof record.txHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(record.txHash)) {
        throw new Error("release-invalid-identity: record txHash malformed (not a valid 64-hex hash)");
      }
    }
    // ---- 4b. Slot hash ↔ record txHash coherence (TASK 4.9-D LOW-1 +
    // TASK 4.9-F N9E-B1) ------------------------------------------------------
    // Un slot live (hash non-null) poate fi eliberat DOAR de un record DROPPED
    // al ACELEIAȘI tranzacții: record.txHash trebuie să fie non-null ȘI egal
    // cu slot hash (case-insensitive). Un record DROPPED hashless (tombstone,
    // txHash null/missing) NU poate elibera un slot committed cu hash H —
    // altfel nonce-ul live ar putea fi reutilizat în timp ce tranzacția H
    // rămâne executabilă (same-nonce collision, N9E-B1).
    // Tombstone: slotul cu hash null păstrează semantica 4.9-B — coerența nu
    // se aplică, indiferent de txHash-ul record-ului (null sau non-null).
    const slotHash = entry && typeof entry === "object" ? entry.hash : entry;
    if (slotHash !== null && slotHash !== undefined) {
      if (record.txHash === null || record.txHash === undefined) {
        throw new Error(
          `release-missing-txhash: slot nonce ${n} committed with hash ${slotHash} requires a DROPPED record with matching txHash (got null/missing)`
        );
      }
      if (String(slotHash).toLowerCase() !== String(record.txHash).toLowerCase()) {
        throw new Error(
          `release-txhash-mismatch: slot hash ${slotHash} != dropped record txHash ${record.txHash} (same nonce, different transaction)`
        );
      }
    }
    // ---- 5. Dropped evidence (stored by markDropped 4.8) --------------------
    const ev = record.droppedEvidence;
    if (ev === null || ev === undefined || typeof ev !== "object") {
      throw new Error("release-invalid-evidence: droppedEvidence missing on tracker record");
    }
    let cid;
    try {
      cid = typeof ev.chainId === "bigint" ? ev.chainId : BigInt(ev.chainId);
    } catch (_) {
      cid = null;
    }
    if (cid !== 56n) {
      throw new Error(`release-chain-mismatch: evidence chainId ${String(ev.chainId)} != BSC 56`);
    }
    if (typeof ev.reason !== "string" || ev.reason.trim() === "") {
      throw new Error("release-invalid-evidence: evidence reason required (non-empty string)");
    }
    if (typeof ev.source !== "string" || ev.source.trim() === "") {
      throw new Error("release-invalid-evidence: evidence source required (non-empty string)");
    }
    if (typeof ev.detectedAt !== "number" || !Number.isFinite(ev.detectedAt)) {
      throw new Error("release-invalid-evidence: evidence detectedAt required (finite timestamp)");
    }
    // ---- 6. Atomic release: toate validările au trecut ----------------------
    // Rewind de next DOAR dacă slotul este cel mai recent (fără gap); altfel
    // next rămâne protejat (eliberarea unui non-mid slot nu deschide un gap).
    this.pending.delete(n);
    if (this.pending.size === 0 && this.next === n + 1) {
      this.next = n;
    }
    return n;
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
    // TASK 4.9 (LOW-6): fail-closed reap.
    //
    // RELEASE RULE: un slot COMMITTED (pending) se eliberează EXCLUSIV pe baza
    // unei dovezi defensive: receipt existent (mined/reverted → nonce consumat)
    // SAU releaseDropped() explicit (dovadă tracker 4.8 consumată de owner).
    //
    // UNCERTAINTY RULE: receipt == null, indiferent de vizibilitatea la
    // getTransaction() (null / existent / eroare RPC), NU eliberează slotul.
    // Absența dintr-un singur RPC nu este dovadă că tranzacția a dispărut
    // definitiv (relay privat invizibil, mempool inconsistent, RPC decalat).
    // Eliberarea unui astfel de slot se face EXCLUSIV prin releaseDropped()
    // explicit. reap() NU apelează niciodată releaseDropped() automat.
    for (const [nonce, entry] of [...this.pending.entries()]) {
      const hash = entry && typeof entry === "object" ? entry.hash : entry;
      if (hash === null || hash === undefined) {
        // Tombstone: submisie privată UNKNOWN/ambiguă (TASK 4.5-D). Tranzacția
        // POATE fi acceptată de relay dar invizibilă pentru RPC-ul public —
        // timpul NU este dovadă de drop. Slotul se eliberează EXCLUSIV prin
        // dovezi on-chain (reconcile / resync de mai jos), niciodată după vârstă.
        continue;
      }
      try {
        const receipt = await provider.getTransactionReceipt(hash);
        // TASK 4.9-B (LOW-2): consumul nonce-ului se confirmă DOAR dacă
        // receipt-ul aparține hash-ului urmărit (identitate verificată) și are
        // o formă validă de receipt (status 0/1, blockNumber, blockHash).
        //   - un receipt truthy fără transactionHash sau cu hash străin NU
        //     dovedește consumarea tranzacției urmărite → slot PĂSTRAT;
        //   - status 0 (revert) consumă la fel nonce-ul → slot șters.
        // Semantica sincronizată cu TransactionTracker._isValidReceipt din 4.7:
        //   VALID RECEIPT FOR EXPECTED TX  => nonce consumed
        //   INVALID / FOREIGN / MALFORMED  => nonce remains protected
        if (receipt && this._isConsumedReceipt(receipt, hash)) {
          this.pending.delete(nonce);
          continue;
        }
        // TASK 4.9 (LOW-6): receipt == null → PĂSTREAZĂ slotul. NU mai apelăm
        // getTransaction() ca dovadă de drop: simpla absență dintr-un RPC nu
        // este dovadă defensibilă (relay privat / mempool inconsistent / receipt
        // întârziat). Notăm observația pe entry (lastSeenMissing) pentru
        // observabilitate, fără a modifica ownership-ul nonce-ului.
        // TASK 4.9-B (LOW-2): valabil și pentru receipt străin/malformed —
        // observația se notează, slotul rămâne protejat.
        if (entry && typeof entry === "object") {
          entry.lastSeenMissing = Date.now();
        }
      } catch (_) {
        /* RPC error — reîncercăm la următorul reap */
      }
    }
    // resync periodic ca să ne protejăm de gaps persistente.
    // TASK 4.9 (LOW-6): STRICT MONOTONIC — next NU regresează niciodată.
    // Un citire on-chain învechită (ex. RPC decalat) nu poate reînvia un nonce
    // deja alocat; protecția împotriva reutilizării are prioritate față de
    // curățarea agresivă a gap-urilor.
    if (this.pending.size === 0 || Date.now() - this.lastSync > 60000) {
      try {
        const onchain = await this.wallet.getNonce("pending");
        if (this.next === null) {
          this.next = onchain;
        } else {
          this.next = Math.max(this.next, onchain);
        }
        this.lastSync = Date.now();
      } catch (_) { /* ignore */ }
    }
    return this.pending.size;
  }
}

module.exports = { NonceManager };

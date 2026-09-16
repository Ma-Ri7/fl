// FLASH — TASK 4.10-B: Durable nonce/transaction journal.
//
// Remediază H1 (audit adversarial 4.10-A): reutilizarea deterministă a unui
// nonce după crash/restart când tranzacția outstanding nu este vizibilă prin
// RPC-ul folosit la pornire (în special submisiile private prin relay).
//
// INVARIANT CENTRAL:
//   Odată ce nonce-ul N a fost alocat unei tranzacții, un restart NU are voie
//   să-l facă reutilizabil decât dacă există dovezi durabile că tranzacția
//   anterioară este terminală (receipt valid sau DROPPED cu dovezi 4.8/4.9).
//
// Reguli cheie:
//   - WRITE-BEFORE-RISK: rezervarea este scrisă pe disc ÎNAINTE ca nonce-ul să
//     fie returnat de NonceManager.reserve();
//   - scrieri atomice: fișier temporar → fsync → rename → fsync(dir, best-effort);
//   - corupție/ambiguitate => FAIL CLOSED (JournalError), niciodată „jurnal gol”;
//   - absența prin RPC NU este dovadă de drop — UNKNOWN rămâne blocant;
//   - submisia privată invizibilă pe RPC rămâne blocantă după restart;
//   - nu se stochează chei private, seed phrases sau orice material secret.

"use strict";

const fs = require("fs");
const path = require("path");

const JOURNAL_VERSION = 1;

// Ciclul de viață al unui record. Terminale = nonce-ul nu mai este deținut.
const STATES = [
  "RESERVED",           // nonce alocat, durabil scris, înainte de orice submisie
  "APPROVED",           // identitate 4.6-D aprobată (fingerprint), fără submisie
  "SUBMITTED_PUBLIC",   // broadcast public acceptat (txHash cunoscut)
  "SUBMITTED_PRIVATE",  // submisie privată acceptată (txHash cunoscut)
  "UNKNOWN",            // submisie ambiguă (tombstone 4.5-D / invizibilă la restart)
  "CONFIRMED_SUCCESS",  // receipt valid, status 1 (4.7)  — TERMINAL
  "CONFIRMED_REVERT",   // receipt valid, status 0 (4.7)  — TERMINAL
  "DROPPED",            // eliberat cu dovezi 4.8/4.9      — TERMINAL
  "ROLLED_BACK",        // rollback înainte de orice submisie acceptată (semantica
                        //   4.5-A) — TERMINAL; după restart nonce-ul revine sub
                        //   guvernanța RPC (comportamentul pre-jurnal).
];

const TERMINAL_STATES = new Set([
  "CONFIRMED_SUCCESS", "CONFIRMED_REVERT", "DROPPED", "ROLLED_BACK",
]);

// Stări care BLOCHEAZĂ nonce-ul după restart (fără dovezi terminale).
const OUTSTANDING_STATES = new Set([
  "RESERVED", "APPROVED", "SUBMITTED_PUBLIC", "SUBMITTED_PRIVATE", "UNKNOWN",
]);

// Tranziții permise (fail-closed: orice altceva aruncă eroare).
// - SUBMITTED_* → UNKNOWN doar la reconcilierea de la pornire (observabilitate;
//   ambele stări blochează identic, nu există regresie spre „eliberat”).
// - CONFIRMED_* și DROPPED sunt ireversibile. Nu există UNKNOWN → CONFIRMED_*
//   fără receipt valid (validat în terminal()).
const ALLOWED = {
  RESERVED: new Set(["APPROVED", "SUBMITTED_PUBLIC", "SUBMITTED_PRIVATE", "UNKNOWN", "ROLLED_BACK"]),
  APPROVED: new Set(["SUBMITTED_PUBLIC", "SUBMITTED_PRIVATE", "UNKNOWN", "ROLLED_BACK"]),
  SUBMITTED_PUBLIC: new Set(["UNKNOWN", "CONFIRMED_SUCCESS", "CONFIRMED_REVERT", "DROPPED"]),
  SUBMITTED_PRIVATE: new Set(["UNKNOWN", "CONFIRMED_SUCCESS", "CONFIRMED_REVERT", "DROPPED"]),
  UNKNOWN: new Set(["CONFIRMED_SUCCESS", "CONFIRMED_REVERT", "DROPPED"]),
  CONFIRMED_SUCCESS: new Set([]),
  CONFIRMED_REVERT: new Set([]),
  DROPPED: new Set([]),
  ROLLED_BACK: new Set([]),
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0[xX][0-9a-fA-F]{64}$/;
const CHANNELS = new Set([null, "public", "private"]);
// TASK 4.10-D: singurul format de ID emis de jurnal. Doar sufixele numerice
// ale acestui format sunt relevante pentru restaurarea contorului `_seq`.
const ID_RE = /^nj-(\d+)$/;

class JournalError extends Error {
  constructor(code, message) {
    super(`journal-${code}: ${message}`);
    this.name = "JournalError";
    this.code = code;
  }
}

class NonceJournal {
  /**
   * @param {object} opts
   *   - {string} path — calea fișierului jurnal. Default:
   *     $NONCE_JOURNAL_PATH sau <repo>/logs/nonce-journal.json (directorul
   *     logs/ este runtime, gitignorat; NU o cale user-specifică hard-codată).
   */
  constructor(opts = {}) {
    this.path = opts.path
      || process.env.NONCE_JOURNAL_PATH
      || path.join(__dirname, "..", "logs", "nonce-journal.json");
    this.wallet = null;      // lowercase address (setat prin bindWallet)
    this.chainId = 56;
    this.records = [];       // ordinea de inserare este păstrată
    this._byNonce = new Map();
    this._ids = new Set();   // TASK 4.10-D: gardă de unicitate pentru ID-uri
    this._loaded = false;
    this._seq = 0;
  }

  /**
   * Leagă jurnalul la un wallet + lanț și încarcă fișierul (fail-closed).
   * Orice corupție/ambiguitate aruncă JournalError — jurnalul NU este niciodată
   * tratat tacit ca „gol”.
   */
  bindWallet(walletAddress, chainId) {
    if (typeof walletAddress !== "string" || !ADDRESS_RE.test(walletAddress)) {
      throw new JournalError("invalid-wallet", `wallet address malformed (${String(walletAddress)})`);
    }
    if (chainId !== 56) {
      throw new JournalError("invalid-chain", `journal requires chainId 56 (got ${String(chainId)})`);
    }
    this.wallet = walletAddress.toLowerCase();
    this.chainId = chainId;
    if (!this._loaded) this.load();
    return this;
  }

  /** Încarcă + validează fișierul. Missing file => jurnal gol valid. */
  load() {
    this.records = [];
    this._byNonce = new Map();
    this._ids = new Set();
    let raw = null;
    try {
      raw = fs.readFileSync(this.path, "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") {
        // Fișierul nu există — nu a fost încă creat niciun jurnal (valid).
        this._loaded = true;
        return this;
      }
      throw new JournalError("unreadable", `cannot read journal (${e.message.slice(0, 120)})`);
    }
    let doc = null;
    try {
      doc = JSON.parse(raw);
    } catch (_) {
      // Malformed / truncated JSON — FAIL CLOSED, niciodată „gol”.
      throw new JournalError("malformed", "journal file is not valid JSON (corrupted or truncated)");
    }
    this._validateDocument(doc);
    const seenIds = new Set();
    for (const rec of doc.records) {
      this._validateRecord(rec);
      // TASK 4.10-B §15: orice nonce duplicat din fișier este corupție/
      // ambiguitate => FAIL CLOSED (nu se alege arbitrar un record).
      if (this._byNonce.has(rec.nonce)) {
        throw new JournalError("duplicate-nonce", `journal contains multiple records for nonce ${rec.nonce} (fail-closed)`);
      }
      if (seenIds.has(rec.id)) {
        throw new JournalError("duplicate-id", `journal contains duplicate record id ${rec.id}`);
      }
      seenIds.add(rec.id);
      this.records.push(rec);
      this._byNonce.set(rec.nonce, rec);
      this._ids.add(rec.id);
    }
    // TASK 4.10-D: contorul de ID-uri trebuie restaurat ÎNAINTE de prima
    // rezervare, altfel un jurnal reîncărcat ar genera din nou `nj-1`.
    this._restoreSeq();
    this._loaded = true;
    return this;
  }

  /**
   * TASK 4.10-D — restaurează contorul de ID-uri după load().
   *
   * MEDIUM-1 (audit 4.10-C): `_seq` nu era restaurat, deci după restart/reconnect
   * un NonceJournal proaspăt genera din nou `nj-1`, scria un ID duplicat, iar
   * următoarea pornire pica fail-closed (`duplicate-id`) — pierdere deterministă
   * de disponibilitate, cu risc operațional de ștergere a jurnalului (ce ar
   * redeschide H1).
   *
   * Restaurare MONOTONĂ: `_seq` devine cel puțin cel mai mare sufix numeric
   * existent, deci următorul ID generat (`nj-<_seq+1>`) nu poate coincide cu un
   * ID existent. Doar ID-urile proprii formatului jurnalului (`nj-<digits>`)
   * contribuie. ID-urile neconforme rămân acceptate la load (semantica 4.10-B
   * neschimbată: validarea cere doar un string non-gol) dar NU influențează
   * `_seq` — nu sunt parsate tăcut ca 0 și nu pot produce coliziuni, pentru că
   * ID-urile emise sunt mereu `nj-<digits>`.
   */
  _restoreSeq() {
    let max = 0;
    for (const rec of this.records) {
      const m = ID_RE.exec(rec.id);
      if (!m) continue;
      const v = Number(m[1]);
      if (Number.isSafeInteger(v) && v > max) max = v;
    }
    if (max > this._seq) this._seq = max;
  }

  /**
   * TASK 4.10-D (LOW-1) — alocă un ID nou, cu gardă de unicitate la creație.
   *
   * Chiar dacă `_seq` este restaurat corect, un ID generat care ar coincide cu
   * unul existent NU trebuie scris niciodată: fail-closed ÎNAINTE de orice
   * mutație a jurnalului (fără append, fără `_save()`), astfel încât fișierul
   * existent rămâne bit-identic și următoarea operație validă e posibilă.
   * `_seq` avansează înainte de verificare, deci după un reject următorul
   * apel generează un ID diferit (nu există blocaj permanent artificial).
   *
   * @returns {string} ID nou, garantat absent din `_ids`
   * @throws {JournalError} "duplicate-id" dacă ID-ul generat există deja
   */
  _nextId() {
    const id = `nj-${++this._seq}`;
    if (this._ids.has(id)) {
      throw new JournalError("duplicate-id", `generated record id ${id} already exists (fail-closed, no mutation)`);
    }
    return id;
  }

  // -- durable write (atomic) -------------------------------------------------

  /**
   * Scriere atomică: tmp file → fsync → rename → fsync(dir) best-effort.
   * Un crash în timpul scrierii lasă în urmă cel mult un fișier .tmp orfan;
   * fișierul jurnal propriu-zis rămâne întotdeauna un document complet.
   */
  _save() {
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    const doc = {
      version: JOURNAL_VERSION,
      wallet: this.wallet,
      chainId: this.chainId,
      updatedAt: Date.now(),
      records: this.records,
    };
    const payload = JSON.stringify(doc, null, 2) + "\n";
    const tmp = path.join(dir, `.${path.basename(this.path)}.tmp-${process.pid}-${++this._seq}`);
    let fd = null;
    try {
      fd = fs.openSync(tmp, "w");
      fs.writeSync(fd, payload);
      try { fs.fsyncSync(fd); } catch (_) { /* best-effort */ }
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    }
    fs.renameSync(tmp, this.path);
    try {
      const dfd = fs.openSync(dir, "r");
      try { fs.fsyncSync(dfd); } catch (_) { /* best-effort */ }
      fs.closeSync(dfd);
    } catch (_) { /* best-effort (platform-dependent) */ }
  }

  _clone(rec) {
    return JSON.parse(JSON.stringify(rec));
  }

  // -- lifecycle API (apelate din NonceManager) --------------------------------

  /**
   * Rezervare durabilă (WRITE-BEFORE-RISK). Superscrie un record ROLLED_BACK
   * sau DROPPED (formal sigur: rolled-back = nicio submisie acceptată conform
   * semanticii 4.5-A; DROPPED = eliberat cu dovezi 4.8/4.9). Orice alt record
   * existent pe același nonce => eroare (fail-closed, double-reserve).
   */
  reserve(nonce) {
    const n = this._validateNonceArg(nonce);
    const existing = this._byNonce.get(n);
    const now = Date.now();
    if (existing) {
      if (existing.state === "ROLLED_BACK" || existing.state === "DROPPED") {
        existing.state = "RESERVED";
        existing.txHash = null;
        existing.fingerprint = null;
        existing.channel = null;
        existing.receipt = null;
        existing.droppedEvidence = null;
        existing.unknownReason = null;
        existing.updatedAt = now;
        existing.reservations = (existing.reservations || 1) + 1;
        this._save();
        return this._clone(existing);
      }
      throw new JournalError(
        "nonce-conflict",
        `nonce ${n} already has a ${existing.state} record (double reservation)`
      );
    }
    const rec = {
      id: this._nextId(),
      wallet: this.wallet,
      chainId: this.chainId,
      nonce: n,
      state: "RESERVED",
      txHash: null,
      fingerprint: null,
      channel: null,
      receipt: null,
      droppedEvidence: null,
      unknownReason: null,
      createdAt: now,
      updatedAt: now,
      reservations: 1,
    };
    this.records.push(rec);
    this._byNonce.set(n, rec);
    this._ids.add(rec.id);
    this._save();
    return this._clone(rec);
  }

  /** Identitate 4.6-D aprobată (fingerprint) — tot înainte de submisie. */
  approve(nonce, fingerprint) {
    const n = this._validateNonceArg(nonce);
    if (typeof fingerprint !== "string" || !HASH_RE.test(fingerprint)) {
      throw new JournalError("invalid-fingerprint", `fingerprint must be a 32-byte hex hash (got ${String(fingerprint)})`);
    }
    const rec = this._byNonce.get(n);
    if (!rec) throw new JournalError("record-missing", `no record for nonce ${n}`);
    this._transition(rec, "APPROVED");
    rec.fingerprint = fingerprint;
    rec.updatedAt = Date.now();
    this._save();
    return this._clone(rec);
  }

  /**
   * Submisie acceptată. hash null => UNKNOWN (tombstone 4.5-D, blocant).
   * channel: 'public' | 'private' (default 'public' pentru compatibilitate).
   */
  commit(nonce, { hash = null, channel = null } = {}) {
    const n = this._validateNonceArg(nonce);
    const target = hash === null || hash === undefined
      ? "UNKNOWN"
      : (channel === "private" ? "SUBMITTED_PRIVATE" : "SUBMITTED_PUBLIC");
    if (hash !== null && hash !== undefined) {
      if (typeof hash !== "string" || !HASH_RE.test(hash)) {
        throw new JournalError("invalid-txhash", `txHash must be a 32-byte hex hash or null (got ${String(hash)})`);
      }
    } else {
      hash = null;
    }
    const rec = this._byNonce.get(n);
    if (!rec) throw new JournalError("record-missing", `no record for nonce ${n}`);
    this._transition(rec, target);
    rec.txHash = hash;
    rec.channel = target === "UNKNOWN" ? null : (channel === "private" ? "private" : "public");
    rec.updatedAt = Date.now();
    this._save();
    return this._clone(rec);
  }

  /** Reconciliere de la pornire: submisie invizibilă/ambiguă => UNKNOWN (blocant). */
  markUnknown(nonce, reason) {
    const n = this._validateNonceArg(nonce);
    const rec = this._byNonce.get(n);
    if (!rec) throw new JournalError("record-missing", `no record for nonce ${n}`);
    this._transition(rec, "UNKNOWN");
    rec.unknownReason = typeof reason === "string" && reason.trim() !== "" ? reason : null;
    rec.updatedAt = Date.now();
    this._save();
    return this._clone(rec);
  }

  /**
   * Trecere în stare TERMINALĂ, doar cu dovezi suficiente:
   *   - CONFIRMED_SUCCESS / CONFIRMED_REVERT: receipt valid 4.7 (status 0/1,
   *     blockNumber + blockHash prezente, transactionHash === record.txHash);
   *   - DROPPED: dovezi 4.8 (chainId 56, reason/source non-empty, detectedAt).
   * Recordul trebuie să aibă txHash non-null pentru CONFIRMED_* (un tombstone
   * nu poate fi confirmat — nu există hash de verificat).
   */
  terminal(nonce, state, evidence) {
    const n = this._validateNonceArg(nonce);
    if (state !== "CONFIRMED_SUCCESS" && state !== "CONFIRMED_REVERT" && state !== "DROPPED") {
      throw new JournalError("invalid-terminal-state", `state must be CONFIRMED_SUCCESS, CONFIRMED_REVERT or DROPPED (got ${String(state)})`);
    }
    const rec = this._byNonce.get(n);
    if (!rec) throw new JournalError("record-missing", `no record for nonce ${n}`);
    // Transition legality is checked BEFORE evidence validation so that an
    // illegal terminal move (e.g. RESERVED -> CONFIRMED_*) is classified as
    // illegal-transition and no state (in-memory or durable) is touched.
    this._checkTransition(rec, state);
    // Validate the evidence FULLY BEFORE any mutation (fail-closed: o tranziție
    // terminală respinsă nu trebuie să corupă nici măcar starea in-memory).
    let dropsEv = null;
    let recpt = null;
    if (state === "DROPPED") {
      const ev = evidence;
      if (ev === null || ev === undefined || typeof ev !== "object") {
        throw new JournalError("invalid-dropped-evidence", "dropped evidence object required");
      }
      let cid = null;
      try { cid = typeof ev.chainId === "bigint" ? ev.chainId : BigInt(ev.chainId); } catch (_) { cid = null; }
      if (cid !== 56n) throw new JournalError("chain-mismatch", `dropped evidence chainId ${String(ev.chainId)} != 56`);
      if (typeof ev.reason !== "string" || ev.reason.trim() === "") {
        throw new JournalError("invalid-dropped-evidence", "evidence reason required (non-empty string)");
      }
      if (typeof ev.source !== "string" || ev.source.trim() === "") {
        throw new JournalError("invalid-dropped-evidence", "evidence source required (non-empty string)");
      }
      if (typeof ev.detectedAt !== "number" || !Number.isFinite(ev.detectedAt)) {
        throw new JournalError("invalid-dropped-evidence", "evidence detectedAt required (finite timestamp)");
      }
      dropsEv = { reason: ev.reason, source: ev.source, chainId: 56, detectedAt: ev.detectedAt };
    } else {
      const r = evidence && typeof evidence === "object" ? (evidence.receipt || evidence) : null;
      if (!r || typeof r !== "object") {
        throw new JournalError("invalid-receipt", "receipt evidence object required for CONFIRMED_*");
      }
      if (rec.txHash === null) {
        throw new JournalError("invalid-receipt", `CONFIRMED_* requires a record txHash (nonce ${n} is a tombstone)`);
      }
      if (r.status !== 1 && r.status !== 0) {
        throw new JournalError("invalid-receipt", `receipt status must be 0 or 1 (got ${String(r.status)})`);
      }
      if (r.blockNumber == null || r.blockHash == null) {
        throw new JournalError("invalid-receipt", "receipt requires blockNumber and blockHash");
      }
      if (typeof r.transactionHash !== "string" || !HASH_RE.test(r.transactionHash)) {
        throw new JournalError("invalid-receipt", "receipt transactionHash must be a 32-byte hex hash");
      }
      if (r.transactionHash.toLowerCase() !== String(rec.txHash).toLowerCase()) {
        throw new JournalError("receipt-identity", `receipt transactionHash != record txHash (${r.transactionHash} != ${rec.txHash})`);
      }
      recpt = {
        status: r.status,
        blockNumber: r.blockNumber,
        blockHash: r.blockHash,
        transactionHash: r.transactionHash,
      };
    }
    // Toate dovezile sunt valide — abia acum se mută starea.
    this._transition(rec, state);
    if (dropsEv) rec.droppedEvidence = dropsEv;
    if (recpt) rec.receipt = recpt;
    rec.updatedAt = Date.now();
    this._save();
    return this._clone(rec);
  }

  /** Rollback înainte de orice submisie acceptată (semantica 4.5-A) — TERMINAL. */
  rolledBack(nonce) {
    const n = this._validateNonceArg(nonce);
    const rec = this._byNonce.get(n);
    if (!rec) throw new JournalError("record-missing", `no record for nonce ${n}`);
    this._transition(rec, "ROLLED_BACK");
    rec.updatedAt = Date.now();
    this._save();
    return this._clone(rec);
  }

  // -- read API -----------------------------------------------------------------

  outstanding() {
    return this.records.filter((r) => OUTSTANDING_STATES.has(r.state)).map((r) => this._clone(r));
  }

  all() {
    return this.records.map((r) => this._clone(r));
  }

  get(nonce) {
    const rec = this._byNonce.get(Number(nonce));
    return rec ? this._clone(rec) : null;
  }

  isOutstanding(rec) {
    return !!(rec && OUTSTANDING_STATES.has(rec.state));
  }

  isTerminalState(state) {
    return TERMINAL_STATES.has(state);
  }

  stats() {
    let outstanding = 0;
    let terminal = 0;
    for (const r of this.records) {
      if (OUTSTANDING_STATES.has(r.state)) outstanding += 1;
      else terminal += 1;
    }
    return { path: this.path, total: this.records.length, outstanding, terminal, wallet: this.wallet, chainId: this.chainId };
  }

  // -- validation helpers -------------------------------------------------------

  _validateDocument(doc) {
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      throw new JournalError("malformed", "journal root must be an object");
    }
    for (const k of Object.keys(doc)) {
      if (!["version", "wallet", "chainId", "updatedAt", "records"].includes(k)) {
        throw new JournalError("unknown-field", `unexpected journal field "${k}"`);
      }
    }
    if (doc.version !== JOURNAL_VERSION) {
      throw new JournalError("version", `journal version ${String(doc.version)} != supported ${JOURNAL_VERSION} (fail-closed)`);
    }
    if (typeof doc.wallet !== "string" || !ADDRESS_RE.test(doc.wallet)) {
      throw new JournalError("wallet", `journal wallet malformed (${String(doc.wallet)})`);
    }
    if (this.wallet && doc.wallet.toLowerCase() !== this.wallet) {
      throw new JournalError("wallet-mismatch", `journal wallet ${doc.wallet} != bound wallet ${this.wallet} (fail-closed)`);
    }
    if (doc.chainId !== 56) {
      throw new JournalError("chain-mismatch", `journal chainId ${String(doc.chainId)} != 56 (fail-closed)`);
    }
    if (!Array.isArray(doc.records)) {
      throw new JournalError("malformed", "journal records must be an array");
    }
    if (doc.updatedAt !== undefined && (typeof doc.updatedAt !== "number" || !Number.isFinite(doc.updatedAt))) {
      throw new JournalError("malformed", "journal updatedAt must be a finite number");
    }
  }

  _validateRecord(rec) {
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
      throw new JournalError("malformed", "record must be an object");
    }
    const required = ["id", "wallet", "chainId", "nonce", "state", "txHash", "fingerprint",
      "channel", "receipt", "droppedEvidence", "unknownReason", "createdAt", "updatedAt"];
    for (const k of required) {
      if (!Object.prototype.hasOwnProperty.call(rec, k)) {
        throw new JournalError("missing-field", `record missing required field "${k}"`);
      }
    }
    for (const k of Object.keys(rec)) {
      if (!required.includes(k) && k !== "reservations") {
        throw new JournalError("unknown-field", `unexpected record field "${k}"`);
      }
    }
    if (typeof rec.id !== "string" || rec.id.trim() === "") {
      throw new JournalError("malformed", "record id must be a non-empty string");
    }
    if (typeof rec.wallet !== "string" || !ADDRESS_RE.test(rec.wallet)) {
      throw new JournalError("wallet", "record wallet malformed");
    }
    if (this.wallet && rec.wallet.toLowerCase() !== this.wallet) {
      throw new JournalError("wallet-mismatch", `record wallet ${rec.wallet} != bound wallet ${this.wallet}`);
    }
    if (rec.chainId !== 56) {
      throw new JournalError("chain-mismatch", `record chainId ${String(rec.chainId)} != 56`);
    }
    if (!Number.isSafeInteger(rec.nonce) || rec.nonce < 0) {
      throw new JournalError("invalid-nonce", `record nonce invalid (${String(rec.nonce)})`);
    }
    if (!STATES.includes(rec.state)) {
      throw new JournalError("invalid-state", `record state invalid (${String(rec.state)})`);
    }
    if (rec.txHash !== null && (typeof rec.txHash !== "string" || !HASH_RE.test(rec.txHash))) {
      throw new JournalError("invalid-txhash", `record txHash invalid (${String(rec.txHash)})`);
    }
    if (rec.fingerprint !== null && (typeof rec.fingerprint !== "string" || !HASH_RE.test(rec.fingerprint))) {
      throw new JournalError("invalid-fingerprint", `record fingerprint invalid (${String(rec.fingerprint)})`);
    }
    if (!CHANNELS.has(rec.channel)) {
      throw new JournalError("invalid-channel", `record channel invalid (${String(rec.channel)})`);
    }
    if (typeof rec.createdAt !== "number" || !Number.isFinite(rec.createdAt) || rec.createdAt <= 0) {
      throw new JournalError("malformed", "record createdAt must be a finite positive number");
    }
    if (typeof rec.updatedAt !== "number" || !Number.isFinite(rec.updatedAt) || rec.updatedAt <= 0) {
      throw new JournalError("malformed", "record updatedAt must be a finite positive number");
    }
    this._validateReceiptEvidence(rec);
    this._validateDroppedEvidence(rec);
  }

  _validateReceiptEvidence(rec) {
    const r = rec.receipt;
    if (rec.state === "CONFIRMED_SUCCESS" || rec.state === "CONFIRMED_REVERT") {
      if (r === null || typeof r !== "object") {
        throw new JournalError("invalid-receipt", `${rec.state} record requires stored receipt evidence`);
      }
      if (rec.txHash === null) {
        throw new JournalError("invalid-receipt", `${rec.state} record requires a non-null txHash`);
      }
      if ((r.status !== 1 && r.status !== 0) || r.blockNumber == null || r.blockHash == null
        || typeof r.transactionHash !== "string" || !HASH_RE.test(r.transactionHash)
        || r.transactionHash.toLowerCase() !== String(rec.txHash).toLowerCase()) {
        throw new JournalError("receipt-identity", `${rec.state} record has inconsistent receipt evidence`);
      }
    } else if (r !== null && r !== undefined && typeof r !== "object") {
      throw new JournalError("malformed", "record receipt must be null or an object");
    }
  }

  _validateDroppedEvidence(rec) {
    const ev = rec.droppedEvidence;
    if (rec.state === "DROPPED") {
      if (ev === null || typeof ev !== "object") {
        throw new JournalError("invalid-dropped-evidence", "DROPPED record requires droppedEvidence");
      }
      if (ev.chainId !== 56 || typeof ev.reason !== "string" || ev.reason.trim() === ""
        || typeof ev.source !== "string" || ev.source.trim() === ""
        || typeof ev.detectedAt !== "number" || !Number.isFinite(ev.detectedAt)) {
        throw new JournalError("invalid-dropped-evidence", "DROPPED evidence incomplete");
      }
    } else if (ev !== null && ev !== undefined && typeof ev !== "object") {
      throw new JournalError("malformed", "record droppedEvidence must be null or an object");
    }
  }

  _transition(rec, to) {
    this._checkTransition(rec, to);
    rec.state = to;
  }

  /** Validate (without mutating) that rec.state -> to is legal. */
  _checkTransition(rec, to) {
    if (TERMINAL_STATES.has(rec.state)) {
      throw new JournalError("terminal", `nonce ${rec.nonce} is ${rec.state} (terminal) — no further transitions`);
    }
    if (!STATES.includes(to)) {
      throw new JournalError("invalid-state", `unknown target state ${String(to)}`);
    }
    if (!ALLOWED[rec.state].has(to)) {
      throw new JournalError("illegal-transition", `illegal transition ${rec.state} -> ${to} (fail-closed)`);
    }
  }

  _validateNonceArg(nonce) {
    const n = Number(nonce);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new JournalError("invalid-nonce", `nonce must be a safe non-negative integer (got ${String(nonce)})`);
    }
    return n;
  }
}

module.exports = {
  NonceJournal,
  JournalError,
  JOURNAL_VERSION,
  JOURNAL_STATES: STATES,
  JOURNAL_TERMINAL_STATES: TERMINAL_STATES,
  JOURNAL_OUTSTANDING_STATES: OUTSTANDING_STATES,
};







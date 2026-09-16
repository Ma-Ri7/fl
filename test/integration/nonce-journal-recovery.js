// TASK 4.10-B — Durable nonce/transaction journal: restart / crash recovery.
//
// Închide H1 (audit adversarial 4.10-A): reutilizarea deterministă a unui nonce
// după crash/restart când tranzacția outstanding nu este vizibilă prin RPC-ul
// folosit la pornire (în special submisii private prin relay).
//
// Proprietăți dovedite (R1–R8 din task):
//   R1: un nonce alocat supraviețuiește restart-ului ca rezervare;
//   R2: absența prin RPC nu eliberează o rezervare durabilă;
//   R3: submisia privată rămâne blocantă după restart (UNKNOWN, nu DROPPED);
//   R4: jurnal corupt/ambiguu => fail-closed;
//   R5: un receipt greșit nu eliberează rezervarea durabilă;
//   R6: nonce duplicat nerezolvat => fail-closed;
//   R7: scrieri atomice — un crash nu transformă o rezervare în „jurnal gol”;
//   R8+: garanțiile 4.6-D / 4.7 / 4.8 / 4.9 rămân intacte.
//
// Toate testele folosesc fișiere temporare REALE (persistență reală) și
// provideri mock — fără RPC live, fără tranzacții reale.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { NonceManager } = require("../../bot/nonce");
const { NonceJournal, JournalError } = require("../../bot/nonce-journal");
const { TransactionTracker } = require("../../bot/tx-tracker");

const WALLET = "0x70997970C51812dc3A010C7d01b50b0429c0d3c8";
const H = "0x" + "ab".repeat(32);
const H2 = "0x" + "cd".repeat(32);
const FP = "0x" + "ef".repeat(32);
const BLOCK_HASH = "0x" + "be".repeat(32);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "njr-"));
}
function mkJournal(p) {
  const j = new NonceJournal({ path: p });
  j.bindWallet(WALLET, 56);
  return j;
}
function mkWallet(rpcPending) {
  let n = rpcPending;
  return { address: WALLET, async getNonce() { return n; }, _set(v) { n = v; } };
}
function mkProvider({ receipt = null, tx = null, rpcError = false } = {}) {
  return {
    async getTransactionReceipt() { if (rpcError) throw new Error("RPC down"); return receipt; },
    async getTransaction() { if (rpcError) throw new Error("RPC down"); return tx; },
  };
}
// Reproducere deterministică a ciclului „proces A -> crash -> proces B”:
// același fișier de jurnal, manager nou (starea in-memory este pierdută).
async function restartFromJournal(p, { rpcPending = 100, provider = null } = {}) {
  const m = new NonceManager(mkWallet(rpcPending), 5);
  await m.init();
  m.attachJournal(mkJournal(p));
  const report = await m.recover(provider || mkProvider({}));
  return { m, report, journal: m.journal };
}
function errCode(fn) {
  try { fn(); return null; } catch (e) { return e instanceof JournalError ? e.code : `NOT-JOURNAL-ERROR:${e.message}`; }
}

describe("TASK 4.10-B — NonceJournal module (persistence & lifecycle)", () => {
  let dir, p;
  beforeEach(() => { dir = tmpDir(); p = path.join(dir, "nonce-journal.json"); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("missing journal file loads as an empty valid journal", () => {
    const j = mkJournal(p);
    expect(j.stats()).to.deep.include({ total: 0, outstanding: 0, terminal: 0 });
  });

  it("reserve() persists a RESERVED record readable from a fresh instance (write-before-risk)", () => {
    const j = mkJournal(p);
    j.reserve(100);
    const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(onDisk.records).to.have.lengthOf(1);
    expect(onDisk.records[0]).to.include({ nonce: 100, state: "RESERVED", wallet: WALLET.toLowerCase(), chainId: 56, txHash: null });
    const j2 = mkJournal(p);
    expect(j2.get(100).state).to.equal("RESERVED");
    expect(j2.outstanding()).to.have.lengthOf(1);
  });

  it("approve() stores the 4.6-D fingerprint durably", () => {
    const j = mkJournal(p);
    j.reserve(100);
    j.approve(100, FP);
    const j2 = mkJournal(p);
    expect(j2.get(100).state).to.equal("APPROVED");
    expect(j2.get(100).fingerprint).to.equal(FP);
    expect(errCode(() => j2.approve(100, "0x1234"))).to.equal("invalid-fingerprint");
  });

  it("commit() records SUBMITTED_PUBLIC / SUBMITTED_PRIVATE with the txHash", () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "public" });
    j.reserve(101); j.commit(101, { hash: H2, channel: "private" });
    const j2 = mkJournal(p);
    expect(j2.get(100).state).to.equal("SUBMITTED_PUBLIC");
    expect(j2.get(100).txHash).to.equal(H);
    expect(j2.get(101).state).to.equal("SUBMITTED_PRIVATE");
    expect(j2.get(101).txHash).to.equal(H2);
  });

  it("commit() with null hash records a tombstone UNKNOWN (blocking)", () => {
    const j = mkJournal(p);
    j.reserve(100);
    j.commit(100, { hash: null, channel: "private" });
    const j2 = mkJournal(p);
    expect(j2.get(100).state).to.equal("UNKNOWN");
    expect(j2.get(100).txHash).to.equal(null);
    expect(j2.outstanding()).to.have.lengthOf(1);
  });

  it("terminal CONFIRMED_* requires receipt evidence with matching transactionHash", () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "public" });
    const good = { status: 1, blockNumber: 5, blockHash: BLOCK_HASH, transactionHash: H };
    const foreign = { status: 1, blockNumber: 5, blockHash: BLOCK_HASH, transactionHash: H2 };
    expect(errCode(() => j.terminal(100, "CONFIRMED_SUCCESS", foreign))).to.equal("receipt-identity");
    expect(errCode(() => j.terminal(100, "CONFIRMED_SUCCESS", { ...good, status: 2 }))).to.equal("invalid-receipt");
    j.terminal(100, "CONFIRMED_SUCCESS", good);
    expect(j.get(100).state).to.equal("CONFIRMED_SUCCESS");
    expect(j.outstanding()).to.have.lengthOf(0);
    // case-insensitive identity is accepted
    j.reserve(101); j.commit(101, { hash: H.toLowerCase(), channel: "public" });
    j.terminal(101, "CONFIRMED_REVERT", { status: 0, blockNumber: 6, blockHash: BLOCK_HASH, transactionHash: H.toUpperCase() });
    expect(j.get(101).state).to.equal("CONFIRMED_REVERT");
  });

  it("terminal DROPPED requires 4.8 evidence (chainId 56, reason, source, detectedAt)", () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "public" });
    expect(errCode(() => j.terminal(100, "DROPPED", null))).to.equal("invalid-dropped-evidence");
    expect(errCode(() => j.terminal(100, "DROPPED", { reason: "r", source: "s", chainId: 1, detectedAt: 1 }))).to.equal("chain-mismatch");
    expect(errCode(() => j.terminal(100, "DROPPED", { reason: "", source: "s", chainId: 56, detectedAt: 1 }))).to.equal("invalid-dropped-evidence");
    j.terminal(100, "DROPPED", { reason: "onchain-nonce-advanced", source: "monitor", chainId: 56, detectedAt: 123 });
    expect(j.get(100).state).to.equal("DROPPED");
  });

  it("illegal transitions fail closed (no state mutation)", () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "public" });
    expect(errCode(() => j.commit(100, { hash: H2, channel: "private" }))).to.equal("illegal-transition");
    expect(j.get(100).txHash).to.equal(H); // unchanged
    expect(errCode(() => j.approve(100, FP))).to.equal("illegal-transition");
    j.terminal(100, "CONFIRMED_SUCCESS", { status: 1, blockNumber: 5, blockHash: BLOCK_HASH, transactionHash: H });
    expect(errCode(() => j.markUnknown(100, "x"))).to.equal("terminal");
    expect(errCode(() => j.terminal(100, "CONFIRMED_REVERT", { status: 0, blockNumber: 5, blockHash: BLOCK_HASH, transactionHash: H }))).to.equal("terminal");
    expect(errCode(() => j.reserve(100))).to.equal("nonce-conflict");
    // RESERVED -> CONFIRMED_* without submission is illegal
    j.reserve(101);
    expect(errCode(() => j.terminal(101, "CONFIRMED_SUCCESS", { status: 1, blockNumber: 5, blockHash: BLOCK_HASH, transactionHash: H }))).to.equal("illegal-transition");
    expect(errCode(() => j.terminal(999, "DROPPED", { reason: "r", source: "s", chainId: 56, detectedAt: 1 }))).to.equal("record-missing");
  });

  it("rolledBack() is terminal and a re-reserve supersedes it; double-reserve is rejected", () => {
    const j = mkJournal(p);
    j.reserve(100);
    j.rolledBack(100);
    expect(j.get(100).state).to.equal("ROLLED_BACK");
    expect(j.outstanding()).to.have.lengthOf(0);
    expect(errCode(() => j.rolledBack(100))).to.equal("terminal");
    j.reserve(100); // supersede
    expect(j.get(100).state).to.equal("RESERVED");
    expect(j.get(100).reservations).to.equal(2);
    expect(errCode(() => j.reserve(100))).to.equal("nonce-conflict");
  });
});

describe("TASK 4.10-B — journal corruption & ambiguity fail closed (§14/§15)", () => {
  let dir, p;
  beforeEach(() => { dir = tmpDir(); p = path.join(dir, "nonce-journal.json"); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("malformed / truncated JSON fails closed", () => {
    fs.writeFileSync(p, '{"version":1,"wallet":"0x7099');
    expect(errCode(() => mkJournal(p))).to.equal("malformed");
    fs.writeFileSync(p, "[1,2,3");
    expect(errCode(() => mkJournal(p))).to.equal("malformed");
  });

  it("wrong version / wrong wallet / wrong chain fails closed", () => {
    const base = { wallet: WALLET.toLowerCase(), chainId: 56, txHash: null, fingerprint: null, channel: null, receipt: null, droppedEvidence: null, unknownReason: null, createdAt: 1, updatedAt: 1 };
    const doc = (records) => JSON.stringify({ version: 1, wallet: WALLET.toLowerCase(), chainId: 56, records });
    fs.writeFileSync(p, doc([{ ...base, id: "a", nonce: 5, state: "RESERVED" }]).replace('"version":1', '"version":2'));
    expect(errCode(() => mkJournal(p))).to.equal("version");
    fs.writeFileSync(p, doc([{ ...base, id: "a", nonce: 5, state: "RESERVED" }]).replace(WALLET.toLowerCase(), "0x" + "77".repeat(20)));
    expect(errCode(() => mkJournal(p))).to.equal("wallet-mismatch");
    fs.writeFileSync(p, doc([{ ...base, id: "a", nonce: 5, state: "RESERVED" }]).replace('"chainId":56', '"chainId":1'));
    expect(errCode(() => mkJournal(p))).to.equal("chain-mismatch");
  });

  it("duplicate nonce in journal fails closed (no arbitrary selection)", () => {
    const base = { wallet: WALLET.toLowerCase(), chainId: 56, txHash: null, fingerprint: null, channel: null, receipt: null, droppedEvidence: null, unknownReason: null, createdAt: 1, updatedAt: 1 };
    fs.writeFileSync(p, JSON.stringify({ version: 1, wallet: WALLET.toLowerCase(), chainId: 56, records: [
      { ...base, id: "a", nonce: 5, state: "RESERVED" },
      { ...base, id: "b", nonce: 5, state: "SUBMITTED_PUBLIC", txHash: H },
    ] }));
    expect(errCode(() => mkJournal(p))).to.equal("duplicate-nonce");
  });

  it("invalid state / txHash / nonce / unknown fields / missing fields fail closed", () => {
    const base = { wallet: WALLET.toLowerCase(), chainId: 56, txHash: null, fingerprint: null, channel: null, receipt: null, droppedEvidence: null, unknownReason: null, createdAt: 1, updatedAt: 1 };
    const doc = (records) => JSON.stringify({ version: 1, wallet: WALLET.toLowerCase(), chainId: 56, records });
    fs.writeFileSync(p, doc([{ ...base, id: "a", nonce: 5, state: "TELEPORTED" }]));
    expect(errCode(() => mkJournal(p))).to.equal("invalid-state");
    fs.writeFileSync(p, doc([{ ...base, id: "a", nonce: 5, state: "SUBMITTED_PUBLIC", txHash: "0x1234" }]));
    expect(errCode(() => mkJournal(p))).to.equal("invalid-txhash");
    fs.writeFileSync(p, doc([{ ...base, id: "a", nonce: -3, state: "RESERVED" }]));
    expect(errCode(() => mkJournal(p))).to.equal("invalid-nonce");
    fs.writeFileSync(p, doc([{ ...base, id: "a", nonce: 1.5, state: "RESERVED" }]));
    expect(errCode(() => mkJournal(p))).to.equal("invalid-nonce");
    fs.writeFileSync(p, doc([{ ...base, id: "a", nonce: 5, state: "CONFIRMED_SUCCESS", txHash: H }]));
    expect(errCode(() => mkJournal(p))).to.equal("invalid-receipt");
    fs.writeFileSync(p, doc([{ ...base, id: "a", nonce: 5, state: "DROPPED" }]));
    expect(errCode(() => mkJournal(p))).to.equal("invalid-dropped-evidence");
    fs.writeFileSync(p, doc([{ ...base, id: "a", nonce: 5, state: "RESERVED", intruder: true }]));
    expect(errCode(() => mkJournal(p))).to.equal("unknown-field");
    fs.writeFileSync(p, doc([{ ...base, id: "a", nonce: 5, state: "RESERVED" }]).replace('"createdAt":1,', ""));
    expect(errCode(() => mkJournal(p))).to.equal("missing-field");
  });

  it("a leftover crashed-write temp file does not corrupt the journal", () => {
    const j = mkJournal(p);
    j.reserve(100);
    fs.writeFileSync(path.join(dir, ".nonce-journal.json.tmp-999-1"), "garbage from a crashed write");
    const j2 = mkJournal(p);
    expect(j2.get(100).state).to.equal("RESERVED");
  });
});

describe("TASK 4.10-B — restart / crash recovery (closes H1)", () => {
  let dir, p;
  beforeEach(() => { dir = tmpDir(); p = path.join(dir, "nonce-journal.json"); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("R1 — restart: reserved nonce is NOT reusable (H1 closed)", async () => {
    // Proces A: reserve -> (crash). Nicio tranzacție nu este cunoscută de RPC.
    const a = new NonceManager(mkWallet(100), 5);
    await a.init();
    a.attachJournal(mkJournal(p));
    const n = await a.reserve();
    expect(n).to.equal(100);
    // Proces B: manager nou (stare in-memory pierdută), RPC raportează 100.
    const { m, report } = await restartFromJournal(p, { rpcPending: 100 });
    expect(report.blocked).to.deep.equal([100]);
    expect(await m.reserve()).to.equal(101); // NICIODATĂ 100
    expect(await m.reserve()).to.equal(102);
  });

  it("R3 — private submission invisible to RPC stays blocked as UNKNOWN after restart", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "private" });
    const { m, report, journal } = await restartFromJournal(p, { rpcPending: 100, provider: mkProvider({ receipt: null, tx: null }) });
    expect(report.unknown).to.deep.equal([100]);
    expect(journal.get(100).state).to.equal("UNKNOWN"); // niciodată DROPPED
    expect(await m.reserve()).to.equal(101);
    // actualizarea UNKNOWN este ea însăși durabilă
    expect(mkJournal(p).get(100).state).to.equal("UNKNOWN");
  });

  it("R2 — public submission invisible to RPC stays blocked after restart", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "public" });
    const { m, journal } = await restartFromJournal(p, { rpcPending: 100, provider: mkProvider({ receipt: null, tx: null }) });
    expect(journal.get(100).state).to.equal("UNKNOWN");
    expect(await m.reserve()).to.equal(101);
  });

  it("tombstone UNKNOWN (no txHash) cannot be reconciled and stays blocked", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: null, channel: "private" });
    const { m, journal } = await restartFromJournal(p, { rpcPending: 100, provider: mkProvider({ receipt: null, tx: null }) });
    expect(journal.get(100).state).to.equal("UNKNOWN");
    expect(await m.reserve()).to.equal(101);
  });

  it("RESERVED record (crash before broadcast) stays blocked — no proof of non-use", async () => {
    const j = mkJournal(p);
    j.reserve(100); // crash înainte de orice submisie
    const { m, journal } = await restartFromJournal(p, { rpcPending: 100, provider: mkProvider({}) });
    expect(journal.get(100).state).to.equal("RESERVED");
    expect(await m.reserve()).to.equal(101);
  });

  it("APPROVED record (crash before broadcast) stays blocked", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.approve(100, FP);
    const { m, journal } = await restartFromJournal(p, { rpcPending: 100, provider: mkProvider({}) });
    expect(journal.get(100).state).to.equal("APPROVED");
    expect(await m.reserve()).to.equal(101);
  });

  it("startup reconciliation recovers CONFIRMED_SUCCESS from a matching status-1 receipt", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "public" });
    const receipt = { status: 1, blockNumber: 5, blockHash: BLOCK_HASH, transactionHash: H };
    const { m, report, journal } = await restartFromJournal(p, { rpcPending: 101, provider: mkProvider({ receipt }) });
    expect(report.resolved).to.deep.equal([{ nonce: 100, status: 1 }]);
    expect(journal.get(100).state).to.equal("CONFIRMED_SUCCESS");
    expect(mkJournal(p).get(100).state).to.equal("CONFIRMED_SUCCESS"); // durabil
    expect(await m.reserve()).to.equal(101); // nonce consumat on-chain — continuă normal
  });

  it("startup reconciliation recovers CONFIRMED_REVERT from a matching status-0 receipt", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "private" });
    const receipt = { status: 0, blockNumber: 5, blockHash: BLOCK_HASH, transactionHash: H };
    const { report, journal } = await restartFromJournal(p, { rpcPending: 101, provider: mkProvider({ receipt }) });
    expect(report.resolved).to.deep.equal([{ nonce: 100, status: 0 }]);
    expect(journal.get(100).state).to.equal("CONFIRMED_REVERT");
  });
});

describe("TASK 4.10-B — recovery evidence discrimination (§10)", () => {
  let dir, p;
  beforeEach(() => { dir = tmpDir(); p = path.join(dir, "nonce-journal.json"); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("R5 — a foreign receipt (different txHash) does NOT release the durable reservation", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "public" });
    const foreign = { status: 1, blockNumber: 5, blockHash: BLOCK_HASH, transactionHash: H2 };
    const { m, journal } = await restartFromJournal(p, { rpcPending: 100, provider: mkProvider({ receipt: foreign }) });
    expect(journal.get(100).state).to.equal("UNKNOWN"); // blocant
    expect(await m.reserve()).to.equal(101);
  });

  it("R5 — an invalid-status receipt (2) does NOT release the durable reservation", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "public" });
    const bad = { status: 2, blockNumber: 5, blockHash: BLOCK_HASH, transactionHash: H };
    const { m, journal } = await restartFromJournal(p, { rpcPending: 100, provider: mkProvider({ receipt: bad }) });
    expect(journal.get(100).state).to.equal("UNKNOWN");
    expect(await m.reserve()).to.equal(101);
  });

  it("R2/R3 — RPC error during recovery is classified UNKNOWN and stays blocked", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "private" });
    const { m, journal } = await restartFromJournal(p, { rpcPending: 100, provider: mkProvider({ rpcError: true }) });
    // Eroare RPC => rezultatul este NECUNOSCUT (blocant, niciodată DROPPED).
    expect(journal.get(100).state).to.equal("UNKNOWN");
    expect(await m.reserve()).to.equal(101);
  });

  it("a VISIBLE transaction (getTransaction match) stays SUBMITTED_* and blocking", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "public" });
    const { m, journal } = await restartFromJournal(p, { rpcPending: 100, provider: mkProvider({ receipt: null, tx: { hash: H, nonce: 100 } }) });
    expect(journal.get(100).state).to.equal("SUBMITTED_PUBLIC"); // neatins
    expect(await m.reserve()).to.equal(101);
  });

  it("§23 — RPC lag: journal terminal nonce above rpcPending still cannot collide", async () => {
    const j = mkJournal(p);
    j.reserve(105); j.commit(105, { hash: H, channel: "public" });
    j.terminal(105, "CONFIRMED_SUCCESS", { status: 1, blockNumber: 9, blockHash: BLOCK_HASH, transactionHash: H });
    // RPC-ul întârzie și raportează pending=100 în ciuda tx-ului minat la 105.
    const { m } = await restartFromJournal(p, { rpcPending: 100, provider: mkProvider({}) });
    expect(await m.reserve()).to.equal(106); // max(journal)+1, nu 100..105
  });

  it("§23 — multiple outstanding nonces: all blocked, next = max+1", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "private" });
    j.reserve(101); // RESERVED (crash pre-broadcast)
    j.reserve(102); j.approve(102, FP);
    const { m, report } = await restartFromJournal(p, { rpcPending: 100, provider: mkProvider({}) });
    expect(report.blocked.slice().sort((a, b) => a - b)).to.deep.equal([100, 101, 102]);
    expect(await m.reserve()).to.equal(103);
  });

  it("ROLLED_BACK record after restart: conservatively skipped (nonce not reused)", async () => {
    const j = mkJournal(p);
    j.reserve(100);
    j.rolledBack(100); // rollback 4.5-A în procesul vechi
    const { m } = await restartFromJournal(p, { rpcPending: 100, provider: mkProvider({}) });
    // Conservator: next = max(rpcPending=100, maxJournal+1=101) = 101. Un nonce
    // irosit este acceptabil; reutilizarea unui nonce cu istoric ambiguu nu.
    expect(await m.reserve()).to.equal(101);
  });

  it("DROPPED record after restart: conservatively skipped (nonce not reused)", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "public" });
    j.terminal(100, "DROPPED", { reason: "onchain-nonce-advanced", source: "monitor", chainId: 56, detectedAt: 1 });
    const { m } = await restartFromJournal(p, { rpcPending: 100, provider: mkProvider({}) });
    expect(await m.reserve()).to.equal(101);
  });
});

describe("TASK 4.10-B — attach-time fail-closed guards", () => {
  let dir, p;
  beforeEach(() => { dir = tmpDir(); p = path.join(dir, "nonce-journal.json"); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("corrupt journal at attach time throws (bot must refuse to start)", () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "private" });
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    raw.records[0].state = "TELEPORTED";
    fs.writeFileSync(p, JSON.stringify(raw));
    const m = new NonceManager(mkWallet(100), 5);
    expect(() => m.attachJournal(mkJournal(p))).to.throw(/invalid-state/);
  });

  it("wallet-mismatched journal at attach time throws", () => {
    const j = mkJournal(p);
    j.reserve(100);
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    raw.wallet = "0x" + "77".repeat(20);
    fs.writeFileSync(p, JSON.stringify(raw));
    const m = new NonceManager(mkWallet(100), 5);
    expect(() => m.attachJournal(mkJournal(p))).to.throw(/wallet-mismatch/);
  });

  it("chain-mismatched journal at attach time throws", () => {
    const j = mkJournal(p);
    j.reserve(100);
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    raw.chainId = 1;
    fs.writeFileSync(p, JSON.stringify(raw));
    const m = new NonceManager(mkWallet(100), 5);
    expect(() => m.attachJournal(mkJournal(p))).to.throw(/chain-mismatch/);
  });

  it("duplicate-nonce journal at attach time throws", () => {
    const j = mkJournal(p);
    j.reserve(100);
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const clone = JSON.parse(JSON.stringify(raw.records[0]));
    clone.id = "nj-999";
    raw.records.push(clone);
    fs.writeFileSync(p, JSON.stringify(raw));
    const m = new NonceManager(mkWallet(100), 5);
    expect(() => m.attachJournal(mkJournal(p))).to.throw(/duplicate-nonce/);
  });

  it("attachJournal rejects non-NonceJournal objects (authority guard, 4.9-D style)", () => {
    const m = new NonceManager(mkWallet(100), 5);
    expect(() => m.attachJournal({
      all: () => [], outstanding: () => [], isOutstanding: () => true, bindWallet: () => {},
    })).to.throw(/invalid-journal/);
    expect(m.journal).to.equal(null);
  });

  it("attachJournal immediately pre-blocks outstanding nonces (before recover)", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "private" });
    const m = new NonceManager(mkWallet(100), 5);
    await m.init(); // next = 100
    m.attachJournal(mkJournal(p)); // pre-block: next >= 101
    expect(m.next).to.equal(101);
    expect(await m.reserve()).to.equal(101);
  });
});

describe("TASK 4.10-B — live lifecycle integration (in-process journal writes)", () => {
  let dir, p;
  beforeEach(() => { dir = tmpDir(); p = path.join(dir, "nonce-journal.json"); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("reserve -> markApproved -> commit(public) writes the full lifecycle durably", async () => {
    const m = new NonceManager(mkWallet(100), 5);
    await m.init();
    m.attachJournal(mkJournal(p));
    const n = await m.reserve();
    expect(n).to.equal(100);
    // write-before-risk: rezervarea este deja pe disc
    expect(mkJournal(p).get(100).state).to.equal("RESERVED");
    m.markApproved(100, FP);
    expect(mkJournal(p).get(100).state).to.equal("APPROVED");
    m.commit(100, H, { channel: "public" });
    expect(mkJournal(p).get(100).state).to.equal("SUBMITTED_PUBLIC");
  });

  it("commit tombstone (null hash) writes a durable UNKNOWN record", async () => {
    const m = new NonceManager(mkWallet(100), 5);
    await m.init();
    m.attachJournal(mkJournal(p));
    const n = await m.reserve();
    m.commit(n, null, { channel: "private" });
    expect(mkJournal(p).get(n).state).to.equal("UNKNOWN");
  });

  it("releaseDropped with a real DROPPED tracker record journals DROPPED and re-enables in-process reuse", async () => {
    const m = new NonceManager(mkWallet(100), 5);
    await m.init();
    m.attachJournal(mkJournal(p));
    const n = await m.reserve();
    m.commit(n, H, { channel: "public" });
    const tracker = new TransactionTracker();
    const rec = tracker.create({ wallet: WALLET, nonce: n });
    tracker.markSubmitted(rec.id, H, { wallet: WALLET, mode: "public" });
    tracker.markPending(rec.id, WALLET);
    tracker.markDropped(rec.id, { reason: "onchain-nonce-advanced", source: "monitor", nonce: n, chainId: 56, detectedAt: Date.now() }, WALLET);
    expect(m.releaseDropped(n, { tracker, recordId: rec.id }, WALLET)).to.equal(n);
    expect(mkJournal(p).get(n).state).to.equal("DROPPED");
    // semantica 4.9: slotul cel mai recent eliberat => reutilizare in-process
    expect(await m.reserve()).to.equal(n);
    // re-rezervarea supersedă recordul DROPPED în jurnal
    expect(mkJournal(p).get(n).state).to.equal("RESERVED");
  });

  it("rollback() journals ROLLED_BACK (terminal) and the nonce can be re-reserved in-process", async () => {
    const m = new NonceManager(mkWallet(100), 5);
    await m.init();
    m.attachJournal(mkJournal(p));
    const n = await m.reserve();
    m.rollback(n);
    expect(mkJournal(p).get(n).state).to.equal("ROLLED_BACK");
    expect(await m.reserve()).to.equal(n); // rewind 4.5-A păstrat in-process
    expect(mkJournal(p).get(n).state).to.equal("RESERVED"); // supersede
  });
});

describe("TASK 4.10-B — reap integration & journal-failure fail-closed", () => {
  let dir, p;
  beforeEach(() => { dir = tmpDir(); p = path.join(dir, "nonce-journal.json"); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("reap() with a valid hash-matching receipt frees the slot AND journals CONFIRMED_SUCCESS", async () => {
    const m = new NonceManager(mkWallet(100), 5);
    await m.init();
    m.attachJournal(mkJournal(p));
    const n = await m.reserve();
    m.commit(n, H, { channel: "public" });
    const provider = mkProvider({ receipt: { status: 1, blockNumber: 5, blockHash: BLOCK_HASH, transactionHash: H } });
    await m.reap(provider);
    expect(m.pending.size).to.equal(0);
    expect(mkJournal(p).get(n).state).to.equal("CONFIRMED_SUCCESS");
    expect(mkJournal(p).get(n).receipt.status).to.equal(1);
  });

  it("reap() with status 0 journals CONFIRMED_REVERT", async () => {
    const m = new NonceManager(mkWallet(100), 5);
    await m.init();
    m.attachJournal(mkJournal(p));
    const n = await m.reserve();
    m.commit(n, H, { channel: "public" });
    const provider = mkProvider({ receipt: { status: 0, blockNumber: 5, blockHash: BLOCK_HASH, transactionHash: H } });
    await m.reap(provider);
    expect(m.pending.size).to.equal(0);
    expect(mkJournal(p).get(n).state).to.equal("CONFIRMED_REVERT");
  });

  it("reap() with null receipt keeps the slot AND the journal record outstanding", async () => {
    const m = new NonceManager(mkWallet(100), 5);
    await m.init();
    m.attachJournal(mkJournal(p));
    const n = await m.reserve();
    m.commit(n, H, { channel: "public" });
    const provider = mkProvider({ receipt: null });
    await m.reap(provider);
    expect(m.pending.size).to.equal(1); // slot protejat (4.9)
    expect(mkJournal(p).get(n).state).to.equal("SUBMITTED_PUBLIC"); // blocant
    expect(await m.reserve()).to.equal(101);
  });

  it("journal write failure at reserve() fails closed: reserve rejects, nonce never handed out", async () => {
    // Eșec REAL de disc: directorul devine read-only după attach (load reușit),
    // deci _save() eșuează la openSync(tmp, 'w') cu EACCES.
    dir = tmpDir();
    p = path.join(dir, "nonce-journal.json");
    const m = new NonceManager(mkWallet(100), 5);
    await m.init();
    m.attachJournal(mkJournal(p)); // load OK (fișierul nu există încă = jurnal gol valid)
    fs.chmodSync(dir, 0o555); // directory read-only => scrierile eșuează
    try {
      let threw = false;
      try { await m.reserve(); } catch (e) { threw = true; }
      expect(threw).to.equal(true);
      // nonce-ul 100 nu a fost niciodată returnat (leak safe, niciodată reutilizabil)
      expect(m.reserved.size).to.equal(1);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    // după restaurarea permisiunilor, 100 rămâne deținut (reserved) => următorul nonce este 101
    expect(await m.reserve()).to.equal(101);
    // iar jurnalul conține ambele rezervări durabile
    expect(mkJournal(p).get(101).state).to.equal("RESERVED");
  });

  it("manager without journal keeps pre-existing semantics (backward compat)", async () => {
    const m = new NonceManager(mkWallet(100), 5);
    await m.init();
    expect(await m.reserve()).to.equal(100);
    m.commit(100, H);
    expect(m.markApproved(100, FP)).to.equal(undefined); // no-op fără eroare
    const provider = mkProvider({ receipt: { status: 1, blockNumber: 5, blockHash: BLOCK_HASH, transactionHash: H } });
    await m.reap(provider);
    expect(m.pending.size).to.equal(0);
    expect(await m.recover(provider)).to.equal(null); // no-op fără eroare
  });

  it("recover() is serialized with reserve() — concurrent reserve cannot steal a journaled nonce", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "private" });
    const m = new NonceManager(mkWallet(100), 5);
    await m.init();
    m.attachJournal(mkJournal(p));
    // recover() și reserve() pornește concurent; mutex-ul _reserveChain le serializ
    const [ , n ] = await Promise.all([m.recover(mkProvider({})), m.reserve()]);
    expect(n).to.equal(101); // niciodată 100
  });
});








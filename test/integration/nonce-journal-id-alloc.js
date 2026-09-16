// TASK 4.10-D — NonceJournal ID allocator: restart/reconnect uniqueness.
//
// Remediază MEDIUM-1 + LOW-1 din auditul adversarial 4.10-C:
//   MEDIUM-1: `_seq` NU era restaurat la load(), deci după restart/reconnect un
//             journal proaspăt genera din nou `nj-1`, scria un ID duplicat, iar
//             restartul următor pica fail-closed (`duplicate-id`).
//   LOW-1:    ID-ul generat nu era verificat față de ID-urile existente înainte
//             de mutarea stării jurnalului.
//
// Testele folosesc fișiere temporare REALE (persistență reală) — fără RPC live,
// fără tranzacții reale. Nicio semantică de ownership/dovenzi nu este modificată.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { NonceManager } = require("../../bot/nonce");
const { NonceJournal, JournalError } = require("../../bot/nonce-journal");

const WALLET = "0x70997970C51812dc3A010C7d01b50b0429c0d3c8";
const H = "0x" + "ab".repeat(32);
const BLOCK_HASH = "0x" + "be".repeat(32);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "njid-"));
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
function mkProvider() {
  return {
    async getTransactionReceipt() { return null; },
    async getTransaction() { return null; },
  };
}
function errCode(fn) {
  try { fn(); return null; } catch (e) { return e instanceof JournalError ? e.code : `NOT-JOURNAL-ERROR:${e.message}`; }
}
// Record complet, valid pentru schema 4.10-B (aceleași câmpuri ca producția).
function rec({ id, nonce, state = "RESERVED", txHash = null }) {
  return {
    id, wallet: WALLET.toLowerCase(), chainId: 56, nonce, state, txHash,
    fingerprint: null, channel: null, receipt: null, droppedEvidence: null,
    unknownReason: null, createdAt: 1, updatedAt: 1, reservations: 1,
  };
}
function writeDoc(p, records) {
  fs.writeFileSync(p, JSON.stringify({ version: 1, wallet: WALLET.toLowerCase(), chainId: 56, updatedAt: 1, records }, null, 2) + "\n");
}
function idsOnDisk(p) {
  return JSON.parse(fs.readFileSync(p, "utf8")).records.map((r) => r.id);
}

describe("TASK 4.10-D — NonceJournal ID allocator (restart/reconnect uniqueness)", () => {
  let dir, p;
  beforeEach(() => { dir = tmpDir(); p = path.join(dir, "nonce-journal.json"); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  // ---- Test A — restart sequence -------------------------------------------
  it("A — restart sequence: nj-1 then nj-2, unique IDs, third load succeeds", () => {
    const j1 = mkJournal(p);
    j1.reserve(100);
    expect(idsOnDisk(p)).to.deep.equal(["nj-1"]);

    const j2 = mkJournal(p);              // "restart": stare in-memory pierdută
    j2.reserve(101);
    const ids = idsOnDisk(p);
    expect(ids).to.deep.equal(["nj-1", "nj-2"]);
    expect(new Set(ids).size).to.equal(ids.length);
    expect(ids[1]).to.not.equal(ids[0]);

    // Al treilea load trebuie să reușească (fără duplicate-id).
    const j3 = mkJournal(p);
    expect(j3.stats().total).to.equal(2);
    expect(j3.get(100).state).to.equal("RESERVED");
    expect(j3.get(101).state).to.equal("RESERVED");
  });

  // ---- Test B — multiple existing IDs --------------------------------------
  it("B — existing nj-1 / nj-5 / nj-9 => _seq >= 9, next generated ID is nj-10", () => {
    writeDoc(p, [rec({ id: "nj-1", nonce: 100 }), rec({ id: "nj-5", nonce: 101 }), rec({ id: "nj-9", nonce: 102 })]);
    const j = mkJournal(p);
    expect(j._seq).to.be.at.least(9);
    const created = j.reserve(200);
    expect(created.id).to.equal("nj-10");
    expect(idsOnDisk(p)).to.deep.equal(["nj-1", "nj-5", "nj-9", "nj-10"]);
    // Și fișierul se reîncarcă fără duplicate-id.
    expect(mkJournal(p).stats().total).to.equal(4);
  });

  // ---- Test C — creation-time collision guard ------------------------------
  it("C — creation-time collision guard: generated ID already present => duplicate-id, no mutation", () => {
    const j = mkJournal(p);
    j.reserve(100);                                  // creează nj-1
    const before = fs.readFileSync(p, "utf8");
    const beforeCount = j.all().length;
    j._seq = 0;                                      // forțează următorul ID = nj-1 (existent)

    expect(errCode(() => j.reserve(200))).to.equal("duplicate-id");
    expect(j.all()).to.have.lengthOf(beforeCount);   // niciun append
    expect(fs.readFileSync(p, "utf8")).to.equal(before); // nicio scriere
    expect(j._ids.has("nj-2")).to.equal(false);

    // Operația validă ulterioară rămâne posibilă (nu există blocaj artificial).
    const ok = j.reserve(200);
    expect(ok.id).to.equal("nj-2");
    expect(mkJournal(p).stats().total).to.equal(2);
  });

  it("C2 — collision guard with several existing IDs leaves the file bit-identical", () => {
    const j = mkJournal(p);
    j.reserve(100); j.reserve(101);                  // două ID-uri distincte
    const existing = j.all().map((r) => r.id);
    expect(new Set(existing).size).to.equal(existing.length);
    const before = fs.readFileSync(p, "utf8");
    // Forțează exact coliziunea cu ULTIMUL ID existent (nu presupune ID-uri
    // consecutive: contorul intern este partajat cu numele fișierelor tmp).
    const lastSuffix = Number(/^nj-(\d+)$/.exec(existing[existing.length - 1])[1]);
    j._seq = lastSuffix - 1;                         // următorul ID generat = ultimul ID existent
    expect(errCode(() => j.reserve(202))).to.equal("duplicate-id");
    expect(fs.readFileSync(p, "utf8")).to.equal(before);   // nicio scriere
    expect(j.all()).to.have.lengthOf(existing.length);     // nicio mutație
    // Operația validă ulterioară rămâne posibilă și produce un ID nou.
    const created = j.reserve(202);
    expect(existing).to.not.include(created.id);
    expect(j._ids.has(created.id)).to.equal(true);
    expect(mkJournal(p).stats().total).to.equal(existing.length + 1);
  });

  // ---- Test D — production reconnect path ----------------------------------
  it("D — reconnect path: new journal over the same file restores the sequence and persists unique IDs", async () => {
    // "Proces 1": manager + jurnal, rezervă și trimite nonce 100.
    const m1 = new NonceManager(mkWallet(100), 5);
    await m1.init();
    m1.attachJournal(mkJournal(p));
    await m1.recover(mkProvider());
    const n1 = await m1.reserve();
    m1.commit(n1, H, { channel: "public" });

    // "Reconnect": bot/index.js construiește un NonceManager NOU și un
    // NonceJournal NOU pe ACELAȘI fișier (exact ca la reconectarea RPC).
    const m2 = new NonceManager(mkWallet(101), 5);
    await m2.init();
    m2.attachJournal(mkJournal(p));
    const report = await m2.recover(mkProvider());
    const n2 = await m2.reserve();
    m2.commit(n2, H, { channel: "public" });

    expect(report.blocked).to.deep.equal([100]);     // H1: nonce-ul vechi rămâne blocat
    expect(n2).to.equal(101);
    const ids = idsOnDisk(p);
    expect(ids).to.have.lengthOf(2);
    expect(new Set(ids).size).to.equal(ids.length);  // ID-uri unice după reconnect (MEDIUM-1)
    expect(ids[0]).to.equal("nj-1");
    expect(ids[1]).to.not.equal(ids[0]);             // al doilea ID NU mai repetă nj-1

    // Al doilea reconnect: totul se reîncarcă fără duplicate-id.
    const m3 = new NonceManager(mkWallet(102), 5);
    await m3.init();
    m3.attachJournal(mkJournal(p));
    await m3.recover(mkProvider());
    expect(await m3.reserve()).to.equal(102);
    const ids3 = idsOnDisk(p);
    expect(ids3).to.have.lengthOf(3);
    expect(new Set(ids3).size).to.equal(ids3.length);
    expect(mkJournal(p).stats().total).to.equal(3);  // reîncărcare fără duplicate-id
  });

  // ---- Test E — existing duplicates remain fail-closed ----------------------
  it("E — a journal already containing duplicate IDs still fails closed on load", () => {
    writeDoc(p, [rec({ id: "nj-1", nonce: 100 }), rec({ id: "nj-1", nonce: 101 })]);
    expect(errCode(() => mkJournal(p))).to.equal("duplicate-id");
  });

  // ---- Test F — numeric suffix edge cases ----------------------------------
  it("F — numeric suffix edge cases: nj-1 / nj-10 / nj-100 => next ID is nj-101", () => {
    writeDoc(p, [rec({ id: "nj-1", nonce: 100 }), rec({ id: "nj-10", nonce: 101 }), rec({ id: "nj-100", nonce: 102 })]);
    const j = mkJournal(p);
    expect(j._seq).to.be.at.least(100);
    expect(j.reserve(200).id).to.equal("nj-101");
  });

  it("F2 — nonconforming IDs load (4.10-B semantics unchanged) but never affect _seq", () => {
    writeDoc(p, [rec({ id: "a", nonce: 100 }), rec({ id: "nj-3", nonce: 101 }), rec({ id: "nj-", nonce: 102 }), rec({ id: "NJ-5", nonce: 103 })]);
    const j = mkJournal(p);
    expect(j.stats().total).to.equal(4);             // acceptate (string non-gol)
    expect(j._seq).to.equal(3);                      // doar `nj-<digits>` contează
    expect(j.reserve(200).id).to.equal("nj-4");      // niciun ID neconform nu colizionează
  });

  it("F3 — zero-padded suffix nj-007 counts as 7 => next generated ID is nj-8", () => {
    writeDoc(p, [rec({ id: "nj-007", nonce: 100 })]);
    const j = mkJournal(p);
    expect(j._seq).to.be.at.least(7);
    expect(j.reserve(200).id).to.equal("nj-8");
  });

  // ---- Regression: schema/durability unchanged ------------------------------
  it("G — persisted document schema is unchanged (reload + no extra fields)", () => {
    const j = mkJournal(p);
    j.reserve(100);
    j.commit(100, { hash: H, channel: "public" });
    j.terminal(100, "CONFIRMED_SUCCESS", { status: 1, blockNumber: 5, blockHash: BLOCK_HASH, transactionHash: H });
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(Object.keys(doc).sort()).to.deep.equal(["chainId", "records", "updatedAt", "version", "wallet"]);
    expect(Object.keys(doc.records[0]).sort()).to.deep.equal(
      ["chainId", "channel", "createdAt", "droppedEvidence", "fingerprint", "id", "nonce",
        "receipt", "reservations", "state", "txHash", "unknownReason", "updatedAt", "wallet"]
    );
    expect(mkJournal(p).get(100).state).to.equal("CONFIRMED_SUCCESS");
  });

  it("H — restart keeps outstanding nonces blocked (no H1 regression after 4.10-D)", async () => {
    const j = mkJournal(p);
    j.reserve(100); j.commit(100, { hash: H, channel: "private" });
    const m = new NonceManager(mkWallet(100), 5);
    await m.init();
    m.attachJournal(mkJournal(p));
    await m.recover(mkProvider());
    expect(await m.reserve()).to.equal(101);          // NICIODATĂ 100
    expect(m.blocked.has(100)).to.equal(true);
  });
});

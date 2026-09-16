// TASK 4.11-D (LOW-1) — public broadcast transport-ambiguity hardening.
// D1-D10 + §13 failure-injection + §14 crash-window preservation.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RealNonceManager = require("../../bot/nonce").NonceManager;
const RealNonceJournal = require("../../bot/nonce-journal").NonceJournal;

const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const BASE = "0x" + "9a".repeat(20);
const E18 = 10n ** 18n;
const CONTRACT = "0x" + "f1".repeat(20);
const WALLET_ADDR = "0x" + "e1".repeat(20);

function makeDiOpp() {
  const tokWbnb = { address: WBNB, decimals: 18, symbol: "WBNB" };
  const tokBase = { address: BASE, decimals: 18, symbol: "BASE" };
  return {
    sourceKind: "v2",
    borrowToken: tokWbnb,
    baseToken: tokBase,
    borrowAmount: 1000n * E18,
    sourceVen: { kind: "v2", pair: "0x" + "a1".repeat(20), tokenA: tokWbnb, tokenB: tokBase, feeBps: 25, blockNumber: 100 },
    buyVen: { kind: "v2", router: "0x" + "b2".repeat(20), feeBps: 25, tokenA: tokWbnb, tokenB: tokBase, reserveA: 1_000_000n * E18, reserveB: 1_000_000n * E18, blockNumber: 100 },
    sellVen: { kind: "v2", router: "0x" + "c3".repeat(20), feeBps: 25, tokenA: tokWbnb, tokenB: tokBase, reserveA: 1_000_000n * E18, reserveB: 500_000n * E18, blockNumber: 100 },
  };
}

function makeWallet(sent = [], sendImpl) {
  return {
    address: WALLET_ADDR,
    getAddress: async () => WALLET_ADDR,
    call: async () => "0x" + "00".repeat(31) + "7b",
    estimateGas: async () => 100000n,
    getNonce: async () => 0,
    sendTransaction: sendImpl || ((tx) => { sent.push(tx); return { hash: "0x" + "ab".repeat(32) }; }),
  };
}

function makeProvider() {
  return {
    getBlockNumber: async () => 100,
    getFeeData: async () => ({ gasPrice: 1n }),
    getNetwork: async () => ({ chainId: 56n }),
  };
}

// Stub ONLY scanner + bloxroute (nonce module stays REAL — injected managers).
function withExecutor(fn) {
  const paths = { scanner: require.resolve("../../bot/scanner"), bloxroute: require.resolve("../../bot/bloxroute") };
  const saved = {};
  for (const k of Object.keys(paths)) saved[k] = require.cache[paths[k]];
  const fakeMod = (exports) => ({ id: paths.scanner, filename: paths.scanner, loaded: true, exports });
  require.cache[paths.scanner] = fakeMod({ readState: async () => {}, pairKey: (a, b) => (a < b ? a + b : b + a) });
  require.cache[paths.bloxroute] = fakeMod({ isAvailable: async () => false, sendPrivateTx: async () => { throw new Error("private-must-not-be-used"); } });
  delete require.cache[require.resolve("../../bot/executor")];
  const executor = require("../../bot/executor");
  try { return fn(executor); }
  finally {
    for (const k of Object.keys(paths)) { if (saved[k]) require.cache[paths[k]] = saved[k]; else delete require.cache[paths[k]]; }
    delete require.cache[require.resolve("../../bot/executor")];
  }
}

function tmpJournal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a411d-"));
  const p = path.join(dir, "nonce-journal.json");
  return { dir, p };
}

const invisible = { getTransactionReceipt: async () => null, getTransaction: async () => null };

describe("TASK 4.11-D — public broadcast transport-ambiguity (LOW-1)", function () {

  // ---- D1/D2/D3/D4 classifier unit semantics --------------------------------
  describe("classifyPublicBroadcastError", function () {
    const { classifyPublicBroadcastError } = require("../../bot/executor");

    it("D1: structured node JSON-RPC error => definitive (rollback eligible)", function () {
      expect(classifyPublicBroadcastError(Object.assign(new Error("nonce too low"), { code: "NONCE_EXPIRED", info: { error: { code: -32000, message: "nonce too low" } } }))).to.equal("definitive");
      expect(classifyPublicBroadcastError(Object.assign(new Error("insufficient funds"), { code: "INSUFFICIENT_FUNDS", info: { error: { code: -32000, message: "insufficient funds" } } }))).to.equal("definitive");
      expect(classifyPublicBroadcastError(Object.assign(new Error("coalesce"), { code: "UNKNOWN_ERROR", info: { error: { code: -32603, message: "internal" } } }))).to.equal("definitive");
    });

    it("D2: plain transport error => ambiguous", function () {
      expect(classifyPublicBroadcastError(new Error("network error"))).to.equal("ambiguous");
    });

    it("D3: timeout => ambiguous", function () {
      expect(classifyPublicBroadcastError(Object.assign(new Error("timeout"), { code: "TIMEOUT" }))).to.equal("ambiguous");
    });

    it("D4: connection reset / aborted response => ambiguous", function () {
      expect(classifyPublicBroadcastError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).to.equal("ambiguous");
      expect(classifyPublicBroadcastError(Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" }))).to.equal("ambiguous");
    });

    it("unknown error shapes (null/string/missing response/server error no body) => ambiguous (fail-closed)", function () {
      expect(classifyPublicBroadcastError(null)).to.equal("ambiguous");
      expect(classifyPublicBroadcastError(undefined)).to.equal("ambiguous");
      expect(classifyPublicBroadcastError("boom")).to.equal("ambiguous");
      // node responded but the RESPONSE was missing/malformed => acceptance unknown
      expect(classifyPublicBroadcastError(Object.assign(new Error("missing response for request"), { code: "BAD_DATA" }))).to.equal("ambiguous");
      // transport/server-class error WITHOUT a raw node error object => ambiguous
      expect(classifyPublicBroadcastError(Object.assign(new Error("server error"), { code: "SERVER_ERROR", info: {} }))).to.equal("ambiguous");
    });
  });

  // ---- D2/D5/D6/D8/§13 — end-to-end ambiguous public broadcast -------------
  it("D2/§13: transport failure after APPROVED → UNKNOWN, nonce blocked, journal non-terminal, NO rollback, NO retry", async function () {
    await withExecutor(async (executor) => {
      const approvalsSeen = [];
      const wallet = makeWallet([], async (tx) => { approvalsSeen.push(tx); throw new Error("ECONNRESET: socket hang up"); });
      const d = tmpJournal();
      const journal = new RealNonceJournal({ path: d.p });
      journal.bindWallet(WALLET_ADDR, 56);
      const mgr = new RealNonceManager(wallet, 5);
      await mgr.init();
      mgr.attachJournal(journal);

      const result = await executor.executeOpp(makeDiOpp(), CONTRACT, wallet, makeProvider(), { nonceManager: mgr });

      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("broadcast-ambiguous");
      expect(result.nonce).to.equal(0);
      expect(result.txHash).to.equal(undefined);
      expect(mgr.reserved.has(0)).to.equal(false);
      expect(mgr.pending.has(0)).to.equal(true);            // owned, not released
      expect(mgr.pending.get(0).hash).to.equal(null);        // tombstone: no fabricated hash
      // journal: non-terminal outstanding record (UNKNOWN by the tombstone
      // commit — exactly the state TASK 4.11-D §6 prescribes). UNKNOWN
      // tombstones intentionally carry channel=null (pre-existing journal
      // design, identical to the private-relay UNKNOWN path); identity evidence
      // persists via the APPROVED fingerprint and the nonce.
      const rec = journal.get(0);
      expect(rec).to.not.equal(null);
      expect(rec.state).to.equal("UNKNOWN");
      expect(rec.txHash).to.equal(null);
      expect(journal.isTerminalState(rec.state)).to.equal(false);
      expect(journal.isOutstanding(rec)).to.equal(true);
      expect(rec.fingerprint).to.match(/^0x[0-9a-f]{64}$/);  // 4.6-D identity preserved
      expect(typeof rec.createdAt).to.equal("number");
      // D5: exactly ONE submit attempt, NO second sendTransaction
      expect(approvalsSeen.length).to.equal(1);
      // D8: the single attempted tx carried the approved identity
      expect(approvalsSeen[0].nonce).to.equal(0);
      expect(approvalsSeen[0].to).to.equal(CONTRACT);
      expect(approvalsSeen[0].data).to.match(/^0x[0-9a-f]+$/);
      expect(approvalsSeen[0].gasLimit).to.equal(120000n);    // cost guard output
      expect(approvalsSeen[0].gasPrice).to.equal(1n);         // approved worst-case bound
      fs.rmSync(d.dir, { recursive: true, force: true });
    });
  });

  it("D7: ambiguous public submission SURVIVES restart — nonce blocked by fresh manager+journal", async function () {
    await withExecutor(async (executor) => {
      const wallet = makeWallet([], async () => { throw new Error("timeout"); });
      const d = tmpJournal();
      const journal = new RealNonceJournal({ path: d.p });
      journal.bindWallet(WALLET_ADDR, 56);
      const mgr = new RealNonceManager(wallet, 5);
      await mgr.init();
      mgr.attachJournal(journal);
      const result = await executor.executeOpp(makeDiOpp(), CONTRACT, wallet, makeProvider(), { nonceManager: mgr });
      expect(result.reason).to.equal("broadcast-ambiguous");
      // restart: fresh process objects, same journal file, RPC blind to the tx
      const mgr2 = new RealNonceManager(wallet, 5);
      await mgr2.init();
      mgr2.attachJournal(new RealNonceJournal({ path: d.p }));
      const rep = await mgr2.recover(invisible);
      expect(rep.blocked).to.include(0);                     // nonce stays blocked
      const n = await mgr2.reserve();
      expect(n).to.not.equal(0);                              // cannot reserve nonce 0 again
      expect(mgr2.blocked.has(0)).to.equal(true);
      fs.rmSync(d.dir, { recursive: true, force: true });
    });
  });

  it("D5b: timeout/ambiguity → no automatic retry (single sendTransaction in the pipeline)", async function () {
    await withExecutor(async (executor) => {
      let calls = 0;
      const wallet = makeWallet([], async () => { calls += 1; throw Object.assign(new Error("timeout"), { code: "TIMEOUT" }); });
      const d = tmpJournal();
      const journal = new RealNonceJournal({ path: d.p });
      journal.bindWallet(WALLET_ADDR, 56);
      const mgr = new RealNonceManager(wallet, 5);
      await mgr.init();
      mgr.attachJournal(journal);
      const result = await executor.executeOpp(makeDiOpp(), CONTRACT, wallet, makeProvider(), { nonceManager: mgr });
      expect(result.reason).to.equal("broadcast-ambiguous");
      expect(calls).to.equal(1);                              // exactly one submit attempt
      fs.rmSync(d.dir, { recursive: true, force: true });
    });
  });

  it("D6: ambiguous public submission → no private submission", async function () {
    // bloxroute is stubbed (isAvailable:false); a private call would throw.
    await withExecutor(async (executor) => {
      const wallet = makeWallet([], async () => { throw new Error("connection reset"); });
      const d = tmpJournal();
      const journal = new RealNonceJournal({ path: d.p });
      journal.bindWallet(WALLET_ADDR, 56);
      const mgr = new RealNonceManager(wallet, 5);
      await mgr.init();
      mgr.attachJournal(journal);
      const result = await executor.executeOpp(makeDiOpp(), CONTRACT, wallet, makeProvider(), { nonceManager: mgr });
      expect(result.reason).to.equal("broadcast-ambiguous");
      // the public path is terminal after ambiguity; no private channel is reached
      expect(result.private).to.equal(undefined);
      expect(mgr.pending.has(0)).to.equal(true);
      fs.rmSync(d.dir, { recursive: true, force: true });
    });
  });

  it("D10: ambiguous submission → no realized PnL (ok=false, no txHash, journal non-terminal)", async function () {
    await withExecutor(async (executor) => {
      const wallet = makeWallet([], async () => { throw new Error("network error"); });
      const d = tmpJournal();
      const journal = new RealNonceJournal({ path: d.p });
      journal.bindWallet(WALLET_ADDR, 56);
      const mgr = new RealNonceManager(wallet, 5);
      await mgr.init();
      mgr.attachJournal(journal);
      const result = await executor.executeOpp(makeDiOpp(), CONTRACT, wallet, makeProvider(), { nonceManager: mgr });
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("broadcast-ambiguous");
      expect(result.txHash).to.equal(undefined);              // no confirmable hash to poll/PnL
      const st = mgr.journal.get(0).state;
      expect(["CONFIRMED_SUCCESS", "CONFIRMED_REVERT", "DROPPED", "ROLLED_BACK"]).to.not.include(st);
      fs.rmSync(d.dir, { recursive: true, force: true });
    });
  });

  // ---- D1 executor-path: definitive rejection still rolls back --------------
  it("D1b: definitive node rejection → broadcast-failed + rollback (4.5-A preserved)", async function () {
    await withExecutor(async (executor) => {
      const wallet = makeWallet([], async () => { throw Object.assign(new Error("nonce too low"), { code: "NONCE_EXPIRED", info: { error: { code: -32000, message: "nonce too low" } } }); });
      const d = tmpJournal();
      const journal = new RealNonceJournal({ path: d.p });
      journal.bindWallet(WALLET_ADDR, 56);
      const mgr = new RealNonceManager(wallet, 5);
      await mgr.init();
      mgr.attachJournal(journal);
      const result = await executor.executeOpp(makeDiOpp(), CONTRACT, wallet, makeProvider(), { nonceManager: mgr });
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("broadcast-failed");
      expect(mgr.pending.has(0)).to.equal(false);             // rolled back
      expect(mgr.journal.get(0).state).to.equal("ROLLED_BACK");
      fs.rmSync(d.dir, { recursive: true, force: true });
    });
  });

  // ---- §14 crash-window preservation ----------------------------------------
  it("§14: crash after APPROVED before/inside broadcast → restart blocks (unchanged)", async function () {
    await withExecutor(async (executor) => {
      const d = tmpJournal();
      const journal = new RealNonceJournal({ path: d.p });
      journal.bindWallet(WALLET_ADDR, 56);
      const mgr = new RealNonceManager(makeWallet([]), 5);
      await mgr.init();
      mgr.attachJournal(journal);
      const n = await mgr.reserve();
      expect(n).to.equal(0);
      mgr.markApproved(0, "0x" + "ab".repeat(32));
      expect(journal.get(0).state).to.equal("APPROVED");      // crash here
      const mgr2 = new RealNonceManager(makeWallet([]), 5);
      await mgr2.init();
      mgr2.attachJournal(new RealNonceJournal({ path: d.p }));
      const rep = await mgr2.recover(invisible);
      expect(rep.blocked).to.include(0);
      expect(await mgr2.reserve()).to.not.equal(0);
      fs.rmSync(d.dir, { recursive: true, force: true });
    });
  });

  // ---- identity preservation (D8 completeness) ------------------------------
  describe("identity preservation", function () {
    const bi = require("../../bot/broadcast-integrity");
    it("approved tx identity fields are immutable and unchanged by ambiguity handling", function () {
      const appr = bi.approveTx({ chainId: 56, to: CONTRACT, data: "0xdeadbeef" + "01".repeat(16), value: 0n, nonce: 7n, gasLimit: 120000n, type: 0, gasPrice: 1n });
      expect(appr.ok).to.equal(true);
      expect(Object.isFrozen(appr.tx)).to.equal(true);
      expect(appr.tx.chainId).to.equal(56n);
      expect(appr.tx.to).to.equal(CONTRACT);
      expect(appr.tx.nonce).to.equal(7n);
      expect(appr.tx.gasLimit).to.equal(120000n);
      expect(appr.tx.type).to.equal(0);
      expect(appr.tx.gasPrice).to.equal(1n);
      expect(appr.fingerprint).to.match(/^0x[0-9a-f]{64}$/);
    });
  });
});

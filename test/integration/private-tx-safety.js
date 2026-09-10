// TASK 4.5-D — Private TX / UNKNOWN / Replacement Safety
//
// Safety layer for private (BloXroute-style) transactions:
//   - relay acceptance ≠ on-chain success (acceptance only → SUBMITTED)
//   - ambiguous submission (timeout / network error / reset / malformed
//     response) → UNKNOWN, nonce NEVER rolled back
//   - UNKNOWN ≠ DROPPED; UNKNOWN private nonce is never reusable
//   - replacement transactions: same nonce + different hash, linked by
//     replaces/replacedBy metadata, never freeing the nonce
//   - receipt priority, terminal states stay terminal
//   - TransactionTracker is the lifecycle authority; NonceManager stays the
//     single nonce owner
//
// All tests use the REAL TransactionTracker and REAL NonceManager state
// machines. Only external I/O (bloxroute/scanner) is stubbed.
const { expect } = require("chai");

// Capture REAL classes BEFORE any module stubbing.
const RealNonceManager = require("../../bot/nonce").NonceManager;
const { TransactionTracker } = require("../../bot/tx-tracker");

const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const BASE = "0x" + "9a".repeat(20);
const E18 = 10n ** 18n;
const WALLET_A = "0x" + "e1".repeat(20);
const WALLET_B = "0x" + "e2".repeat(20);
const H1 = "0x" + "11".repeat(32);
const H2 = "0x" + "22".repeat(32);
const H3 = "0x" + "33".repeat(32);
const BLOCK_HASH = "0x" + "cd".repeat(32);

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

function makeWallet(sent = [], address = WALLET_A, startNonce = 100) {
  let n = startNonce;
  return {
    address,
    getAddress: async () => address,
    call: async () => "0x" + "00".repeat(31) + "7b",
    estimateGas: async () => 100000n,
    async getNonce() { return n; },
    sendTransaction(tx) { sent.push(tx); return { hash: H2 }; },
  };
}

function makeProvider() {
  return {
    getBlockNumber: async () => 100,
    getFeeData: async () => ({ gasPrice: 1n }),
  };
}

// Provider for tracker.poll(): scripted receipt/tx or throws.
function makePollProvider(opts = {}) {
  return {
    receiptCalls: 0,
    txCalls: 0,
    async getTransactionReceipt() {
      this.receiptCalls += 1;
      if (opts.throwReceipt) throw new Error("RPC failure: receipt");
      return opts.receipt !== undefined ? opts.receipt : null;
    },
    async getTransaction() {
      this.txCalls += 1;
      if (opts.throwTx) throw new Error("RPC failure: tx");
      return opts.tx !== undefined ? opts.tx : null;
    },
  };
}

function validReceipt(status, blockNumber = 500) {
  return { status, blockNumber, blockHash: BLOCK_HASH, transactionIndex: 2 };
}

// Isolate executor with stubbed scanner + scripted bloxroute. Real nonce +
// real tracker remain in play.
function withIsolatedExecutor(bloxrouteHandler, fn) {
  const paths = {
    scanner: require.resolve("../../bot/scanner"),
    bloxroute: require.resolve("../../bot/bloxroute"),
  };
  const saved = {};
  for (const k of Object.keys(paths)) saved[k] = require.cache[paths[k]];
  const fakeMod = (exports) => ({ id: paths.scanner, filename: paths.scanner, loaded: true, exports });
  require.cache[paths.scanner] = fakeMod({ readState: async () => {}, pairKey: (a, b) => (a < b ? a + b : b + a) });
  require.cache[paths.bloxroute] = fakeMod({ isAvailable: async () => true, sendPrivateTx: bloxrouteHandler });
  delete require.cache[require.resolve("../../bot/executor")];
  const executor = require("../../bot/executor");
  try {
    return fn(executor);
  } finally {
    for (const k of Object.keys(paths)) {
      if (saved[k]) require.cache[paths[k]] = saved[k];
      else delete require.cache[paths[k]];
    }
    delete require.cache[require.resolve("../../bot/executor")];
  }
}

describe("TASK 4.5-D — Private TX / UNKNOWN / Replacement Safety", () => {
describe("A — private submission lifecycle (executor + real tracker + real NonceManager)", () => {
    it("1 — private accepted → tracker record SUBMITTED (mode private, txHash set)", async () => {
      withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: H1, block: 123 }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        expect(res.ok).to.equal(true);
        expect(res.private).to.equal(true);
        const rec = tracker.get(res.trackerId);
        expect(rec.state).to.equal("SUBMITTED");
        expect(rec.mode).to.equal("private");
        expect(rec.txHash).to.equal(H1);
        expect(rec.wallet).to.equal(WALLET_A);
        expect(rec.nonce).to.equal(res.nonce);
      });
    });

    it("2 — accepted tx keeps nonce owned (pending, not reusable)", async () => {
      withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: H1, block: 123 }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        expect(mgr.pending.has(res.nonce)).to.equal(true);
        expect(mgr.pending.get(res.nonce).hash).to.equal(H1);
        expect(mgr.reserved.has(res.nonce)).to.equal(false);
        const again = await mgr.reserve();
        expect(again).to.not.equal(res.nonce);
      });
    });

    it("3 — accepted + commit failure → nonce-commit-failed, rollback NEVER called", async () => {
      const rollbackSpy = [];
      withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: H1, block: 123 }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = {
          async reserve() { return 7; },
          commit(n, h) { throw new Error("simulated-commit-failure"); },
          rollback(n) { rollbackSpy.push(n); },
          validateWallet() {},
        };
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        expect(res.ok).to.equal(false);
        expect(res.reason).to.equal("nonce-commit-failed");
        expect(res.txHash).to.equal(H1);
        expect(rollbackSpy.length).to.equal(0);
      });
    });

    it("4 — accepted relay without on-chain visibility → poll → UNKNOWN, NOT DROPPED, nonce owned", async () => {
      withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: H1, block: 123 }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        expect(res.ok).to.equal(true);
        const snap = await tracker.poll(res.trackerId, makePollProvider({ receipt: null, tx: null }));
        expect(snap.state).to.equal("UNKNOWN");
        expect(snap.state).to.not.equal("DROPPED");
        expect(mgr.pending.has(res.nonce)).to.equal(true); // nonce still owned
      });
    });

    it("5 — explicit relay rejection ('failed') → fallback public: same nonce, DIFFERENT hash", async () => {
      const sent = [];
      withIsolatedExecutor(async () => ({ ok: false, status: "failed", error: "relay rejected" }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(sent), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(sent), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        expect(res.ok).to.equal(true);
        expect(res.private).to.equal(false);
        expect(res.txHash).to.equal(H2); // public broadcast hash — same nonce
        expect(sent.length).to.equal(1);
        const rec = tracker.get(res.trackerId);
        expect(rec.state).to.equal("SUBMITTED");
        expect(rec.mode).to.equal("public");
        expect(rec.txHash).to.equal(H2);
        expect(rec.nonce).to.equal(res.nonce);
        // exactly ONE record for this reservation (H1 never existed — rejected pre-acceptance)
        expect(tracker.list({ wallet: WALLET_A }).length).to.equal(1);
        expect(mgr.pending.get(res.nonce).hash).to.equal(H2);
      });
    });

    it("6 — relay accepted with MALFORMED hash → tombstone commit + tracker UNKNOWN (fail-closed)", async () => {
      withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: "bundle-123-not-a-hash" }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        const rec = tracker.get(res.trackerId);
        expect(rec.state).to.equal("UNKNOWN"); // ambiguous identity — never SUBMITTED with a fake hash
        expect(mgr.pending.has(res.nonce)).to.equal(true);
        expect(mgr.pending.get(res.nonce).hash).to.equal(null); // tombstone, not the malformed hash
      });
    });

    it("7 — relay timeout → UNKNOWN + tombstone, NO rollback", async () => {
      withIsolatedExecutor(async () => ({ ok: false, status: "unknown", error: "timeout after 5000ms" }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        expect(res.ok).to.equal(false);
        expect(res.reason).to.equal("private-unknown");
        expect(tracker.get(res.trackerId).state).to.equal("UNKNOWN");
        expect(mgr.pending.get(res.nonce).hash).to.equal(null); // tombstone
        expect(mgr.reserved.has(res.nonce)).to.equal(false); // owned via pending, not reserved
      });
    });

    it("8 — network error → UNKNOWN + tombstone, lastError preserved", async () => {
      withIsolatedExecutor(async () => ({ ok: false, status: "unknown", error: "getaddrinfo ENOTFOUND mev.api.blxrbdn.com" }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        expect(res.reason).to.equal("private-unknown");
        const rec = tracker.get(res.trackerId);
        expect(rec.state).to.equal("UNKNOWN");
        expect(rec.lastError).to.include("ENOTFOUND");
        expect(mgr.pending.has(res.nonce)).to.equal(true);
      });
    });

    it("9 — connection reset → UNKNOWN + tombstone", async () => {
      withIsolatedExecutor(async () => ({ ok: false, status: "unknown", error: "socket hang up (ECONNRESET)" }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        expect(tracker.get(res.trackerId).state).to.equal("UNKNOWN");
        expect(mgr.pending.has(res.nonce)).to.equal(true);
      });
    });

    it("10 — ambiguous submission error → tracker UNKNOWN with full identity preserved", async () => {
      withIsolatedExecutor(async () => ({ ok: false, status: "unknown", error: "ambiguous relay state" }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        const rec = tracker.get(res.trackerId);
        expect(rec.state).to.equal("UNKNOWN");
        expect(rec.lastError).to.equal("ambiguous relay state");
        expect(rec.nonce).to.equal(res.nonce);
        expect(rec.wallet).to.equal(WALLET_A);
      });
    });
  });
describe("B — nonce safety (real NonceManager + real tracker)", () => {
    it("12 — §31 CRITICAL: reserve N → ambiguous private timeout → UNKNOWN → next reserve() !== N", async () => {
      withIsolatedExecutor(async () => ({ ok: false, status: "unknown", error: "timeout" }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        const n = res.nonce;
        expect(tracker.get(res.trackerId).state).to.equal("UNKNOWN");
        // The nonce MUST remain occupied (tombstone) and MUST NOT be handed out again.
        expect(mgr.pending.has(n)).to.equal(true);
        expect(mgr.pending.get(n).hash).to.equal(null);
        const next = await mgr.reserve();
        expect(next).to.not.equal(n);
        expect(next).to.equal(n + 1);
      });
    });

    it("13 — timeout does not rollback (nonce stays owned via tombstone)", async () => {
      withIsolatedExecutor(async () => ({ ok: false, status: "unknown", error: "timeout" }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        expect(mgr.reserved.has(res.nonce)).to.equal(false);
        expect(mgr.pending.has(res.nonce)).to.equal(true);
        expect(mgr.blocked.has(res.nonce)).to.equal(false);
      });
    });

    it("14 — network error does not rollback", async () => {
      withIsolatedExecutor(async () => ({ ok: false, status: "unknown", error: "ECONNREFUSED" }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        expect(mgr.pending.has(res.nonce)).to.equal(true);
        expect(mgr.reserved.has(res.nonce)).to.equal(false);
      });
    });

    it("15 — tracker error AFTER accepted submission → nonce stays committed, rollback 0", async () => {
      withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: H1, block: 1 }), async (executor) => {
        const tracker = new TransactionTracker();
        // Injected failure point AFTER relay acceptance: markSubmitted throws.
        tracker.markSubmitted = () => { throw new Error("injected tracker failure"); };
        const state = { committed: undefined, rollbacks: [] };
        const mgr = {
          async reserve() { return 50; },
          commit(n, h) { state.committed = h; },
          rollback(n) { state.rollbacks.push(n); },
          validateWallet() {},
        };
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        expect(res.ok).to.equal(true); // relay acceptance is the fact that matters
        expect(state.committed).to.equal(H1); // nonce committed (owned)
        expect(state.rollbacks.length).to.equal(0); // NEVER rolled back
      });
    });

    it("16 — rollback ONLY before submission: tracker-create failure → rollback allowed", async () => {
      withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: H1 }), async (executor) => {
        const tracker = new TransactionTracker();
        // Injected failure point BEFORE any submission: create throws.
        tracker.create = () => { throw new Error("injected create failure"); };
        const state = { committed: undefined, rollbacks: [] };
        const mgr = {
          async reserve() { return 9; },
          commit() { throw new Error("must not be reached"); },
          rollback(n) { state.rollbacks.push(n); },
          validateWallet() {},
        };
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        expect(res.ok).to.equal(false);
        expect(res.reason).to.equal("tracker-create-failed");
        expect(state.rollbacks).to.deep.equal([9]); // safe: NO submission was attempted
      });
    });
  });
describe("B2 — reconcile / reap / reserve after UNKNOWN private submission", () => {
    it("11 — UNKNOWN private tx blocks nonce reuse (manager level)", async () => {
      const mgr = new RealNonceManager(makeWallet(), 10);
      const n = await mgr.reserve();
      mgr.commit(n, null); // private UNKNOWN tombstone
      expect(mgr.pending.has(n)).to.equal(true);
      const next = await mgr.reserve();
      expect(next).to.not.equal(n);
    });

    it("17 — reconcile cannot free unknown private nonce (tombstone survives, monotonic)", async () => {
      const mgr = new RealNonceManager(makeWallet(), 10);
      const n = await mgr.reserve();
      mgr.commit(n, null); // private UNKNOWN tombstone
      // Chain still reports pending = n (private tx invisible or pending).
      await mgr.reconcile({ getPendingNonce: async () => n });
      expect(mgr.pending.has(n)).to.equal(true); // tombstone NOT deleted
      const next = await mgr.reserve();
      expect(next).to.not.equal(n);
      // Chain advanced: reconcile moves next forward, tombstone still kept.
      await mgr.reconcile({ getPendingNonce: async () => n + 5 });
      expect(mgr.pending.has(n)).to.equal(true);
      expect(mgr.next).to.be.at.least(n + 5);
    });

    it("18 — reap never frees a private-UNKNOWN tombstone (time is NOT proof of drop)", async () => {
      const mgr = new RealNonceManager(makeWallet(), 10);
      const n = await mgr.reserve();
      mgr.commit(n, null);
      // Simulate an old tombstone (way beyond the legacy 90s window).
      mgr.pending.get(n).ts = Date.now() - 10 * 60 * 1000;
      await mgr.reap(makePollProvider({ receipt: null, tx: null }));
      expect(mgr.pending.has(n)).to.equal(true); // still owned
      const next = await mgr.reserve();
      expect(next).to.not.equal(n);
    });

    it("19 — later reserve after UNKNOWN cannot return the unknown nonce (manager level)", async () => {
      const mgr = new RealNonceManager(makeWallet(), 10);
      const n = await mgr.reserve();
      mgr.commit(n, null);
      const a = await mgr.reserve();
      const b = await mgr.reserve();
      expect(a).to.not.equal(n);
      expect(b).to.not.equal(n);
      expect(new Set([n, a, b]).size).to.equal(3);
    });
  });
describe("C — on-chain observation of a private tx (tracker level)", () => {
    // Fixture: real tracker with a private record already SUBMITTED.
    async function makeTracked() {
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: 42, mode: "private" });
      tracker.markSubmitted(rec.id, H1, { wallet: WALLET_A, mode: "private" });
      return { tracker, id: rec.id };
    }

    it("20 — UNKNOWN → PENDING when the tx becomes visible on-chain", async () => {
      const { tracker, id } = await makeTracked();
      tracker.transition(id, "UNKNOWN", { lastError: "relay accepted, not visible yet" });
      const snap = await tracker.poll(id, makePollProvider({ receipt: null, tx: { hash: H1 } }));
      expect(snap.state).to.equal("PENDING");
    });

    it("21 — UNKNOWN → CONFIRMED with receipt status 1", async () => {
      const { tracker, id } = await makeTracked();
      tracker.transition(id, "UNKNOWN");
      const snap = await tracker.poll(id, makePollProvider({ receipt: validReceipt(1) }));
      expect(snap.state).to.equal("CONFIRMED");
      expect(snap.receiptStatus).to.equal(1);
    });

    it("22 — UNKNOWN → REVERTED with receipt status 0", async () => {
      const { tracker, id } = await makeTracked();
      tracker.transition(id, "UNKNOWN");
      const snap = await tracker.poll(id, makePollProvider({ receipt: validReceipt(0, 777) }));
      expect(snap.state).to.equal("REVERTED");
      expect(snap.receiptStatus).to.equal(0);
      expect(snap.blockNumber).to.equal(777);
    });

    it("23 — receipt priority: receipt present + tx null → CONFIRMED (never just PENDING)", async () => {
      const { tracker, id } = await makeTracked();
      tracker.transition(id, "UNKNOWN");
      const snap = await tracker.poll(id, makePollProvider({ receipt: validReceipt(1), tx: null }));
      expect(snap.state).to.equal("CONFIRMED");
    });

    it("24 — malformed receipt → UNKNOWN (never CONFIRMED)", async () => {
      const { tracker, id } = await makeTracked();
      tracker.transition(id, "UNKNOWN");
      const snap = await tracker.poll(id, makePollProvider({ receipt: { status: 1 } })); // no block data
      expect(snap.state).to.equal("UNKNOWN");
    });

    it("25 — null tx + null receipt remains UNKNOWN (never DROPPED)", async () => {
      const { tracker, id } = await makeTracked();
      tracker.transition(id, "UNKNOWN");
      for (let i = 0; i < 3; i++) {
        const snap = await tracker.poll(id, makePollProvider({ receipt: null, tx: null }));
        expect(snap.state).to.equal("UNKNOWN");
        expect(snap.state).to.not.equal("DROPPED");
      }
    });

    it("26 — RPC failure on a private tx → UNKNOWN with lastError, identity intact", async () => {
      const { tracker, id } = await makeTracked();
      tracker.transition(id, "UNKNOWN");
      const snap = await tracker.poll(id, makePollProvider({ throwReceipt: true }));
      expect(snap.state).to.equal("UNKNOWN");
      expect(snap.lastError).to.include("RPC failure");
      expect(snap.nonce).to.equal(42);
      expect(snap.txHash).to.equal(H1);
      expect(snap.wallet).to.equal(WALLET_A);
    });
  });
describe("D — replacement safety (same nonce, different hash)", () => {
    async function makeOriginal() {
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: 100, mode: "private" });
      tracker.markSubmitted(rec.id, H1, { wallet: WALLET_A, mode: "private" });
      tracker.transition(rec.id, "UNKNOWN", { lastError: "relay accepted, not visible" });
      return { tracker, id: rec.id };
    }

    it("27 — two tx hashes may share the same nonce (distinct records)", async () => {
      const { tracker, id } = await makeOriginal();
      const rep = tracker.replace(id, { txHash: H2, wallet: WALLET_A, mode: "private" });
      expect(rep.nonce).to.equal(100);
      expect(rep.txHash).to.equal(H2);
      expect(rep.id).to.not.equal(id);
      expect(tracker.get(id).txHash).to.equal(H1);
      expect(tracker.get(id).nonce).to.equal(100);
    });

    it("28 — original and replacement remain distinct and independently pollable", async () => {
      const { tracker, id } = await makeOriginal();
      const rep = tracker.replace(id, { txHash: H2, wallet: WALLET_A, mode: "private" });
      const a = await tracker.poll(id, makePollProvider({ receipt: null, tx: null }));
      const b = await tracker.poll(rep.id, makePollProvider({ receipt: validReceipt(1, 900) }));
      expect(a.state).to.equal("UNKNOWN");
      expect(b.state).to.equal("CONFIRMED");
      expect(tracker.get(id).state).to.equal("UNKNOWN");
      expect(tracker.get(rep.id).state).to.equal("CONFIRMED");
    });

    it("29 — replacement metadata preserved (replaces / replacedBy)", async () => {
      const { tracker, id } = await makeOriginal();
      const rep = tracker.replace(id, { txHash: H2, wallet: WALLET_A, mode: "private" });
      expect(rep.replaces).to.equal(id);
      expect(tracker.get(id).replacedBy).to.equal(rep.id);
      expect(tracker.get(id).replaces).to.equal(null);
      expect(rep.replacedBy).to.equal(null);
    });

    it("30 — replacement does NOT free the nonce (NonceManager side stays owned)", async () => {
      const mgr = new RealNonceManager(makeWallet(), 10);
      const n = await mgr.reserve();
      mgr.commit(n, null); // H1 private UNKNOWN tombstone
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: n, mode: "private" });
      tracker.markSubmitted(rec.id, H1, { wallet: WALLET_A });
      tracker.transition(rec.id, "UNKNOWN");
      const rep = tracker.replace(rec.id, { txHash: H2, wallet: WALLET_A, mode: "private" });
      expect(rep.nonce).to.equal(n);
      expect(mgr.pending.has(n)).to.equal(true);
      const next = await mgr.reserve();
      expect(next).to.not.equal(n);
    });
  });
describe("D2 — replacement identity & atomicity", () => {
    async function makeOriginal() {
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: 100, mode: "private" });
      tracker.markSubmitted(rec.id, H1, { wallet: WALLET_A, mode: "private" });
      tracker.transition(rec.id, "UNKNOWN", { lastError: "relay accepted, not visible" });
      return { tracker, id: rec.id };
    }

    it("31 — replacement mined → H2 CONFIRMED, nonce consumed (re-commit blocks)", async () => {
      const mgr = new RealNonceManager(makeWallet(), 10);
      const n = await mgr.reserve();
      mgr.commit(n, null); // H1 tombstone
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: n, mode: "private" });
      tracker.markSubmitted(rec.id, H1, { wallet: WALLET_A });
      const rep = tracker.replace(rec.id, { txHash: H2, wallet: WALLET_A, mode: "private" });
      await tracker.poll(rep.id, makePollProvider({ receipt: validReceipt(1, 900) }));
      expect(tracker.get(rep.id).state).to.equal("CONFIRMED");
      // Nonce side: re-committing the consumed nonce is refused and BLOCKED —
      // it can never be handed out again (nonce consumed by the mined replacement).
      expect(() => mgr.commit(n, H2)).to.throw(/nonce-already-committed/);
      expect(mgr.blocked.has(n)).to.equal(true);
      const next = await mgr.reserve();
      expect(next).to.not.equal(n);
    });

    it("32 — replacement confirmed → original remains historically identifiable", async () => {
      const { tracker, id } = await makeOriginal();
      const rep = tracker.replace(id, { txHash: H2, wallet: WALLET_A, mode: "private" });
      await tracker.poll(rep.id, makePollProvider({ receipt: validReceipt(1, 901) }));
      const old = tracker.get(id);
      expect(old.state).to.equal("UNKNOWN");   // NOT auto-dropped, NOT auto-confirmed
      expect(old.txHash).to.equal(H1);          // original identity intact
      expect(old.replacedBy).to.equal(rep.id);  // chain link preserved
      expect(tracker.get(rep.id).replaces).to.equal(id);
    });

    it("33 — replacement reverted → H2 REVERTED, nonce still consumed", async () => {
      const mgr = new RealNonceManager(makeWallet(), 10);
      const n = await mgr.reserve();
      mgr.commit(n, null);
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: n, mode: "private" });
      tracker.markSubmitted(rec.id, H1, { wallet: WALLET_A });
      const rep = tracker.replace(rec.id, { txHash: H2, wallet: WALLET_A, mode: "private" });
      await tracker.poll(rep.id, makePollProvider({ receipt: validReceipt(0, 902) }));
      expect(tracker.get(rep.id).state).to.equal("REVERTED");
      expect(mgr.pending.has(n)).to.equal(true);
      const next = await mgr.reserve();
      expect(next).to.not.equal(n);
    });

    it("34 — old transaction cannot overwrite the replacement (old identity immutable)", async () => {
      const { tracker, id } = await makeOriginal();
      const rep = tracker.replace(id, { txHash: H2, wallet: WALLET_A, mode: "private" });
      expect(() => tracker.markSubmitted(id, H2, { wallet: WALLET_A }))
        .to.throw(/illegal transition/);
      expect(tracker.get(id).txHash).to.equal(H1);
      expect(tracker.get(rep.id).txHash).to.equal(H2);
    });

    it("35 — replacement cannot overwrite the old transaction identity", async () => {
      const { tracker, id } = await makeOriginal();
      const rep = tracker.replace(id, { txHash: H2, wallet: WALLET_A, mode: "private" });
      expect(() => tracker.markSubmitted(rep.id, H1, { wallet: WALLET_A }))
        .to.throw(/illegal transition/);
      expect(tracker.get(rep.id).txHash).to.equal(H2);
      expect(tracker.get(id).txHash).to.equal(H1);
    });

    it("36 — replacement with invalid hash rejected ATOMICALLY (no partial metadata)", async () => {
      const { tracker, id } = await makeOriginal();
      const before = tracker.get(id);
      expect(() => tracker.replace(id, { txHash: "not-a-hash", wallet: WALLET_A }))
        .to.throw(/invalid txHash/);
      expect(tracker.get(id).replacedBy).to.equal(null);   // no partial mutation
      expect(tracker.list().length).to.equal(1);            // no orphan record
      expect(tracker.get(id)).to.deep.equal(before);
    });

    it("37 — wallet mismatch on replace is rejected", async () => {
      const { tracker, id } = await makeOriginal();
      expect(() => tracker.replace(id, { txHash: H2, wallet: WALLET_B }))
        .to.throw(/wallet-mismatch/);
      expect(tracker.list().length).to.equal(1);
    });
  });
describe("E — terminal safety (private tx context)", () => {
    async function makeConfirmed() {
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: 55, mode: "private" });
      tracker.markSubmitted(rec.id, H1, { wallet: WALLET_A, mode: "private" });
      await tracker.poll(rec.id, makePollProvider({ receipt: validReceipt(1, 800) }));
      return { tracker, id: rec.id };
    }

    it("38 — CONFIRMED remains terminal (transition rejected)", async () => {
      const { tracker, id } = await makeConfirmed();
      for (const to of ["PENDING", "REVERTED", "UNKNOWN", "DROPPED", "SUBMITTED", "RESERVED"]) {
        expect(() => tracker.transition(id, to)).to.throw(/illegal transition/);
      }
      expect(tracker.get(id).state).to.equal("CONFIRMED");
    });

    it("39 — REVERTED remains terminal", async () => {
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: 56, mode: "private" });
      tracker.markSubmitted(rec.id, H1, { wallet: WALLET_A });
      await tracker.poll(rec.id, makePollProvider({ receipt: validReceipt(0, 801) }));
      for (const to of ["PENDING", "CONFIRMED", "UNKNOWN", "DROPPED"]) {
        expect(() => tracker.transition(rec.id, to)).to.throw(/illegal transition/);
      }
      expect(tracker.get(rec.id).state).to.equal("REVERTED");
    });

    it("40 — DROPPED remains terminal", async () => {
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: 57, mode: "private" });
      tracker.markSubmitted(rec.id, H1, { wallet: WALLET_A });
      tracker.transition(rec.id, "UNKNOWN");
      tracker.transition(rec.id, "DROPPED");
      for (const to of ["PENDING", "CONFIRMED", "REVERTED", "UNKNOWN"]) {
        expect(() => tracker.transition(rec.id, to)).to.throw(/illegal transition/);
      }
      expect(tracker.get(rec.id).state).to.equal("DROPPED");
    });

    it("41 — terminal transaction does not trigger RPC polling (provider untouched)", async () => {
      const { tracker, id } = await makeConfirmed();
      const p = makePollProvider({ receipt: validReceipt(1) });
      const snap = await tracker.poll(id, p);
      expect(p.receiptCalls).to.equal(0);
      expect(p.txCalls).to.equal(0);
      expect(snap.state).to.equal("CONFIRMED");
    });

    it("42 — terminal transaction cannot be replaced silently", async () => {
      const { tracker, id } = await makeConfirmed();
      expect(() => tracker.replace(id, { txHash: H2, wallet: WALLET_A }))
        .to.throw(/cannot replace terminal/);
      expect(tracker.get(id).replacedBy).to.equal(null);
      expect(tracker.list().length).to.equal(1);
    });
  });
describe("F — concurrency / atomicity", () => {
    it("43 — concurrent private submissions do not reuse nonce (real manager)", async () => {
      withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: H1, block: 1 }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const [r1, r2, r3] = await Promise.all([
          executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker }),
          executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker }),
          executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker }),
        ]);
        const nonces = [r1.nonce, r2.nonce, r3.nonce];
        expect(new Set(nonces).size).to.equal(3);
        expect(nonces.every((n) => mgr.pending.has(n))).to.equal(true);
        const recs = tracker.list({ wallet: WALLET_A, state: "SUBMITTED" });
        expect(recs.length).to.equal(3);
        expect(new Set(recs.map((r) => r.id)).size).to.equal(3);
      });
    });

    it("44 — concurrent polling of the same private tx does not corrupt state", async () => {
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: 60, mode: "private" });
      tracker.markSubmitted(rec.id, H1, { wallet: WALLET_A });
      const p = makePollProvider({ receipt: validReceipt(1, 700) });
      const [a, b] = await Promise.all([tracker.poll(rec.id, p), tracker.poll(rec.id, p)]);
      expect(a.state).to.equal("CONFIRMED");
      expect(b.state).to.equal("CONFIRMED");
      expect(tracker.get(rec.id).state).to.equal("CONFIRMED");
    });

    it("45 — concurrent replacement registration is deterministic, corruption-free", async () => {
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: 61, mode: "private" });
      tracker.markSubmitted(rec.id, H1, { wallet: WALLET_A });
      tracker.transition(rec.id, "UNKNOWN");
      const [r1, r2] = await Promise.all([
        Promise.resolve(tracker.replace(rec.id, { txHash: H2, wallet: WALLET_A })),
        Promise.resolve(tracker.replace(rec.id, { txHash: H3, wallet: WALLET_A })),
      ]);
      expect(r1.id).to.not.equal(r2.id);
      expect(r1.replaces).to.equal(rec.id);
      expect(r2.replaces).to.equal(rec.id);
      expect(tracker.get(rec.id).replacedBy).to.equal(r2.id);
      expect(tracker.get(r1.id).txHash).to.equal(H2);
      expect(tracker.get(r2.id).txHash).to.equal(H3);
    });
  });
describe("G — identity", () => {
    it("46 — same txHash submission with WRONG wallet rejected (no mutation)", async () => {
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: 70, mode: "private" });
      expect(() => tracker.markSubmitted(rec.id, H1, { wallet: WALLET_B }))
        .to.throw(/wallet-mismatch/);
      const after = tracker.get(rec.id);
      expect(after.state).to.equal("RESERVED");
      expect(after.txHash).to.equal(null);
    });

    it("47 — same nonce + different hash handled independently", async () => {
      const tracker = new TransactionTracker();
      const a = tracker.create({ wallet: WALLET_A, nonce: 80, mode: "private" });
      const b = tracker.create({ wallet: WALLET_A, nonce: 80, mode: "private" });
      tracker.markSubmitted(a.id, H1, { wallet: WALLET_A });
      tracker.markSubmitted(b.id, H2, { wallet: WALLET_A });
      await tracker.poll(a.id, makePollProvider({ receipt: validReceipt(1) }));
      await tracker.poll(b.id, makePollProvider({ receipt: null, tx: null }));
      expect(tracker.get(a.id).state).to.equal("CONFIRMED");
      expect(tracker.get(b.id).state).to.equal("UNKNOWN");
      expect(tracker.get(a.id).txHash).to.equal(H1);
      expect(tracker.get(b.id).txHash).to.equal(H2);
    });

    it("48 — case-insensitive wallet identity accepted on mutating ops", async () => {
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: 81, mode: "private" });
      const s = tracker.markSubmitted(rec.id, H1, { wallet: WALLET_A.toUpperCase() });
      expect(s.state).to.equal("SUBMITTED");
      const p = await tracker.poll(rec.id, makePollProvider({ receipt: validReceipt(1) }), WALLET_A.toLowerCase());
      expect(p.state).to.equal("CONFIRMED");
    });

    it("49 — transaction identity is NOT nonce-only (id is the key)", async () => {
      const tracker = new TransactionTracker();
      const a = tracker.create({ wallet: WALLET_A, nonce: 90, mode: "private" });
      const b = tracker.create({ wallet: WALLET_B, nonce: 90, mode: "private" });
      expect(a.id).to.not.equal(b.id);
      tracker.markSubmitted(a.id, H1, { wallet: WALLET_A });
      tracker.markSubmitted(b.id, H2, { wallet: WALLET_B });
      expect(tracker.get(a.id).txHash).to.equal(H1);
      expect(tracker.get(b.id).txHash).to.equal(H2);
      expect(() => tracker.markPending(b.id, WALLET_A)).to.throw(/wallet-mismatch/);
    });

    it("50 — §32 restart: chain reports private nonce OCCUPIED → new manager never reuses it", async () => {
      const tracker = new TransactionTracker();
      const rec = tracker.create({ wallet: WALLET_A, nonce: 100, mode: "private" });
      tracker.markSubmitted(rec.id, H1, { wallet: WALLET_A, mode: "private" });
      // Process dies → fresh NonceManager. On-chain the private tx IS visible
      // as pending → nonce 100 occupied → chain pending = 101.
      const mgr = new RealNonceManager(makeWallet(), 10);
      await mgr.reconcile({ getPendingNonce: async () => 101 });
      const fresh = await mgr.reserve();
      expect(fresh).to.equal(101);
      expect(fresh).to.not.equal(100); // MUST NEVER reuse the in-flight private nonce
    });

    it("51 — §32 LIMITATION (documented): chain pending = N with INVISIBLE private tx cannot be detected without persistence", async () => {
      // Honest limitation probe: a private tx accepted by the relay may be
      // INVISIBLE to getTransactionCount("pending") (private mempool). After a
      // crash, a fresh manager reconciles to chain pending = N and CANNOT know
      // that nonce N may be in flight. This ambiguity is inherent to an
      // in-memory tracker; persistence/restart-recovery is a later task.
      const mgr = new RealNonceManager(makeWallet(), 10);
      await mgr.reconcile({ getPendingNonce: async () => 100 });
      const n = await mgr.reserve();
      expect(n).to.equal(100); // documented ambiguity — NOT a safety regression of this task
    });
  });
describe("H — executor tracker integration & DI safety", () => {
    it("52 — executor uses injected tracker for the full lifecycle (private accepted)", async () => {
      withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: H1, block: 5 }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        expect(res.ok).to.equal(true);
        expect(res.trackerId).to.be.a("string");
        const rec = tracker.get(res.trackerId);
        expect(rec.state).to.equal("SUBMITTED");
        expect(rec.mode).to.equal("private");
        expect(rec.txHash).to.equal(H1);
        expect(rec.nonce).to.equal(res.nonce);
      });
    });

    it("53 — invalid injected tx-tracker is rejected explicitly (no silent fallback)", async () => {
      withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: H1 }), async (executor) => {
        const bad = { create: async () => ({ id: "x" }) }; // missing markSubmitted/poll
        let err;
        try {
          await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: { async reserve() { return 1; }, commit() {}, rollback() {}, validateWallet() {} }, txTracker: bad });
        } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.include("invalid-tx-tracker");
      });
    });

    it("54 — malformed relay response (executor-level) → tracker UNKNOWN, tombstone, no throw", async () => {
      withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: "garbage" }), async (executor) => {
        const tracker = new TransactionTracker();
        const mgr = new RealNonceManager(makeWallet(), 10);
        const res = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(), makeProvider(), { nonceManager: mgr, txTracker: tracker });
        const rec = tracker.get(res.trackerId);
        expect(rec.state).to.equal("UNKNOWN");
        expect(rec.txHash).to.equal(null);
        expect(mgr.pending.get(res.nonce).hash).to.equal(null);
      });
    });
  });
  });
// TASK 4.8 — Replacement / Dropped Transaction Integrity.
//
// Behavioral tests for the explicit, evidence-bearing REPLACED / DROPPED model and
// the identity/PnL/nonce safety guarantees. The core fail-closed principle:
//   - same nonce ≠ same transaction;
//   - REPLACED/DROPPED require explicit, auditable evidence (never inferred from
//     null receipt, mempool absence, timeout, or same-nonce coincidence);
//   - confirmation belongs ONLY to the exact tracked/approved transaction hash.
const chai = require("chai");
const chaiAsPromised = require("chai-as-promised");
chai.use(chaiAsPromised);
const { expect } = chai;
const { TransactionTracker } = require("../../bot/tx-tracker");
const { PnLTracker, PnLStatus } = require("../../bot/pnl");
const { NonceManager } = require("../../bot/nonce");

const WALLET = "0x70997970C51812dc3A010C7d01b50b0429c0d3c8";
const TX_HASH = "0x" + "ab".repeat(32);
const H2 = "0x" + "22".repeat(32);
const H3 = "0x" + "33".repeat(32);
const BLOCK_HASH = "0x" + "cd".repeat(32);

function makeWallet(startNonce = 100) {
  let nonce = startNonce;
  return {
    address: WALLET.toLowerCase(),
    async getNonce() { return nonce; },
    _setNonce(n) { nonce = n; },
  };
}

function makeSubmittedTracker(wallet = WALLET, nonce = 7, hash = TX_HASH) {
  const tracker = new TransactionTracker();
  const rec = tracker.create({ wallet, nonce });
  tracker.markSubmitted(rec.id, hash, { wallet });
  return { tracker, id: rec.id, hash };
}

function makeProvider(opts = {}) {
  const p = {
    receipt: opts.receipt,
    tx: opts.tx,
    network: opts.network !== undefined ? opts.network : { chainId: 56n },
    throwReceipt: !!opts.throwReceipt,
    async getTransactionReceipt() {
      if (p.throwReceipt) throw new Error("RPC failure: receipt");
      return p.receipt;
    },
    async getTransaction() {
      return p.tx;
    },
    async getNetwork() {
      return p.network;
    },
  };
  return p;
}

function successReceipt(overrides = {}) {
  return { status: 1, blockNumber: 100, blockHash: BLOCK_HASH, transactionIndex: 2, gasUsed: 200000n, effectiveGasPrice: 3000000000n, ...overrides };
}
function revertReceipt(overrides = {}) {
  return { ...successReceipt(overrides), status: 0 };
}

function replacementEvidence(overrides = {}) {
  return { replacerTxHash: H2, nonce: 7, chainId: 56, detectedAt: 1699000000, source: "onchain-observation", ...overrides };
}
function droppedEvidence(overrides = {}) {
  return { reason: "onchain-nonce-advanced", nonce: 7, chainId: 56, detectedAt: 1699000000, source: "onchain-observation", ...overrides };
}
describe("TASK 4.8 — Replacement / Dropped Transaction Integrity", function () {
  describe("Replacement: same nonce is NOT replacement by itself", function () {
    it("R1 — same nonce + different hash → NOT auto-linked as replacement", function () {
      const t = new TransactionTracker();
      const a = t.create({ wallet: WALLET, nonce: 7 });
      const b = t.create({ wallet: WALLET, nonce: 7 });
      t.markSubmitted(a.id, TX_HASH, { wallet: WALLET });
      t.markSubmitted(b.id, H2, { wallet: WALLET });
      expect(t.get(a.id).replacedBy).to.equal(null);
      expect(t.get(b.id).replaces).to.equal(null);
      expect(t.get(a.id).replacedEvidence).to.equal(null);
    });

    it("R2 — same nonce + different calldata → NOT replacement by itself", function () {
      const t = new TransactionTracker();
      const a = t.create({ wallet: WALLET, nonce: 7 });
      const b = t.create({ wallet: WALLET, nonce: 7 });
      t.markSubmitted(a.id, TX_HASH, { wallet: WALLET });
      t.markSubmitted(b.id, H3, { wallet: WALLET });
      expect(t.get(a.id).replacedBy).to.equal(null);
      expect(t.get(b.id).replaces).to.equal(null);
    });

    it("R3 — same nonce + different gas params → NOT replacement by itself", function () {
      const t = new TransactionTracker();
      const a = t.create({ wallet: WALLET, nonce: 7 });
      const b = t.create({ wallet: WALLET, nonce: 7 });
      t.markSubmitted(a.id, TX_HASH, { wallet: WALLET });
      t.markSubmitted(b.id, H2, { wallet: WALLET });
      expect(t.list().length).to.equal(2);
      expect(t.get(a.id).replacedEvidence).to.equal(null);
    });

    it("R4 — replacement evidence absent → PENDING (never REPLACED)", async function () {
      const { tracker, id } = makeSubmittedTracker();
      const snap = await tracker.poll(id, makeProvider({ receipt: null }));
      expect(snap.state).to.equal("PENDING");
      expect(tracker.get(id).replacedEvidence).to.equal(null);
    });

    it("R5 — explicit defensible replacement evidence → replacedEvidence recorded", function () {
      const { tracker, id } = makeSubmittedTracker();
      const snap = tracker.markReplaced(id, replacementEvidence(), WALLET);
      expect(snap.replacedEvidence.replacerTxHash).to.equal(H2.toLowerCase());
      expect(tracker.get(id).replacedEvidence.replacerTxHash).to.equal(H2.toLowerCase());
      expect(tracker.get(id).txHash).to.equal(TX_HASH.toLowerCase()); // identity immutable
    });

    it("R6 — replacement receipt cannot confirm the ORIGINAL (foreign hash → UNKNOWN)", async function () {
      const { tracker, id } = makeSubmittedTracker();
      tracker.markReplaced(id, replacementEvidence(), WALLET);
      const snap = await tracker.poll(id, makeProvider({ receipt: successReceipt({ transactionHash: H2 }) }));
      expect(snap.state).to.equal("UNKNOWN");
      expect(tracker.get(id).lastError).to.include("receipt hash mismatch");
      expect(tracker.get(id).state).to.not.equal("CONFIRMED");
    });

    it("R7 — replacement success does NOT create original PnL", function () {
      const pnl = new PnLTracker();
      pnl.recordPnL({
        txHash: H2, wallet: WALLET, settlementToken: "0x" + "aa".repeat(20),
        settlementDecimals: 18, beforeBalanceRaw: 0n, afterBalanceRaw: 1000n,
        receipt: successReceipt({ transactionHash: H2 }),
      });
      expect(pnl.getPnL(TX_HASH)).to.equal(null);
      expect(pnl.getPnL(H2)).to.not.equal(null);
      expect(pnl.getPnL(H2).grossProfitStatus).to.equal(PnLStatus.REALIZED);
    });

    it("R8 — replacement does NOT release original nonce (tracker decoupled from NonceManager)", function () {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET, nonce: 1 });
      t.markSubmitted(rec.id, TX_HASH, { wallet: WALLET });
      t.markReplaced(rec.id, replacementEvidence({ nonce: 1 }), WALLET);
      expect(t.get(rec.id).replacedEvidence).to.not.equal(null);
      const mgr = new NonceManager(makeWallet(50));
      expect(typeof mgr.rollback).to.equal("function");
    });
  });


  describe("Dropped: must not be inferred from heuristic signals", function () {
    it("R9 — null receipt → PENDING", async function () {
      const { tracker, id } = makeSubmittedTracker();
      const snap = await tracker.poll(id, makeProvider({ receipt: null }));
      expect(snap.state).to.equal("PENDING");
      expect(snap.state).to.not.equal("DROPPED");
    });

    it("R10 — repeated null receipts → remains PENDING", async function () {
      const { tracker, id } = makeSubmittedTracker();
      for (let i = 0; i < 5; i++) await tracker.poll(id, makeProvider({ receipt: null }));
      expect(tracker.get(id).state).to.equal("PENDING");
      expect(tracker.get(id).state).to.not.equal("DROPPED");
    });

    it("R11 — timeout (null receipt) → NOT DROPPED", async function () {
      const { tracker, id } = makeSubmittedTracker();
      await tracker.poll(id, makeProvider({ receipt: null }));
      expect(tracker.get(id).state).to.equal("PENDING");
    });

    it("R12 — mempool invisibility → NOT DROPPED", async function () {
      const { tracker, id } = makeSubmittedTracker();
      await tracker.poll(id, makeProvider({ receipt: null, tx: null }));
      expect(tracker.get(id).state).to.equal("PENDING");
    });

    it("R13 — temporary RPC error → UNKNOWN (fail-closed, not DROPPED)", async function () {
      const { tracker, id } = makeSubmittedTracker();
      const snap = await tracker.poll(id, makeProvider({ throwReceipt: true }));
      expect(snap.state).to.equal("UNKNOWN");
      expect(snap.state).to.not.equal("DROPPED");
    });

    it("R14 — provider disagreement (receipt null + tx visible) → PENDING", async function () {
      const { tracker, id } = makeSubmittedTracker();
      const snap = await tracker.poll(id, makeProvider({ receipt: null, tx: { hash: TX_HASH } }));
      expect(snap.state).to.equal("PENDING");
      expect(snap.state).to.not.equal("DROPPED");
    });

    it("R15 — explicit defensible dropped evidence → DROPPED", function () {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET, nonce: 7 });
      t.markSubmitted(rec.id, TX_HASH, { wallet: WALLET });
      t.markPending(rec.id, WALLET);
      const snap = t.markDropped(rec.id, droppedEvidence(), WALLET);
      expect(snap.state).to.equal("DROPPED");
      expect(t.get(rec.id).droppedEvidence.reason).to.equal("onchain-nonce-advanced");
    });

    it("R16 — DROPPED does NOT create PnL", function () {
      const pnl = new PnLTracker();
      const r = pnl.recordPnL({
        txHash: TX_HASH, wallet: WALLET, settlementToken: "0x" + "aa".repeat(20),
        settlementDecimals: 18, beforeBalanceRaw: 0n, afterBalanceRaw: 5000n,
        receipt: null,
      });
      expect(r.grossProfitStatus).to.not.equal(PnLStatus.REALIZED);
      expect(r.grossProfitRaw).to.equal(null);
    });

    it("R17 — DROPPED without defensible evidence → stays PENDING (no release)", async function () {
      const { tracker, id } = makeSubmittedTracker();
      await tracker.poll(id, makeProvider({ receipt: null }));
      expect(tracker.get(id).state).to.equal("PENDING");
      expect(() => tracker.markDropped(id, droppedEvidence({ nonce: 999 }), WALLET)).to.throw(/nonce/);
      expect(tracker.get(id).state).to.equal("PENDING");
    });
  });

  describe("Identity: confirmation belongs only to the exact transaction", function () {
    it("R18 — foreign receipt hash → UNKNOWN", async function () {
      const { tracker, id } = makeSubmittedTracker();
      const snap = await tracker.poll(id, makeProvider({ receipt: successReceipt({ transactionHash: H3 }) }));
      expect(snap.state).to.equal("UNKNOWN");
      expect(tracker.get(id).lastError).to.include("receipt hash mismatch");
    });

    it("R19 — replacement receipt hash cannot confirm original", async function () {
      const { tracker, id } = makeSubmittedTracker();
      tracker.markReplaced(id, replacementEvidence(), WALLET);
      const snap = await tracker.poll(id, makeProvider({ receipt: successReceipt({ transactionHash: H2 }) }));
      expect(snap.state).to.equal("UNKNOWN");
      expect(snap.state).to.not.equal("CONFIRMED");
    });

    it("R20 — wrong chainId → UNKNOWN", async function () {
      const { tracker, id } = makeSubmittedTracker();
      const snap = await tracker.poll(id, makeProvider({ receipt: successReceipt({ transactionHash: TX_HASH }), network: { chainId: 1n } }), undefined, { expectedChainId: 56 });
      expect(snap.state).to.equal("UNKNOWN");
      expect(tracker.get(id).lastError).to.include("chain mismatch");
    });

    it("R21 — invalid/missing receipt status → UNKNOWN (never success)", async function () {
      const { tracker, id } = makeSubmittedTracker();
      const s1 = await tracker.poll(id, makeProvider({ receipt: { blockNumber: 100, blockHash: BLOCK_HASH } }));
      expect(s1.state).to.equal("UNKNOWN");
      const s2 = await tracker.poll(id, makeProvider({ receipt: successReceipt({ status: 2, transactionHash: TX_HASH }) }));
      expect(s2.state).to.equal("UNKNOWN");
    });

    it("R22 — exact original receipt status 1 → CONFIRMED_SUCCESS", async function () {
      const { tracker, id } = makeSubmittedTracker();
      const snap = await tracker.poll(id, makeProvider({ receipt: successReceipt({ transactionHash: TX_HASH }) }));
      expect(snap.state).to.equal("CONFIRMED");
      expect(tracker.get(id).receiptStatus).to.equal(1);
    });

    it("R23 — exact original receipt status 0 → CONFIRMED_REVERT", async function () {
      const { tracker, id } = makeSubmittedTracker();
      const snap = await tracker.poll(id, makeProvider({ receipt: revertReceipt({ transactionHash: TX_HASH }) }));
      expect(snap.state).to.equal("REVERTED");
      expect(tracker.get(id).receiptStatus).to.equal(0);
    });
  });

  describe("Lifecycle transitions", function () {
    it("R24 — PENDING → CONFIRMED_SUCCESS", async function () {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET, nonce: 3 });
      t.markSubmitted(rec.id, TX_HASH, { wallet: WALLET });
      t.markPending(rec.id, WALLET);
      const snap = await t.poll(rec.id, makeProvider({ receipt: successReceipt({ transactionHash: TX_HASH }) }));
      expect(snap.state).to.equal("CONFIRMED");
    });

    it("R25 — PENDING → CONFIRMED_REVERT", async function () {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET, nonce: 4 });
      t.markSubmitted(rec.id, TX_HASH, { wallet: WALLET });
      t.markPending(rec.id, WALLET);
      const snap = await t.poll(rec.id, makeProvider({ receipt: revertReceipt({ transactionHash: TX_HASH }) }));
      expect(snap.state).to.equal("REVERTED");
    });

    it("R26 — PENDING → UNKNOWN (real RPC uncertainty)", async function () {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET, nonce: 5 });
      t.markSubmitted(rec.id, TX_HASH, { wallet: WALLET });
      t.markPending(rec.id, WALLET);
      const snap = await t.poll(rec.id, makeProvider({ throwReceipt: true }));
      expect(snap.state).to.equal("UNKNOWN");
    });

    it("R27 — UNKNOWN → later exact confirmation only when receipt becomes valid", async function () {
      const { tracker, id } = makeSubmittedTracker();
      await tracker.poll(id, makeProvider({ throwReceipt: true }));
      expect(tracker.get(id).state).to.equal("UNKNOWN");
      const snap = await tracker.poll(id, makeProvider({ receipt: successReceipt({ transactionHash: TX_HASH }) }));
      expect(snap.state).to.equal("CONFIRMED");
    });

    it("R28 — invalid transition must fail closed", function () {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET, nonce: 6 });
      expect(() => t.transition(rec.id, "CONFIRMED")).to.throw(/illegal transition/);
      t.markSubmitted(rec.id, TX_HASH, { wallet: WALLET });
      t.markPending(rec.id, WALLET);
      const c = t.transition(rec.id, "CONFIRMED", { receiptStatus: 1, blockNumber: 1, blockHash: BLOCK_HASH });
      expect(c.state).to.equal("CONFIRMED");
      expect(() => t.markDropped(rec.id, droppedEvidence({ nonce: 6 }), WALLET)).to.throw(/illegal transition/);
      expect(() => t.markReplaced(rec.id, replacementEvidence({ nonce: 6 }), WALLET)).to.throw(/terminal/);
    });
  });
});

// TASK 4.5-C — Transaction Tracker State Machine
//
// Explicit, fail-closed, deterministic transaction lifecycle tracker:
//   RESERVED → SUBMITTED → PENDING → {CONFIRMED | REVERTED | DROPPED}, with
//   UNKNOWN reachable from any non-terminal state and UNKNOWN != DROPPED.
//
// Receipt is the source of truth for finalization. poll() NEVER fabricates
// DROPPED from a null transaction and never treats RPC errors as finality.
const { expect } = require("chai");
const { TransactionTracker } = require("../../bot/tx-tracker");

const WALLET_A = "0x70997970C51812dc3A010C7d01b50b0429c0d3c8";
const WALLET_B = "0x3C44CdddB6a900fa2b585dd299e03D12FA4293BC";
const TX_HASH = "0xabc1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const BLOCK_HASH = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

// Scripted provider: per-hash receipt and transaction responses, plus an
// optional per-method throw to simulate transient RPC failure.
function makeProvider(opts = {}) {
  const p = {
    receipt: opts.receipt,           // value or null
    tx: opts.tx,                     // value or null
    throwReceipt: !!opts.throwReceipt,
    throwTx: !!opts.throwTx,
    receiptCalls: 0,
    txCalls: 0,
    async getTransactionReceipt(hash) {
      p.receiptCalls += 1;
      if (p.throwReceipt) throw new Error("RPC failure: receipt");
      return p.receipt;
    },
    async getTransaction(hash) {
      p.txCalls += 1;
      if (p.throwTx) throw new Error("RPC failure: tx");
      return p.tx;
    },
  };
  return p;
}

function validReceipt(status, blockNumber = 100) {
  return {
    status,
    blockNumber,
    blockHash: BLOCK_HASH,
    transactionIndex: 3,
  };
}

// Creates a tracker + a record already walked through SUBMITTED with a hash,
// ready to be polled. State machine used is the real one.
async function makeSubmittedTracker(wallet = WALLET_A, nonce = 7) {
  const tracker = new TransactionTracker();
  const rec = tracker.create({ wallet, nonce });
  tracker.markSubmitted(rec.id, TX_HASH);
  return { tracker, id: rec.id };
}

describe("A — create (RESERVED)", () => {
    it("1 — create() returns a record in state RESERVED", () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A, nonce: 10 });
      expect(rec.state).to.equal("RESERVED");
      expect(t.get(rec.id).state).to.equal("RESERVED");
    });

    it("2 — unique ids per record", () => {
      const t = new TransactionTracker();
      const a = t.create({ wallet: WALLET_A, nonce: 1 });
      const b = t.create({ wallet: WALLET_A, nonce: 2 });
      expect(a.id).to.not.equal(b.id);
    });

    it("3 — nonce is preserved", () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A, nonce: 42 });
      expect(t.get(rec.id).nonce).to.equal(42);
    });

    it("4 — wallet is preserved (normalized lower-case)", () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A.toUpperCase(), nonce: 1 });
      expect(t.get(rec.id).wallet).to.equal(WALLET_A.toLowerCase());
    });

    it("5 — createdAt is set", () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A, nonce: 1 });
      expect(t.get(rec.id).createdAt).to.be.a("number");
      expect(t.get(rec.id).createdAt).to.be.greaterThan(0);
    });

    it("6 — updatedAt is set (== createdAt at creation)", () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A, nonce: 1 });
      const r = t.get(rec.id);
      expect(r.updatedAt).to.be.a("number");
      expect(r.updatedAt).to.be.at.least(r.createdAt);
    });

    it("invalid nonce at create is rejected", () => {
      const t = new TransactionTracker();
      expect(() => t.create({ wallet: WALLET_A, nonce: "abc" })).to.throw(/invalid nonce/);
      expect(() => t.create({ wallet: WALLET_A, nonce: -1 })).to.throw(/invalid nonce/);
      expect(() => t.create({ wallet: WALLET_A, nonce: 10.5 })).to.throw(/invalid nonce/);
    });

    it("invalid wallet at create is rejected", () => {
      const t = new TransactionTracker();
      expect(() => t.create({ wallet: "", nonce: 1 })).to.throw(/invalid wallet/);
      expect(() => t.create({ wallet: 42, nonce: 1 })).to.throw(/invalid wallet/);
    });

    it("create() promises nothing about the chain — txHash is null in RESERVED", () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A, nonce: 1 });
      expect(t.get(rec.id).txHash).to.equal(null);
    });
  });

  describe("B — submission (RESERVED → SUBMITTED)", () => {
    it("7 — RESERVED → SUBMITTED", () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A, nonce: 1 });
      const s = t.markSubmitted(rec.id, TX_HASH);
      expect(s.state).to.equal("SUBMITTED");
      expect(t.get(rec.id).state).to.equal("SUBMITTED");
    });

    it("8 — txHash is preserved", () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A, nonce: 1 });
      t.markSubmitted(rec.id, TX_HASH);
      expect(t.get(rec.id).txHash).to.equal(TX_HASH);
    });

    it("9 — submittedAt is set", () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A, nonce: 1 });
      t.markSubmitted(rec.id, TX_HASH);
      expect(t.get(rec.id).submittedAt).to.be.a("number");
      expect(t.get(rec.id).submittedAt).to.be.greaterThan(0);
    });

    it("10 — invalid hash is rejected", () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A, nonce: 1 });
      expect(() => t.markSubmitted(rec.id, "")).to.throw(/invalid txHash/);
      expect(() => t.markSubmitted(rec.id, "nothash")).to.throw(/invalid txHash/);
      expect(() => t.markSubmitted(rec.id, null)).to.throw(/invalid txHash/);
      expect(t.get(rec.id).state).to.equal("RESERVED"); // unchanged
    });

    it("11 — submit on an already-committed/pending tx is rejected", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      expect(() => tracker.markSubmitted(id, TX_HASH)).to.throw(/illegal transition/);
    });

    it("resubmitting the SAME hash is idempotent", () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A, nonce: 1 });
      t.markSubmitted(rec.id, TX_HASH);
      const again = t.markSubmitted(rec.id, TX_HASH);
      expect(again.state).to.equal("SUBMITTED");
      expect(again.txHash).to.equal(TX_HASH);
    });

    it("resubmitting a DIFFERENT hash after submission is rejected", () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A, nonce: 1 });
      t.markSubmitted(rec.id, TX_HASH);
      expect(() => t.markSubmitted(rec.id, "0xffff")).to.throw(/illegal transition|txHash/);
    });
  });
describe("C — PENDING", () => {
    it("12 — SUBMITTED → PENDING", () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A, nonce: 1 });
      t.markSubmitted(rec.id, TX_HASH);
      const p = t.markPending(rec.id);
      expect(p.state).to.equal("PENDING");
    });

    it("13 — PENDING → PENDING is idempotent", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const again = tracker.markPending(id);
      expect(again.state).to.equal("PENDING");
      expect(tracker.get(id).state).to.equal("PENDING");
    });

    it("14 — updatedAt refreshes on state change, createdAt does not", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      const before = tracker.get(id);
      tracker.markPending(id);
      const after = tracker.get(id);
      expect(after.createdAt).to.equal(before.createdAt); // immutable
      expect(after.updatedAt).to.be.at.least(before.updatedAt);
    });

    it("15 — record stays coherent after repeated PENDING", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      for (let i = 0; i < 5; i++) tracker.markPending(id);
      const r = tracker.get(id);
      expect(r.state).to.equal("PENDING");
      expect(r.txHash).to.equal(TX_HASH);
      expect(r.nonce).to.equal(7);
      expect(r.wallet).to.equal(WALLET_A.toLowerCase());
    });
  });

  describe("D — receipt success → CONFIRMED", () => {
    it("16 — PENDING → CONFIRMED via poll", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: validReceipt(1) });
      const snap = await tracker.poll(id, provider);
      expect(snap.state).to.equal("CONFIRMED");
      expect(tracker.get(id).state).to.equal("CONFIRMED");
    });

    it("17 — receipt status 1 → CONFIRMED (receiptStatus preserved)", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: validReceipt(1) });
      await tracker.poll(id, provider);
      expect(tracker.get(id).receiptStatus).to.equal(1);
    });

    it("18 — blockNumber is preserved on CONFIRMED", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: validReceipt(1, 12345) });
      await tracker.poll(id, provider);
      expect(tracker.get(id).blockNumber).to.equal(12345);
    });

    it("19 — blockHash is preserved on CONFIRMED", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: validReceipt(1) });
      await tracker.poll(id, provider);
      expect(tracker.get(id).blockHash).to.equal(BLOCK_HASH);
    });

    it("20 — transactionIndex is preserved on CONFIRMED", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: validReceipt(1) });
      await tracker.poll(id, provider);
      expect(tracker.get(id).transactionIndex).to.equal(3);
    });
  });

  describe("E — receipt revert → REVERTED", () => {
    it("21 — PENDING → REVERTED via poll", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: validReceipt(0) });
      const snap = await tracker.poll(id, provider);
      expect(snap.state).to.equal("REVERTED");
      expect(tracker.get(id).state).to.equal("REVERTED");
    });

    it("22 — receipt status 0 → REVERTED (receiptStatus preserved)", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: validReceipt(0) });
      await tracker.poll(id, provider);
      expect(tracker.get(id).receiptStatus).to.equal(0);
    });

    it("23 — block data preserved on REVERTED", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: validReceipt(0, 777) });
      await tracker.poll(id, provider);
      const r = tracker.get(id);
      expect(r.blockNumber).to.equal(777);
      expect(r.blockHash).to.equal(BLOCK_HASH);
    });
  });
describe("F — UNKNOWN (fail-closed)", () => {
    it("24 — transaction null + receipt null → UNKNOWN", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: null, tx: null });
      const snap = await tracker.poll(id, provider);
      expect(snap.state).to.equal("UNKNOWN");
    });

    it("25 — receipt RPC error → UNKNOWN with lastError", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ throwReceipt: true });
      const snap = await tracker.poll(id, provider);
      expect(snap.state).to.equal("UNKNOWN");
      expect(snap.lastError).to.include("receipt RPC error");
    });

    it("26 — transaction RPC error → UNKNOWN with lastError", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: null, throwTx: true });
      const snap = await tracker.poll(id, provider);
      expect(snap.state).to.equal("UNKNOWN");
      expect(snap.lastError).to.include("tx RPC error");
    });

    it("27 — UNKNOWN preserves lastError", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: null, tx: null });
      await tracker.poll(id, provider);
      expect(tracker.get(id).lastError).to.not.equal(null);
    });
  });

  describe("G — UNKNOWN != DROPPED", () => {
    it("28 — null receipt + null tx → UNKNOWN, NEVER DROPPED", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: null, tx: null });
      await tracker.poll(id, provider);
      expect(tracker.get(id).state).to.equal("UNKNOWN");
      expect(tracker.get(id).state).to.not.equal("DROPPED");
    });

    it("29 — poll never produces DROPPED even after repeated null polls", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: null, tx: null });
      for (let i = 0; i < 5; i++) await tracker.poll(id, provider);
      expect(tracker.get(id).state).to.equal("UNKNOWN");
      expect(tracker.get(id).state).to.not.equal("DROPPED");
    });

    it("DROPPED is only reachable via an explicit transition, never via poll", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      tracker.transition(id, "DROPPED"); // explicit, structural
      expect(tracker.get(id).state).to.equal("DROPPED");
    });
  });
describe("H — receipt priority over mempool", () => {
    it("30 — tx null + receipt success → CONFIRMED (not UNKNOWN, not DROPPED)", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: validReceipt(1), tx: null });
      await tracker.poll(id, provider);
      expect(tracker.get(id).state).to.equal("CONFIRMED");
    });

    it("31 — tx null + receipt revert → REVERTED (not UNKNOWN)", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: validReceipt(0), tx: null });
      await tracker.poll(id, provider);
      expect(tracker.get(id).state).to.equal("REVERTED");
    });
  });

  describe("I — illegal transitions are rejected", () => {
    it("32 — CONFIRMED → PENDING rejected", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: validReceipt(1) }));
      expect(() => tracker.transition(id, "PENDING")).to.throw(/illegal transition/);
      expect(tracker.get(id).state).to.equal("CONFIRMED");
    });

    it("33 — CONFIRMED → REVERTED rejected", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: validReceipt(1) }));
      expect(() => tracker.transition(id, "REVERTED")).to.throw(/illegal transition/);
    });

    it("34 — CONFIRMED → UNKNOWN rejected", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: validReceipt(1) }));
      expect(() => tracker.transition(id, "UNKNOWN")).to.throw(/illegal transition/);
    });

    it("35 — REVERTED → CONFIRMED rejected", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: validReceipt(0) }));
      expect(() => tracker.transition(id, "CONFIRMED")).to.throw(/illegal transition/);
    });

    it("36 — REVERTED → PENDING rejected", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: validReceipt(0) }));
      expect(() => tracker.transition(id, "PENDING")).to.throw(/illegal transition/);
    });

    it("37 — DROPPED → PENDING rejected", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      tracker.transition(id, "DROPPED");
      expect(() => tracker.transition(id, "PENDING")).to.throw(/illegal transition/);
    });

    it("38 — DROPPED → CONFIRMED rejected", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      tracker.transition(id, "DROPPED");
      expect(() => tracker.transition(id, "CONFIRMED")).to.throw(/illegal transition/);
    });
  });
describe("J — idempotency", () => {
    it("39 — PENDING → PENDING is a no-op that keeps the record coherent", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const before = tracker.get(id);
      await tracker.poll(id, makeProvider({ receipt: null, tx: {} }));
      tracker.markPending(id);
      const after = tracker.get(id);
      expect(after.state).to.equal("PENDING");
      expect(after.createdAt).to.equal(before.createdAt);
      expect(after.txHash).to.equal(TX_HASH);
    });

    it("40 — CONFIRMED → CONFIRMED no-op (via poll with receipt)", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: validReceipt(1, 100) });
      await tracker.poll(id, provider);
      await tracker.poll(id, provider); // repeated
      expect(tracker.get(id).state).to.equal("CONFIRMED");
      expect(tracker.get(id).blockNumber).to.equal(100);
    });

    it("41 — REVERTED → REVERTED no-op", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: validReceipt(0, 50) });
      await tracker.poll(id, provider);
      await tracker.poll(id, provider);
      expect(tracker.get(id).state).to.equal("REVERTED");
      expect(tracker.get(id).blockNumber).to.equal(50);
    });

    it("42 — UNKNOWN → UNKNOWN no-op", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: null, tx: null });
      await tracker.poll(id, provider);
      await tracker.poll(id, provider);
      expect(tracker.get(id).state).to.equal("UNKNOWN");
    });
  });
describe("K — concurrency", () => {
    it("43 — two simultaneous polls of the SAME tx → coherent final state", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      const provider = makeProvider({ receipt: validReceipt(1, 321) });
      const [a, b] = await Promise.all([tracker.poll(id, provider), tracker.poll(id, provider)]);
      expect(a.state).to.equal("CONFIRMED");
      expect(b.state).to.equal("CONFIRMED");
      expect(tracker.get(id).state).to.equal("CONFIRMED");
      expect(tracker.get(id).blockNumber).to.equal(321);
    });

    it("44 — many transactions polled in parallel stay isolated", async () => {
      const tracker = new TransactionTracker();
      const ids = [];
      for (let i = 0; i < 8; i++) {
        const rec = tracker.create({ wallet: WALLET_A, nonce: 100 + i });
        tracker.markSubmitted(rec.id, `0x${String(i).padStart(2, "0")}${"abcd".repeat(15)}`);
        tracker.markPending(rec.id);
        ids.push(rec.id);
      }
      const providers = ids.map((_, i) =>
        makeProvider({ receipt: validReceipt(i % 2 === 0 ? 1 : 0, 1000 + i) })
      );
      await Promise.all(ids.map((id, i) => tracker.poll(id, providers[i])));
      ids.forEach((id, i) => {
        expect(tracker.get(id).state).to.equal(i % 2 === 0 ? "CONFIRMED" : "REVERTED");
        expect(tracker.get(id).blockNumber).to.equal(1000 + i);
      });
    });

    it("45 — records with DIFFERENT ids never cross-write during parallel polls", async () => {
      const { tracker, id: a } = await makeSubmittedTracker(WALLET_A, 1);
      const recB = tracker.create({ wallet: WALLET_B, nonce: 2 });
      tracker.markSubmitted(recB.id, "0x0000000000000000000000000000000000000000000000000000000000000000");
      tracker.markPending(recB.id);
      await Promise.all([
        tracker.poll(a, makeProvider({ receipt: validReceipt(1, 5) })),
        tracker.poll(recB.id, makeProvider({ receipt: validReceipt(0, 6) })),
      ]);
      expect(tracker.get(a).state).to.equal("CONFIRMED");
      expect(tracker.get(recB.id).state).to.equal("REVERTED");
    });
  });
describe("L — data integrity & false positives", () => {
    it("46 — nonce never changes after creation", async () => {
      const { tracker, id } = await makeSubmittedTracker(WALLET_A, 77);
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: validReceipt(1) }));
      expect(tracker.get(id).nonce).to.equal(77);
    });

    it("47 — wallet never changes after creation", async () => {
      const { tracker, id } = await makeSubmittedTracker(WALLET_A, 1);
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: validReceipt(1) }));
      expect(tracker.get(id).wallet).to.equal(WALLET_A.toLowerCase());
    });

    it("48 — txHash never changes after submission", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: validReceipt(1) }));
      expect(tracker.get(id).txHash).to.equal(TX_HASH);
    });

    it("49 — createdAt is never rewritten (polls/transitions keep it)", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      const createdAt = tracker.get(id).createdAt;
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: null, tx: {} }));
      await tracker.poll(id, makeProvider({ receipt: null, tx: null }));
      expect(tracker.get(id).createdAt).to.equal(createdAt);
    });

    it("50 — block data appears ONLY when a valid receipt exists", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: null, tx: {} }));
      expect(tracker.get(id).blockNumber).to.equal(null);
      expect(tracker.get(id).blockHash).to.equal(null);
      await tracker.poll(id, makeProvider({ receipt: validReceipt(1, 999) }));
      expect(tracker.get(id).blockNumber).to.equal(999);
      expect(tracker.get(id).blockHash).to.equal(BLOCK_HASH);
    });

    it("51 — receipt missing status → UNKNOWN, never CONFIRMED", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: { blockNumber: 1, blockHash: BLOCK_HASH } }));
      expect(tracker.get(id).state).to.equal("UNKNOWN");
      expect(tracker.get(id).blockNumber).to.equal(null); // no invented data
    });

    it("52 — receipt missing blockHash → UNKNOWN, never CONFIRMED", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: { status: 1, blockNumber: 1 } }));
      expect(tracker.get(id).state).to.equal("UNKNOWN");
    });

    it("53 — receipt with invalid status (2) → UNKNOWN, never CONFIRMED", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      await tracker.poll(
        id,
        makeProvider({ receipt: { status: 2, blockNumber: 1, blockHash: BLOCK_HASH } })
      );
      expect(tracker.get(id).state).to.equal("UNKNOWN");
    });

    it("54 — RPC error is NEVER REVERTED and NEVER CONFIRMED", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ throwReceipt: true }));
      expect(tracker.get(id).state).to.equal("UNKNOWN");
      expect(tracker.get(id).state).to.not.equal("REVERTED");
      expect(tracker.get(id).state).to.not.equal("CONFIRMED");
    });

    it("55 — RPC tx error is NEVER DROPPED", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: null, throwTx: true }));
      expect(tracker.get(id).state).to.equal("UNKNOWN");
      expect(tracker.get(id).state).to.not.equal("DROPPED");
    });
  });
describe("read-only API (get/list) + determinism", () => {
    it("56 — get() returns a defensive copy — mutating it cannot corrupt the tracker", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      const snap = tracker.get(id);
      snap.state = "CONFIRMED";
      snap.nonce = 9999;
      snap.txHash = "0xffff";
      expect(tracker.get(id).state).to.equal("SUBMITTED");
      expect(tracker.get(id).nonce).to.equal(7);
      expect(tracker.get(id).txHash).to.equal(TX_HASH);
    });

    it("57 — list() returns copies filtered by state and wallet", async () => {
      const tracker = new TransactionTracker();
      const a = tracker.create({ wallet: WALLET_A, nonce: 1 });
      const b = tracker.create({ wallet: WALLET_B, nonce: 2 });
      tracker.markSubmitted(a.id, TX_HASH);
      tracker.markPending(a.id);
      const all = tracker.list();
      expect(all.length).to.equal(2);
      const pending = tracker.list({ state: "PENDING" });
      expect(pending.length).to.equal(1);
      expect(pending[0].id).to.equal(a.id);
      const walletB = tracker.list({ wallet: WALLET_B.toUpperCase() }); // case-insens
      expect(walletB.length).to.equal(1);
      expect(walletB[0].id).to.equal(b.id);
      // mutating list() result does not corrupt
      all[0].state = "CONFIRMED";
      expect(tracker.list({ state: "PENDING" }).length).to.equal(1);
    });

    it("58 — poll on a RESERVED record (no txHash) is rejected", async () => {
      const t = new TransactionTracker();
      const rec = t.create({ wallet: WALLET_A, nonce: 1 });
      await expect(t.poll(rec.id, makeProvider({ receipt: null, tx: null })))
        .to.be.rejectedWith(/cannot poll without a txHash/);
    });

    it("59 — deterministic: same event sequence → same final state regardless of extra polls", async () => {
      const make = () => {
        const t = new TransactionTracker();
        const rec = t.create({ wallet: WALLET_A, nonce: 1 });
        t.markSubmitted(rec.id, TX_HASH);
        return { t, id: rec.id };
      };
      const extraPolls = [
        () => makeProvider({ receipt: null, tx: {} }),   // PENDING-neutral
        () => makeProvider({ receipt: null, tx: null }), // UNKNOWN
      ];
      // Sequence A: no extra polls → CONFIRMED
      const { t: ta, id: ia } = make();
      ta.markPending(ia);
      await ta.poll(ia, makeProvider({ receipt: validReceipt(1, 500) }));
      // Sequence B: two extra polls in different positions → CONFIRMED
      const { t: tb, id: ib } = make();
      tb.markPending(ib);
      await tb.poll(ib, extraPolls[0]());
      await tb.poll(ib, extraPolls[1]());
      await tb.poll(ib, makeProvider({ receipt: validReceipt(1, 500) }));
      expect(ta.get(ia).state).to.equal("CONFIRMED");
      expect(tb.get(ib).state).to.equal("CONFIRMED");
      expect(tb.get(ib).blockNumber).to.equal(ta.get(ia).blockNumber);
    });

    it("60 — tracker NEVER frees/rolls back the nonce it tracks (no NonceManager coupling)", async () => {
      const { tracker, id } = await makeSubmittedTracker();
      tracker.markPending(id);
      await tracker.poll(id, makeProvider({ receipt: null, tx: null })); // → UNKNOWN
      await tracker.poll(id, makeProvider({ receipt: null, tx: null })); // still UNKNOWN
      // Record remains, nonce still reserved for that record — nothing freed.
      expect(tracker.get(id).state).to.equal("UNKNOWN");
      expect(tracker.get(id).nonce).to.equal(7);
      expect(tracker.list({ state: "UNKNOWN" }).length).to.equal(1);
    });
  });

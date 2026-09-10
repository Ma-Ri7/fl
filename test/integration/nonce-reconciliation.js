// TASK 4.5-B — Nonce Reconciliation after Restart / RPC Reconnect
//
// Fail-closed + monotonic nonce reconciliation:
//   - reads the chain "pending" nonce (this.wallet.getNonce("pending") by default)
//   - serialized with reserve() through the SAME _reserveChain mutex
//   - next NEVER regresses
//   - reserved / pending / blocked state is NEVER deleted
//   - RPC failure or invalid nonce → local state unchanged
//   - wallet mismatch rejected (case-insensitive)
//   - restart safety: a fresh manager must never reuse nonces the chain has
//     already advanced past
const chai = require("chai");
const chaiAsPromised = require("chai-as-promised");
chai.use(chaiAsPromised);
const { expect } = chai;
const { NonceManager } = require("../../bot/nonce");

const WALLET_ADDR = "0x70997970C51812dc3A010C7d01b50b0429c0d3c8";
const OTHER_ADDR = "0x3C44CdddB6a900fa2b585dd299e03D12FA4293BC";

// Controlled wallet: getNonce("pending") returns the scripted nonce or throws.
function makeWallet(opts = {}) {
  const w = {
    address: WALLET_ADDR,
    nonce: opts.nonce,
    throws: !!opts.throws,
    calls: [],
    getNonce(tag) {
      w.calls.push(tag);
      if (w.throws) throw new Error("RPC failure");
      if (tag !== "pending") throw new Error(`unexpected blockTag ${tag}`);
      return w.nonce;
    },
  };
  return w;
}

// Factory that drives the REAL NonceManager state machine.
function makeManager(opts = {}) {
  const wallet =
    opts.wallet ||
    makeWallet({ nonce: opts.chainNonce !== undefined ? opts.chainNonce : 10 });
  const mgr = new NonceManager(
    wallet,
    opts.maxPending !== undefined ? opts.maxPending : 100
  );
  if (opts.next !== undefined) mgr.next = opts.next;
  return mgr;
}

describe("NonceManager.reconcile() — TASK 4.5-B", () => {
  describe("chain state vs local next", () => {
    it("A — chain pending nonce > next → next advances; fresh reserve starts at chain", async () => {
      const mgr = makeManager({ chainNonce: 15, next: 5 });
      await mgr.reconcile();
      expect(mgr.next).to.equal(15);
      expect(await mgr.reserve()).to.equal(15);
    });

    it("B — chain pending nonce == next → stable state", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 10 });
      await mgr.reconcile();
      expect(mgr.next).to.equal(10);
    });

    it("C — chain pending nonce < next → next does NOT regress", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 20 });
      await mgr.reconcile();
      expect(mgr.next).to.equal(20);
      expect(await mgr.reserve()).to.equal(20);
    });

    it("T — reconcile can never reduce next (monotonic 10→15→12→15→20)", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 10 });
      await mgr.reconcile(); // chain 10 → next 10
      mgr.wallet.nonce = 15;
      await mgr.reconcile(); // chain 15 → next 15
      mgr.wallet.nonce = 12;
      await mgr.reconcile(); // chain 12 → next STAYS 15
      expect(mgr.next).to.equal(15);
      mgr.wallet.nonce = 15;
      await mgr.reconcile(); // chain 15 → stable 15
      expect(mgr.next).to.equal(15);
      mgr.wallet.nonce = 20;
      await mgr.reconcile(); // chain 20 → next 20
      expect(mgr.next).to.equal(20);
    });

    it("U — repeated reconcile is idempotent when chain is stable", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 10 });
      await mgr.reconcile();
      await mgr.reconcile();
      await mgr.reconcile();
      expect(mgr.next).to.equal(10);
    });

    it("uses wallet.getNonce('pending') — never a different blockTag", async () => {
      const wallet = makeWallet({ nonce: 10 });
      const mgr = new NonceManager(wallet, 10);
      await mgr.reconcile();
      expect(wallet.calls.length).to.be.at.least(1);
      for (const tag of wallet.calls) expect(tag).to.equal("pending");
    });
describe("state protection — reserved / pending / blocked", () => {
    it("D — reserved nonce is NOT deleted by reconcile", async () => {
      const mgr = makeManager({ chainNonce: 11, next: 10 });
      expect(await mgr.reserve()).to.equal(10); // RESERVED
      await mgr.reconcile();
      expect(mgr.reserved.has(10)).to.equal(true);
    });

    it("reserved nonce NOT yet observed on-chain stays protected — reconcile != rollback", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 10 });
      await mgr.reserve(); // 10 reserved, chain still reports 10
      await mgr.reconcile();
      expect(mgr.reserved.has(10)).to.equal(true);
      expect(mgr.next).to.equal(11);
    });

    it("reconcile NEVER calls rollback()", async () => {
      const mgr = makeManager({ chainNonce: 11, next: 10 });
      await mgr.reserve();
      let rollbackCalls = 0;
      mgr.rollback = () => {
        rollbackCalls += 1;
      };
      await mgr.reconcile();
      expect(rollbackCalls).to.equal(0);
      expect(mgr.reserved.has(10)).to.equal(true);
    });

    it("E — pending nonce is NOT deleted by reconcile", async () => {
      const mgr = makeManager({ chainNonce: 15, next: 10 });
      const n = await mgr.reserve(); // 10
      mgr.commit(n, "0xabc");
      await mgr.reconcile();
      expect(mgr.pending.has(10)).to.equal(true);
      expect(mgr.pending.get(10).hash).to.equal("0xabc");
    });

    it("pending nonce is not reused after reconcile", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 10 });
      const n = await mgr.reserve(); // 10
      mgr.commit(n, "0xabc");
      await mgr.reconcile();
      const nextN = await mgr.reserve();
      expect(nextN).to.not.equal(10);
    });

    it("F — blocked nonce is NOT deleted by reconcile", async () => {
      const mgr = makeManager({ chainNonce: 12, next: 10 });
      mgr.blocked.add(7);
      await mgr.reconcile();
      expect(mgr.blocked.has(7)).to.equal(true);
    });

    it("G — blocked nonce is never returned by reserve after reconcile", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 10 });
      mgr.blocked.add(10);
      await mgr.reconcile();
      expect(await mgr.reserve()).to.not.equal(10);
    });
  });

  describe("RPC failures and invalid nonces — fail-closed", () => {
    it("H — RPC failure leaves local state EXACTLY unchanged", async () => {
      const wallet = makeWallet({ nonce: 15 });
      const mgr = new NonceManager(wallet, 10);
      mgr.next = 10;
      mgr.reserved.add(5);
      mgr.pending.set(6, { hash: "0xabc", ts: 0 });
      mgr.blocked.add(7);
      const before = {
        next: mgr.next,
        reserved: [...mgr.reserved].sort(),
        pending: [...mgr.pending.keys()].sort(),
        blocked: [...mgr.blocked].sort(),
      };
      wallet.throws = true;
      await expect(mgr.reconcile()).to.be.rejectedWith(/RPC failure/);
      expect(mgr.next).to.equal(before.next);
      expect([...mgr.reserved].sort()).to.deep.equal(before.reserved);
      expect([...mgr.pending.keys()].sort()).to.deep.equal(before.pending);
      expect([...mgr.blocked].sort()).to.deep.equal(before.blocked);
    });

    const invalidValues = [
      ["undefined", undefined],
      ["null", null],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["-Infinity", -Infinity],
      ["negative -1", -1],
      ["fractional 10.5", 10.5],
      ["string 'abc'", "abc"],
      ["unsafe integer 2^53", 9007199254740992],
    ];
    for (const [label, value] of invalidValues) {
      it(`I..O — rejects invalid nonce: ${label}`, async () => {
        const mgr = makeManager({ chainNonce: 10, next: 10 });
        await expect(
          mgr.reconcile({ getPendingNonce: async () => value })
        ).to.be.rejectedWith(/invalid-chain-pending-nonce/);
        expect(mgr.next).to.equal(10); // state unchanged
      });
    }

    it("accepts a valid numeric string, normalized to integer", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 5 });
      await mgr.reconcile({ getPendingNonce: async () => "12" });
      expect(mgr.next).to.equal(12);
    });

    it("accepts a valid bigint nonce", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 5 });
      await mgr.reconcile({ getPendingNonce: async () => 12n });
      expect(mgr.next).to.equal(12);
    });
  });
describe("wallet identity", () => {
    it("P — wallet mismatch is rejected", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 10 });
      await expect(mgr.reconcile({ wallet: OTHER_ADDR }))
        .to.be.rejectedWith(/wallet-mismatch/);
      expect(mgr.next).to.equal(10); // state unchanged
    });

    it("wallet identity comparison is case-insensitive (accepted)", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 10 });
      await mgr.reconcile({ wallet: WALLET_ADDR.toUpperCase() });
      expect(mgr.next).to.equal(10);
    });
  });

  describe("restart safety", () => {
    it("Q — restart: fresh manager with empty state must not reuse consumed nonce", async () => {
      // Lifecycle 1: manager A uses nonce 10 (tx submitted on-chain).
      const wA = makeWallet({ nonce: 10 });
      const mgrA = new NonceManager(wA, 10);
      mgrA.next = 10;
      const used = await mgrA.reserve(); // 10
      mgrA.commit(used, "0xabc");

      // Process crashes → manager B has EMPTY local state (next === null).
      // Chain has advanced to pending nonce 11 → nonce 10 is consumed.
      const wB = makeWallet({ nonce: 11 });
      const mgrB = new NonceManager(wB, 10);
      await mgrB.reconcile();
      expect(mgrB.next).to.equal(11);
      const fresh = await mgrB.reserve();
      expect(fresh).to.equal(11);
      expect(fresh).to.not.equal(10); // MUST NEVER reuse nonce 10
    });

    it("restart with previous pending tx — never undershoots on-chain pending view", async () => {
      // Chain still reports pending nonce 10; a new manager must reconcile to
      // >= 10 and must never hand out a nonce below the on-chain pending view.
      const w = makeWallet({ nonce: 10 });
      const mgr = new NonceManager(w, 10);
      await mgr.reconcile();
      expect(mgr.next).to.equal(10);
      expect(await mgr.reserve()).to.be.at.least(10);
    });

    it("RPC reconnect — new wallet/provider is used without resetting local state", async () => {
      const w1 = makeWallet({ nonce: 10 });
      const mgr = new NonceManager(w1, 10);
      mgr.next = 10;
      const used = await mgr.reserve(); // 10
      // RPC A fails; manager switches to wallet B (reconnect).
      const w2 = makeWallet({ nonce: 12 });
      mgr.wallet = w2;
      await mgr.reconcile();
      expect(mgr.next).to.equal(12); // advanced, not reset
      expect(mgr.reserved.has(used)).to.equal(true); // local reservation kept
    });
  });

  describe("concurrency", () => {
    it("S — two concurrent reserve() calls return distinct nonces", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 10 });
      const [a, b] = await Promise.all([mgr.reserve(), mgr.reserve()]);
      expect(new Set([a, b]).size).to.equal(2);
    });

    it("R — concurrent reserve + reconcile serialize: no duplicate handed-out nonces", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 10 });
      const reserved = [];
      const reconciled = [];
      await Promise.all([
        mgr.reserve().then((v) => reserved.push(v)),
        mgr.reconcile().then((v) => reconciled.push(v)),
        mgr.reserve().then((v) => reserved.push(v)),
        mgr.reconcile().then((v) => reconciled.push(v)),
        mgr.reserve().then((v) => reserved.push(v)),
      ]);
      expect(reserved.length).to.equal(3);
      expect(new Set(reserved).size).to.equal(3); // 3 unique handed-out nonces
      expect(reconciled.length).to.equal(2);
    });

    it("V — reconcile does not create duplicate nonces afterwards", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 10 });
      await mgr.reconcile();
      const a = await mgr.reserve();
      await mgr.reconcile();
      const b = await mgr.reserve();
      expect(a).to.not.equal(b);
    });

    it("4 concurrent reconcile() calls are deterministic and safe", async () => {
      const mgr = makeManager({ chainNonce: 10, next: 10 });
      const results = await Promise.all([
        mgr.reconcile(),
        mgr.reconcile(),
        mgr.reconcile(),
        mgr.reconcile(),
      ]);
      expect(results.every((n) => n === 10)).to.equal(true);
      expect(mgr.next).to.equal(10);
    });
  });
});
  });
// TASK 4.5-A — NonceManager Lifecycle & Single-Owner Discipline
const { expect } = require("chai");
const { NonceManager } = require("../../bot/nonce");

function makeWallet(address = "0x" + "a1".repeat(20), startNonce = 100) {
  let nonce = startNonce;
  return { address, async getNonce() { return nonce; }, _setNonce(n) { nonce = n; } };
}

function makeManager(opts = {}) {
  const wallet = makeWallet(opts.address, opts.startNonce);
  return { mgr: new NonceManager(wallet, opts.maxPending || 5), wallet };
}

describe("TASK 4.5-A — NonceManager Lifecycle & Single-Owner Discipline", function () {

  describe("sequential reservations", function () {
    it("reserve() three times → N, N+1, N+2", async function () {
      const { mgr } = makeManager({ startNonce: 100 });
      expect(await mgr.reserve()).to.equal(100);
      expect(await mgr.reserve()).to.equal(101);
      expect(await mgr.reserve()).to.equal(102);
    });

    it("maxPending caps reservations", async function () {
      const { mgr } = makeManager({ startNonce: 10, maxPending: 2 });
      expect(await mgr.reserve()).to.equal(10);
      expect(await mgr.reserve()).to.equal(11);
      expect(await mgr.reserve()).to.equal(null);
    });
  });

  describe("concurrent reservations produce unique nonces", function () {
    it("10 concurrent reserves → 10 unique nonces", async function () {
      const { mgr } = makeManager({ startNonce: 50, maxPending: 20 });
      const promises = [];
      for (let i = 0; i < 10; i++) promises.push(mgr.reserve());
      const nonces = await Promise.all(promises);
      expect(new Set(nonces).size).to.equal(10);
      nonces.sort((a, b) => a - b);
      for (let i = 1; i < 10; i++) expect(nonces[i]).to.equal(nonces[i - 1] + 1);
    });

    it("100 concurrent reserves → 100 unique nonces (stress)", async function () {
      const { mgr } = makeManager({ startNonce: 0, maxPending: 200 });
      const promises = [];
      for (let i = 0; i < 100; i++) promises.push(mgr.reserve());
      const nonces = await Promise.all(promises);
      expect(new Set(nonces).size).to.equal(100);
    });
  });

  describe("commit prevents nonce reuse", function () {
    it("reserve → commit → next reserve skips committed nonce", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();
      mgr.commit(n, "0xabc");
      expect(await mgr.reserve()).to.equal(11);
    });

    it("commit with tx hash marks nonce as committed", async function () {
      const { mgr } = makeManager({ startNonce: 20 });
      const n = await mgr.reserve();
      mgr.commit(n, "0xhash123");
      expect(mgr.pending.has(n)).to.equal(true);
      expect(mgr.reserved.has(n)).to.equal(false);
    });

    it("commit with null hash (tombstone) marks nonce as committed", async function () {
      const { mgr } = makeManager({ startNonce: 30 });
      const n = await mgr.reserve();
      mgr.commit(n, null);
      expect(mgr.pending.has(n)).to.equal(true);
    });
  });

  describe("rollback without tx hash releases nonce", function () {
    it("reserve → rollback → reserve returns same nonce", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();
      mgr.rollback(n);
      expect(await mgr.reserve()).to.equal(10);
    });

    it("rollback only reuses if no newer nonces are pending", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      await mgr.reserve();
      const b = await mgr.reserve();
      mgr.rollback(b);
      expect(await mgr.reserve()).to.equal(11);
    });
  });

  describe("commit with tx hash → rollback is refuzat", function () {
    it("cannot rollback a nonce that has a tx hash", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();
      mgr.commit(n, "0xhash");
      let err = null;
      try { mgr.rollback(n); } catch (e) { err = e; }
      expect(err).to.not.equal(null);
      expect(err.message).to.include("nonce-already-committed");
    });

    it("cannot rollback a tombstone", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();
      mgr.commit(n, null);
      let err = null;
      try { mgr.rollback(n); } catch (e) { err = e; }
      expect(err).to.not.equal(null);
      expect(err.message).to.include("nonce-already-committed");
    });
  });

  describe("double commit/rollback are refuzat", function () {
    it("committing the same nonce twice throws", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();
      mgr.commit(n, "0xhash");
      let err = null;
      try { mgr.commit(n, "0xhash2"); } catch (e) { err = e; }
      expect(err).to.not.equal(null);
      expect(err.message).to.include("nonce-already-committed");
    });

    it("rolling back the same nonce twice throws", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();
      mgr.rollback(n);
      let err = null;
      try { mgr.rollback(n); } catch (e) { err = e; }
      expect(err).to.not.equal(null);
      expect(err.message).to.include("nonce-not-reserved");
    });
  });

  describe("unknown nonce operations are refuzat", function () {
    it("commit for nonce never reserved throws", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      let err = null;
      try { mgr.commit(999, "0xhash"); } catch (e) { err = e; }
      expect(err).to.not.equal(null);
      expect(err.message).to.include("nonce-not-reserved");
    });

    it("rollback for nonce never reserved throws", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      let err = null;
      try { mgr.rollback(999); } catch (e) { err = e; }
      expect(err).to.not.equal(null);
      expect(err.message).to.include("nonce-not-reserved");
    });
  });

  describe("wallet mismatch is refuzat", function () {
    it("validateWallet throws for different wallet", function () {
      const { mgr } = makeManager({ address: "0x" + "aa".repeat(20) });
      let err = null;
      try { mgr.validateWallet(makeWallet("0x" + "bb".repeat(20))); } catch (e) { err = e; }
      expect(err).to.not.equal(null);
      expect(err.message).to.include("wallet-mismatch");
    });

    it("validateWallet passes for matching wallet", function () {
      const { mgr, wallet } = makeManager({ address: "0x" + "aa".repeat(20) });
      mgr.validateWallet(wallet);
    });

    it("validateWallet is case-insensitive", function () {
      const { mgr } = makeManager({ address: "0x" + "Aa".repeat(20) });
      mgr.validateWallet(makeWallet("0x" + "aa".repeat(20)));
      mgr.validateWallet(makeWallet("0x" + "AA".repeat(20)));
    });
  });

  describe("multiple executions share the same manager", function () {
    it("three sequential reserves → N, N+1, N+2", async function () {
      const { mgr } = makeManager({ startNonce: 100 });
      const a = await mgr.reserve();
      const b = await mgr.reserve();
      const c = await mgr.reserve();
      expect([a, b, c]).to.deep.equal([100, 101, 102]);
    });

    it("all reserved nonces are unique across many reserves", async function () {
      const { mgr } = makeManager({ startNonce: 0, maxPending: 100 });
      const nonces = [];
      for (let i = 0; i < 20; i++) nonces.push(await mgr.reserve());
      expect(new Set(nonces).size).to.equal(20);
    });
  });

  describe("failure path semantics", function () {
    it("failure before tx hash → rollback allowed", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();
      mgr.rollback(n);
      expect(await mgr.reserve()).to.equal(10);
    });

    it("failure after tx hash → rollback refuzat", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();
      mgr.commit(n, "0xtxhash");
      let err = null;
      try { mgr.rollback(n); } catch (e) { err = e; }
      expect(err).to.not.equal(null);
      expect(err.message).to.include("nonce-already-committed");
    });
  });

  describe("nonce source", function () {
    it("init() fetches nonce from wallet.getNonce('pending')", async function () {
      const wallet = makeWallet("0x" + "a1".repeat(20), 77);
      const mgr = new NonceManager(wallet, 5);
      expect(await mgr.init()).to.equal(77);
    });

    it("init() caches nonce until force", async function () {
      const wallet = makeWallet("0x" + "a1".repeat(20), 50);
      const mgr = new NonceManager(wallet, 5);
      await mgr.init();
      wallet._setNonce(99);
      expect(await mgr.init()).to.equal(50);
      expect(await mgr.init(true)).to.equal(99);
    });
  });
});

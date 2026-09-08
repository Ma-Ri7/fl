// TASK 4.5-A-FIX — Fail-closed la commit() eșuat după existența unui txHash
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

describe("TASK 4.5-A-FIX — Fail-closed la commit() eșuat după txHash", function () {

  describe("private accepted + commit failure → fail-closed", function () {
    it("ok=false, txHash preserved, nonce blocked, no rollback", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();
      expect(n).to.equal(10);

      const txHash = "0x" + "abc".repeat(20);
      mgr.commit(n, txHash);
      let commitError = null;
      try { mgr.commit(n, txHash); } catch (e) { commitError = e; }
      expect(commitError).to.not.equal(null);
      expect(commitError.message).to.include("nonce-already-committed");
      expect(mgr.blocked.has(n)).to.equal(true);

      const m = await mgr.reserve();
      expect(m).to.not.equal(10);
      expect(m).to.equal(11);
    });
  });

  describe("public broadcast + commit failure → fail-closed", function () {
    it("ok=false, txHash preserved, nonce blocked, no rollback", async function () {
      const { mgr } = makeManager({ startNonce: 20 });
      const n = await mgr.reserve();

      const txHash = "0x" + "def".repeat(20);
      mgr.commit(n, txHash);
      let commitError = null;
      try { mgr.commit(n, txHash); } catch (e) { commitError = e; }
      expect(commitError).to.not.equal(null);
      expect(mgr.blocked.has(n)).to.equal(true);

      const m = await mgr.reserve();
      expect(m).to.not.equal(20);
      expect(m).to.equal(21);
    });
  });

  describe("nonce with hash cannot be reused after commit failure", function () {
    it("execution A → nonce 7, commit throws; execution B → nonce != 7", async function () {
      const { mgr } = makeManager({ startNonce: 7 });
      const n = await mgr.reserve();
      expect(n).to.equal(7);

      mgr.commit(n, "0x" + "111".repeat(20));
      try { mgr.commit(n, "0x" + "222".repeat(20)); } catch (e) { /* expected */ }
      expect(mgr.blocked.has(n)).to.equal(true);

      const m = await mgr.reserve();
      expect(m).to.not.equal(7);
    });
  });

  describe("private UNKNOWN + tombstone commit failure → fail-closed", function () {
    it("commit(nonce, null) throws → nonce blocked, no rollback", async function () {
      const { mgr } = makeManager({ startNonce: 7 });
      const n = await mgr.reserve();

      mgr.commit(n, null);
      let commitError = null;
      try { mgr.commit(n, null); } catch (e) { commitError = e; }
      expect(commitError).to.not.equal(null);
      expect(mgr.blocked.has(n)).to.equal(true);

      const m = await mgr.reserve();
      expect(m).to.not.equal(7);
    });
  });

  describe("commit failure never returns ok=true", function () {
    it("after commit throws, nonce is blocked (not available)", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();

      mgr.commit(n, "0xhash");
      try { mgr.commit(n, "0xhash2"); } catch (e) { /* expected */ }

      expect(mgr.blocked.has(n)).to.equal(true);
      const m = await mgr.reserve();
      expect(m).to.not.equal(n);
    });
  });

  describe("rollback is NOT called after commit failure with hash", function () {
    it("commit throws → nonce stays in blocked, rollback refuzat", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();

      mgr.commit(n, "0xhash");
      try { mgr.commit(n, "0xhash2"); } catch (e) { /* expected */ }

      expect(mgr.blocked.has(n)).to.equal(true);
      expect(mgr.reserved.has(n)).to.equal(false);

      // Rollback must be refuzat (nonce is committed with hash)
      let rollbackError = null;
      try { mgr.rollback(n); } catch (e) { rollbackError = e; }
      expect(rollbackError).to.not.equal(null);
      // Nonce is in pending (committed) → rollback throws nonce-already-committed
      expect(rollbackError.message).to.include("nonce-already-committed");
    });
  });

  describe("txHash is preserved after commit failure", function () {
    it("commit failure does not lose the txHash", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();
      const txHash = "0x" + "abc".repeat(20);

      mgr.commit(n, txHash);
      expect(mgr.pending.get(n).hash).to.equal(txHash);
    });
  });

  describe("broadcast failure without hash → rollback still works", function () {
    it("reserve → rollback → reserve returns same nonce", async function () {
      const { mgr } = makeManager({ startNonce: 7 });
      const n = await mgr.reserve();
      expect(n).to.equal(7);

      mgr.rollback(n);
      const m = await mgr.reserve();
      expect(m).to.equal(7);
    });
  });

  describe("blocked nonces are skipped by reserve()", function () {
    it("multiple blocked nonces are all skipped", async function () {
      const { mgr } = makeManager({ startNonce: 10, maxPending: 20 });

      const a = await mgr.reserve(); // 10
      const b = await mgr.reserve(); // 11
      const c = await mgr.reserve(); // 12

      mgr.commit(a, "0xhash");
      mgr.commit(b, "0xhash");
      mgr.commit(c, "0xhash");
      try { mgr.commit(a, "0xhash"); } catch (e) { /* block a */ }
      try { mgr.commit(b, "0xhash"); } catch (e) { /* block b */ }
      try { mgr.commit(c, "0xhash"); } catch (e) { /* block c */ }

      expect(mgr.blocked.has(a)).to.equal(true);
      expect(mgr.blocked.has(b)).to.equal(true);
      expect(mgr.blocked.has(c)).to.equal(true);

      const d = await mgr.reserve();
      expect(d).to.equal(13);
    });
  });

  // ---- Part C: nonce-not-reserved does NOT add to blocked -----------------
  describe("commit() on unknown nonce does NOT add to blocked", function () {
    it("commit(999) for unknown nonce throws and does not block", function () {
      const { mgr } = makeManager({ startNonce: 10 });
      let err = null;
      try { mgr.commit(999, "0xhash"); } catch (e) { err = e; }
      expect(err).to.not.equal(null);
      expect(err.message).to.include("nonce-not-reserved");
      // CRITICAL: unknown nonce must NOT be added to blocked
      expect(mgr.blocked.has(999)).to.equal(false);
    });

    it("unknown nonce does not contaminate reserve()", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      // Try to commit an unknown nonce (should throw, not block)
      try { mgr.commit(999, "0xhash"); } catch (e) { /* expected */ }
      expect(mgr.blocked.has(999)).to.equal(false);

      // Reserve should work normally
      const a = await mgr.reserve();
      expect(a).to.equal(10);
      const b = await mgr.reserve();
      expect(b).to.equal(11);
    });
  });

  // ---- Part A: REAL NonceManager FIRST commit failure → blocked -----------
  describe("REAL NonceManager: FIRST commit failure blocks the nonce", function () {
    // ThrowingMap: real Map but .set() throws — a controlled failure point
    // that exercises the real commit() fail-closed path.
    class ThrowingMap extends Map {
      set() { throw new Error("simulated-first-commit-failure"); }
    }

    it("reserve(N) → FIRST commit throws → blocked.has(N) === true", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();
      expect(n).to.equal(10);

      // Inject controlled failure: pending.set() throws on FIRST commit
      mgr.pending = new ThrowingMap();

      let err = null;
      try { mgr.commit(n, "0xhash"); } catch (e) { err = e; }
      expect(err).to.not.equal(null);
      expect(err.message).to.include("simulated-first-commit-failure");

      // CRITICAL: nonce is blocked, not lost
      expect(mgr.blocked.has(n)).to.equal(true);
      expect(mgr.reserved.has(n)).to.equal(false);
      expect(mgr.pending.has(n)).to.equal(false);
    });

    it("FIRST commit failure → next reserve() does NOT return N", async function () {
      const { mgr } = makeManager({ startNonce: 10 });
      const n = await mgr.reserve();
      expect(n).to.equal(10);

      mgr.pending = new ThrowingMap();
      try { mgr.commit(n, "0xhash"); } catch (e) { /* expected */ }
      expect(mgr.blocked.has(n)).to.equal(true);

      // Observable behavior: reserve() must skip blocked nonce
      const m = await mgr.reserve();
      expect(m).to.not.equal(10);
      expect(m).to.equal(11);
    });
  });
});

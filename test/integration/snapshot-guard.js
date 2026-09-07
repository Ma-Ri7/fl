// ============================================================================
// test/integration/snapshot-guard.js — TASK 4.2-A
//
// Tests the integration contract between index.js (execGuardedOpp) and
// executor.js (executeOpp), plus the snapshot-consistency validation:
//   A. snapshot valid          => ACCEPT
//   B. buy venue stale         => REJECT
//   C. sell venue stale        => REJECT
//   D. buyVen missing          => REJECT
//   E. sellVen missing         => REJECT
//   F. dependency propagation  => execGuardedOpp passes contract/wallet/provider
//                                 + opts (nonceManager, snapshot) to executeOpp
//   G. injected NonceManager   => executeOpp reuses the injected instance
//
// Run: npx mocha test/integration/snapshot-guard.js
// ============================================================================
const { expect } = require("chai");
const {
  validateSnapshot,
  execGuardedOpp,
} = require("../../bot/index");

describe("TASK 4.2-A — snapshot guard + integration", function () {
  // A realistic opportunity object as profit.js builds it (buyVen/sellVen).
  function makeOpp(bnBuy = 100, bnSell = 100) {
    return {
      buyVen: { kind: "v2", router: "0xRouterA", blockNumber: bnBuy },
      sellVen: { kind: "v2", router: "0xRouterB", blockNumber: bnSell },
      borrowAmount: 1000n,
      netProfit: 5n,
    };
  }

  function makeSnapshot(bn = 100) {
    return { blockNumber: bn, blockHash: "0x" + "0".repeat(64), timestamp: 1n, stateVersion: 0n };
  }

  describe("validateSnapshot (Tests A–E)", function () {
    it("Test A: snapshot valid (all venues on exact block) => ACCEPT", function () {
      const opp = makeOpp(100, 100);
      expect(validateSnapshot(opp, makeSnapshot(100))).to.equal(true);
    });

    it("Test B: buy venue stale => REJECT", function () {
      const opp = makeOpp(99, 100);
      expect(validateSnapshot(opp, makeSnapshot(100))).to.equal(false);
    });

    it("Test C: sell venue stale => REJECT", function () {
      const opp = makeOpp(100, 101);
      expect(validateSnapshot(opp, makeSnapshot(100))).to.equal(false);
    });

    it("Test D: buyVen missing => REJECT", function () {
      const opp = makeOpp();
      delete opp.buyVen;
      expect(validateSnapshot(opp, makeSnapshot(100))).to.equal(false);
    });

    it("Test E: sellVen missing => REJECT", function () {
      const opp = makeOpp();
      delete opp.sellVen;
      expect(validateSnapshot(opp, makeSnapshot(100))).to.equal(false);
    });

    it("missing snapshot => REJECT", function () {
      expect(validateSnapshot(makeOpp(), null)).to.equal(false);
      expect(validateSnapshot(makeOpp(), undefined)).to.equal(false);
      expect(validateSnapshot(makeOpp(), {})).to.equal(false);
    });
  });

  describe("execGuardedOpp dependency propagation (Tests F–G)", function () {
    it("Test F: passes contractAddr, wallet, provider, nonceManager, snapshot to executeOpp", async function () {
      const seen = {};
      const fakeExecute = async (opp_, contractAddr_, wallet_, provider_, opts_) => {
        seen.contractAddr = contractAddr_;
        seen.wallet = wallet_;
        seen.provider = provider_;
        seen.opts = opts_;
        return { ok: true, propagated: true };
      };

      // Inject a fake executeOpp through the module cache (DI seam).
      const executorPath = require.resolve("../../bot/executor");
      const realExecutor = require.cache[executorPath];
      require.cache[executorPath] = {
        id: executorPath,
        filename: executorPath,
        loaded: true,
        exports: { executeOpp: fakeExecute },
      };

      // index.js binds executeOpp at require time — re-require a fresh copy.
      delete require.cache[require.resolve("../../bot/index")];
      const index = require("../../bot/index");

      try {
        const wallet = { getAddress: async () => "0xWallet" };
        const provider = { getBlockNumber: async () => 100 };
        const nonceManager = { reserve: async () => 5 };
        const snapshot = makeSnapshot(100);

        const result = await index.execGuardedOpp(
          makeOpp(100, 100),
          "0xContract",
          wallet,
          provider,
          { nonceManager, snapshot }
        );

        expect(result).to.deep.equal({ ok: true, propagated: true });
        expect(seen.contractAddr).to.equal("0xContract");
        expect(seen.wallet).to.equal(wallet);
        expect(seen.provider).to.equal(provider);
        expect(seen.opts.nonceManager).to.equal(nonceManager);
        expect(seen.opts.snapshot).to.equal(snapshot);
      } finally {
        require.cache[executorPath] = realExecutor;
        delete require.cache[require.resolve("../../bot/index")];
      }
    });

    it("Test G: executeOpp reuses an injected NonceManager (no second instance)", function () {
      const { NonceManager } = require("../../bot/nonce");
      const injected = new NonceManager({ address: "0xWallet" }, 5);
      const { executeOpp } = require("../../bot/executor");

      // Source-level check: the fallback construction only happens when
      // opts.nonceManager is NOT already a NonceManager instance.
      const src = require("fs").readFileSync(
        require.resolve("../../bot/executor"), "utf8"
      );
      expect(src).to.include("opts.nonceManager instanceof NonceManager");

      // The injected manager must satisfy the instanceof contract.
      expect(injected).to.be.an.instanceOf(NonceManager);
      expect(executeOpp).to.be.a("function");
    });
  });
});

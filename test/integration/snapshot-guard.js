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

    // ---- TASK 4.2-B: behavioral DI tests (drive the REAL executeOpp) --------
    const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"; // matches profit.js
    const BASE = "0x1111111111111111111111111111111111111111";
    const PAIR = "0x2222222222222222222222222222222222222222";
    const ROUTER_A = "0x10ed43c718714eb63d5aa57b78b54704e256024e";
    const ROUTER_B = "0x3a6d8ca21d1cf76f653a67577fa0d27453350dD8".toLowerCase();
    const CONTRACT = "0x3333333333333333333333333333333333333333";
    const WALLET_ADDR = "0x4444444444444444444444444444444444444444";
    const TX_HASH = "0x" + "ab".repeat(32);
    const E18 = 10n ** 18n;

    function makeOpp() {
      const tokWbnb = { address: WBNB, decimals: 18, symbol: "WBNB" };
      const tokBase = { address: BASE, decimals: 18, symbol: "BASE" };
      return {
        sourceKind: "v2",
        borrowToken: tokWbnb,        // WBNB → tokenPriceInBnb = 1:1
        baseToken: tokBase,
        borrowAmount: 1000n * E18,
        // no snapshot → age 0 → not stale
        sourceVen: { kind: "v2", pair: PAIR, tokenA: tokWbnb, tokenB: tokBase, feeBps: 25, blockNumber: 100 },
        buyVen: { kind: "v2", router: ROUTER_A, feeBps: 25, tokenA: tokWbnb, tokenB: tokBase, reserveA: 1_000_000n * E18, reserveB: 1_000_000n * E18, blockNumber: 100 },
        sellVen: { kind: "v2", router: ROUTER_B, feeBps: 25, tokenA: tokWbnb, tokenB: tokBase, reserveA: 1_000_000n * E18, reserveB: 500_000n * E18, blockNumber: 100 },
      };
    }

    function makeWallet(sent) {
      const abi = require("../../artifacts/contracts/FlashLoanArbitrage.sol/FlashLoanArbitrage.json").abi;
      const iface = new (require("ethers").Interface)(abi);
      return {
        getAddress: async () => WALLET_ADDR,
        // ContractRunner: staticCall → call() returns ABI-encoded uint256 profit
        call: async () => iface.encodeFunctionResult("flashArbitrage", [123n]),
        estimateGas: async () => 100_000n,
        sendTransaction: async (tx) => { sent.push(tx); return { hash: TX_HASH }; },
      };
    }

    function makeProvider() {
      return {
        getBlockNumber: async () => 100,
        getFeeData: async () => ({ gasPrice: 1n }),
      };
    }

    /** Stub scanner/bloxroute/nonce in require-cache, re-require executor fresh. */
    function withStubbedDeps(fn) {
      const paths = {
        executor: require.resolve("../../bot/executor"),
        scanner: require.resolve("../../bot/scanner"),
        bloxroute: require.resolve("../../bot/bloxroute"),
        nonce: require.resolve("../../bot/nonce"),
      };
      const saved = {};
      for (const k of Object.keys(paths)) saved[k] = require.cache[paths[k]];

      const spy = { constructed: 0, reserved: 0, commits: [], rollbacks: [] };
      const fakeMod = (exports) => ({ id: paths.scanner, filename: paths.scanner, loaded: true, exports });
      require.cache[paths.scanner] = fakeMod({ readState: async () => {}, pairKey: (a, b) => (a < b ? a + b : b + a) });
      require.cache[paths.bloxroute] = fakeMod({
        isAvailable: async () => false,
        sendPrivateTx: async () => { throw new Error("not-used"); },
      });
      require.cache[paths.nonce] = fakeMod({
        NonceManager: class SpyNonceManager {
          constructor() { spy.constructed++; }
          async reserve() { spy.reserved++; return 42; }
          commit(n, h) { spy.commits.push([n, h]); }
          rollback(n) { spy.rollbacks.push(n); }
          async init() {}
        },
      });
      delete require.cache[paths.executor];
      const executor = require("../../bot/executor");
      try {
        return fn(executor, spy);
      } finally {
        for (const k of Object.keys(paths)) {
          if (saved[k]) require.cache[paths[k]] = saved[k];
          else delete require.cache[paths[k]];
        }
        delete require.cache[paths.executor];
      }
    }

    it("Test G1: injected manager is USED (reserve on it), no fallback constructed", async function () {
      await withStubbedDeps(async (executor, spy) => {
        const sent = [];
        let reserveCalls = 0;
        const injectedManager = {
          commits: [],
          reserve: async () => { reserveCalls++; return 7; },
          commit: (n, h) => injectedManager.commits.push([n, h]),
          rollback: () => {},
        };

        const result = await executor.executeOpp(
          makeOpp(), CONTRACT, makeWallet(sent), makeProvider(),
          { nonceManager: injectedManager }
        );

        expect(result.ok).to.equal(true);
        expect(reserveCalls).to.equal(1);            // reserve() called on the INJECTED object
        expect(spy.constructed).to.equal(0);          // NO second/fallback manager built
        expect(sent.length).to.equal(1);              // broadcast happened (mock)
        expect(sent[0].nonce).to.equal(7);            // the nonce came FROM the injected manager
        expect(injectedManager.commits[0][0]).to.equal(7);
        expect(injectedManager.commits[0][1]).to.equal(TX_HASH);
        expect(result.nonce).to.equal(7);
      });
    });
    // ANCHOR_G23
    it("Test G2: no injected manager → real fallback NonceManager is constructed and used", async function () {
      await withStubbedDeps(async (executor, spy) => {
        const sent = [];
        const result = await executor.executeOpp(
          makeOpp(), CONTRACT, makeWallet(sent), makeProvider(), {}
        );
        expect(result.ok).to.equal(true);
        expect(spy.constructed).to.equal(1);          // fallback constructed exactly once
        expect(spy.reserved).to.equal(1);
        expect(sent[0].nonce).to.equal(42);           // nonce from the fallback manager
        expect(spy.commits[0][0]).to.equal(42);
      });
    });

    it("Test G3: structurally invalid injected manager → explicit error, NO silent fallback", async function () {
      await withStubbedDeps(async (executor, spy) => {
        const broken = { reserve: async () => 7 };    // missing commit/rollback
        let err = null;
        try {
          await executor.executeOpp(makeOpp(), CONTRACT, makeWallet([]), makeProvider(), { nonceManager: broken });
        } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.message).to.include("invalid-nonce-manager");
        expect(spy.constructed).to.equal(0);          // never silently replaced
      });
    });
  });
});

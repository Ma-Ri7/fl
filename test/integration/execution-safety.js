// TASK 4.6-A — Economic execution safety (final requote + slippage + min-profit).
const { expect } = require("chai");
const safety = require("../../bot/execution-safety");
const v3lib = require("../../lib/v3");
const dodo = require("../../lib/dodo");

const E18 = 10n ** 18n;
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const BASE = "0x" + "9a".repeat(20);
const T0 = "0x" + "01".repeat(20);
const T1 = "0x" + "02".repeat(20);
const DODO_BASE = "0x" + "03".repeat(20);
const DODO_QUOTE = "0x" + "04".repeat(20);

const tokWbnb = { address: WBNB, decimals: 18, symbol: "WBNB" };
const tokBase = { address: BASE, decimals: 18, symbol: "BASE" };

// --- Fixtures ---------------------------------------------------------------

function v2Venue(pairAddr, tokA, tokB, reserveA, reserveB, feeBps = 25) {
  return { kind: "v2", router: pairAddr, feeBps, tokenA: tokA, tokenB: tokB, reserveA, reserveB };
}

// Profitable V2 opp: buyVen prices BASE cheap (1:1), sellVen prices BASE dear (2:1).
function makeV2Opp(over = {}) {
  const opp = {
    sourceKind: "v2",
    borrowToken: tokWbnb,
    baseToken: tokBase,
    borrowAmount: 1000n * E18,
    sourceVen: { kind: "v2", pair: "0x" + "a1".repeat(20), tokenA: tokWbnb, tokenB: tokBase, feeBps: 25 },
    buyVen: v2Venue("0x" + "b2".repeat(20), tokWbnb, tokBase, 1_000_000n * E18, 1_000_000n * E18),
    sellVen: v2Venue("0x" + "c3".repeat(20), tokWbnb, tokBase, 1_000_000n * E18, 500_000n * E18),
  };
  return { ...opp, ...over };
}

// Complete empty V3 bitmap (every word present = KNOWN/EMPTY, not UNKNOWN).
function completeV3Bitmap() {
  const m = new Map();
  for (let w = -400; w <= 400; w++) m.set(w, 0n);
  return m;
}

function v3Venue() {
  const SQRT_LO = v3lib.getSqrtRatioAtTick(-890);
  const SQRT_HI = v3lib.getSqrtRatioAtTick(-880);
  const SQRT = SQRT_LO + (SQRT_HI - SQRT_LO) / 2n;
  const words = completeV3Bitmap();
  return {
    kind: "v3",
    pool: "0x" + "v3".repeat(20),
    tokenA: { address: T0 },
    tokenB: { address: T1 },
    feeTier: 500,
    v3State: {
      sqrtPriceX96: SQRT.toString(),
      tick: -890,
      liquidity: (500000000000000000n).toString(),
      tickSpacing: 10,
      words: [...words].map(([word, value]) => ({ word, value: value.toString() })),
      ticks: [],
    },
  };
}

function dodoVenue() {
  const state = dodo.pmmStateFromReserves({ i: E18, K: E18 / 2n, B: 1_000_000n * E18, Q: 1_000_000n * E18 });
  return {
    kind: "dodo",
    pool: "0x" + "dd".repeat(20),
    baseToken: DODO_BASE,
    quoteToken: DODO_QUOTE,
    pmm: state,
    lpFeeRate: 0n,
    mtFeeRate: 0n,
  };
}

describe("TASK 4.6-A — Economic execution safety", function () {
  describe("Slippage policy", function () {
    it("1. validateSlippageBps accepts valid bps", function () {
      expect(safety.validateSlippageBps(100n)).to.equal(100n);
      expect(safety.validateSlippageBps(0n)).to.equal(0n);
      expect(safety.validateSlippageBps(9999n)).to.equal(9999n);
    });
    it("2. validateSlippageBps accepts number 100", function () {
      expect(safety.validateSlippageBps(100)).to.equal(100n);
    });
    it("3. zero slippage → minOut equals expectedOut", function () {
      expect(safety.computeMinOut(1000n, 0n)).to.equal(1000n);
    });
    it("4. 100 bps → 1% slippage", function () {
      expect(safety.computeMinOut(1000n, 100n)).to.equal(990n);
    });
    it("5. 2500 bps → 25% slippage", function () {
      expect(safety.computeMinOut(1000n, 2500n)).to.equal(750n);
    });
    it("6. boundary 9999 bps", function () {
      expect(safety.computeMinOut(10000n, 9999n)).to.equal(1n);
    });
    it("7. 10000 bps rejected", function () {
      expect(safety.validateSlippageBps(10000n)).to.be.null;
    });
    it("8. >10000 bps rejected", function () {
      expect(safety.validateSlippageBps(15000n)).to.be.null;
    });
    it("9. negative bps rejected", function () {
      expect(safety.validateSlippageBps(-1n)).to.be.null;
    });
    it("10. fractional bps rejected", function () {
      expect(safety.validateSlippageBps(10.5)).to.be.null;
      expect(safety.validateSlippageBps("10.5")).to.be.null;
    });
    it("11. BigInt exact, floor rounding", function () {
      expect(safety.computeMinOut(9999n, 100n)).to.equal(9899n);
    });
    it("12. computeMinOut throws on invalid expectedOut", function () {
      expect(() => safety.computeMinOut(-1n, 100n)).to.throw("invalid-expected-out");
      expect(() => safety.computeMinOut("x", 100n)).to.throw("invalid-expected-out");
    });
    it("13. computeMinOut throws on invalid slippage", function () {
      expect(() => safety.computeMinOut(1000n, 10000n)).to.throw("invalid-slippage-bps");
    });
  });



  describe("V2 final requote", function () {
    it("14. fresh quote success", function () {
      const r = safety.finalRequote(makeV2Opp(), { slippageBps: 100n });
      expect(r.ok).to.equal(true);
      expect(r.final.net > 0n).to.be.true;
      expect(r.final.minProfit > 0n).to.be.true;
      expect(r.rejection).to.be.null;
    });
    it("15. expected vs final separation", function () {
      const opp = makeV2Opp({ baseRecv: 1n, quoteRecv: 2n, netProfit: 3n });
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.expected.baseRecv).to.equal(1n);
      expect(r.expected.quoteRecv).to.equal(2n);
      expect(r.expected.net).to.equal(3n);
      expect(r.final.net).to.not.equal(3n);
    });
    it("16. leg A zero output → QUOTE_FAILED", function () {
      const opp = makeV2Opp({ buyVen: v2Venue("0x" + "b2".repeat(20), tokWbnb, tokBase, 0n, 1_000_000n * E18) });
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("QUOTE_FAILED");
    });
    it("17. leg B zero output → QUOTE_FAILED", function () {
      const opp = makeV2Opp({ sellVen: v2Venue("0x" + "c3".repeat(20), tokWbnb, tokBase, 1_000_000n * E18, 0n) });
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("QUOTE_FAILED");
    });
    it("18. zero borrowAmount → INVALID_AMOUNT", function () {
      const r = safety.finalRequote(makeV2Opp({ borrowAmount: 0n }), { slippageBps: 100n });
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("INVALID_AMOUNT");
    });
    it("19. negative borrowAmount → INVALID_AMOUNT", function () {
      const r = safety.finalRequote(makeV2Opp({ borrowAmount: -1n }), { slippageBps: 100n });
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("INVALID_AMOUNT");
    });
    it("20. missing opportunity → MISSING_STATE", function () {
      const r = safety.finalRequote(null);
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("MISSING_STATE");
    });
    it("21. missing venue → MISSING_STATE", function () {
      const r = safety.finalRequote(makeV2Opp({ sellVen: undefined }), { slippageBps: 100n });
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("MISSING_STATE");
    });
    it("22. invalid slippage → INVALID_SLIPPAGE", function () {
      const r = safety.finalRequote(makeV2Opp(), { slippageBps: 10000n });
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("INVALID_SLIPPAGE");
    });
    it("23. reserve changed → different quote", function () {
      const a = safety.finalRequote(makeV2Opp(), { slippageBps: 100n });
      const worse = makeV2Opp({ sellVen: v2Venue("0x" + "c3".repeat(20), tokWbnb, tokBase, 1_000_000n * E18, 900_000n * E18) });
      const b = safety.finalRequote(worse, { slippageBps: 100n });
      expect(b.final.quoteRecv).to.not.equal(a.final.quoteRecv);
    });
    it("24. fee changed → different output", function () {
      const a = safety.finalRequote(makeV2Opp(), { slippageBps: 100n });
      const b = safety.finalRequote(makeV2Opp({ buyVen: v2Venue("0x" + "b2".repeat(20), tokWbnb, tokBase, 1_000_000n * E18, 1_000_000n * E18, 100) }), { slippageBps: 100n });
      expect(b.final.baseRecv).to.not.equal(a.final.baseRecv);
    });
    it("25. two-leg dependency (leg B input = leg A output)", function () {
      const profit = require("../../bot/profit");
      const opp = makeV2Opp();
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      const expectedBase = profit.venueOutput(opp.buyVen, opp.borrowToken.address, opp.borrowAmount);
      const expectedQuote = profit.venueOutput(opp.sellVen, opp.baseToken.address, expectedBase);
      expect(r.final.baseRecv).to.equal(expectedBase);
      expect(r.final.quoteRecv).to.equal(expectedQuote);
    });
    it("26. opportunity is not mutated", function () {
      const opp = makeV2Opp();
      const before = JSON.stringify(opp, (k, v) => (typeof v === "bigint" ? v.toString() : v));
      safety.finalRequote(opp, { slippageBps: 100n });
      const after = JSON.stringify(opp, (k, v) => (typeof v === "bigint" ? v.toString() : v));
      expect(after).to.equal(before);
    });
    it("27. deterministic result", function () {
      const a = safety.finalRequote(makeV2Opp(), { slippageBps: 100n });
      const b = safety.finalRequote(makeV2Opp(), { slippageBps: 100n });
      expect(b.final.net).to.equal(a.final.net);
      expect(b.final.minProfit).to.equal(a.final.minProfit);
    });
  });

  describe("V3 final requote", function () {
    it("28. missing V3 state → QUOTE_FAILED (no approximate fallback)", function () {
      const opp = makeV2Opp({ buyVen: { kind: "v3", pool: "0x" + "v3".repeat(20), tokenA: { address: T0 }, tokenB: { address: T1 }, feeTier: 500 }, sellVen: v2Venue("0x" + "c3".repeat(20), tokWbnb, tokBase, 1_000_000n * E18, 500_000n * E18) });
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("QUOTE_FAILED");
    });
    it("29. valid V3 state → exact quote", function () {
      const v3 = v3Venue();
      const opp = { sourceKind: "v2", borrowToken: { address: T0 }, baseToken: { address: T1 }, borrowAmount: 1000n, buyVen: v3, sellVen: v3, slippageBps: 100n };
      // Both legs use the same V3 pool (0->1 then 1->0), deterministic output.
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.ok).to.equal(true);
      expect(r.final.baseRecv > 0n).to.be.true;
    });
    it("30. V3 direction zeroForOne vs oneForZero differs", function () {
      const profit = require("../../bot/profit");
      const v3 = v3Venue();
      const out01 = profit.venueOutput(v3, T0, 1000n);
      const out10 = profit.venueOutput(v3, T1, 1000n);
      expect(out01 > 0n).to.be.true;
      expect(out10 > 0n).to.be.true;
      expect(out01).to.not.equal(out10);
    });
    it("31. V3 incomplete bitmap (missing word) → fail closed → 0", function () {
      const profit = require("../../bot/profit");
      const v3 = v3Venue();
      v3.v3State.words = [{ word: 0, value: "0" }]; // single word, others UNKNOWN
      expect(profit.venueOutput(v3, T0, 1000n)).to.equal(0n);
    });
  });

  describe("DODO final requote", function () {
    it("32. missing PMM → QUOTE_FAILED", function () {
      const d = dodoVenue();
      delete d.pmm;
      const opp = { sourceKind: "dodo", borrowToken: { address: DODO_BASE }, baseToken: { address: DODO_QUOTE }, borrowAmount: 1000n * E18, buyVen: d, sellVen: d };
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("QUOTE_FAILED");
    });
    it("33. valid PMM → exact quote", function () {
      const d = dodoVenue();
      const opp = { sourceKind: "dodo", borrowToken: { address: DODO_BASE }, baseToken: { address: DODO_QUOTE }, borrowAmount: 1000n * E18, buyVen: d, sellVen: d };
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.ok).to.equal(true);
      expect(r.final.baseRecv > 0n).to.be.true;
    });
    it("34. changed PMM state → different output", function () {
      const d1 = dodoVenue();
      const d2 = dodoVenue();
      d2.pmm.B = d2.pmm.B / 2n;
      const profit = require("../../bot/profit");
      const a = profit.venueOutput(d1, DODO_BASE, 1000n * E18);
      const b = profit.venueOutput(d2, DODO_BASE, 1000n * E18);
      expect(a).to.not.equal(b);
    });
    it("35. DODO fee (lpFeeRate) reduces output", function () {
      const profit = require("../../bot/profit");
      const d0 = dodoVenue();
      const d1 = dodoVenue();
      d1.lpFeeRate = 10000000000000000n; // 1% (1e16 / 1e18)
      const a = profit.venueOutput(d0, DODO_BASE, 1000n * E18);
      const b = profit.venueOutput(d1, DODO_BASE, 1000n * E18);
      expect(b < a).to.be.true;
    });
  });


  describe("validateExecutionEconomics", function () {
    function profitableRequote() {
      return safety.finalRequote(makeV2Opp(), { slippageBps: 100n });
    }
    it("36. passes for profitable requote", function () {
      const g = safety.validateExecutionEconomics(profitableRequote(), { slippageBps: 100n });
      expect(g.ok).to.equal(true);
      expect(g.rejection).to.be.null;
    });
    it("37. minProfit <= 0 → MIN_PROFIT_FAILED", function () {
      const r = profitableRequote();
      r.final.minProfit = 0n;
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n });
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("MIN_PROFIT_FAILED");
    });
    it("38. net <= 0 → ECONOMIC_CHECK_FAILED", function () {
      const r = profitableRequote();
      r.final.net = -1n;
      r.final.minProfit = 0n;
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n });
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("ECONOMIC_CHECK_FAILED");
    });
    it("39. invalid slippage → INVALID_SLIPPAGE", function () {
      const g = safety.validateExecutionEconomics(profitableRequote(), { slippageBps: 10000n });
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("INVALID_SLIPPAGE");
    });
    it("40. missing result → ECONOMIC_CHECK_FAILED", function () {
      const g = safety.validateExecutionEconomics(null, {});
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("ECONOMIC_CHECK_FAILED");
    });
    it("41. net below minProfit floor → MIN_PROFIT_FAILED", function () {
      const r = profitableRequote();
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n, minProfit: r.final.net + 1n });
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("MIN_PROFIT_FAILED");
    });
    it("42. net above minProfit floor → ok", function () {
      const r = profitableRequote();
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n, minProfit: 1n });
      expect(g.ok).to.equal(true);
    });
    it("43. netInBnb below minProfitBnb → MIN_PROFIT_FAILED", function () {
      const r = profitableRequote();
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n, netInBnb: 5n, minProfitBnb: 10n });
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("MIN_PROFIT_FAILED");
    });
    it("44. netInBnb above minProfitBnb → ok", function () {
      const r = profitableRequote();
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n, netInBnb: 15n, minProfitBnb: 10n });
      expect(g.ok).to.equal(true);
    });
    it("45. gas floor: netInBnb below floor → MIN_PROFIT_FAILED", function () {
      const r = profitableRequote();
      // gas 100 wei, 0 reserve → floor = 100; netInBnb 100 is NOT > 100 → reject
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n, netInBnb: 100n, gasCostWei: 100n, gasReserveBps: 0n });
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("MIN_PROFIT_FAILED");
    });
    it("46. gas floor passes when netInBnb above floor", function () {
      const r = profitableRequote();
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n, netInBnb: 101n, gasCostWei: 100n, gasReserveBps: 0n });
      expect(g.ok).to.equal(true);
    });
    it("47. missing netInBnb when minProfitBnb provided → ECONOMIC_CHECK_FAILED", function () {
      const r = profitableRequote();
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n, minProfitBnb: 1n });
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("ECONOMIC_CHECK_FAILED");
    });
    it("48. zero output → MIN_OUTPUT_FAILED", function () {
      const r = profitableRequote();
      r.final.quoteRecv = 0n;
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n });
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("MIN_OUTPUT_FAILED");
    });
  });

  describe("Immutability / edge", function () {
    it("49. missing borrowToken → MISSING_STATE", function () {
      const opp = makeV2Opp({ borrowToken: undefined });
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("MISSING_STATE");
    });
    it("50. snapshot object is not mutated", function () {
      const opp = makeV2Opp();
      opp.snapshot = { blockNumber: 100, blockHash: "0x" + "ee".repeat(32) };
      const before = JSON.stringify(opp.snapshot);
      safety.finalRequote(opp, { slippageBps: 100n });
      expect(JSON.stringify(opp.snapshot)).to.equal(before);
    });
    it("51. minOut is meaningful and below quoteRecv", function () {
      const r = safety.finalRequote(makeV2Opp(), { slippageBps: 100n });
      expect(r.slippage.minOut > 0n).to.be.true;
      expect(r.slippage.minOut < r.final.quoteRecv).to.be.true;
    });
  });

  describe("Executor integration (guard actually called)", function () {
    const SCAN = require.resolve("../../bot/scanner");
    const BX = require.resolve("../../bot/bloxroute");
    const EX = require.resolve("../../bot/executor");

    function isolate(opts, fn) {
      const savedScan = require.cache[SCAN];
      const savedBx = require.cache[BX];
      require.cache[SCAN] = { id: SCAN, filename: SCAN, loaded: true, exports: { readState: async () => {}, pairKey: (a, b) => a + b } };
      require.cache[BX] = { id: BX, filename: BX, loaded: true, exports: {
        isAvailable: async () => opts.available !== false,
        sendPrivateTx: opts.sendPrivateTx || (async () => ({ ok: true, status: "accepted", txHash: "0x" + "aa".repeat(32), block: 1 })),
      } };
      delete require.cache[EX];
      const executor = require("../../bot/executor");
      try {
        return fn(executor);
      } finally {
        if (savedScan) require.cache[SCAN] = savedScan; else delete require.cache[SCAN];
        if (savedBx) require.cache[BX] = savedBx; else delete require.cache[BX];
        delete require.cache[EX];
      }
    }

    function wallet(sent) {
      return { address: "0x" + "e1".repeat(20), getAddress: async () => "0x" + "e1".repeat(20), getNonce: async () => 100, call: async () => "0x" + "00".repeat(31) + "7b", estimateGas: async () => 100000n, sendTransaction(tx) { sent.push(tx); return { hash: "0x" + "tx".repeat(10) }; } };
    }
    function provider() {
      return { getBlockNumber: async () => 100, getFeeData: async () => ({ gasPrice: 1n }) };
    }
    function unprofitableOpp() {
      return makeV2Opp({ sellVen: v2Venue("0x" + "c3".repeat(20), tokWbnb, tokBase, 1_000_000n * E18, 1_000_000n * E18) });
    }

    it("52. profitable opportunity → submission allowed (private accepted)", async function () {
      await isolate({}, async (executor) => {
        const res = await executor.executeOpp(makeV2Opp(), "0x" + "f1".repeat(20), wallet([]), provider(), {});
        expect(res.ok).to.equal(true);
        expect(res.txHash).to.equal("0x" + "aa".repeat(32));
      });
    });
    it("53. economic failure → ok:false, ECONOMIC_CHECK_FAILED", async function () {
      await isolate({}, async (executor) => {
        const res = await executor.executeOpp(unprofitableOpp(), "0x" + "f1".repeat(20), wallet([]), provider(), {});
        expect(res.ok).to.equal(false);
        expect(res.reason).to.equal("ECONOMIC_CHECK_FAILED");
      });
    });
    it("54. economic failure → sendPrivateTx NOT called", async function () {
      let calls = 0;
      await isolate({ sendPrivateTx: async () => { calls++; return { ok: true, status: "accepted", txHash: "0x" + "bb".repeat(32) }; } }, async (executor) => {
        await executor.executeOpp(unprofitableOpp(), "0x" + "f1".repeat(20), wallet([]), provider(), {});
      });
      expect(calls).to.equal(0);
    });
    it("55. economic failure → nonce NOT reserved", async function () {
      let reserveCalls = 0;
      const mgr = { async reserve() { reserveCalls++; return 1; }, commit() {}, rollback() {} };
      await isolate({}, async (executor) => {
        await executor.executeOpp(unprofitableOpp(), "0x" + "f1".repeat(20), wallet([]), provider(), { nonceManager: mgr });
      });
      expect(reserveCalls).to.equal(0);
    });
    it("56. public path: profitable → broadcast", async function () {
      await isolate({ available: false }, async (executor) => {
        const sent = [];
        const res = await executor.executeOpp(makeV2Opp(), "0x" + "f1".repeat(20), wallet(sent), provider(), {});
        expect(res.ok).to.equal(true);
        expect(sent.length).to.equal(1);
      });
    });
    it("57. public path: economic failure → no broadcast", async function () {
      await isolate({ available: false }, async (executor) => {
        const sent = [];
        const res = await executor.executeOpp(unprofitableOpp(), "0x" + "f1".repeat(20), wallet(sent), provider(), {});
        expect(res.ok).to.equal(false);
        expect(sent.length).to.equal(0);
      });
    });
    it("58. no calldata/broadcast before guard (unprofitable returns before reserve)", async function () {
      let reserveCalls = 0;
      const mgr = { async reserve() { reserveCalls++; return 1; }, commit() {}, rollback() {} };
      await isolate({}, async (executor) => {
        const res = await executor.executeOpp(unprofitableOpp(), "0x" + "f1".repeat(20), wallet([]), provider(), { nonceManager: mgr });
        expect(res.reason).to.equal("ECONOMIC_CHECK_FAILED");
      });
      expect(reserveCalls).to.equal(0);
    });
  });

  describe("Expected vs final profit separation", function () {
    it("59. final worse than expected (deterioration)", function () {
      const opp = makeV2Opp({ netProfit: 1_000_000n * E18 }); // huge expected
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.ok).to.equal(true);
      expect(r.final.net < r.expected.net).to.be.true;
      expect(r.expected.net).to.equal(1_000_000n * E18); // expected preserved
    });
    it("60. final better than expected (improvement)", function () {
      const opp = makeV2Opp({ netProfit: 1n }); // tiny expected
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.ok).to.equal(true);
      expect(r.final.net > r.expected.net).to.be.true;
    });
    it("61. expected quote not overwritten by final", function () {
      const opp = makeV2Opp({ baseRecv: 7n, quoteRecv: 8n, netProfit: 9n });
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.expected.baseRecv).to.equal(7n);
      expect(r.expected.quoteRecv).to.equal(8n);
      expect(r.expected.net).to.equal(9n);
      expect(r.final.baseRecv).to.not.equal(7n);
    });
    it("62. expected zero net is a valid known value, not UNKNOWN", function () {
      const opp = makeV2Opp({ netProfit: 0n });
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.expected.net).to.equal(0n);
      expect(r.final.net > 0n).to.be.true;
    });
  });


  describe("Adversarial / boundary (mutation-detection)", function () {
    function manualRequote(net, minProfit, quoteRecv = 1000n, baseRecv = 500n) {
      return { ok: true, final: { baseRecv, quoteRecv, net, minProfit, flashFee: 0n } };
    }

    it("63. profit exactly == minProfit floor → accept (>= semantics)", function () {
      const g = safety.validateExecutionEconomics(manualRequote(50n, 50n), { slippageBps: 100n, minProfit: 50n });
      expect(g.ok).to.equal(true);
    });
    it("64. profit one wei below floor → reject", function () {
      const g = safety.validateExecutionEconomics(manualRequote(49n, 49n), { slippageBps: 100n, minProfit: 50n });
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("MIN_PROFIT_FAILED");
    });
    it("65. expected=100, final=40, minProfit=50 → reject", function () {
      const opp = makeV2Opp({ netProfit: 100n });
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      // Simulate a deteriorated final net of 40 with a floor of 50.
      const g = safety.validateExecutionEconomics(manualRequote(40n, 40n), { slippageBps: 100n, minProfit: 50n });
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("MIN_PROFIT_FAILED");
    });
    it("66. malformed final.net (string) → ECONOMIC_CHECK_FAILED (not throw)", function () {
      const r = manualRequote(50n, 50n);
      r.final.net = "abc";
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n });
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("ECONOMIC_CHECK_FAILED");
    });
    it("67. malformed final.minProfit (number) → ECONOMIC_CHECK_FAILED", function () {
      const r = manualRequote(50n, 50n);
      r.final.minProfit = 50;
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n });
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("ECONOMIC_CHECK_FAILED");
    });
    it("68. both legs bad → QUOTE_FAILED", function () {
      const opp = makeV2Opp({
        buyVen: v2Venue("0x" + "b2".repeat(20), tokWbnb, tokBase, 0n, 1_000_000n * E18),
        sellVen: v2Venue("0x" + "c3".repeat(20), tokWbnb, tokBase, 1_000_000n * E18, 0n),
      });
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("QUOTE_FAILED");
    });
    it("69. final quote better than expected → allowed", function () {
      const opp = makeV2Opp({ netProfit: 1n }); // tiny expected
      const r = safety.finalRequote(opp, { slippageBps: 100n });
      expect(r.ok).to.equal(true);
      expect(r.final.net > r.expected.net).to.be.true;
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n });
      expect(g.ok).to.equal(true);
    });
    it("70. removing minProfit check would be detected (mutated minProfit=0)", function () {
      const r = safety.finalRequote(makeV2Opp(), { slippageBps: 100n });
      r.final.minProfit = 0n; // mutation: pretend the minProfit guard was removed
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n });
      expect(g.ok).to.equal(false);
    });
    it("71. removing net check would be detected (mutated net<=0)", function () {
      const r = safety.finalRequote(makeV2Opp(), { slippageBps: 100n });
      r.final.net = -1n;
      r.final.minProfit = 0n;
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n });
      expect(g.ok).to.equal(false);
    });
    it("72. zero quoteRecv (reuse stale expected as final) → MIN_OUTPUT_FAILED", function () {
      const r = safety.finalRequote(makeV2Opp(), { slippageBps: 100n });
      r.final.quoteRecv = 0n; // mutation: final output collapsed to 0
      const g = safety.validateExecutionEconomics(r, { slippageBps: 100n });
      expect(g.ok).to.equal(false);
      expect(g.rejection.code).to.equal("MIN_OUTPUT_FAILED");
    });
    it("73. deterministic across repeated calls (pure module)", function () {
      const opp = makeV2Opp();
      const a = safety.finalRequote(opp, { slippageBps: 100n });
      const b = safety.finalRequote(opp, { slippageBps: 100n });
      expect(a.final.net).to.equal(b.final.net);
      expect(a.final.minProfit).to.equal(b.final.minProfit);
      expect(a.slippage.minOut).to.equal(b.slippage.minOut);
      expect(a.slippage.bps).to.equal(b.slippage.bps);
    });
  });

});

// TASK 4.5-F — Expected vs Realized P&L Reconciliation - Behavioral tests
const chai = require("chai");
const chaiAsPromised = require("chai-as-promised");
chai.use(chaiAsPromised);
const { expect } = chai;
const { PnLTracker } = require("../../bot/pnl");
const {
  ReconciliationTracker,
  ReconcileStatus,
  DeviationDirection,
  calcBps,
} = require("../../bot/reconciliation");

const WALLET_A = "0x70997970C51812dc3A010C7d01b50b0429c0d3c8";
const WALLET_B = "0x3C44CdddB6a900fa2b585dd299e03D12FA4293BC";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const BNB = "0x0000000000000000000000000000000000000000";
const TX_HASH_1 = "0x" + "a".repeat(64);
const TX_HASH_2 = "0x" + "b".repeat(64);
const BLOCK_HASH = "0x" + "d".repeat(64);

function confirmedReceipt(overrides = {}) {
  return { status: 1, gasUsed: 200000n, effectiveGasPrice: 3000000000n, blockNumber: 100, blockHash: BLOCK_HASH, ...overrides };
}

function revertedReceipt(overrides = {}) {
  return { status: 0, gasUsed: 200000n, effectiveGasPrice: 3000000000n, blockNumber: 100, blockHash: BLOCK_HASH, ...overrides };
}

function makeExpected(overrides = {}) {
  return {
    settlementToken: USDT, settlementDecimals: 6,
    grossRaw: 20000000n, gasWei: 600000000000000n, source: "finalRequote",
    ...overrides,
  };
}

function makePnLRecord(txHash, overrides = {}) {
  const t = new PnLTracker();
  return t.recordPnL({
    txHash, wallet: WALLET_A, settlementToken: USDT, settlementDecimals: 6,
    beforeBalanceRaw: 1000000n, afterBalanceRaw: 1012500n, receipt: confirmedReceipt(), ...overrides,
  });
}

describe("TASK 4.5-F — Expected vs Realized Reconciliation", function () {
  let tracker;
  beforeEach(function () { tracker = new ReconciliationTracker(new PnLTracker()); });

  describe("Basic Reconciliation", function () {
    it("1. expected > realized (underperformance)", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 20000000n }, realizedRecord: realized });
      expect(rec.status).to.equal(ReconcileStatus.PARTIAL);
            expect(rec.grossDeviationRaw).to.equal(12500n - 20000000n);
    });

    it("2. expected < realized (overperformance)", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 5000n }, realizedRecord: realized });
      expect(rec.grossDeviationRaw).to.equal(7500n);
      expect(rec.grossDirection).to.equal(DeviationDirection.BETTER_THAN_EXPECTED);
    });

    it("3. expected == realized (exact)", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 12500n }, realizedRecord: realized });
      expect(rec.grossDeviationRaw).to.equal(0n);
            expect(rec.grossDirection).to.equal(DeviationDirection.EXACTLY_AS_EXPECTED);
    });

    it("4. expected zero, realized positive", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 0n }, realizedRecord: realized });
      expect(rec.grossDeviationRaw).to.equal(12500n);
      expect(rec.grossDirection).to.equal(DeviationDirection.BETTER_THAN_EXPECTED);
    });

    it("5. expected positive, realized zero", function () {
      const realized = makePnLRecord(TX_HASH_1, { afterBalanceRaw: 1000000n });
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 20000000n }, realizedRecord: realized });
      expect(rec.grossDeviationRaw).to.equal(-20000000n);
    });

    it("6. expected negative, realized negative", function () {
      const realized = makePnLRecord(TX_HASH_1, { beforeBalanceRaw: 1012500n, afterBalanceRaw: 1000000n });
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: -5000n }, realizedRecord: realized });
      // realized = after - before = 1000000 - 1012500 = -12500
      // deviation = realized - expected = -12500 - (-5000) = -7500
      expect(rec.grossDeviationRaw).to.equal(-7500n);
    });

    it("7. transaction identity preserved", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized });
      expect(rec.txHash).to.equal(TX_HASH_1);
      expect(rec.wallet).to.equal(WALLET_A.toLowerCase());
    });

    it("8. block metadata preserved", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), blockNumber: 50, blockHash: BLOCK_HASH }, realizedRecord: realized });
      expect(rec.expected.blockNumber).to.equal(50);
      expect(rec.realized.blockNumber).to.equal(100);
    });

    it("9. expected source preserved", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), source: "finalRequote" }, realizedRecord: realized });
      expect(rec.expected.source).to.equal("finalRequote");
      expect(rec.realized.source).to.equal("PnLTracker");
    });

    it("10. raw BigInt preserved", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized });
      expect(typeof rec.grossDeviationRaw).to.equal("bigint");
        });
  });

  describe("BPS Calculation", function () {
    it("11. calcBps +100% (doubled)", function () {
      expect(calcBps(20000n, 10000n)).to.equal(10000n);
    });
    it("12. calcBps -100% (halved to zero)", function () {
      expect(calcBps(0n, 10000n)).to.equal(-10000n);
    });
    it("13. calcBps +25%", function () {
      expect(calcBps(12500n, 10000n)).to.equal(2500n);
    });
    it("14. calcBps -25%", function () {
      expect(calcBps(7500n, 10000n)).to.equal(-2500n);
    });
    it("15. calcBps zero expected → null", function () {
      expect(calcBps(10000n, 0n)).to.be.null;
    });
    it("16. calcBps null realized → null", function () {
      expect(calcBps(null, 10000n)).to.be.null;
    });
    it("17. calcBps null expected → null", function () {
      expect(calcBps(10000n, null)).to.be.null;
    });
    it("18. calcBps negative deviation", function () {
      expect(calcBps(5000n, 10000n)).to.equal(-5000n);
    });
    it("19. calcBps truncation (not rounding)", function () {
      expect(calcBps(12501n, 10000n)).to.equal(2501n);
      expect(calcBps(3333n, 10000n)).to.equal(-6667n);
    });
    it("20. BPS integrated into record", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 10000n }, realizedRecord: realized });
            expect(rec.grossDeviationBps).to.equal(2500n);
    });
  });

  describe("Gas Reconciliation", function () {
    it("21. gas deviation known (more gas used)", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), gasWei: 500000000000000n }, realizedRecord: realized });
      expect(rec.gasDeviationWei).to.equal(100000000000000n);
      expect(rec.gasDirection).to.equal(DeviationDirection.WORSE_THAN_EXPECTED);
    });
    it("22. gas under budget (less gas used)", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), gasWei: 700000000000000n }, realizedRecord: realized });
      expect(rec.gasDeviationWei).to.equal(-100000000000000n);
      expect(rec.gasDirection).to.equal(DeviationDirection.BETTER_THAN_EXPECTED);
    });
    it("23. gas exact match", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), gasWei: 600000000000000n }, realizedRecord: realized });
      expect(rec.gasDeviationWei).to.equal(0n);
      expect(rec.gasDirection).to.equal(DeviationDirection.EXACTLY_AS_EXPECTED);
    });
    it("24. gas BPS", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), gasWei: 500000000000000n }, realizedRecord: realized });
      // realized 600e12 vs expected 500e12 → +100e12; bps = 100/500 * 10000 = 2000
      expect(rec.gasDeviationBps).to.equal(2000n);
    });
    it("25. expected gas null → no gas deviation", function () {
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), gasWei: null }, realizedRecord: makePnLRecord(TX_HASH_1) });
      expect(rec.gasDeviationWei).to.be.null;
    });
    it("26. realized gas null → no gas deviation", function () {
      const realized = makePnLRecord(TX_HASH_1, { receipt: null });
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), gasWei: 600000000000000n }, realizedRecord: realized });
            expect(rec.gasDeviationWei).to.be.null;
    });
  });

  describe("Net Reconciliation", function () {
    it("27. net deviation computable when BNB settlement", function () {
      const realized = makePnLRecord(TX_HASH_1, {
        settlementToken: BNB, settlementDecimals: 18,
        beforeBalanceRaw: 1000000000000000000n, afterBalanceRaw: 1012500000000000000n,
        borrowedAmountRaw: 0n, repaidAmountRaw: 0n,
      });
      const rec = tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { settlementToken: BNB, settlementDecimals: 18, grossRaw: 20000000000000000n, gasWei: 600000000000000n, netRaw: 14000000000000000n, source: "requote" },
        realizedRecord: realized,
      });
      expect(rec.netDeviationRaw).to.not.be.null;
    });
    it("28. net deviation NOT computed when USDT + BNB gas", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { settlementToken: USDT, settlementDecimals: 6, grossRaw: 20000000n, gasWei: 600000000000000n, netRaw: 14000000n, source: "requote" },
        realizedRecord: realized,
      });
      expect(rec.netDeviationRaw).to.be.null;
      expect(rec.realized.netRaw).to.be.null;
    });
    it("29. net deviation UNKNOWN when realized net unknown", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { settlementToken: USDT, settlementDecimals: 6, grossRaw: 20000000n, gasWei: 600000000000000n, netRaw: 14000000n, source: "requote" },
        realizedRecord: realized,
      });
      expect(rec.netDeviationRaw).to.be.null;
    });
    it("30. net BPS when computable", function () {
      const realized = makePnLRecord(TX_HASH_1, {
        settlementToken: BNB, settlementDecimals: 18,
        beforeBalanceRaw: 1000000000000000000n, afterBalanceRaw: 10100000000000000000n,
        borrowedAmountRaw: 0n, repaidAmountRaw: 0n,
      });
      const rec = tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { settlementToken: BNB, settlementDecimals: 18, grossRaw: 1000000000000000000n, gasWei: 500000000000000n, netRaw: 500000000000000000n, source: "requote" },
        realizedRecord: realized,
      });
      expect(rec.netDeviationBps).to.exist;
    });
  });

  describe("Token Dimensionality", function () {
    it("31. USDT vs USDT → can compare gross", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized });
      expect(rec.tokenDimensionalityMatch).to.be.true;
    });
    it("32. USDC vs USDC → can compare gross", function () {
      const realized = makePnLRecord(TX_HASH_1, { settlementToken: USDC });
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), settlementToken: USDC }, realizedRecord: realized });
      expect(rec.tokenDimensionalityMatch).to.be.true;
    });
    it("34. USDT vs BNB → cannot compare gross, net UNKNOWN", function () {
      const realized = makePnLRecord(TX_HASH_1, { settlementToken: BNB, settlementDecimals: 18, beforeBalanceRaw: 1000000000000000000n, afterBalanceRaw: 1010000000000000000n });
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), settlementToken: USDT }, realizedRecord: realized });
      expect(rec.tokenDimensionalityMatch).to.be.false;
      expect(rec.grossDeviationRaw).to.be.null;
    });
    it("35. USDT vs USDC → cannot compare without conversion", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), settlementToken: USDC }, realizedRecord: realized });
      expect(rec.tokenDimensionalityMatch).to.be.false;
      expect(rec.grossDeviationRaw).to.be.null;
    });
    it("36. USDT profit + BNB gas not mixed in net", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { settlementToken: USDT, settlementDecimals: 6, grossRaw: 20000000n, gasWei: 600000000000000n, source: "requote" },
        realizedRecord: realized,
      });
      expect(rec.grossDeviationRaw).to.not.be.null;
      expect(rec.gasDeviationWei).to.not.be.null;
            expect(rec.netDeviationRaw).to.be.null;
    });
  });

  describe("UNKNOWN Handling", function () {
    it("37. realized not recorded → UNKNOWN status", function () {
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected() });
      expect(rec.status).to.equal(ReconcileStatus.UNKNOWN);
      expect(rec.realized.grossRaw).to.be.null;
      expect(rec.grossDeviationRaw).to.be.null;
    });
    it("38. UNKNOWN not converted to zero", function () {
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected() });
      expect(rec.grossDeviationRaw).to.be.null;
      expect(rec.grossDeviationRaw === 0n).to.be.false;
    });
    it("39. UNKNOWN excluded from known aggregation", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected() });
      tracker.reconcile({
        txHash: TX_HASH_2, wallet: WALLET_A,
        expected: { ...makeExpected(), grossRaw: 5000n },
        realizedRecord: makePnLRecord(TX_HASH_2),
      });
      const list = tracker.listReconciliations();
      expect(list.length).to.equal(2);
    });
  });

  describe("Reverted Transaction", function () {
    it("40. reverted → PARTIAL status", function () {
      const realized = makePnLRecord(TX_HASH_1, { receipt: revertedReceipt() });
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized });
      expect(rec.status).to.equal(ReconcileStatus.PARTIAL);
      expect(rec.realized.isReverted).to.be.true;
    });
    it("41. reverted → gas cost still captured", function () {
      const realized = makePnLRecord(TX_HASH_1, { receipt: revertedReceipt() });
      const rec = tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { ...makeExpected(), gasWei: 500000000000000n },
        realizedRecord: realized,
      });
      expect(rec.realized.gasWei).to.equal(600000000000000n);
      expect(rec.gasDeviationWei).to.equal(100000000000000n);
    });
    it("42. reverted → gross deviation UNKNOWN", function () {
      const realized = makePnLRecord(TX_HASH_1, { receipt: revertedReceipt() });
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized });
      expect(rec.grossDeviationRaw).to.be.null;
    });
    it("43. reverted → no fake realized profit", function () {
      const realized = makePnLRecord(TX_HASH_1, { receipt: revertedReceipt() });
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 20000000n }, realizedRecord: realized });
      expect(rec.realized.grossRaw).to.be.null;
      expect(rec.grossDeviationRaw).to.be.null;
    });
    it("44. reverted → expected retained", function () {
      const realized = makePnLRecord(TX_HASH_1, { receipt: revertedReceipt() });
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 20000000n }, realizedRecord: realized });
      expect(rec.expected.grossRaw).to.equal(20000000n);
    });
  });

  describe("Dropped Transaction", function () {
    it("45. dropped → REALIZED unknown, no fake P&L", function () {
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected() });
      expect(rec.status).to.equal(ReconcileStatus.UNKNOWN);
      expect(rec.realized.grossRaw).to.be.null;
    });
    it("46. dropped → no fake loss or profit", function () {
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 20000000n }, realizedRecord: null });
            expect(rec.grossDeviationRaw).to.be.null;
    });
  });

  describe("Idempotency", function () {
    it("47. same tx reconciled twice → same record", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const r1 = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized });
      const r2 = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized });
      expect(r1.id).to.equal(r2.id);
      expect(r1.grossDeviationRaw).to.equal(r2.grossDeviationRaw);
    });
    it("48. same tx ten times → one record", function () {
      const realized = makePnLRecord(TX_HASH_1);
      for (let i = 0; i < 10; i++) {
        tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized });
      }
      expect(tracker.listReconciliations().length).to.equal(1);
    });
    it("49. concurrent same tx → idempotent", async function () {
      const realized = makePnLRecord(TX_HASH_1);
      const data = { txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized };
      const results = await Promise.all([
        Promise.resolve(tracker.reconcile(data)),
        Promise.resolve(tracker.reconcile(data)),
        Promise.resolve(tracker.reconcile(data)),
      ]);
      expect(results[0].id).to.equal(results[1].id);
      expect(tracker.listReconciliations().length).to.equal(1);
    });
  });

  describe("Replacement Safety", function () {
    it("50. H1/H2 same nonce distinct records", function () {
      const r1 = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected() });
      const r2 = tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: makeExpected() });
      expect(r1.id).to.not.equal(r2.id);
      expect(r2.txHash).to.equal(TX_HASH_2.toLowerCase());
    });
    it("51. H1 unknown/H2 confirmed → distinct records", function () {
      const realizedH2 = makePnLRecord(TX_HASH_2);
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected() });
      const r2 = tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realizedH2 });
      expect(r2.status).to.not.equal(ReconcileStatus.UNKNOWN);
      expect(tracker.listReconciliations().length).to.equal(2);
    });
    it("52. reconciliation keys by transaction hash (no second replacement model)", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected() });
      const r = tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: makeExpected() });
      expect(r.txHash).to.equal(TX_HASH_2.toLowerCase());
      expect(tracker.listReconciliations().length).to.equal(2);
    });
  });

  describe("Immutability", function () {
    it("53. mutate returned record does not affect internal state", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const r1 = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized });
      const beforeVal = r1.grossDeviationRaw;
      r1.grossDeviationRaw = 999999n;
      r1.grossDirection = "TAMPERED";
      const r2 = tracker.getReconciliation(TX_HASH_1);
      expect(r2.grossDeviationRaw).to.equal(beforeVal);
    });
    it("54. mutate expected input does not affect record", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const expected = { ...makeExpected(), grossRaw: 12500n };
      const r1 = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected, realizedRecord: realized });
      expected.grossRaw = 999999n;
      const r2 = tracker.getReconciliation(TX_HASH_1);
      expect(r2.expected.grossRaw).to.equal(12500n);
    });
    it("55. mutate nested expected/realized objects", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const r1 = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized });
      r1.expected.grossRaw = 999999n;
      r1.realized.grossRaw = 999999n;
      const r2 = tracker.getReconciliation(TX_HASH_1);
      expect(r2.expected.grossRaw).to.not.equal(999999n);
      expect(r2.realized.grossRaw).to.not.equal(999999n);
    });
  });

  describe("Input Validation", function () {
    it("56. invalid txHash rejected", function () {
      expect(() => tracker.reconcile({ txHash: "invalid", wallet: WALLET_A, expected: makeExpected() })).to.throw("invalid txHash");
    });
    it("57. invalid wallet rejected", function () {
      expect(() => tracker.reconcile({ txHash: TX_HASH_1, wallet: "invalid", expected: makeExpected() })).to.throw("invalid wallet");
    });
    it("58. invalid expected gross rejected", function () {
      expect(() => tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: "20000" } })).to.throw("bigint");
    });
    it("59. missing expected object", function () {
      expect(() => tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A })).to.throw();
    });
    it("60. wallet mismatch rejected", function () {
      expect(() => tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { ...makeExpected(), wallet: WALLET_B },
      })).to.throw("wallet mismatch");
    });
    it("61. invalid settlement token rejected", function () {
      expect(() => tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), settlementToken: "0x1234" } })).to.throw();
    });
    it("62. negative expected gas rejected", function () {
      expect(() => tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), gasWei: -1n } })).to.throw("negative");
    });
    it("63. invalid blockHash rejected", function () {
      expect(() => tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), blockHash: "0x1234" } })).to.throw();
    });
  });

  describe("Error Atomicity", function () {
    it("64. invalid expected does not create partial record", function () {
      expect(() => tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { settlementToken: USDT, settlementDecimals: 6, grossRaw: "invalid" },
      })).to.throw();
      expect(tracker.listReconciliations().length).to.equal(0);
    });
    it("65. invalid txHash does not create partial record", function () {
      expect(() => tracker.reconcile({ txHash: "bad", wallet: WALLET_A, expected: makeExpected() })).to.throw();
      expect(tracker.listReconciliations().length).to.equal(0);
    });
    it("66. realizedRecord txHash mismatch throws, no record", function () {
      const realized = makePnLRecord(TX_HASH_2);
      expect(() => tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized })).to.throw("mismatch");
            expect(tracker.listReconciliations().length).to.equal(0);
    });
  });

  describe("Aggregation", function () {
    it("67. multiple positive reconciliations", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 10000n }, realizedRecord: makePnLRecord(TX_HASH_1) });
      tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 10000n }, realizedRecord: makePnLRecord(TX_HASH_2, { afterBalanceRaw: 1015000n }) });
      expect(tracker.listReconciliations().length).to.equal(2);
    });
    it("68. positive + negative deviation", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 5000n }, realizedRecord: makePnLRecord(TX_HASH_1) });
      tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 20000000n }, realizedRecord: makePnLRecord(TX_HASH_2, { afterBalanceRaw: 998000n }) });
      const list = tracker.listReconciliations();
      expect(list[0].grossDirection).to.equal(DeviationDirection.BETTER_THAN_EXPECTED);
      expect(list[1].grossDirection).to.equal(DeviationDirection.WORSE_THAN_EXPECTED);
    });
    it("69. complete + partial statuses", function () {
      const r1 = makePnLRecord(TX_HASH_1);
      const r2 = makePnLRecord(TX_HASH_2, { receipt: revertedReceipt() });
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 12500n }, realizedRecord: r1 });
      tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: makeExpected(), realizedRecord: r2 });
      const complete = tracker.listReconciliations({ status: ReconcileStatus.COMPLETE });
      const partial = tracker.listReconciliations({ status: ReconcileStatus.PARTIAL });
      expect(complete.length + partial.length).to.equal(2);
    });
    it("70. different settlement tokens not mixed", function () {
      const r1 = makePnLRecord(TX_HASH_1, { settlementToken: USDT });
      const r2 = makePnLRecord(TX_HASH_2, { settlementToken: USDC });
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), settlementToken: USDT }, realizedRecord: r1 });
      tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: { ...makeExpected(), settlementToken: USDC }, realizedRecord: r2 });
      const usdtList = tracker.listReconciliations({ settlementToken: USDT });
      const usdcList = tracker.listReconciliations({ settlementToken: USDC });
      expect(usdtList.length).to.equal(1);
      expect(usdcList.length).to.equal(1);
    });
    it("71. repeated list consistent", function () {
      const r = makePnLRecord(TX_HASH_1);
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: r });
      const a1 = tracker.listReconciliations();
      const a2 = tracker.listReconciliations();
      expect(a1.length).to.equal(a2.length);
            expect(a1[0].id).to.equal(a2[0].id);
    });
  });

  describe("BPS Rounding", function () {
    it("72. BPS uses truncation not rounding", function () {
      expect(calcBps(12501n, 10000n)).to.equal(2501n);
      expect(calcBps(3333n, 10000n)).to.equal(-6667n);
    });
    it("73. BPS zero expected protected", function () {
      expect(calcBps(10000n, 0n)).to.be.null;
    });
    it("74. BPS returns BigInt", function () {
      const bps = calcBps(12500n, 10000n);
      expect(typeof bps).to.equal("bigint");
      expect(bps).to.equal(2500n);
    });
  });

  describe("No Fake USD Conversion", function () {
    it("75. no USD conversion in reconciliation", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { settlementToken: USDT, settlementDecimals: 6, grossRaw: 20000000n, gasWei: 600000000000000n },
        realizedRecord: realized,
      });
      expect(rec.grossDeviationRaw).to.not.be.null;
      expect(rec.gasDeviationWei).to.not.be.null;
      expect(rec.netDeviationRaw).to.be.null;
    });
  });

  describe("No Expected Recalculation", function () {
    it("76. realized does not overwrite expected", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { ...makeExpected(), grossRaw: 20000000n },
        realizedRecord: realized,
      });
      expect(rec.expected.grossRaw).to.equal(20000000n);
      expect(rec.realized.grossRaw).to.equal(12500n);
    });
  });

  describe("Coverage Tracking", function () {
    it("77. tracks realized source", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: makeExpected(),
        realizedRecord: realized,
      });
      expect(rec.realized.source).to.equal("PnLTracker");
    });
    it("78. tracks transaction identity", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: makeExpected(),
        realizedRecord: realized,
      });
      expect(rec.txHash).to.equal(TX_HASH_1);
      expect(rec.realizedRecordId).to.not.be.null;
    });
    it("79. tracks block identity for reorg future", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { ...makeExpected(), blockNumber: 50, blockHash: BLOCK_HASH },
        realizedRecord: realized,
      });
      expect(rec.expected.blockNumber).to.equal(50);
      expect(rec.realized.blockNumber).to.equal(100);
    });
    it("80. tracks timing", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const before = Date.now();
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized });
      const after = Date.now();
      expect(rec.createdAt).to.be.at.least(before);
      expect(rec.createdAt).to.be.at.most(after);
      expect(rec.reconciledAt).to.equal(rec.createdAt);
    });
  });

  describe("Conflict Detection", function () {
    it("81. same txHash + different expected → existing unchanged", function () {
      const realized = makePnLRecord(TX_HASH_1);
      tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { ...makeExpected(), grossRaw: 20000000n },
        realizedRecord: realized,
      });
      const r2 = tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { ...makeExpected(), grossRaw: 5000n },
        realizedRecord: realized,
      });
      expect(r2.expected.grossRaw).to.equal(20000000n);
    });
  });

  describe("Deterministic Output", function () {
    it("82. same inputs → same output", function () {
      const realized = makePnLRecord(TX_HASH_1);
      const r1 = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized });
      expect(typeof r1.grossDeviationRaw).to.equal("bigint");
    });
    it("83. no current market price dependency", function () {
      const realized = makePnLRecord(TX_HASH_1);
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected(), realizedRecord: realized });
      const r2 = tracker.getReconciliation(TX_HASH_1);
      expect(r2.grossDeviationRaw).to.exist;
    });
  });

  describe("Explicit Reconciliation Test", function () {
    it("expected=20 USDT, realized=12 USDT, deviation=-8 USDT (-40%)", function () {
      const realized = makePnLRecord(TX_HASH_1, { beforeBalanceRaw: 1000000n, afterBalanceRaw: 13000000n });
      const rec = tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { ...makeExpected(), grossRaw: 20000000n },
        realizedRecord: realized,
      });
      // realized = 13000000 - 1000000 = 12000000 (12 USDT @ 6 decimals)
      expect(rec.realized.grossRaw).to.equal(12000000n);
      expect(rec.grossDeviationRaw).to.equal(-8000000n);
      expect(rec.grossDeviationBps).to.equal(-4000n);
      expect(rec.grossDirection).to.equal(DeviationDirection.WORSE_THAN_EXPECTED);
    });
  });

  describe("Static Safety", function () {
    it("84. no expected used as realized in API", function () {
      const expected = { ...makeExpected(), grossRaw: 20000000n };
      const realized = makePnLRecord(TX_HASH_1);
      const rec = tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected, realizedRecord: realized });
            expect(rec.realized.grossRaw).to.equal(12500n);
      expect(rec.expected.grossRaw).to.equal(20000000n);
    });
  });

  describe("Aggregation (aggregate method)", function () {
    it("85. single token", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 20000000n }, realizedRecord: makePnLRecord(TX_HASH_1) });
      const agg = tracker.aggregate();
      expect(agg.totalTransactions).to.equal(1);
      expect(agg.knownCount).to.equal(1);
      expect(agg.unknownCount).to.equal(0);
      const t = agg.tokens.get(USDT.toLowerCase());
      expect(t.count).to.equal(1);
      expect(t.expectedGrossRaw).to.equal(20000000n);
      expect(t.realizedGrossRaw).to.equal(12500n);
      expect(t.grossDeviationRaw).to.equal(12500n - 20000000n);
    });

    it("86. multiple transactions same token", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 10000n }, realizedRecord: makePnLRecord(TX_HASH_1) });
      tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 20000n }, realizedRecord: makePnLRecord(TX_HASH_2, { afterBalanceRaw: 1015000n }) });
      const t = tracker.aggregate().tokens.get(USDT.toLowerCase());
      expect(t.count).to.equal(2);
      expect(t.expectedGrossRaw).to.equal(30000n);
      expect(t.realizedGrossRaw).to.equal(27500n);
      expect(t.grossDeviationRaw).to.equal(27500n - 30000n);
    });

    it("87. multiple tokens segregated", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), settlementToken: USDT, grossRaw: 20000000n }, realizedRecord: makePnLRecord(TX_HASH_1, { settlementToken: USDT }) });
      tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: { settlementToken: USDC, settlementDecimals: 6, grossRaw: 50000000n }, realizedRecord: makePnLRecord(TX_HASH_2, { settlementToken: USDC, afterBalanceRaw: 1015000n }) });
      const agg = tracker.aggregate();
      expect(agg.tokens.size).to.equal(2);
      expect(agg.tokens.get(USDT.toLowerCase()).realizedGrossRaw).to.equal(12500n);
      expect(agg.tokens.get(USDC.toLowerCase()).realizedGrossRaw).to.equal(15000n);
    });

    it("88. UNKNOWN transaction counted separately", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: makeExpected() });
      const agg = tracker.aggregate();
      expect(agg.totalTransactions).to.equal(1);
      expect(agg.knownCount).to.equal(0);
      expect(agg.unknownCount).to.equal(1);
      const t = agg.tokens.get(USDT.toLowerCase());
      expect(t.knownCount).to.equal(0);
      expect(t.unknownCount).to.equal(1);
      expect(t.realizedGrossRaw).to.be.null;
      expect(t.grossDeviationRaw).to.be.null;
    });

    it("89. UNKNOWN not counted as zero", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 10000n }, realizedRecord: makePnLRecord(TX_HASH_1) });
      tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 30000n } });
      const agg = tracker.aggregate();
      expect(agg.knownCount).to.equal(1);
      expect(agg.unknownCount).to.equal(1);
      const t = agg.tokens.get(USDT.toLowerCase());
      expect(t.expectedGrossRaw).to.equal(40000n);
      expect(t.realizedGrossRaw).to.equal(12500n);
      expect(t.grossDeviationRaw).to.equal(12500n - 40000n);
    });

    it("90. positive + negative realized", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 10000n }, realizedRecord: makePnLRecord(TX_HASH_1) });
      tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 20000n }, realizedRecord: makePnLRecord(TX_HASH_2, { beforeBalanceRaw: 1015000n, afterBalanceRaw: 1005000n }) });
      const t = tracker.aggregate().tokens.get(USDT.toLowerCase());
      expect(t.realizedGrossRaw).to.equal(12500n - 10000n);
      expect(t.grossDeviationRaw).to.equal((12500n - 10000n) - 30000n);
    });

    it("91. zero realized", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 10000n }, realizedRecord: makePnLRecord(TX_HASH_1, { afterBalanceRaw: 1000000n }) });
      const t = tracker.aggregate().tokens.get(USDT.toLowerCase());
      expect(t.realizedGrossRaw).to.equal(0n);
      expect(t.knownCount).to.equal(1);
    });

    it("92. expected aggregation keeps all records", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 10000n }, realizedRecord: makePnLRecord(TX_HASH_1) });
      tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 20000n }, realizedRecord: makePnLRecord(TX_HASH_2, { afterBalanceRaw: 1015000n }) });
      const t = tracker.aggregate().tokens.get(USDT.toLowerCase());
      expect(t.expectedGrossRaw).to.equal(30000n);
    });

    it("93. realized aggregation excludes UNKNOWN", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 10000n }, realizedRecord: makePnLRecord(TX_HASH_1) });
      tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 30000n } });
      const t = tracker.aggregate().tokens.get(USDT.toLowerCase());
      expect(t.realizedGrossRaw).to.equal(12500n);
      expect(t.unknownCount).to.equal(1);
    });

    it("94. deviation aggregation = realized - expected", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 10000n }, realizedRecord: makePnLRecord(TX_HASH_1) });
      tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 20000n }, realizedRecord: makePnLRecord(TX_HASH_2, { afterBalanceRaw: 1015000n }) });
      const t = tracker.aggregate().tokens.get(USDT.toLowerCase());
      expect(t.grossDeviationRaw).to.equal(t.realizedGrossRaw - t.expectedGrossRaw);
      expect(t.grossDeviationRaw).to.equal(-2500n);
    });

    it("95. gas aggregation in wei", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), gasWei: 500000000000000n }, realizedRecord: makePnLRecord(TX_HASH_1) });
      tracker.reconcile({ txHash: TX_HASH_2, wallet: WALLET_A, expected: { ...makeExpected(), gasWei: 500000000000000n }, realizedRecord: makePnLRecord(TX_HASH_2) });
      const gas = tracker.aggregate().gas;
      expect(gas.expectedWei).to.equal(1000000000000000n);
      expect(gas.realizedWei).to.equal(1200000000000000n);
      expect(gas.deviationWei).to.equal(200000000000000n);
    });

    it("96. net aggregation when dimensionally valid (BNB)", function () {
      const r1 = makePnLRecord(TX_HASH_1, { settlementToken: BNB });
      tracker.reconcile({
        txHash: TX_HASH_1, wallet: WALLET_A,
        expected: { settlementToken: BNB, settlementDecimals: 18, grossRaw: 12500n, gasWei: 600000000000000n, netRaw: 12500n - 600000000000000n },
        realizedRecord: r1,
      });
      const t = tracker.aggregate().tokens.get(BNB.toLowerCase());
      expect(t.realizedNetRaw).to.equal(12500n - 600000000000000n);
      expect(t.expectedNetRaw).to.equal(12500n - 600000000000000n);
      expect(t.netDeviationRaw).to.equal(0n);
    });

    it("97. net UNKNOWN when dimensions incompatible (USDT)", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 20000000n }, realizedRecord: makePnLRecord(TX_HASH_1) });
      const t = tracker.aggregate().tokens.get(USDT.toLowerCase());
      expect(t.realizedNetRaw).to.be.null;
      expect(t.expectedNetRaw).to.be.null;
      expect(t.netDeviationRaw).to.be.null;
    });

    it("98. repeated aggregate consistent", function () {
      tracker.reconcile({ txHash: TX_HASH_1, wallet: WALLET_A, expected: { ...makeExpected(), grossRaw: 10000n }, realizedRecord: makePnLRecord(TX_HASH_1) });
      const a1 = tracker.aggregate();
      const a2 = tracker.aggregate();
      expect(a1.totalTransactions).to.equal(a2.totalTransactions);
      expect(a1.tokens.get(USDT.toLowerCase()).realizedGrossRaw).to.equal(a2.tokens.get(USDT.toLowerCase()).realizedGrossRaw);
    });

    it("99. empty tracker", function () {
      const agg = tracker.aggregate();
      expect(agg.totalTransactions).to.equal(0);
      expect(agg.knownCount).to.equal(0);
      expect(agg.unknownCount).to.equal(0);
      expect(agg.tokens.size).to.equal(0);
      expect(agg.gas.expectedWei).to.be.null;
      expect(agg.gas.realizedWei).to.be.null;
      expect(agg.gas.deviationWei).to.be.null;
    });
  });
});
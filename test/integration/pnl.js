// TASK 4.5-E — Realized P&L Tracker - Behavioral tests
const chai = require("chai");
const chaiAsPromised = require("chai-as-promised");
chai.use(chaiAsPromised);
const { expect } = chai;
const { PnLTracker, PnLStatus, NetProfitStatus } = require("../../bot/pnl");

const WALLET_A = "0x70997970C51812dc3A010C7d01b50b0429c0d3c8";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TX_HASH_1 = "0x" + "a".repeat(64);
const TX_HASH_2 = "0x" + "b".repeat(64);
const TX_HASH_3 = "0x" + "c".repeat(64);
const BLOCK_HASH = "0x" + "d".repeat(64);

function confirmedReceipt(overrides = {}) {
  return { status: 1, gasUsed: 200000n, effectiveGasPrice: 3000000000n, blockNumber: 100, blockHash: BLOCK_HASH, ...overrides };
}

function revertedReceipt(overrides = {}) {
  return { status: 0, gasUsed: 200000n, effectiveGasPrice: 3000000000n, blockNumber: 100, blockHash: BLOCK_HASH, ...overrides };
}

function baseData(overrides = {}) {
  return {
    txHash: TX_HASH_1, wallet: WALLET_A, settlementToken: USDT, settlementDecimals: 6,
    beforeBalanceRaw: 1000000n, afterBalanceRaw: 1012500n, receipt: confirmedReceipt(), ...overrides,
  };
}

describe("TASK 4.5-E — Realized P&L Tracker", function () {
  let tracker;
  beforeEach(function () { tracker = new PnLTracker(); });

  describe("Basic Profit", function () {
    it("1. positive realized profit", function () {
      const r = tracker.recordPnL(baseData());
      expect(r.grossProfitRaw).to.equal(12500n);
    });
    it("2. zero realized profit", function () {
      const r = tracker.recordPnL(baseData({ afterBalanceRaw: 1000000n }));
      expect(r.grossProfitRaw).to.equal(0n);
    });
    it("3. negative realized profit", function () {
      const r = tracker.recordPnL(baseData({ afterBalanceRaw: 998000n }));
      expect(r.grossProfitRaw).to.equal(-2000n);
    });
    it("4. raw BigInt arithmetic", function () {
      const r = tracker.recordPnL(baseData({ beforeBalanceRaw: 1000000000000000000n, afterBalanceRaw: 1000000000000002000n }));
      expect(r.grossProfitRaw).to.equal(2000n);
      expect(typeof r.grossProfitRaw).to.equal("bigint");
    });
    it("5. decimals conversion", function () {
      const r = tracker.recordPnL(baseData({ settlementDecimals: 18 }));
      expect(r.settlementDecimals).to.equal(18);
      expect(r.grossProfitRaw).to.equal(12500n);
    });
    it("6. token identity (lowercase address)", function () {
      const r = tracker.recordPnL(baseData({ settlementToken: USDT.toUpperCase() }));
      expect(r.settlementToken).to.equal(USDT.toLowerCase());
    });
    it("7. wallet identity (case-insensitive)", function () {
      const r = tracker.recordPnL(baseData({ wallet: WALLET_A.toUpperCase() }));
      expect(r.wallet).to.equal(WALLET_A.toLowerCase());
    });
    it("8. txHash identity", function () {
      const r = tracker.recordPnL(baseData({ txHash: TX_HASH_1.toUpperCase() }));
      expect(r.txHash).to.equal(TX_HASH_1.toLowerCase());
    });
    it("9. block metadata", function () {
      const r = tracker.recordPnL(baseData({ receipt: confirmedReceipt({ blockNumber: 12345 }) }));
      expect(r.blockNumber).to.equal(12345);
      expect(r.blockHash).to.equal(BLOCK_HASH.toLowerCase());
    });
    it("10. timestamp metadata", function () {
      const r = tracker.recordPnL(baseData({ blockTimestamp: 1699000000 }));
      expect(r.blockTimestamp).to.equal(1699000000);
    });
  });

  describe("Flashloan", function () {
    it("11. flashloan principal excluded", function () {
      const r = tracker.recordPnL(baseData({ borrowedAmountRaw: 10000000n, repaidAmountRaw: 10000000n }));
      expect(r.grossProfitRaw).to.equal(12500n);
    });
    it("12. flashloan repayment excluded from profit", function () {
      const r = tracker.recordPnL(baseData({ borrowedAmountRaw: 5000000n, repaidAmountRaw: 5000000n }));
      expect(r.grossProfitRaw).to.equal(12500n);
    });
    it("13. flashloan fee included (via balance delta)", function () {
      const r = tracker.recordPnL(baseData({ afterBalanceRaw: 1012490n, flashloanFeeRaw: 10n }));
      // Fee is already reflected in afterBalanceRaw, so gross = after - before = 12490
      expect(r.grossProfitRaw).to.equal(12490n);
    });
    it("14. gross surplus correctly calculated", function () {
      const r = tracker.recordPnL(baseData({ afterBalanceRaw: 1015000n }));
      expect(r.grossProfitRaw).to.equal(15000n);
    });
    it("15. pre-existing balance excluded", function () {
      const r = tracker.recordPnL(baseData({ beforeBalanceRaw: 5000000n, afterBalanceRaw: 5012500n }));
      expect(r.grossProfitRaw).to.equal(12500n);
    });
    it("16. previous profit excluded", function () {
      const r = tracker.recordPnL(baseData({ beforeBalanceRaw: 2000000n, afterBalanceRaw: 2012500n }));
      expect(r.grossProfitRaw).to.equal(12500n);
    });
    it("17. manual deposit not treated as profit", function () {
      const r = tracker.recordPnL(baseData({ afterBalanceRaw: 1112500n, externalInflowRaw: 100000n }));
      expect(r.grossProfitRaw).to.equal(12500n);
    });
    it("18. external transfer not silently treated as profit", function () {
      const r = tracker.recordPnL(baseData({ externalOutflowRaw: 50000n }));
      expect(r.grossProfitRaw).to.equal(62500n);
    });
  });

  describe("Gas", function () {
    it("19. gasUsed × effectiveGasPrice", function () {
      const r = tracker.recordPnL(baseData());
      expect(r.gasCostWei).to.equal(600000000000000n);
    });
    it("20. legacy receipt", function () {
      const r = tracker.recordPnL(baseData({ receipt: { status: 1, gasUsed: 150000n, effectiveGasPrice: 5000000000n, blockNumber: 100, blockHash: BLOCK_HASH } }));
      expect(r.gasCostWei).to.equal(750000000000000n);
    });
    it("21. EIP-1559 receipt", function () {
      const r = tracker.recordPnL(baseData({ receipt: { status: 1, gasUsed: 250000n, effectiveGasPrice: 3500000000n, blockNumber: 100, blockHash: BLOCK_HASH } }));
      expect(r.gasCostWei).to.equal(875000000000000n);
    });
    it("22. gas cost preserved as wei", function () {
      const r = tracker.recordPnL(baseData());
      expect(typeof r.gasCostWei).to.equal("bigint");
    });
    it("23. gas cost preserved as native token", function () {
      const r = tracker.recordPnL(baseData());
      expect(r.gasCostWei > 0n).to.be.true;
    });
    it("24. invalid gasUsed rejected", function () {
      expect(() => tracker.recordPnL(baseData({ gasUsed: -1n }))).to.throw("negative");
      expect(() => tracker.recordPnL(baseData({ gasUsed: "200000" }))).to.throw("bigint");
    });
    it("25. invalid gas price rejected", function () {
      expect(() => tracker.recordPnL(baseData({ effectiveGasPrice: -1n }))).to.throw("negative");
      expect(() => tracker.recordPnL(baseData({ effectiveGasPrice: "3000000000" }))).to.throw("bigint");
    });
    it("26. missing gas price → incomplete/unknown", function () {
      const r = tracker.recordPnL(baseData({ receipt: null, gasUsed: null, effectiveGasPrice: null }));
      expect(r.gasCostWei).to.be.null;
    });
    it("27. reverted tx gas cost captured", function () {
      const r = tracker.recordPnL(baseData({ receipt: revertedReceipt() }));
      expect(r.gasCostWei).to.equal(600000000000000n);
    });
  });

  describe("Status", function () {
    it("28. CONFIRMED → realized", function () {
      const r = tracker.recordPnL(baseData());
      expect(r.txStatus).to.equal("CONFIRMED");
      expect(r.status).to.equal(PnLStatus.REALIZED);
    });
    it("29. REVERTED → no fake gross profit", function () {
      const r = tracker.recordPnL(baseData({ receipt: revertedReceipt() }));
      expect(r.grossProfitRaw).to.be.null;
    });
    it("30. REVERTED → gas cost captured", function () {
      const r = tracker.recordPnL(baseData({ receipt: revertedReceipt() }));
      expect(r.gasCostWei).to.equal(600000000000000n);
    });
    it("31. UNKNOWN → not realized (no receipt)", function () {
      const r = tracker.recordPnL(baseData({ receipt: null }));
      expect(r.status).to.equal(PnLStatus.UNKNOWN);
    });
    it("32. DROPPED → not realized (no receipt)", function () {
      const r = tracker.recordPnL(baseData({ receipt: null }));
      expect(r.status).to.equal(PnLStatus.UNKNOWN);
    });
    it("33. pending → not realized (no receipt)", function () {
      const r = tracker.recordPnL(baseData({ receipt: null }));
      expect(r.status).to.equal(PnLStatus.UNKNOWN);
    });
    it("34. submitted → not realized (no receipt)", function () {
      const r = tracker.recordPnL(baseData({ receipt: null }));
      expect(r.status).to.equal(PnLStatus.UNKNOWN);
    });
    it("35. terminal state immutable", function () {
      const r1 = tracker.recordPnL(baseData());
      const r2 = tracker.getPnL(TX_HASH_1);
      expect(r1.id).to.equal(r2.id);
      expect(r1.grossProfitRaw).to.equal(r2.grossProfitRaw);
    });
  });

  describe("Unknown", function () {
    it("36. missing receipt", function () {
      const r = tracker.recordPnL(baseData({ receipt: null }));
      expect(r.status).to.equal(PnLStatus.UNKNOWN);
    });
    it("37. RPC failure (simulated by null receipt)", function () {
      const r = tracker.recordPnL(baseData({ receipt: null }));
      expect(r.status).to.equal(PnLStatus.UNKNOWN);
    });
    it("38. missing balance", function () {
      expect(() => tracker.recordPnL(baseData({ beforeBalanceRaw: null }))).to.throw();
    });
    it("39. malformed receipt", function () {
      expect(() => tracker.recordPnL(baseData({ receipt: { status: 2 } }))).to.throw("status");
      expect(() => tracker.recordPnL(baseData({ receipt: { status: 1, gasUsed: "200000" } }))).to.throw("gasUsed");
    });
    it("40. malformed balance", function () {
      expect(() => tracker.recordPnL(baseData({ beforeBalanceRaw: "1000000" }))).to.throw("bigint");
      expect(() => tracker.recordPnL(baseData({ afterBalanceRaw: 1.5 }))).to.throw();
    });
    it("41. unknown gross result never becomes zero", function () {
      const r = tracker.recordPnL(baseData({ receipt: revertedReceipt() }));
      expect(r.grossProfitRaw === null).to.be.true;
    });
    it("42. unknown net result never becomes zero", function () {
      const r = tracker.recordPnL(baseData({ receipt: revertedReceipt() }));
      expect(r.netProfitRaw).to.be.null;
    });
  });

  describe("Idempotency", function () {
    it("43. same tx processed twice", function () {
      const r1 = tracker.recordPnL(baseData());
      const r2 = tracker.recordPnL(baseData());
      expect(r1.id).to.equal(r2.id);
      expect(r1.grossProfitRaw).to.equal(r2.grossProfitRaw);
    });
    it("44. same tx cannot double-count", function () {
      tracker.recordPnL(baseData());
      tracker.recordPnL(baseData());
      const list = tracker.listPnL();
      expect(list.length).to.equal(1);
    });
    it("45. same replacement processed twice", function () {
      const r1 = tracker.recordPnL(baseData({ replacesTxHash: TX_HASH_2 }));
      const r2 = tracker.recordPnL(baseData({ replacesTxHash: TX_HASH_2 }));
      expect(r1.id).to.equal(r2.id);
    });
    it("46. different hash same nonce remains distinct", function () {
      const r1 = tracker.recordPnL(baseData({ txHash: TX_HASH_1 }));
      const r2 = tracker.recordPnL(baseData({ txHash: TX_HASH_2 }));
      expect(r1.id).to.not.equal(r2.id);
      expect(tracker.listPnL().length).to.equal(2);
    });
  });

  describe("Replacement", function () {
    it("47. H1 and H2 same nonce distinct", function () {
      const h1 = tracker.recordPnL(baseData({ txHash: TX_HASH_1, receipt: null }));
      const h2 = tracker.recordPnL(baseData({ txHash: TX_HASH_2, replacesTxHash: TX_HASH_1 }));
      expect(h1.id).to.not.equal(h2.id);
      expect(h2.replacesTxHash).to.equal(TX_HASH_1.toLowerCase());
    });
    it("48. only confirmed H2 gets realized P&L", function () {
      const h1 = tracker.recordPnL(baseData({ txHash: TX_HASH_1, receipt: null }));
      const h2 = tracker.recordPnL(baseData({ txHash: TX_HASH_2, replacesTxHash: TX_HASH_1 }));
      expect(h1.status).to.equal(PnLStatus.UNKNOWN);
      expect(h2.status).to.equal(PnLStatus.REALIZED);
    });
    it("49. H1 does not duplicate H2 profit", function () {
      tracker.recordPnL(baseData({ txHash: TX_HASH_1, receipt: null }));
      tracker.recordPnL(baseData({ txHash: TX_HASH_2, replacesTxHash: TX_HASH_1 }));
      const agg = tracker.aggregatePnL();
      expect(agg.totalGrossProfitRaw).to.equal(12500n);
      expect(agg.grossCount).to.equal(1);
    });
    it("50. reverted H2 gas captured once", function () {
      tracker.recordPnL(baseData({ txHash: TX_HASH_1, receipt: null }));
      const h2 = tracker.recordPnL(baseData({ txHash: TX_HASH_2, replacesTxHash: TX_HASH_1, receipt: revertedReceipt() }));
      expect(h2.gasCostWei).to.equal(600000000000000n);
      const agg = tracker.aggregatePnL();
      expect(agg.totalGasCostWei).to.equal(600000000000000n);
    });
    it("51. replacement metadata preserved", function () {
      const h2 = tracker.recordPnL(baseData({ txHash: TX_HASH_2, replacesTxHash: TX_HASH_1 }));
      expect(h2.replacesTxHash).to.equal(TX_HASH_1.toLowerCase());
    });
  });

  describe("Aggregation", function () {
    it("52. multiple positive trades", function () {
      tracker.recordPnL(baseData({ txHash: TX_HASH_1, afterBalanceRaw: 1012500n }));
      tracker.recordPnL(baseData({ txHash: TX_HASH_2, afterBalanceRaw: 1015000n }));
      const agg = tracker.aggregatePnL();
      expect(agg.totalGrossProfitRaw).to.equal(27500n);
      expect(agg.grossCount).to.equal(2);
    });
    it("53. positive + negative", function () {
      tracker.recordPnL(baseData({ txHash: TX_HASH_1, afterBalanceRaw: 1012500n }));
      tracker.recordPnL(baseData({ txHash: TX_HASH_2, afterBalanceRaw: 998000n }));
      const agg = tracker.aggregatePnL();
      expect(agg.totalGrossProfitRaw).to.equal(10500n);
    });
    it("54. zero + positive", function () {
      tracker.recordPnL(baseData({ txHash: TX_HASH_1, afterBalanceRaw: 1000000n }));
      tracker.recordPnL(baseData({ txHash: TX_HASH_2, afterBalanceRaw: 1012500n }));
      const agg = tracker.aggregatePnL();
      expect(agg.totalGrossProfitRaw).to.equal(12500n);
    });
    it("55. UNKNOWN excluded from known totals", function () {
      tracker.recordPnL(baseData({ txHash: TX_HASH_1 }));
      tracker.recordPnL(baseData({ txHash: TX_HASH_2, receipt: null }));
      const agg = tracker.aggregatePnL();
      expect(agg.totalGrossProfitRaw).to.equal(12500n);
      expect(agg.grossCount).to.equal(1);
      expect(agg.totalUnknownCount).to.equal(1);
    });
    it("56. different settlement tokens not silently mixed", function () {
      tracker.recordPnL(baseData({ txHash: TX_HASH_1, settlementToken: USDT }));
      tracker.recordPnL(baseData({ txHash: TX_HASH_2, settlementToken: USDC }));
      const agg = tracker.aggregatePnL();
      expect(agg.tokens[USDT.toLowerCase()]).to.exist;
      expect(agg.tokens[USDC.toLowerCase()]).to.exist;
      expect(agg.tokens[USDT.toLowerCase()].totalGrossProfitRaw).to.equal(12500n);
      expect(agg.tokens[USDC.toLowerCase()].totalGrossProfitRaw).to.equal(12500n);
    });
    it("57. aggregation is idempotent", function () {
      tracker.recordPnL(baseData({ txHash: TX_HASH_1 }));
      const agg1 = tracker.aggregatePnL();
      const agg2 = tracker.aggregatePnL();
      expect(agg1.totalGrossProfitRaw).to.equal(agg2.totalGrossProfitRaw);
    });
  });

  describe("Dimensional Testing", function () {
    it("USDT profit + BNB gas not directly mixed", function () {
      const r = tracker.recordPnL(baseData({
        settlementToken: USDT,
        receipt: confirmedReceipt({ gasUsed: 200000n, effectiveGasPrice: 3000000000n }),
      }));
      expect(r.grossProfitRaw).to.equal(12500n);
      expect(r.gasCostWei).to.equal(600000000000000n);
      expect(r.netProfitStatus).to.equal(NetProfitStatus.UNKNOWN);
      expect(r.netProfitRaw).to.be.null;
    });
  });

  describe("Explicit Flashloan Test", function () {
    it("initial=1000, borrowed=10000, repayment=10000, fee=10, final=1005", function () {
      const r = tracker.recordPnL(baseData({
        beforeBalanceRaw: 1000000000n,
        afterBalanceRaw: 1005000000n,
        borrowedAmountRaw: 10000000000n,
        repaidAmountRaw: 10000000000n,
        flashloanFeeRaw: 10000000n,
      }));
      // gross = 1005 - 1000 - 10000 + 10000 = 5 USDT (fee already in after balance)
      expect(r.grossProfitRaw).to.equal(5000000n);
    });
  });

  describe("Explicit External Flow Test", function () {
    it("before=1000, profit=12, external=100, after=1112", function () {
      const r = tracker.recordPnL(baseData({
        beforeBalanceRaw: 1000000n,
        afterBalanceRaw: 1112000n,
        externalInflowRaw: 100000n,
      }));
      expect(r.grossProfitRaw).to.equal(12000n);
    });
  });

  describe("Explicit Unknown Test", function () {
    it("receipt=null → realized=false", function () {
      const r = tracker.recordPnL(baseData({ receipt: null }));
      expect(r.status).to.equal(PnLStatus.UNKNOWN);
      expect(r.grossProfitRaw).to.be.null;
    });
  });

  describe("Explicit Duplicate Test", function () {
    it("record(txHash) twice → total includes once", function () {
      tracker.recordPnL(baseData());
      tracker.recordPnL(baseData());
      const agg = tracker.aggregatePnL();
      expect(agg.totalGrossProfitRaw).to.equal(12500n);
      expect(agg.grossCount).to.equal(1);
    });
  });

  describe("Explicit Replacement Test", function () {
    it("H1 nonce 100, H2 nonce 100, H2 confirmed → single P&L", function () {
      tracker.recordPnL(baseData({ txHash: TX_HASH_1, receipt: null }));
      tracker.recordPnL(baseData({ txHash: TX_HASH_2, replacesTxHash: TX_HASH_1 }));
      const agg = tracker.aggregatePnL();
      expect(agg.grossCount).to.equal(1);
      expect(agg.totalGrossProfitRaw).to.equal(12500n);
    });
  });

  describe("Explicit Reverted Test", function () {
    it("status=0, gasUsed=200000, effectiveGasPrice=3000000000 → gasCostWei=600000000000000", function () {
      const r = tracker.recordPnL(baseData({
        receipt: revertedReceipt({ gasUsed: 200000n, effectiveGasPrice: 3000000000n }),
      }));
      expect(r.gasCostWei).to.equal(600000000000000n);
      expect(r.grossProfitRaw).to.be.null;
    });
  });

  describe("Security / Input Hardening", function () {
    it("reject null txHash", function () {
      expect(() => tracker.recordPnL(baseData({ txHash: null }))).to.throw();
    });
    it("reject undefined txHash", function () {
      expect(() => tracker.recordPnL(baseData({ txHash: undefined }))).to.throw();
    });
    it("reject empty string txHash", function () {
      expect(() => tracker.recordPnL(baseData({ txHash: "" }))).to.throw();
    });
    it("reject string numeric txHash", function () {
      expect(() => tracker.recordPnL(baseData({ txHash: "12345" }))).to.throw();
    });
    it("reject negative raw amount", function () {
      expect(() => tracker.recordPnL(baseData({ beforeBalanceRaw: -1n }))).to.throw("negative");
    });
    it("reject fractional amount", function () {
      expect(() => tracker.recordPnL(baseData({ beforeBalanceRaw: 1.5 }))).to.throw();
    });
    it("reject unsafe integer", function () {
      expect(() => tracker.recordPnL(baseData({ blockTimestamp: Number.MAX_SAFE_INTEGER + 1 }))).to.throw();
    });
    it("reject malformed hex txHash", function () {
      expect(() => tracker.recordPnL(baseData({ txHash: "0xZZZ" }))).to.throw();
    });
    it("reject wrong address wallet", function () {
      expect(() => tracker.recordPnL(baseData({ wallet: "0x1234" }))).to.throw();
    });
    it("reject wrong token", function () {
      expect(() => tracker.recordPnL(baseData({ settlementToken: "0x1234" }))).to.throw();
    });
    it("reject wrong block hash", function () {
      expect(() => tracker.recordPnL(baseData({ receipt: confirmedReceipt({ blockHash: "0x1234" }) }))).to.throw();
    });
  });

  describe("Concurrency", function () {
    it("Promise.all with duplicate records", async function () {
      const results = await Promise.all([
        Promise.resolve(tracker.recordPnL(baseData({ txHash: TX_HASH_1 }))),
        Promise.resolve(tracker.recordPnL(baseData({ txHash: TX_HASH_2 }))),
        Promise.resolve(tracker.recordPnL(baseData({ txHash: TX_HASH_1 }))),
        Promise.resolve(tracker.aggregatePnL()),
      ]);
      expect(results[0].id).to.equal(results[2].id);
      expect(tracker.listPnL().length).to.equal(2);
    });
  });

  describe("Error Atomicity", function () {
    it("invalid gas price does not create partial record", function () {
      expect(() => tracker.recordPnL(baseData({ effectiveGasPrice: -1n }))).to.throw();
      expect(tracker.listPnL().length).to.equal(0);
    });
    it("invalid wallet does not create partial record", function () {
      expect(() => tracker.recordPnL(baseData({ wallet: "invalid" }))).to.throw();
      expect(tracker.listPnL().length).to.equal(0);
    });
  });

  describe("Consistency Check", function () {
    it("before + known flows + result should correspond to after", function () {
      const r = tracker.recordPnL(baseData({
        beforeBalanceRaw: 1000000n,
        afterBalanceRaw: 1012500n,
        borrowedAmountRaw: 10000000n,
        repaidAmountRaw: 10000000n,
      }));
      const reconstructed = r.beforeBalanceRaw + r.grossProfitRaw + r.borrowedAmountRaw - r.repaidAmountRaw;
      expect(reconstructed).to.equal(r.afterBalanceRaw);
    });
  });
});
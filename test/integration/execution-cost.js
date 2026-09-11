// TASK 4.6-C — Execution Cost & Gas Safety.
// Partea 1: guard-ul pur (bot/execution-cost.js) — fail-closed, BigInt, borduri.
// Partea 2: integrare executor — ordering & binding (adversarial).
const { expect } = require("chai");
const ec = require("../../bot/execution-cost");

const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const USDT = "0x55d398326f99059ff775485246999027b3197955";

describe("TASK 4.6-C — Execution cost guard (pure, BigInt-only)", () => {
  describe("validateGasUnits — fail-closed pe estimate/wei", () => {
    it("acceptă BigInt>=0 și safe integer>=0", () => {
      expect(ec.validateGasUnits(5n)).to.equal(5n);
      expect(ec.validateGasUnits(0n)).to.equal(0n);
      expect(ec.validateGasUnits(500000)).to.equal(500000n);
      expect(ec.validateGasUnits(Number.MAX_SAFE_INTEGER)).to.equal(BigInt(Number.MAX_SAFE_INTEGER));
    });
    it("respinge negativ / fracționar / NaN / Infinity / string / null / unsafe", () => {
      expect(ec.validateGasUnits(-1n)).to.equal(null);
      expect(ec.validateGasUnits(-5)).to.equal(null);
      expect(ec.validateGasUnits(1.5)).to.equal(null);
      expect(ec.validateGasUnits(NaN)).to.equal(null);
      expect(ec.validateGasUnits(Infinity)).to.equal(null);
      expect(ec.validateGasUnits("100000")).to.equal(null);
      expect(ec.validateGasUnits(null)).to.equal(null);
      expect(ec.validateGasUnits(undefined)).to.equal(null);
      expect(ec.validateGasUnits({})).to.equal(null);
      expect(ec.validateGasUnits(Number.MAX_SAFE_INTEGER + 1)).to.equal(null);
    });
  });

  describe("worstCaseGasPriceWei — legacy + EIP-1559, fără default-uri", () => {
    it("legacy: gasPrice singur", () => {
      const r = ec.worstCaseGasPriceWei({ gasPrice: 1n });
      expect(r.ok).to.equal(true);
      expect(r.priceWei).to.equal(1n);
      expect(r.mode).to.equal("legacy");
    });
    it("EIP-1559: maxFeePerGas singur", () => {
      const r = ec.worstCaseGasPriceWei({ maxFeePerGas: 3n });
      expect(r.ok).to.equal(true);
      expect(r.priceWei).to.equal(3n);
      expect(r.mode).to.equal("eip1559");
    });
    it("conflicting fee data -> MAXIMUL (conservator)", () => {
      expect(ec.worstCaseGasPriceWei({ gasPrice: 5n, maxFeePerGas: 3n }).priceWei).to.equal(5n);
      expect(ec.worstCaseGasPriceWei({ gasPrice: 2n, maxFeePerGas: 9n }).priceWei).to.equal(9n);
    });
    it("maxPriorityFeePerGas NU mărește bound-ul (maxFeePerGas îl acoperă)", () => {
      expect(ec.worstCaseGasPriceWei({ gasPrice: 2n, maxPriorityFeePerGas: 99n }).priceWei).to.equal(2n);
    });
    it("lipsă / malformed => REJECT (niciodată default)", () => {
      expect(ec.worstCaseGasPriceWei({}).rejection.code).to.equal("GAS_PRICE_INVALID");
      expect(ec.worstCaseGasPriceWei(null).rejection.code).to.equal("INVALID_FEE_DATA");
      expect(ec.worstCaseGasPriceWei(undefined).rejection.code).to.equal("INVALID_FEE_DATA");
      expect(ec.worstCaseGasPriceWei({ gasPrice: -1n }).rejection.code).to.equal("GAS_PRICE_INVALID");
      expect(ec.worstCaseGasPriceWei({ gasPrice: 1.5 }).rejection.code).to.equal("GAS_PRICE_INVALID");
      expect(ec.worstCaseGasPriceWei({ gasPrice: "abc" }).rejection.code).to.equal("GAS_PRICE_INVALID");
      expect(ec.worstCaseGasPriceWei({ gasPrice: NaN }).rejection.code).to.equal("GAS_PRICE_INVALID");
      expect(ec.worstCaseGasPriceWei({ gasPrice: Infinity }).rejection.code).to.equal("GAS_PRICE_INVALID");
    });
  });

  describe("computeGasLimit — buffer bps întregi, ceil conservator, ceiling", () => {
    it("buffer 2000 bps: 100000n -> 120000n", () => {
      expect(ec.computeGasLimit(100000n, { bufferBps: 2000 }).gasLimit).to.equal(120000n);
    });
    it("rotunjire ÎN SUS la valori nedivizibile: 1234n/333bps -> 1276n", () => {
      // 1234 * 10333 = 12,750,922 / 10000 = 1275.0922 -> ceil 1276 (>=, niciodată sub)
      expect(ec.computeGasLimit(1234n, { bufferBps: 333 }).gasLimit).to.equal(1276n);
    });
    it("bufferBps = 0 -> identitate", () => {
      expect(ec.computeGasLimit(777n, { bufferBps: 0 }).gasLimit).to.equal(777n);
    });
    it("estimate = 0 / malformed => GAS_ESTIMATE_INVALID", () => {
      expect(ec.computeGasLimit(0n).rejection.code).to.equal("GAS_ESTIMATE_INVALID");
      expect(ec.computeGasLimit(undefined).rejection.code).to.equal("GAS_ESTIMATE_INVALID");
      expect(ec.computeGasLimit(-5n).rejection.code).to.equal("GAS_ESTIMATE_INVALID");
      expect(ec.computeGasLimit(1.5).rejection.code).to.equal("GAS_ESTIMATE_INVALID");
      expect(ec.computeGasLimit("100000").rejection.code).to.equal("GAS_ESTIMATE_INVALID");
      expect(ec.computeGasLimit(NaN).rejection.code).to.equal("GAS_ESTIMATE_INVALID");
    });
    it("ceiling: == plafon => ACCEPT, > plafon => GAS_LIMIT_TOO_HIGH", () => {
      expect(ec.computeGasLimit(10000n, { bufferBps: 2000, maxGasLimit: 12000 }).ok).to.equal(true);
      const r = ec.computeGasLimit(10001n, { bufferBps: 2000, maxGasLimit: 12000 });
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("GAS_LIMIT_TOO_HIGH");
    });
    it("overflow: 2^255 / 2^256-1 => GAS_LIMIT_TOO_HIGH, fără throw/overflow", () => {
      expect(ec.computeGasLimit(2n ** 255n, { maxGasLimit: 5000000n }).rejection.code).to.equal("GAS_LIMIT_TOO_HIGH");
      expect(ec.computeGasLimit(2n ** 256n - 1n, { maxGasLimit: 5000000n }).rejection.code).to.equal("GAS_LIMIT_TOO_HIGH");
    });
    it("config invalid => throw (eroare de programare, nu condiție economică)", () => {
      expect(() => ec.computeGasLimit(100n, { bufferBps: -1 })).to.throw();
      expect(() => ec.computeGasLimit(100n, { bufferBps: 1.5 })).to.throw();
      expect(() => ec.computeGasLimit(100n, { maxGasLimit: 0 })).to.throw();
    });
  });

  describe("executionCostWei", () => {
    it("înmulțire BigInt exactă", () => {
      const r = ec.executionCostWei(500000n, 3000000000n);
      expect(r.ok).to.equal(true);
      expect(r.costWei).to.equal(1500000000000000n);
    });
    it("zero estimate / zero price / malformed => GAS_COST_INVALID", () => {
      expect(ec.executionCostWei(10n, 0n).rejection.code).to.equal("GAS_COST_INVALID");
      expect(ec.executionCostWei(0n, 3n).rejection.code).to.equal("GAS_COST_INVALID");
      expect(ec.executionCostWei(-1n, 3n).rejection.code).to.equal("GAS_COST_INVALID");
      expect(ec.executionCostWei("x", 3n).rejection.code).to.equal("GAS_COST_INVALID");
    });
  });
});

describe("TASK 4.6-C — evaluateExecutionCost (net dimensional + flops)", () => {
  const base = { gasEstimate: 100n, feeData: { gasPrice: 1n } };

  it("WBNB nativ: profit 1000, cost 100 => net 900 ACCEPT", () => {
    const r = ec.evaluateExecutionCost({ ...base, profitRaw: 1000n, settlementToken: WBNB, policy: { bufferBps: 0, gasReserveBps: 0 } });
    expect(r.ok).to.equal(true);
    expect(r.costWei).to.equal(100n);
    expect(r.netBnb).to.equal(900n);
    expect(r.conversion).to.equal("native-bnb");
  });

  it("profit pozitiv + gas mic => ACCEPT; profit pozitiv + gas mare => REJECT", () => {
    const ok = ec.evaluateExecutionCost({ profitRaw: 1000n, settlementToken: WBNB, gasEstimate: 100n, feeData: { gasPrice: 1n }, policy: { bufferBps: 0, gasReserveBps: 0 } });
    expect(ok.ok).to.equal(true);
    const bad = ec.evaluateExecutionCost({ profitRaw: 1000n, settlementToken: WBNB, gasEstimate: 100n, feeData: { gasPrice: 100n }, policy: { bufferBps: 0, gasReserveBps: 0 } });
    expect(bad.ok).to.equal(false);
    expect(bad.rejection.code).to.equal("NET_PROFIT_BELOW_FLOOR");
  });

  it("borderă exactă: profit == cost => REJECT; == cost+1wei => ACCEPT; == cost-1wei => REJECT", () => {
    // fără gasReserveBps — testăm EXCLUSIV bară net>0, izolată
    const eq = ec.evaluateExecutionCost({ profitRaw: 120n, settlementToken: WBNB, gasEstimate: 100n, feeData: { gasPrice: 1n }, policy: { bufferBps: 2000 } });
    expect(eq.ok).to.equal(false);
    expect(eq.rejection.code).to.equal("NET_PROFIT_BELOW_FLOOR");
    const plus1 = ec.evaluateExecutionCost({ profitRaw: 121n, settlementToken: WBNB, gasEstimate: 100n, feeData: { gasPrice: 1n }, policy: { bufferBps: 2000 } });
    expect(plus1.ok).to.equal(true);
    expect(plus1.netBnb).to.equal(1n);
    const minus1 = ec.evaluateExecutionCost({ profitRaw: 119n, settlementToken: WBNB, gasEstimate: 100n, feeData: { gasPrice: 1n }, policy: { bufferBps: 2000 } });
    expect(minus1.ok).to.equal(false);
  });

  it("profit negativ => NET_PROFIT_BELOW_FLOOR (nu e mascât în 0)", () => {
    const r = ec.evaluateExecutionCost({ profitRaw: -5n, settlementToken: WBNB, gasEstimate: 100n, feeData: { gasPrice: 1n }, policy: { bufferBps: 0, gasReserveBps: 0 } });
    expect(r.ok).to.equal(false);
    expect(r.rejection.code).to.equal("NET_PROFIT_BELOW_FLOOR");
  });

  it("minProfitBnb: net == floor => ACCEPT (inclusiv); net < floor => REJECT", () => {
    const eq = ec.evaluateExecutionCost({ profitRaw: 1000n, settlementToken: WBNB, gasEstimate: 100n, feeData: { gasPrice: 1n }, policy: { bufferBps: 0, gasReserveBps: 0, minProfitBnb: 900n } });
    expect(eq.ok).to.equal(true);
    const below = ec.evaluateExecutionCost({ profitRaw: 1000n, settlementToken: WBNB, gasEstimate: 100n, feeData: { gasPrice: 1n }, policy: { bufferBps: 0, gasReserveBps: 0, minProfitBnb: 901n } });
    expect(below.ok).to.equal(false);
    expect(below.rejection.code).to.equal("NET_PROFIT_BELOW_FLOOR");
  });
});

describe("TASK 4.6-C — evaluateExecutionCost (dimensiuni, fee, proprietăți)", () => {
  it("gasReserveBps: bară = ceil(cost*10500/10000); net == bară => REJECT, bară+1 => ACCEPT", () => {
    // cost = 100n (buffer 0); bară net = ceil(100*10500/10000) = 105n
    const eq = ec.evaluateExecutionCost({ profitRaw: 205n, settlementToken: WBNB, gasEstimate: 100n, feeData: { gasPrice: 1n }, policy: { bufferBps: 0, gasReserveBps: 500 } });
    expect(eq.ok).to.equal(false);
    expect(eq.rejection.code).to.equal("NET_PROFIT_BELOW_FLOOR");
    const ok = ec.evaluateExecutionCost({ profitRaw: 206n, settlementToken: WBNB, gasEstimate: 100n, feeData: { gasPrice: 1n }, policy: { bufferBps: 0, gasReserveBps: 500 } });
    expect(ok.ok).to.equal(true);
    expect(ok.netBnb).to.equal(106n);
  });

  it("USDT fără conversie verificată => PROFIT_CONVERSION_UNAVAILABLE (NU net=0, NU ACCEPT)", () => {
    const r = ec.evaluateExecutionCost({ profitRaw: 1000n, settlementToken: USDT, gasEstimate: 100n, feeData: { gasPrice: 1n }, policy: {} });
    expect(r.ok).to.equal(false);
    expect(r.rejection.code).to.equal("PROFIT_CONVERSION_UNAVAILABLE");
  });

  it("conversie rațională verificată: 6 USDT (6 decimals) = 2 BNB la 1 BNB = 3 USDT", () => {
    const r = ec.evaluateExecutionCost({
      profitRaw: 6000000n, settlementToken: USDT, gasEstimate: 100n, feeData: { gasPrice: 1n },
      priceBnb: { num: 1n * 10n ** 18n, den: 3n * 10n ** 6n },
      policy: { bufferBps: 0, gasReserveBps: 0 },
    });
    expect(r.ok).to.equal(true);
    expect(r.grossBnb).to.equal(2n * 10n ** 18n);
    expect(r.netBnb).to.equal(2n * 10n ** 18n - 100n);
    expect(r.conversion).to.equal("venue-rational");
  });

  it("priceBnb invalid (num=0) => PROFIT_CONVERSION_UNAVAILABLE", () => {
    const r = ec.evaluateExecutionCost({ profitRaw: 1000n, settlementToken: USDT, gasEstimate: 100n, feeData: { gasPrice: 1n }, priceBnb: { num: 0n, den: 1n }, policy: {} });
    expect(r.rejection.code).to.equal("PROFIT_CONVERSION_UNAVAILABLE");
  });

  it("EIP-1559: costul folosește maxFeePerGas (limita superioară), nu optimistic", () => {
    const r = ec.evaluateExecutionCost({ profitRaw: 1000n, settlementToken: WBNB, gasEstimate: 100n, feeData: { gasPrice: 1n, maxFeePerGas: 7n }, policy: { bufferBps: 0 } });
    expect(r.ok).to.equal(true);
    expect(r.priceWei).to.equal(7n);
    expect(r.costWei).to.equal(700n);
    expect(r.mode).to.equal("worst-case");
  });

  it("gas price = 0 => GAS_COST_INVALID (zero nu e un cost valid)", () => {
    const r = ec.evaluateExecutionCost({ profitRaw: 1000n, settlementToken: WBNB, gasEstimate: 100n, feeData: { gasPrice: 0n }, policy: {} });
    expect(r.ok).to.equal(false);
    expect(r.rejection.code).to.equal("GAS_COST_INVALID");
  });

  it("fee data lipsă în interiorul guard-ului => fail-closed propagat", () => {
    expect(ec.evaluateExecutionCost({ profitRaw: 1000n, settlementToken: WBNB, gasEstimate: 100n, feeData: {}, policy: {} }).rejection.code).to.equal("GAS_PRICE_INVALID");
    expect(ec.evaluateExecutionCost({ profitRaw: 1000n, settlementToken: WBNB, gasEstimate: 100n, feeData: null, policy: {} }).rejection.code).to.equal("INVALID_FEE_DATA");
  });

  it("ordine fail-closed: estimate invalid are prioritate peste fee invalid", () => {
    const r = ec.evaluateExecutionCost({ profitRaw: 1000n, settlementToken: WBNB, gasEstimate: "bad", feeData: {}, policy: {} });
    expect(r.rejection.code).to.equal("GAS_ESTIMATE_INVALID");
  });

  it("determinist: aceleași inputuri => același rezultat", () => {
    const input = { profitRaw: 987654321n, settlementToken: WBNB, gasEstimate: 123456n, feeData: { gasPrice: 3n }, policy: { bufferBps: 2000, gasReserveBps: 500, minProfitBnb: 1n } };
    const a = ec.evaluateExecutionCost(input);
    const b = ec.evaluateExecutionCost(input);
    expect(a).to.deep.equal(b);
    expect(a.ok).to.equal(true);
  });

  it("fără mutația inputului (Object.freeze + deep compare)", () => {
    const input = Object.freeze({ profitRaw: 1000n, settlementToken: WBNB, gasEstimate: 100n, feeData: Object.freeze({ gasPrice: 1n }), policy: Object.freeze({ bufferBps: 0, gasReserveBps: 0 }) });
    const snap = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() + "n" : v));
    const before = snap(input);
    const r = ec.evaluateExecutionCost(input);
    expect(r.ok).to.equal(true);
    expect(snap(input)).to.equal(before);
  });
});

// ---- PART 2: integrare executor — ordering & binding (adversarial) ------
const executionSafety = require("../../bot/execution-safety");

function makeDiOpp() {
  const tokWbnb = { address: WBNB, decimals: 18, symbol: "WBNB" };
  const tokBase = { address: "0x" + "9a".repeat(20), decimals: 18, symbol: "BASE" };
  return {
    sourceKind: "v2",
    borrowToken: tokWbnb,
    baseToken: tokBase,
    borrowAmount: 1000n * 10n ** 18n,
    sourceVen: { kind: "v2", pair: "0x" + "a1".repeat(20), tokenA: tokWbnb, tokenB: tokBase, feeBps: 25, blockNumber: 100 },
    buyVen: { kind: "v2", router: "0x" + "b2".repeat(20), feeBps: 25, tokenA: tokWbnb, tokenB: tokBase, reserveA: 1000000n * 10n ** 18n, reserveB: 1000000n * 10n ** 18n, blockNumber: 100 },
    sellVen: { kind: "v2", router: "0x" + "c3".repeat(20), feeBps: 25, tokenA: tokWbnb, tokenB: tokBase, reserveA: 1000000n * 10n ** 18n, reserveB: 500000n * 10n ** 18n, blockNumber: 100 },
  };
}
// Profitul exact al DI opp (proaspăt recalculat, nu hardcodat în aserțiuni).
const DI_NET = executionSafety.finalRequote(makeDiOpp(), {}).final.net;

function makeWallet(estimateValue, sent = []) {
  const estimateGas = estimateValue === "throw"
    ? async () => { throw new Error("simulated-estimate-failure"); }
    : async () => estimateValue;
  return {
    address: "0x" + "e1".repeat(20),
    getAddress: async () => "0x" + "e1".repeat(20),
    call: async () => "0x" + "00".repeat(31) + "7b",
    estimateGas,
    sendTransaction(tx) { sent.push(tx); return { hash: "0x" + "ab".repeat(32) }; },
  };
}

function makeProvider(feeData) {
  return {
    getBlockNumber: async () => 100,
    getFeeData: async () => feeData,
  };
}

function withIsolatedExecutor(bloxrouteHandler, fn) {
  const paths = {
    scanner: require.resolve("../../bot/scanner"),
    bloxroute: require.resolve("../../bot/bloxroute"),
  };
  const saved = {};
  for (const k of Object.keys(paths)) saved[k] = require.cache[paths[k]];
  const fakeMod = (exports) => ({ id: paths.scanner, filename: paths.scanner, loaded: true, exports });
  require.cache[paths.scanner] = fakeMod({ readState: async () => {}, pairKey: (a, b) => (a < b ? a + b : b + a) });
  require.cache[paths.bloxroute] = fakeMod({ isAvailable: async () => true, sendPrivateTx: bloxrouteHandler });
  delete require.cache[require.resolve("../../bot/executor")];
  const executor = require("../../bot/executor");
  try { return fn(executor); }
  finally {
    for (const k of Object.keys(paths)) {
      if (saved[k]) require.cache[paths[k]] = saved[k];
      else delete require.cache[paths[k]];
    }
    delete require.cache[require.resolve("../../bot/executor")];
  }
}

function spyManager() {
  const m = { reserveCalls: 0, commitCalls: 0, rollbackCalls: 0 };
  m.reserve = async () => { m.reserveCalls += 1; return 7; };
  m.commit = () => { m.commitCalls += 1; };
  m.rollback = () => { m.rollbackCalls += 1; };
  return m;
}

const CONTRACT = "0x" + "f1".repeat(20);
const snap = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() + "n" : v));

describe("TASK 4.6-C — Executor integration (ordering & binding)", () => {
  it("C1: estimateGas aruncă => GAS_ESTIMATE_FAILED, ÎNAINTE de nonce/tracker/submisie", async () => {
    await withIsolatedExecutor(async () => { throw new Error("relay-not-reached"); }, async (executor) => {
      const mgr = spyManager();
      const trackerCreates = [];
      const tracker = { create: (x) => { trackerCreates.push(x); return { id: 1 }; }, markSubmitted() {}, poll() {} };
      const res = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet("throw"), makeProvider({ gasPrice: 1n }), { nonceManager: mgr, txTracker: tracker });
      expect(res.ok).to.equal(false);
      expect(res.reason).to.equal("GAS_ESTIMATE_FAILED");
      expect(mgr.reserveCalls).to.equal(0);
      expect(trackerCreates.length).to.equal(0);
    });
  });

  it("C2: fee data fără gas price ({}) => GAS_PRICE_INVALID, înainte de nonce", async () => {
    await withIsolatedExecutor(async () => { throw new Error("relay-not-reached"); }, async (executor) => {
      const mgr = spyManager();
      const res = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n), makeProvider({}), { nonceManager: mgr });
      expect(res.ok).to.equal(false);
      expect(res.reason).to.equal("GAS_PRICE_INVALID");
      expect(mgr.reserveCalls).to.equal(0);
    });
  });

  it("C3: getFeeData => null => INVALID_FEE_DATA, înainte de nonce", async () => {
    await withIsolatedExecutor(async () => { throw new Error("relay-not-reached"); }, async (executor) => {
      const mgr = spyManager();
      const res = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n), makeProvider(null), { nonceManager: mgr });
      expect(res.ok).to.equal(false);
      expect(res.reason).to.equal("INVALID_FEE_DATA");
      expect(mgr.reserveCalls).to.equal(0);
    });
  });

  it("C4: estimateGas = 0n => GAS_ESTIMATE_INVALID, înainte de nonce", async () => {
    await withIsolatedExecutor(async () => { throw new Error("relay-not-reached"); }, async (executor) => {
      const mgr = spyManager();
      const res = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(0n), makeProvider({ gasPrice: 1n }), { nonceManager: mgr });
      expect(res.ok).to.equal(false);
      expect(res.reason).to.equal("GAS_ESTIMATE_INVALID");
      expect(mgr.reserveCalls).to.equal(0);
    });
  });

  it("C5: estimateGas = 2^256-1 => GAS_LIMIT_TOO_HIGH (plafon config), fără overflow", async () => {
    await withIsolatedExecutor(async () => { throw new Error("relay-not-reached"); }, async (executor) => {
      const mgr = spyManager();
      const res = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(2n ** 256n - 1n), makeProvider({ gasPrice: 1n }), { nonceManager: mgr });
      expect(res.ok).to.equal(false);
      expect(res.reason).to.equal("GAS_LIMIT_TOO_HIGH");
      expect(mgr.reserveCalls).to.equal(0);
    });
  });

  // Fee-urile adversariale derivate din profitul REAL al DI opp (nu hardcodate):
  // rejectFee: cu estimate 480000 (buffered 576000) => bară 604800*fee >= net
  // acceptFee: cu orice estimate => bară < net (marjă sigură)
  const REJECT_FEE = (DI_NET + 604799n) / 604800n; // ceil(net/604800)
  const ACCEPT_FEE = DI_NET / 700000n;             // floor(net/700000)

  it("C6: mutația estimate-ului schimbă verdictul (fresh estimate, nu cached)", async () => {
    await withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: "0x" + "ab".repeat(16), block: 1 }), async (executor) => {
      // A: estimate 100000n (buffered 120000n) la ACELAȘI fee => ACCEPT
      const okA = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n), makeProvider({ gasPrice: REJECT_FEE }), { nonceManager: spyManager() });
      expect(okA.ok).to.equal(true);
      // B: estimate 480000n (buffered 576000n) la ACELAȘI fee => cost*1.05 >= net => REJECT
      const mgrB = spyManager();
      const badB = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(480000n), makeProvider({ gasPrice: REJECT_FEE }), { nonceManager: mgrB });
      expect(badB.ok).to.equal(false);
      expect(badB.reason).to.equal("NET_PROFIT_BELOW_FLOOR");
      expect(mgrB.reserveCalls).to.equal(0);
    });
  });

  it("C7: mutația gas price-ului închide fereastra (fee mare => REJECT înainte de nonce)", async () => {
    await withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: "0x" + "ab".repeat(16), block: 1 }), async (executor) => {
      const okLow = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n), makeProvider({ gasPrice: ACCEPT_FEE }), { nonceManager: spyManager() });
      expect(okLow.ok).to.equal(true);
      const mgrHigh = spyManager();
      const rejHigh = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n), makeProvider({ gasPrice: (DI_NET + 99999n) / 100000n }), { nonceManager: mgrHigh });
      expect(rejHigh.ok).to.equal(false);
      // Plafonul static grosier (500k gas) e strict peste estimate*buffer (120k)
      // pentru acest estimate — respingerea vine la pre-filtru. Ambele straturi
      // sunt fail-closed și ambele ÎNAINTE de nonce: fereastra e închisă.
      expect(rejHigh.reason).to.equal("profit-below-gas-floor");
      expect(mgrHigh.reserveCalls).to.equal(0);
    });
  });

  it("C8: private relay primește bound-ul VALIDAT (gasLimit buffered + maxFeePerGas validated)", async () => {
    const seen = [];
    await withIsolatedExecutor(async (args) => { seen.push(args); return { ok: true, status: "accepted", txHash: "0x" + "cd".repeat(16), block: 1 }; }, async (executor) => {
      const res = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n), makeProvider({ gasPrice: ACCEPT_FEE }), { nonceManager: spyManager() });
      expect(res.ok).to.equal(true);
      expect(seen.length).to.equal(1);
      expect(seen[0].gasLimit).to.equal(120000n); // ceil(100000 * 1.2)
      expect(seen[0].maxFeePerGas).to.equal(ACCEPT_FEE); // bound validat, nu default 5 gwei
    });
  });

  it("C9: fallback public păstrează ACEEAȘI tranzacție validată (gasLimit/gasPrice/nonce)", async () => {
    const sent = [];
    await withIsolatedExecutor(async () => ({ ok: false, status: "failed", error: "definitiv" }), async (executor) => {
      const res = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n, sent), makeProvider({ gasPrice: ACCEPT_FEE }), { nonceManager: spyManager() });
      expect(res.ok).to.equal(true);
      expect(res.private).to.equal(false);
      expect(sent.length).to.equal(1);
      expect(sent[0].gasLimit).to.equal(120000n);
      expect(sent[0].gasPrice).to.equal(ACCEPT_FEE);
      expect(sent[0].nonce).to.equal(7);
    });
  });

  it("C10: executeOpp nu mută oportunitatea (deep compare pe accept ȘI reject)", async () => {
    await withIsolatedExecutor(async () => ({ ok: true, status: "accepted", txHash: "0x" + "ef".repeat(16), block: 1 }), async (executor) => {
      const opp = makeDiOpp();
      const before = snap(opp);
      await executor.executeOpp(opp, CONTRACT, makeWallet(100000n), makeProvider({ gasPrice: ACCEPT_FEE }), { nonceManager: spyManager() });
      expect(snap(opp)).to.equal(before);
      const opp2 = makeDiOpp();
      const before2 = snap(opp2);
      await executor.executeOpp(opp2, CONTRACT, makeWallet(480000n), makeProvider({ gasPrice: REJECT_FEE }), { nonceManager: spyManager() });
      expect(snap(opp2)).to.equal(before2);
    });
  });

  it("A1 (audit F1): maxFeePerGas malformed în feeData → relay primește BOUND-UL validat, nu valoarea raw", async () => {
    const seen = [];
    await withIsolatedExecutor(async (args) => { seen.push(args); return { ok: true, status: "accepted", txHash: "0x" + "11".repeat(16), block: 1 }; }, async (executor) => {
      const malformed = "9".repeat(10); // truthy dar invalid
      const res = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n), makeProvider({ gasPrice: ACCEPT_FEE, maxFeePerGas: malformed }), { nonceManager: spyManager() });
      expect(res.ok).to.equal(true);
      expect(seen.length).to.equal(1);
      // Bound-ul worst-case validat (gasPrice), NICIODATĂ valoarea raw malformedă
      expect(seen[0].maxFeePerGas).to.equal(ACCEPT_FEE);
      expect(seen[0].maxFeePerGas).to.not.equal(malformed);
      // Coerență guard ↔ submission: același preț economice validat
      expect(seen[0].gasLimit).to.equal(120000n);
    });
  });

  it("A2 (audit F2): priority tip malformed sau > bound → relay primește un tip sanitizat ≤ bound", async () => {
    const seen = [];
    await withIsolatedExecutor(async (args) => { seen.push(args); return { ok: true, status: "accepted", txHash: "0x" + "22".repeat(16), block: 1 }; }, async (executor) => {
      // caz 1: priority malformed (string truthy)
      await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n), makeProvider({ gasPrice: ACCEPT_FEE, maxPriorityFeePerGas: "tip" }), { nonceManager: spyManager() });
      expect(seen[0].maxPriorityFeePerGas).to.equal(0n);
      // caz 2: priority > maxFee bound → ELIMINAT (0n) — niciodată tip peste bound
      await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n), makeProvider({ gasPrice: ACCEPT_FEE, maxPriorityFeePerGas: ACCEPT_FEE * 10n }), { nonceManager: spyManager() });
      expect(seen[1].maxPriorityFeePerGas).to.equal(0n);
      // caz 3: priority valid ≤ bound → păstrat
      await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n), makeProvider({ gasPrice: ACCEPT_FEE, maxPriorityFeePerGas: 1n }), { nonceManager: spyManager() });
      expect(seen[2].maxPriorityFeePerGas).to.equal(1n);
      // Invariant global: efectiv plătibil ≤ gasLimit × bound (semantica EIP-1559)
      for (const args of seen) {
        expect(args.maxPriorityFeePerGas <= args.maxFeePerGas).to.equal(true);
      }
    });
  });

  it("A3 (audit F1/F2): feeData 1559 complet valid → relay primește exact bound-ul worst-case", async () => {
    const seen = [];
    await withIsolatedExecutor(async (args) => { seen.push(args); return { ok: true, status: "accepted", txHash: "0x" + "33".repeat(16), block: 1 }; }, async (executor) => {
      // gasPrice > maxFeePerGas → bound = max = gasPrice
      const res = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n), makeProvider({ gasPrice: 9n, maxFeePerGas: 3n, maxPriorityFeePerGas: 2n }), { nonceManager: spyManager() });
      expect(res.ok).to.equal(true);
      expect(seen[0].maxFeePerGas).to.equal(9n); // worst-case bound
      expect(seen[0].maxPriorityFeePerGas).to.equal(2n); // valid ≤ bound, păstrat
    });
  });

  it("C11: evaluare repetată identică => același verdict și aceiași parametri de cost", async () => {
    const sent = [];
    await withIsolatedExecutor(async () => ({ ok: false, status: "failed", error: "definitiv" }), async (executor) => {
      const r1 = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n, sent), makeProvider({ gasPrice: ACCEPT_FEE }), { nonceManager: spyManager() });
      const r2 = await executor.executeOpp(makeDiOpp(), CONTRACT, makeWallet(100000n, sent), makeProvider({ gasPrice: ACCEPT_FEE }), { nonceManager: spyManager() });
      expect(r1.ok).to.equal(true);
      expect(r2.ok).to.equal(true);
      expect(sent[0].gasLimit).to.equal(sent[1].gasLimit);
      expect(sent[0].gasPrice).to.equal(sent[1].gasPrice);
    });
  });
});
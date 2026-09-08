// TASK 4.5-A-FIX-2 — Executor integration (public scenarios)
const { expect } = require("chai");

const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const BASE = "0x" + "9a".repeat(20);
const E18 = 10n ** 18n;

function makeDiOpp() {
  const tokWbnb = { address: WBNB, decimals: 18, symbol: "WBNB" };
  const tokBase = { address: BASE, decimals: 18, symbol: "BASE" };
  return {
    sourceKind: "v2",
    borrowToken: tokWbnb,
    baseToken: tokBase,
    borrowAmount: 1000n * E18,
    sourceVen: { kind: "v2", pair: "0x" + "a1".repeat(20), tokenA: tokWbnb, tokenB: tokBase, feeBps: 25, blockNumber: 100 },
    buyVen: { kind: "v2", router: "0x" + "b2".repeat(20), feeBps: 25, tokenA: tokWbnb, tokenB: tokBase, reserveA: 1_000_000n * E18, reserveB: 1_000_000n * E18, blockNumber: 100 },
    sellVen: { kind: "v2", router: "0x" + "c3".repeat(20), feeBps: 25, tokenA: tokWbnb, tokenB: tokBase, reserveA: 1_000_000n * E18, reserveB: 500_000n * E18, blockNumber: 100 },
  };
}

function makeWallet(sent = [], address = "0x" + "e1".repeat(20), startNonce = 0) {
  let nonce = startNonce;
  return {
    address,
    getAddress: async () => address,
    call: async () => "0x" + "00".repeat(31) + "7b",
    estimateGas: async () => 100000n,
    async getNonce() { return nonce; },
    sendTransaction(tx) { sent.push(tx); return { hash: "0x" + "tx".repeat(10) }; },
  };
}

function makeProvider() {
  return {
    getBlockNumber: async () => 100,
    getFeeData: async () => ({ gasPrice: 1n }),
  };
}

// Stub scanner/bloxroute/nonce to isolate executor
function withIsolatedExecutor(fn) {
  const paths = { scanner: require.resolve("../../bot/scanner"), bloxroute: require.resolve("../../bot/bloxroute"), nonce: require.resolve("../../bot/nonce") };
  const saved = {};
  for (const k of Object.keys(paths)) saved[k] = require.cache[paths[k]];
  const fakeMod = (exports) => ({ id: paths.scanner, filename: paths.scanner, loaded: true, exports });
  require.cache[paths.scanner] = fakeMod({ readState: async () => {}, pairKey: (a, b) => (a < b ? a + b : b + a) });
  require.cache[paths.bloxroute] = fakeMod({ isAvailable: async () => false, sendPrivateTx: async () => { throw new Error("not-used"); } });
  require.cache[paths.nonce] = fakeMod({ NonceManager: class { constructor(w) { this.wallet = w; } async reserve() { return 42; } commit() {} rollback() {} async init() {} } });
  delete require.cache[require.resolve("../../bot/executor")];
  const executor = require("../../bot/executor");
  try { return fn(executor); }
  finally {
    for (const k of Object.keys(paths)) { if (saved[k]) require.cache[paths[k]] = saved[k]; else delete require.cache[paths[k]]; }
    delete require.cache[require.resolve("../../bot/executor")];
  }
}

describe("TASK 4.5-A-FIX-2 — Executor integration (public)", function () {

  it("A3: public broadcast + commit failure → ok=false, nonce-commit-failed, txHash preserved, rollback=0", async function () {
    await withIsolatedExecutor(async (executor) => {
      const sent = [];
      const rollbackSpy = [];
      const manager = { async reserve() { return 7; }, commit(n, h) { throw new Error("simulated-commit-failure"); }, rollback(n) { rollbackSpy.push(n); } };
      const result = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(sent), makeProvider(), { nonceManager: manager });
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("nonce-commit-failed");
      expect(result.txHash).to.equal("0x" + "tx".repeat(10));
      expect(rollbackSpy.length).to.equal(0);
      expect(sent[0].nonce).to.equal(7);
    });
  });

  it("A5: nonce with hash cannot be reused after commit failure", async function () {
    // Use a real NonceManager (not stubbed) to test nonce reuse prevention
    const wallet = makeWallet([]);
    const { NonceManager } = require("../../bot/nonce");
    const realMgr = new NonceManager(wallet, 5);
    await realMgr.init();

    // Manually reserve a nonce and simulate commit failure
    const n = await realMgr.reserve();
    // Force commit to throw by double-commit (moves to blocked)
    realMgr.commit(n, "0xhash");
    try { realMgr.commit(n, "0xhash2"); } catch (e) { /* expected - moves to blocked */ }

    // Nonce is blocked
    expect(realMgr.blocked.has(n)).to.equal(true);

    // Next reserve must NOT return the blocked nonce
    const m = await realMgr.reserve();
    expect(m).to.not.equal(n);
  });

  it("A6: public broadcast + commit throws → ok=false (not success)", async function () {
    await withIsolatedExecutor(async (executor) => {
      const manager = { async reserve() { return 7; }, commit(n, h) { throw new Error("simulated-commit-failure"); }, rollback(n) {} };
      const result = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet([]), makeProvider(), { nonceManager: manager });
      expect(result.ok).to.equal(false);
    });
  });

  it("A7: public broadcast txHash preserved", async function () {
    await withIsolatedExecutor(async (executor) => {
      const sent = [];
      const manager = { async reserve() { return 7; }, commit(n, h) { throw new Error("simulated-commit-failure"); }, rollback(n) {} };
      const result = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet(sent), makeProvider(), { nonceManager: manager });
      expect(result.txHash).to.equal("0x" + "tx".repeat(10));
    });
  });

  it("A8: broadcast failure without hash → rollback called, result.ok=false", async function () {
    await withIsolatedExecutor(async (executor) => {
      const rollbackSpy = [];
      const wallet = makeWallet([]);
      wallet.sendTransaction = async () => { throw new Error("network error"); };
      const manager = { async reserve() { return 7; }, commit(n, h) {}, rollback(n) { rollbackSpy.push(n); } };
      const result = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), wallet, makeProvider(), { nonceManager: manager });
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("broadcast-fail");
      expect(rollbackSpy.length).to.equal(1);
      expect(rollbackSpy[0]).to.equal(7);
    });
  });
});

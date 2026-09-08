// TASK 4.5-A-FIX-2 — Executor integration (private scenarios)
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

function makeWallet(sent = [], address = "0x" + "e1".repeat(20)) {
  return {
    address,
    getAddress: async () => address,
    call: async () => "0x" + "00".repeat(31) + "7b", // uint256 = 123
    estimateGas: async () => 100000n,
    sendTransaction(tx) { sent.push(tx); return { hash: "0x" + "tx".repeat(10) }; },
  };
}

function makeProvider() {
  return {
    getBlockNumber: async () => 100,
    getFeeData: async () => ({ gasPrice: 1n }),
  };
}

function stubBloxroute(handler) {
  const p = require.resolve("../../bot/bloxroute");
  const s = require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { isAvailable: async () => true, sendPrivateTx: handler } };
  delete require.cache[require.resolve("../../bot/executor")];
  return s;
}

function restoreBloxroute(saved, p) {
  if (saved) require.cache[p] = saved; else delete require.cache[p];
  delete require.cache[require.resolve("../../bot/executor")];
}

describe("TASK 4.5-A-FIX-2 — Executor integration (private)", function () {

  it("A1: private accepted + commit failure → ok=false, nonce-commit-failed, txHash preserved, rollback=0", async function () {
    const rollbackSpy = [];
    const submittedTxHash = "0x" + "abc".repeat(20);
    const manager = { async reserve() { return 7; }, commit(n, h) { throw new Error("simulated-commit-failure"); }, rollback(n) { rollbackSpy.push(n); } };
    const p = require.resolve("../../bot/bloxroute");
    const saved = stubBloxroute(async () => ({ ok: true, status: "accepted", txHash: submittedTxHash, block: 123 }));
    const executor = require("../../bot/executor");
    try {
      const result = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet([]), makeProvider(), { nonceManager: manager });
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("nonce-commit-failed");
      expect(result.txHash).to.equal(submittedTxHash);
      expect(rollbackSpy.length).to.equal(0);
    } finally { restoreBloxroute(saved, p); }
  });

  it("A2: private accepted + commit throws → rollback callCount === 0", async function () {
    const rollbackSpy = [];
    const manager = { async reserve() { return 7; }, commit(n, h) { throw new Error("simulated-commit-failure"); }, rollback(n) { rollbackSpy.push(n); } };
    const p = require.resolve("../../bot/bloxroute");
    const saved = stubBloxroute(async () => ({ ok: true, status: "accepted", txHash: "0xdef", block: 1 }));
    const executor = require("../../bot/executor");
    try {
      await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet([]), makeProvider(), { nonceManager: manager });
      expect(rollbackSpy.length).to.equal(0);
    } finally { restoreBloxroute(saved, p); }
  });

  it("A4: private UNKNOWN + tombstone commit failure → ok=false, txHash=null, rollback=0", async function () {
    const rollbackSpy = [];
    const manager = { async reserve() { return 7; }, commit(n, h) { throw new Error("simulated-tombstone-failure"); }, rollback(n) { rollbackSpy.push(n); } };
    const p = require.resolve("../../bot/bloxroute");
    const saved = stubBloxroute(async () => ({ ok: false, status: "unknown", error: "timeout" }));
    const executor = require("../../bot/executor");
    try {
      const result = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet([]), makeProvider(), { nonceManager: manager });
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("nonce-commit-failed");
      expect(result.txHash).to.equal(null);
      expect(rollbackSpy.length).to.equal(0);
    } finally { restoreBloxroute(saved, p); }
  });

  it("A7: private accepted txHash preserved", async function () {
    const submittedTxHash = "0x" + "abc".repeat(20);
    const manager = { async reserve() { return 7; }, commit(n, h) { throw new Error("simulated-commit-failure"); }, rollback(n) {} };
    const p = require.resolve("../../bot/bloxroute");
    const saved = stubBloxroute(async () => ({ ok: true, status: "accepted", txHash: submittedTxHash, block: 1 }));
    const executor = require("../../bot/executor");
    try {
      const result = await executor.executeOpp(makeDiOpp(), "0x" + "f1".repeat(20), makeWallet([]), makeProvider(), { nonceManager: manager });
      expect(result.txHash).to.equal(submittedTxHash);
    } finally { restoreBloxroute(saved, p); }
  });
});

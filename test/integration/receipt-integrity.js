// TASK 4.7 — POST-BROADCAST OUTCOME & RECEIPT INTEGRITY.
//
// Tests the LIVE observer (bot/tracker.js trackTransaction) — the function the
// main loop uses to classify the real on-chain outcome:
//   - "mined"  ONLY for a receipt with status === 1 (INVARIANT 1/2);
//   - status 0 → "reverted", NEVER "mined" (INVARIANT 2/3);
//   - receipt identity binding: transactionHash mismatch → "unknown" (INVARIANT 7);
//   - chain identity: provider must prove chainId 56 (INVARIANT 8);
//   - null receipt / RPC errors → "timeout"/"unknown", NEVER success (INVARIANT 4).
const chai = require("chai");
const chaiAsPromised = require("chai-as-promised");
chai.use(chaiAsPromised);
const { expect } = chai;
const { trackTransaction } = require("../../bot/tracker");

const TX_HASH = "0x" + "ab".repeat(32);
const OTHER_HASH = "0x" + "cd".repeat(32);
const BLOCK_HASH = "0x" + "be".repeat(32);

function makeProvider(opts = {}) {
  const p = {
    receipt: opts.receipt,
    network: opts.network !== undefined ? opts.network : { chainId: 56n },
    throwReceipt: !!opts.throwReceipt,
    receiptCalls: 0,
    networkCalls: 0,
    async getNetwork() {
      p.networkCalls += 1;
      return p.network;
    },
    async getTransactionReceipt() {
      p.receiptCalls += 1;
      if (p.throwReceipt) throw new Error("RPC failure: receipt");
      return p.receipt;
    },
    async getTransaction() {
      return null;
    },
  };
  return p;
}

function successReceipt(overrides = {}) {
  return {
    status: 1,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    transactionIndex: 2,
    gasUsed: 300000n,
    effectiveGasPrice: 3000000000n,
    logs: [],
    ...overrides,
  };
}

function revertedReceipt(overrides = {}) {
  return { ...successReceipt(overrides), status: 0 };
}

describe("TASK 4.7 — live observer receipt integrity (bot/tracker.js)", function () {
  this.timeout(30000);

  it("4.7-O1 — receipt status 1 + matching transactionHash → status 'mined'", async function () {
    const provider = makeProvider({ receipt: successReceipt({ transactionHash: TX_HASH }) });
    const r = await trackTransaction(provider, { txHash: TX_HASH, timeoutMs: 2000 });
    expect(r.status).to.equal("mined");
    expect(r.blockNumber).to.equal(100);
    // Gas-ul real: gasUsed × effectiveGasPrice (nu gasPrice).
    expect(r.gasCostBnb).to.equal(300000n * 3000000000n);
  });

  it("4.7-O2 — receipt status 0 → status 'reverted', NEVER 'mined' (INVARIANT 2/3)", async function () {
    const provider = makeProvider({ receipt: revertedReceipt({ transactionHash: TX_HASH }) });
    const r = await trackTransaction(provider, { txHash: TX_HASH, timeoutMs: 2000 });
    expect(r.status).to.equal("reverted");
    expect(r.status).to.not.equal("mined");
    expect(r.realizedProfit).to.be.undefined;
    expect(r.gasCostBnb).to.equal(300000n * 3000000000n); // gas consumat de revert, NU profit
  });

  it("4.7-O3 — receipt transactionHash MISMATCH → 'unknown' (INVARIANT 7, fail-closed)", async function () {
    const provider = makeProvider({ receipt: successReceipt({ transactionHash: OTHER_HASH }) });
    const r = await trackTransaction(provider, { txHash: TX_HASH, timeoutMs: 2000 });
    expect(r.status).to.equal("unknown");
    expect(r.status).to.not.equal("mined");
    expect(r.lastError).to.include("receipt hash mismatch");
  });

  it("4.7-O4 — receipt transactionHash malformed → 'unknown' (INVARIANT 7)", async function () {
    const provider = makeProvider({ receipt: successReceipt({ transactionHash: "garbage" }) });
    const r = await trackTransaction(provider, { txHash: TX_HASH, timeoutMs: 2000 });
    expect(r.status).to.equal("unknown");
    expect(r.lastError).to.include("receipt hash mismatch");
  });

  it("4.7-O5 — provider chainId mismatch (56 ≠ 1) → 'unknown', NOT mined (INVARIANT 8)", async function () {
    const provider = makeProvider({ network: { chainId: 1n }, receipt: successReceipt({ transactionHash: TX_HASH }) });
    const r = await trackTransaction(provider, { txHash: TX_HASH, timeoutMs: 2000, expectedChainId: 56 });
    expect(r.status).to.equal("unknown");
    expect(r.lastError).to.include("chain mismatch");
  });

  it("4.7-O6 — provider network unavailable (getNetwork throws) → 'unknown'", async function () {
    const p = makeProvider({ receipt: successReceipt({ transactionHash: TX_HASH }) });
    p.getNetwork = async function () { throw new Error("RPC dead"); };
    const r = await trackTransaction(p, { txHash: TX_HASH, timeoutMs: 2000, expectedChainId: 56 });
    expect(r.status).to.equal("unknown");
    expect(r.lastError).to.include("network unavailable");
  });

  it("4.7-O7 — no receipt ever → 'timeout', NEVER success (INVARIANT 4)", async function () {
    const provider = makeProvider({ receipt: null });
    const r = await trackTransaction(provider, { txHash: TX_HASH, timeoutMs: 80 });
    expect(r.status).to.equal("timeout");
    expect(r.status).to.not.equal("mined");
    expect(provider.receiptCalls).to.be.at.least(1);
  });

  it("4.7-O8 — receipt RPC errors are transient → 'timeout', never fabricated success", async function () {
    const provider = makeProvider({ throwReceipt: true });
    const r = await trackTransaction(provider, { txHash: TX_HASH, timeoutMs: 80 });
    expect(r.status).to.equal("timeout");
  });

  it("4.7-O9 — mined result REQUIRES receipt.status === 1 (no status → not success)", async function () {
    // Receipt cu blockNumber dar fără status = shape invalid — observatorul
    // nu poate dovedi succes => nu returnează "mined".
    const provider = makeProvider({ receipt: { blockNumber: 100, blockHash: BLOCK_HASH, gasUsed: 1n, effectiveGasPrice: 1n, transactionHash: TX_HASH, logs: [] } });
    const r = await trackTransaction(provider, { txHash: TX_HASH, timeoutMs: 80 });
    expect(r.status).to.not.equal("mined");
  });

  it("4.7-O10 — BigInt gas arithmetic remains exact (no float coercion)", async function () {
    const gasUsed = 1234567n;
    const eff = 15000000000n;
    const provider = makeProvider({ receipt: successReceipt({ gasUsed, effectiveGasPrice: eff, transactionHash: TX_HASH }) });
    const r = await trackTransaction(provider, { txHash: TX_HASH, timeoutMs: 2000 });
    expect(r.status).to.equal("mined");
    expect(r.gasCostBnb).to.equal(gasUsed * eff);
    expect(typeof r.gasCostBnb).to.equal("bigint");
  });
});

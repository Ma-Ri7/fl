// TASK 4.11-L-B — RECEIPT NORMALIZATION & TERMINALISATION REGRESSION (F1/F2).
//
// Proves the remediation against REAL ethers v6.17.0 receipt objects obtained from a
// local mock JSON-RPC server (never a network call, never a broadcast):
//   F1 — NonceManager._isConsumedReceipt() recognises a v6 receipt and reap()/recover()
//        terminalise the journal record, so pending slots cannot accumulate forever;
//   F2 — pnl.validateReceipt() requires a verifiable transaction identity for a
//        successful receipt and accepts the v6 `gasPrice` field.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const chai = require("chai");
const { expect } = chai;
const { ethers } = require("ethers");
const { NonceManager } = require("../../bot/nonce");
const { NonceJournal } = require("../../bot/nonce-journal");
const { PnLTracker, PnLStatus } = require("../../bot/pnl");

const WALLET = "0x1111111111111111111111111111111111111111";
const TX = "0x" + "ab".repeat(32);
const OTHER = "0x" + "cd".repeat(32);
const BLOCK_HASH = "0x" + "be".repeat(32);
const USDT = "0x55d398326f99059ff775485246999027b3197955";

/** Local mock node: serves eth_chainId/eth_blockNumber/eth_getTransactionCount/receipts. */
function startMockNode() {
  const receipts = new Map();     // hash -> json-rpc receipt
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body); } catch { payload = {}; }
      const single = !Array.isArray(payload);
      const out = (single ? [payload] : payload).map((r) => {
        let result = null;
        if (r.method === "eth_chainId") result = "0x38";                       // BSC 56
        else if (r.method === "eth_blockNumber") result = "0x8abcdf";
        else if (r.method === "eth_getTransactionCount") result = "0x64";
        else if (r.method === "eth_getTransactionReceipt") {
          const found = receipts.get(r.params[0]);
          result = found === undefined ? null : found;
        }
        return { jsonrpc: "2.0", id: r.id, result };
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(single ? out[0] : out));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const provider = new ethers.JsonRpcProvider(
        `http://127.0.0.1:${server.address().port}`, undefined,
        // cacheTimeout: -1 disables ethers' 250ms JSON-RPC response cache, so a receipt
        // republished for the same hash (status change) is always re-read.
        { staticNetwork: true, cacheTimeout: -1 });
      resolve({
        provider,
        /** Publish a mined receipt for `hash` on the mock node. */
        publish(hash, { status = 1, blockNumber = 9000000 } = {}) {
          receipts.set(hash, {
            transactionHash: hash, transactionIndex: "0x1",
            blockHash: BLOCK_HASH, blockNumber: "0x" + blockNumber.toString(16),
            from: WALLET, to: "0x2222222222222222222222222222222222222222",
            cumulativeGasUsed: "0x5208", gasUsed: "0x5208", contractAddress: null,
            logs: [], logsBloom: "0x" + "00".repeat(256), status: "0x" + status.toString(16),
            type: "0x2", effectiveGasPrice: "0x3b9aca00",
          });
        },
        close() { server.close(); },
      });
    });
  });
}

function tmpJournalPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "4.11-l-b-"));
  return { dir, file: path.join(dir, "nonce-journal.json") };
}

/** Mock wallet: never funded, never broadcasts; only supplies the pending nonce. */
function mockWallet(pending) {
  return { address: WALLET, async getNonce() { return pending; } };
}

describe("TASK 4.11-L-B — receipt normalization & terminalisation (F1/F2)", function () {
  this.timeout(30000);
  let node;
  before(async () => { node = await startMockNode(); });
  after(() => { node.close(); });

  // ---------------------------------------------------------------------------
  describe("F1 — real ethers v6 receipt identity", function () {
    it("L1.1 — real v6 receipt fields: `hash` present, `transactionHash` absent, `gasPrice` present", async () => {
      node.publish(TX);
      const r = await node.provider.getTransactionReceipt(TX);
      // Recorded evidence (the exact v6.17.0 shape that broke the old contract).
      expect(typeof r.hash).to.equal("string");
      expect(r.hash.toLowerCase()).to.equal(TX.toLowerCase());
      expect(r.transactionHash).to.equal(undefined);
      expect(typeof r.gasPrice).to.equal("bigint");
      expect(r.effectiveGasPrice).to.equal(undefined);
      expect(r.status).to.equal(1);
      expect(r.blockNumber).to.be.a("number");
      expect(typeof r.blockHash).to.equal("string");
    });

    it("L1.2 — _isConsumedReceipt() ACCEPTS a real v6 receipt (exact hash)", async () => {
      const { file } = tmpJournalPath();
      const nj = new NonceJournal({ path: file });
      nj.bindWallet(WALLET, 56);
      const nm = new NonceManager(mockWallet(100), 5);
      nm.attachJournal(nj);
      const real = await node.provider.getTransactionReceipt(TX);
      expect(nm._isConsumedReceipt(real, TX)).to.equal(true);
    });

    it("L1.3 — identity is case-insensitive (v6 hash)", async () => {
      const nm = new NonceManager(mockWallet(100), 5);
      const real = await node.provider.getTransactionReceipt(TX);
      expect(nm._isConsumedReceipt(real, TX.toUpperCase())).to.equal(true);
    });

    it("L1.4 — FOREIGN hash rejected (v6 receipt for another transaction)", async () => {
      const { file } = tmpJournalPath();
      const nj = new NonceJournal({ path: file });
      nj.bindWallet(WALLET, 56);
      const nm = new NonceManager(mockWallet(100), 5);
      nm.attachJournal(nj);
      node.publish(OTHER);
      const foreign = await node.provider.getTransactionReceipt(OTHER);
      expect(nm._isConsumedReceipt(foreign, TX)).to.equal(false);
    });

    it("L1.5 — MISSING hash rejected (legacy hash-less receipt)", () => {
      const nm = new NonceManager(mockWallet(100), 5);
      expect(nm._isConsumedReceipt({ status: 1, blockNumber: 1, blockHash: BLOCK_HASH }, TX)).to.equal(false);
      expect(nm._isConsumedReceipt({ status: 1, blockNumber: 1, blockHash: BLOCK_HASH, transactionHash: null }, TX)).to.equal(false);
    });

    it("L1.6 — status 0 and status 1 are both CONSUMED; malformed status is not", () => {
      const nm = new NonceManager(mockWallet(100), 5);
      const base = { hash: TX, blockNumber: 1, blockHash: BLOCK_HASH };
      expect(nm._isConsumedReceipt({ ...base, status: 0 }, TX)).to.equal(true);
      expect(nm._isConsumedReceipt({ ...base, status: 1 }, TX)).to.equal(true);
      expect(nm._isConsumedReceipt({ ...base, status: 2 }, TX)).to.equal(false);
      expect(nm._isConsumedReceipt({ ...base, status: "1" }, TX)).to.equal(false);
      expect(nm._isConsumedReceipt({ ...base }, TX)).to.equal(false);
    });

    it("L1.7 — missing blockNumber / blockHash rejected (fail-closed preserved)", () => {
      const nm = new NonceManager(mockWallet(100), 5);
      expect(nm._isConsumedReceipt({ hash: TX, status: 1, blockHash: BLOCK_HASH }, TX)).to.equal(false);
      expect(nm._isConsumedReceipt({ hash: TX, status: 1, blockNumber: 1 }, TX)).to.equal(false);
      expect(nm._isConsumedReceipt(null, TX)).to.equal(false);
      expect(nm._isConsumedReceipt("not-a-receipt", TX)).to.equal(false);
    });

    it("L1.8 — legacy synthetic receipt (transactionHash) remains supported", () => {
      const nm = new NonceManager(mockWallet(100), 5);
      expect(nm._isConsumedReceipt({ transactionHash: TX, status: 1, blockNumber: 1, blockHash: BLOCK_HASH }, TX)).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe("F1 — lifecycle / terminalisation / availability", function () {
    async function managed(pending, maxPending) {
      const { file } = tmpJournalPath();
      const nj = new NonceJournal({ path: file });
      nj.bindWallet(WALLET, 56);
      const nm = new NonceManager(mockWallet(pending), maxPending);
      nm.attachJournal(nj);
      return { file, nj, nm };
    }

    it("L2.1 — public submission: reap() consumes the slot AND terminalises the journal", async () => {
      const { nj, nm } = await managed(500, 5);
      const n = await nm.reserve();
      nm.commit(n, TX, { channel: "public" });
      node.publish(TX);
      await nm.reap(node.provider);
      expect(nm.pending.size).to.equal(0);
      expect(nj.get(n).state).to.equal("CONFIRMED_SUCCESS");
      expect(nj.isOutstanding(nj.get(n))).to.equal(false);
    });

    it("L2.2 — private submission: reap() consumes the slot and terminalises (status 0 → revert)", async () => {
      const { nj, nm } = await managed(600, 5);
      const n = await nm.reserve();
      nm.commit(n, OTHER, { channel: "private" });
      node.publish(OTHER, { status: 0 });
      await nm.reap(node.provider);
      expect(nm.pending.size).to.equal(0);
      expect(nj.get(n).state).to.equal("CONFIRMED_REVERT");
    });

    it("L2.3 — recover() at restart terminalises a real v6 receipt", async () => {
      const { nj, nm } = await managed(700, 5);
      const n = await nm.reserve();
      nm.commit(n, TX, { channel: "public" });
      const { file: f2 } = tmpJournalPath();
      void f2;
      // fresh managers over the same journal file (restart)
      const nj2 = new NonceJournal({ path: nj.path });
      nj2.bindWallet(WALLET, 56);
      const nm2 = new NonceManager(mockWallet(0), 5);
      nm2.attachJournal(nj2);
      await nm2.recover(node.provider);
      expect(nj2.get(n).state).to.equal("CONFIRMED_SUCCESS");
      expect(nj2.isOutstanding(nj2.get(n))).to.equal(false);
      // `blocked` is intentionally NOT pruned by recover() (over-blocking is conservative:
      // the nonce is consumed on-chain and the floor already moved past it).
      expect(nm2.next >= n + 1).to.equal(true);
    });

    it("L2.4 — restart after terminalisation keeps CONFIRMED_SUCCESS on disk", async () => {
      const { nj, nm } = await managed(800, 5);
      const n = await nm.reserve();
      nm.commit(n, TX, { channel: "public" });
      await nm.reap(node.provider);
      const nj2 = new NonceJournal({ path: nj.path });
      nj2.bindWallet(WALLET, 56);
      expect(nj2.get(n).state).to.equal("CONFIRMED_SUCCESS");
    });

    it("L2.5 — 100 sequential receipt/reap cycles: no accumulation, reserve() never null", async () => {
      const { nj, nm } = await managed(1000, 5);
      const hashes = [];
      for (let i = 0; i < 100; i++) {
        const h = "0x" + i.toString(16).padStart(4, "0").repeat(16);
        hashes.push(h);
        node.publish(h);
      }
      for (let i = 0; i < 100; i++) {
        const n = await nm.reserve();
        expect(n, `reserve() must remain available at cycle ${i}`).to.not.equal(null);
        nm.commit(n, hashes[i], { channel: i % 2 ? "public" : "private" });
        await nm.reap(node.provider);
        expect(nm.pending.size, `pending must not accumulate at cycle ${i}`).to.equal(0);
      }
      const outstanding = nj.outstanding().filter((r) => /^SUBMITTED_/.test(r.state)).length;
      expect(outstanding, "no outstanding SUBMITTED_* record may accumulate").to.equal(0);
    });

    it("L2.6 — maxPending does not deadlock (regression for the F1 halt)", async () => {
      const MAX = 5;
      const { nm } = await managed(2000, MAX);
      for (let i = 0; i < MAX * 3; i++) {
        const h = "0x" + (i + 5000).toString(16).padStart(4, "0").repeat(16);
        node.publish(h);
        const n = await nm.reserve();
        expect(n, `reserve() must not return null at cycle ${i}`).to.not.equal(null);
        nm.commit(n, h, { channel: "public" });
        await nm.reap(node.provider);
      }
      expect(nm.pending.size).to.equal(0);
      const stillAvailable = await nm.reserve();
      expect(stillAvailable).to.not.equal(null);
    });

    it("L2.7 — invalid receipts never release the slot nor terminalise the journal", async () => {
      const cases = [
        ["missing identity", { status: 1, blockNumber: 1, blockHash: BLOCK_HASH }],
        ["foreign hash", { hash: OTHER, status: 1, blockNumber: 1, blockHash: BLOCK_HASH }],
        ["missing blockNumber", { hash: TX, status: 1, blockHash: BLOCK_HASH }],
        ["missing blockHash", { hash: TX, status: 1, blockNumber: 1 }],
        ["invalid status", { hash: TX, status: 2, blockNumber: 1, blockHash: BLOCK_HASH }],
      ];
      for (const [label, receipt] of cases) {
        const { nj, nm } = await managed(3000, 5);
        const n = await nm.reserve();
        nm.commit(n, TX, { channel: "public" });
        await nm.reap({ getTransactionReceipt: async () => receipt });
        expect(nm.pending.has(n), `${label}: slot must remain committed`).to.equal(true);
        expect(nj.get(n).state, `${label}: journal must remain non-terminal`).to.equal("SUBMITTED_PUBLIC");
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe("F2 — PnL receipt validation / normalization", function () {
    const BNB = "0x0000000000000000000000000000000000000000";
    const base = (over = {}) => Object.assign({
      txHash: TX, wallet: WALLET, settlementToken: BNB, settlementDecimals: 18,
      beforeBalanceRaw: 1000000n, afterBalanceRaw: 1200000n,
    }, over);

    it("L3.1 — a REAL v6 receipt realizes gross/net with the existing accounting rules", async () => {
      node.publish(TX, { status: 1 });
      const real = await node.provider.getTransactionReceipt(TX);
      const rec = new PnLTracker().recordPnL(base({ receipt: real }));
      expect(rec.grossProfitStatus).to.equal(PnLStatus.REALIZED);
      expect(rec.grossProfitRaw).to.equal(200000n);
      // real receipt: gasUsed 0x5208 = 21000, gasPrice 0x3b9aca00 = 1e9 (v6 field name)
      expect(rec.gasCostWei).to.equal(21000n * 1000000000n);
      expect(rec.netProfitStatus).to.equal("KNOWN");
      expect(rec.netProfitRaw).to.equal(200000n - 21000n * 1000000000n);
    });

    it("L3.2 — status 1 + MISSING identity → REJECTED (no realization)", () => {
      expect(() => new PnLTracker().recordPnL(base({
        receipt: { status: 1, gasUsed: 21000n, effectiveGasPrice: 1000000000n, blockNumber: 1, blockHash: BLOCK_HASH },
      }))).to.throw(/identity missing/);
    });

    it("L3.3 — FOREIGN hash → REJECTED (foreign receipt)", () => {
      expect(() => new PnLTracker().recordPnL(base({
        receipt: { transactionHash: OTHER, status: 1, gasUsed: 21000n, effectiveGasPrice: 1000000000n, blockNumber: 1, blockHash: BLOCK_HASH },
      }))).to.throw(/hash mismatch/);
      expect(() => new PnLTracker().recordPnL(base({
        receipt: { hash: OTHER, status: 1, gasUsed: 21000n, gasPrice: 1000000000n, blockNumber: 1, blockHash: BLOCK_HASH },
      }))).to.throw(/hash mismatch/);
    });

    it("L3.4 — hash case mutation → ACCEPTED (case-insensitive identity)", () => {
      const rec = new PnLTracker().recordPnL(base({
        receipt: { hash: TX.toUpperCase(), status: 1, gasUsed: 21000n, gasPrice: 1000000000n, blockNumber: 1, blockHash: BLOCK_HASH },
      }));
      expect(rec.grossProfitStatus).to.equal(PnLStatus.REALIZED);
    });

    it("L3.5 — `gasPrice` (v6) and `effectiveGasPrice` (legacy) are both accepted", () => {
      const a = new PnLTracker().recordPnL(base({
        receipt: { hash: TX, status: 1, gasUsed: 21000n, gasPrice: 2000000000n, blockNumber: 1, blockHash: BLOCK_HASH },
      }));
      const b = new PnLTracker().recordPnL(base({
        txHash: OTHER, receipt: { transactionHash: OTHER, status: 1, gasUsed: 21000n, effectiveGasPrice: 2000000000n, blockNumber: 1, blockHash: BLOCK_HASH },
      }));
      expect(a.gasCostWei).to.equal(21000n * 2000000000n);
      expect(b.gasCostWei).to.equal(21000n * 2000000000n);
    });

    it("L3.6 — missing / malformed gas price → REJECTED", () => {
      const mk = (gas) => ({ hash: TX, status: 1, gasUsed: 21000n, blockNumber: 1, blockHash: BLOCK_HASH, ...gas });
      expect(() => new PnLTracker().recordPnL(base({ receipt: mk({}) }))).to.throw(/gas price/);
      expect(() => new PnLTracker().recordPnL(base({ receipt: mk({ effectiveGasPrice: 1000000000 }) }))).to.throw(/gas price/);
      expect(() => new PnLTracker().recordPnL(base({ receipt: mk({ gasPrice: "1000000000" }) }))).to.throw(/gas price/);
      expect(() => new PnLTracker().recordPnL(base({ receipt: mk({ gasPrice: -1n }) }))).to.throw(/gas price/);
    });

    it("L3.7 — declared chainId: wrong → REJECTED, malformed → REJECTED, 56/56n → ACCEPTED", () => {
      const mk = (chainId) => ({ hash: TX, status: 1, gasUsed: 21000n, gasPrice: 1000000000n, blockNumber: 1, blockHash: BLOCK_HASH, chainId });
      expect(() => new PnLTracker().recordPnL(base({ receipt: mk(1) }))).to.throw(/wrong chain/);
      expect(() => new PnLTracker().recordPnL(base({ receipt: mk("not-a-chain") }))).to.throw(/invalid receipt\.chainId/);
      const ok56 = new PnLTracker().recordPnL(base({ receipt: mk(56) }));
      expect(ok56.grossProfitStatus).to.equal(PnLStatus.REALIZED);
      const ok56n = new PnLTracker().recordPnL(base({ txHash: OTHER, receipt: { ...mk(56n), hash: OTHER } }));
      expect(ok56n.grossProfitStatus).to.equal(PnLStatus.REALIZED);
    });

    it("L3.7b — chain ABSENT from the receipt: governed by the caller's chain (documented semantics)", () => {
      // Real ethers v6 receipts expose no chainId, so an absent field is NOT treated as
      // a mismatch (the provider/chain context governs). A DECLARED chain is always
      // enforced (L3.7). This is the one point where the remediation deliberately does
      // not reject, because rejecting would make every real v6 receipt unusable.
      const rec = new PnLTracker().recordPnL(base({
        receipt: { hash: TX, status: 1, gasUsed: 21000n, gasPrice: 1000000000n, blockNumber: 1, blockHash: BLOCK_HASH },
      }));
      expect(rec.grossProfitStatus).to.equal(PnLStatus.REALIZED);
    });

    it("L3.8 — status 0 never realizes", () => {
      const rec = new PnLTracker().recordPnL(base({
        receipt: { hash: TX, status: 0, gasUsed: 21000n, gasPrice: 1000000000n, blockNumber: 1, blockHash: BLOCK_HASH },
      }));
      expect(rec.grossProfitStatus).to.not.equal(PnLStatus.REALIZED);
      expect(rec.grossProfitRaw).to.equal(null);
      expect(rec.netProfitRaw).to.equal(null);
      expect(rec.isReverted).to.equal(true);
    });

    it("L3.9 — status 1 missing blockNumber/blockHash → REJECTED", () => {
      expect(() => new PnLTracker().recordPnL(base({
        receipt: { hash: TX, status: 1, gasUsed: 21000n, gasPrice: 1000000000n, blockHash: BLOCK_HASH },
      }))).to.throw(/blockNumber|blockHash/);
      expect(() => new PnLTracker().recordPnL(base({
        receipt: { hash: TX, status: 1, gasUsed: 21000n, gasPrice: 1000000000n, blockNumber: 1 },
      }))).to.throw(/blockNumber|blockHash/);
    });

    it("L3.10 — no receipt / invalid status never realize", () => {
      const none = new PnLTracker().recordPnL(base({ receipt: null }));
      expect(none.grossProfitStatus).to.not.equal(PnLStatus.REALIZED);
      expect(none.status).to.equal(PnLStatus.UNKNOWN);
      expect(() => new PnLTracker().recordPnL(base({ receipt: { hash: TX, status: 2, blockNumber: 1, blockHash: BLOCK_HASH } })))
        .to.throw(/status/);
    });
  });
});


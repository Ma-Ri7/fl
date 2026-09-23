"use strict";
// TASK 4.11-I-B — HTTP polling failure containment (I-A-LOW-1 remediation).
// All providers are in-process mocks — no network, no live BSC, no broadcast.
const assert = require("assert");
const { ethers } = require("ethers");
const { runHttpPollingLoop, resolvePollIntervalMs } = require("../../bot/index");

const SILENT = { info: () => {}, warn: () => {}, error: () => {} };
const noSleep = async () => {};

class P {
  constructor() { this.steps = []; this.calls = 0; }
  script(...s) { this.steps = s; return this; }
  getBlockNumber() {
    this.calls++;
    const s = this.steps.length ? this.steps.shift() : null;
    if (s === null || s === undefined) return Promise.resolve(0);
    if (typeof s === "function") return s();
    return Promise.resolve(s);
  }
}
const ret = (n) => () => Promise.resolve(n);
const rej = (m) => () => Promise.reject(new Error(m));
const thr = (m) => () => { throw new Error(m); };

function stopAfter(n) { let i = 0; return () => { i++; return i > n; }; }

async function drive({ steps, iterations, scan, sleep, pollIntervalMs = 1, backoffMs = 100 }) {
  const p = new P().script(...steps);
  let currentBlock = 0;
  const S = { scans: 0, execs: 0, nonce: 0, journal: 0, pnl: 0 };
  const scanFn = scan || (async () => { S.scans++; S.execs++; S.nonce++; S.journal++; S.pnl++; });
  const sleepDurations = [];
  const result = await runHttpPollingLoop({
    provider: p, scan: scanFn,
    getCurrentBlock: () => currentBlock, setCurrentBlock: (bn) => { currentBlock = bn; },
    pollIntervalMs, logger: SILENT,
    sleep: sleep || (async (ms) => { sleepDurations.push(ms); }),
    backoffMs, isDone: stopAfter(iterations),
  });
  return { p, S, currentBlock, result, sleepDurations };
}

describe("TASK 4.11-I-B — HTTP polling failure containment", function () {
  this.timeout(20000);

  it("I-B1: single getBlockNumber rejection is contained", async () => {
    const r = await drive({ steps: [rej("ECONNREFUSED")], iterations: 1 });
    assert.strictEqual(r.S.scans, 0);
    assert.strictEqual(r.p.calls, 1);
  });

  it("I-B2: 5 consecutive failures are contained", async () => {
    const r = await drive({ steps: Array(5).fill(rej("ECONNRESET")), iterations: 5 });
    assert.strictEqual(r.S.scans, 0);
    assert.strictEqual(r.p.calls, 5);
  });

  it("I-B3: 10 consecutive failures are contained", async () => {
    const r = await drive({ steps: Array(10).fill(rej("ETIMEDOUT")), iterations: 10 });
    assert.strictEqual(r.S.scans, 0);
    assert.strictEqual(r.p.calls, 10);
  });

  it("I-B4: 100 consecutive failures are contained", async () => {
    const r = await drive({ steps: Array(100).fill(rej("HTTP 500")), iterations: 100 });
    assert.strictEqual(r.S.scans, 0);
    assert.strictEqual(r.p.calls, 100);
  });

  it("I-B5: failure → recovery resumes scanning", async () => {
    const r = await drive({ steps: [rej("down"), ret(5), ret(5), ret(6)], iterations: 4 });
    assert.strictEqual(r.S.scans, 2, "5→scan, 5→dup, 6→scan");
    assert.strictEqual(r.currentBlock, 6);
  });

  it("I-B6: recovery resets backoff", async () => {
    const r = await drive({ steps: [rej("a"), rej("b"), rej("c"), ret(1), rej("d")], iterations: 5, pollIntervalMs: 1, backoffMs: 100 });
    assert.strictEqual(r.sleepDurations[4], 1, "backoff reset to base after recovery");
    assert.ok(r.sleepDurations[4] < r.sleepDurations[2], "reset backoff < escalated backoff");
  });

  it("I-B7: failure does not call scan", async () => {
    const r = await drive({ steps: Array(3).fill(rej("x")), iterations: 3 });
    assert.strictEqual(r.S.scans, 0);
  });

  it("I-B8: failure does not execute", async () => {
    const r = await drive({ steps: Array(3).fill(rej("x")), iterations: 3 });
    assert.strictEqual(r.S.execs, 0);
  });

  it("I-B9: failure does not reserve nonce", async () => {
    const r = await drive({ steps: Array(3).fill(rej("x")), iterations: 3 });
    assert.strictEqual(r.S.nonce, 0);
  });

  it("I-B10: failure does not write nonce journal", async () => {
    const r = await drive({ steps: Array(3).fill(rej("x")), iterations: 3 });
    assert.strictEqual(r.S.journal, 0);
  });

  it("I-B11: failure does not write PnL", async () => {
    const r = await drive({ steps: Array(3).fill(rej("x")), iterations: 3 });
    assert.strictEqual(r.S.pnl, 0);
  });

  it("I-B12: no second polling loop (single while-loop instance)", async () => {
    let currentBlock = 0, scans = 0;
    const p = new P().script(ret(1), ret(2));
    await runHttpPollingLoop({
      provider: p, scan: async () => { scans++; },
      getCurrentBlock: () => currentBlock, setCurrentBlock: (b) => { currentBlock = b; },
      pollIntervalMs: 1, logger: SILENT, sleep: noSleep, backoffMs: 100,
      isDone: stopAfter(2),
    });
    assert.strictEqual(scans, 2);
    assert.strictEqual(currentBlock, 2);
  });

  it("I-B13: max one RPC request in flight", async () => {
    let inflight = 0, maxInflight = 0;
    const p = new P();
    p.getBlockNumber = () => {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      return new Promise((res) => setImmediate(() => { inflight--; res(1); }));
    };
    let currentBlock = 0, scans = 0;
    await runHttpPollingLoop({
      provider: p, scan: async () => { scans++; },
      getCurrentBlock: () => currentBlock, setCurrentBlock: (b) => { currentBlock = b; },
      pollIntervalMs: 0, logger: SILENT, sleep: noSleep, backoffMs: 100,
      isDone: stopAfter(20),
    });
    assert.strictEqual(maxInflight, 1);
  });

  it("I-B14: duplicate block semantics preserved (same block → no duplicate scan)", async () => {
    const r = await drive({ steps: [ret(9), ret(9), ret(9), ret(9)], iterations: 4 });
    assert.strictEqual(r.S.scans, 1);
  });

  it("I-B15: new block triggers exactly one scan", async () => {
    const r = await drive({ steps: [ret(1), ret(2), ret(3)], iterations: 3 });
    assert.strictEqual(r.S.scans, 3);
  });

  it("I-B16: malformed provider result is contained", async () => {
    const r = await drive({ steps: [ret(null), ret(undefined), ret(NaN), ret("x"), ret({}), ret([]), ret(-5)], iterations: 7 });
    assert.strictEqual(r.p.calls, 7, "loop survived all malformed values");
  });

  it("I-B17: provider destruction is contained", async () => {
    const r = await drive({ steps: [thr("provider destroyed"), thr("provider destroyed")], iterations: 2 });
    assert.strictEqual(r.S.scans, 0);
    assert.strictEqual(r.p.calls, 2);
  });

  it("I-B18: permanent RPC failure keeps process alive", async () => {
    const r = await drive({ steps: Array(150).fill(rej("permanently down")), iterations: 150 });
    assert.strictEqual(r.S.scans, 0);
    assert.strictEqual(r.result.pollingFailures, 150);
  });

  it("I-B19: RPC recovery after 100 failures resumes polling", async () => {
    const steps = [...Array(100).fill(rej("down")), ret(7)];
    const r = await drive({ steps, iterations: 101 });
    assert.strictEqual(r.S.scans, 1, "healthy read after 100 failures resumes scan");
    assert.strictEqual(r.currentBlock, 7);
  });

  it("I-B20: a throwing scan is defensively contained (loop survives)", async () => {
    let currentBlock = 0, throws = 0;
    await runHttpPollingLoop({
      provider: new P().script(ret(1), ret(2)),
      scan: async () => { throws++; throw new Error("scan boom"); },
      getCurrentBlock: () => currentBlock, setCurrentBlock: (b) => { currentBlock = b; },
      pollIntervalMs: 1, logger: SILENT, sleep: noSleep, backoffMs: 100,
      isDone: stopAfter(2),
    });
    assert.strictEqual(throws, 2, "scan invoked; loop survived the throws (no crash)");
  });

  it("I-B-REAL-ETHERS: genuine dead-RPC provider rejection is contained", async function () {
    this.timeout(10000);
    const provider = new ethers.JsonRpcProvider("http://127.0.0.1:1", undefined, { staticNetwork: true });
    let currentBlock = 0, scans = 0;
    try {
      const r = await runHttpPollingLoop({
        provider, scan: async () => { scans++; },
        getCurrentBlock: () => currentBlock, setCurrentBlock: (b) => { currentBlock = b; },
        pollIntervalMs: 1, logger: SILENT, sleep: noSleep, backoffMs: 100,
        isDone: stopAfter(2),
      });
      assert.strictEqual(scans, 0, "no scan on a real dead-RPC rejection");
      assert.ok(r.pollingFailures >= 1, "real rejection counted as a polling failure");
    } finally {
      provider.destroy();
    }
  });
});

describe("TASK 4.11-I-C — pollIntervalMs fail-closed validation", function () {
  const rejects = (fn) => { let t = false; try { fn(); } catch (e) { t = true; } return t; };

  it("IC1: absent → 2000", () => assert.strictEqual(resolvePollIntervalMs({}), 2000));
  it("IC2: undefined → 2000", () => assert.strictEqual(resolvePollIntervalMs({ pollIntervalMs: undefined }), 2000));
  it("IC3: valid integer 2000 → 2000", () => assert.strictEqual(resolvePollIntervalMs({ pollIntervalMs: 2000 }), 2000));
  it("IC4: valid minimum 1 → 1", () => assert.strictEqual(resolvePollIntervalMs({ pollIntervalMs: 1 }), 1));
  it("IC5: valid fractional 1.5 → 1.5", () => assert.strictEqual(resolvePollIntervalMs({ pollIntervalMs: 1.5 }), 1.5));
  it("IC6: valid large 30000 → 30000", () => assert.strictEqual(resolvePollIntervalMs({ pollIntervalMs: 30000 }), 30000));
  it("IC7: zero → reject", () => assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: 0 }))));
  it("IC8: negative -1 → reject", () => assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: -1 }))));
  it("IC9: Infinity → reject", () => assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: Infinity }))));
  it("IC10: -Infinity → reject", () => assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: -Infinity }))));
  it("IC11: NaN → reject", () => assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: NaN }))));
  it("IC12: null → reject", () => assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: null }))));
  it("IC13: true → reject", () => assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: true }))));
  it("IC14: false → reject", () => assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: false }))));
  it("IC15: \"2000\" → reject", () => assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: "2000" }))));
  it("IC16: \"\" → reject", () => assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: "" }))));
  it("IC17: [] → reject", () => assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: [] }))));
  it("IC18: {} → reject", () => assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: {} }))));
  it("IC19: 2000n (BigInt) → reject", () => assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: 2000n }))));

  it("IC20: valid backoff formula preserved (base=10, cap=100)", async () => {
    const r = await drive({ steps: Array(5).fill(rej("x")), iterations: 5, pollIntervalMs: 10, backoffMs: 100 });
    assert.deepStrictEqual(r.sleepDurations, [10, 20, 40, 80, 100]);
  });

  it("IC21: reset after success", async () => {
    const r = await drive({ steps: [rej("a"), rej("b"), rej("c"), ret(1), rej("d")], iterations: 5, pollIntervalMs: 10, backoffMs: 100 });
    assert.deepStrictEqual(r.sleepDurations, [10, 20, 40, 10, 10]);
  });

  it("IC22: invalid config cannot start the polling loop with a malformed value", () => {
    // the resolver throws BEFORE runHttpPollingLoop, so the bad value never reaches the loop
    assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: -1 })));
    assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: Infinity })));
    assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: {} })));
    assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: 2000n })));
    // structural: the production call site resolves via resolvePollIntervalMs (no `|| 2000`)
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../../bot/index.js"), "utf8");
    assert.ok(!/pollIntervalMs: config\.bot\.pollIntervalMs \|\| 2000/.test(src), "no truthiness fallback remains at the call site");
  });

  it("IC-adversarial: extra edge values classified per the strict rule", () => {
    // -0 → reject (0 <= 0)
    assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: -0 })));
    // strings → reject
    for (const v of ["1", "0", "-1"]) assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: v })), `string ${v}`);
    // arrays/objects → reject
    assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: [2000] })));
    assert.ok(rejects(() => resolvePollIntervalMs({ pollIntervalMs: { value: 2000 } })));
    // Number.MIN_VALUE / MAX_VALUE are positive finite → accepted per the strict rule
    assert.strictEqual(resolvePollIntervalMs({ pollIntervalMs: Number.MIN_VALUE }), Number.MIN_VALUE);
    assert.strictEqual(resolvePollIntervalMs({ pollIntervalMs: Number.MAX_VALUE }), Number.MAX_VALUE);
  });
});



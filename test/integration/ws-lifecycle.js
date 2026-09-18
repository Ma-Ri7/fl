// TASK 4.11-G-B — WS lifecycle remediation tests (N1–N15 + 20-cycle liveness).
// All sockets are in-process EventEmitter mocks — no network, no live BSC.
"use strict";
const { EventEmitter } = require("events");
const assert = require("assert");
const { createWsLifecycle } = require("../../bot/index");

const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

// ethers-shaped mock: provider exposes .websocket (raw socket EventEmitter)
class MockWsProvider extends EventEmitter {
  constructor() {
    super();
    this.websocket = new EventEmitter();
  }
}
const mkProvider = () => new MockWsProvider();

// builds a lifecycle with an injectable pick queue + tunable delay
function build({ providers, pickErrs = [], delayMs = 10, onBlock = async () => {} } = {}) {
  const pickCalls = { n: 0 };
  const pickWsProvider = async () => {
    const i = pickCalls.n++;
    if (pickErrs[i]) throw pickErrs[i];
    const ws = providers.length ? providers.shift() : mkProvider();
    return { wsProvider: ws, url: `mock://ws-${i + 2}` };
  };
  const lc = createWsLifecycle({ pickWsProvider, onBlock, logger: SILENT, reconnectDelayMs: delayMs });
  return { lc, pickCalls };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("TASK 4.11-G-B — WS lifecycle state machine", function () {
  this.timeout(20000);

  it("N1: single disconnect — ws1 dies, ws2 takes over, scan continues", async () => {
    const ws1 = mkProvider(), ws2 = mkProvider();
    let scans = 0;
    const { lc } = build({ providers: [ws2], onBlock: async () => { scans++; } });
    await lc.start(ws1);
    ws1.emit("block", 100); await wait(15);
    assert.ok(scans >= 1, "scan runs on ws1");
    ws1.websocket.emit("close"); await wait(40); // reconnect delay 10ms
    assert.strictEqual(lc.currentProvider, ws2, "ws2 is current");
    ws2.emit("block", 101); await wait(15);
    assert.ok(scans >= 2, "scan continues on ws2");
    assert.strictEqual(lc.inspect().state, "CONNECTED");
  });

  it("N2: second disconnect — ws1→ws2→ws3, scanning continues", async () => {
    const ws1 = mkProvider(), ws2 = mkProvider(), ws3 = mkProvider();
    const { lc } = build({ providers: [ws2, ws3] });
    await lc.start(ws1);
    ws1.emit("block", 1); await wait(12);
    ws1.websocket.emit("close"); await wait(40);
    ws2.emit("block", 2); await wait(12);
    ws2.websocket.emit("close"); await wait(40);
    assert.strictEqual(lc.currentProvider, ws3, "ws3 is current after 2nd disconnect");
    ws3.emit("block", 3); await wait(12);
    assert.strictEqual(lc.inspect().state, "CONNECTED", "not idle after 2nd disconnect");
  });

  it("N3: 10 disconnect cycles — all functional", async () => {
    const sockets = [mkProvider()]; for (let i = 0; i < 10; i++) sockets.push(mkProvider());
    const { lc } = build({ providers: sockets.slice(1), delayMs: 5 });
    await lc.start(sockets[0]);
    let cur = sockets[0];
    for (let d = 1; d <= 10; d++) {
      cur.emit("block", 1000 + d); await wait(10);
      cur.websocket.emit("close"); await wait(25);
      cur = lc.currentProvider;
      assert.notStrictEqual(cur, undefined, `current after disconnect #${d}`);
      assert.notStrictEqual(cur, null);
    }
    assert.strictEqual(lc.generation, 11, "10 replacements");
    assert.strictEqual(lc.inspect().state, "CONNECTED");
  });

  it("N4: duplicate close ×3 on same socket — ONE reconnect flight, ONE replacement", async () => {
    const ws1 = mkProvider(), ws2 = mkProvider();
    const { lc, pickCalls } = build({ providers: [ws2] });
    await lc.start(ws1);
    ws1.websocket.emit("close"); ws1.websocket.emit("close"); ws1.websocket.emit("close");
    await wait(60);
    assert.strictEqual(pickCalls.n, 1, "exactly one pickWsProvider call");
    assert.strictEqual(lc.currentProvider, ws2, "one replacement");
    assert.strictEqual(lc.inspect().timerPending, false);
  });

  it("N5: error only (no close) — no uncaught crash, reconnect starts", async () => {
    const ws1 = mkProvider(), ws2 = mkProvider();
    const { lc } = build({ providers: [ws2] });
    await lc.start(ws1);
    ws1.websocket.emit("error", new Error("ECONNRESET-sim")); // would previously crash
    await wait(40);
    assert.strictEqual(lc.currentProvider, ws2, "reconnected after error");
    ws2.emit("block", 5); await wait(12);
    assert.strictEqual(lc.inspect().state, "CONNECTED");
  });

  it("N6: close+error+close+error storm — ONE reconnect flight", async () => {
    const ws1 = mkProvider(), ws2 = mkProvider();
    const { lc, pickCalls } = build({ providers: [ws2] });
    await lc.start(ws1);
    ws1.websocket.emit("close"); ws1.websocket.emit("error", new Error("e1"));
    ws1.websocket.emit("close"); ws1.websocket.emit("error", new Error("e2"));
    await wait(60);
    assert.strictEqual(pickCalls.n, 1, "one flight despite 4 failure events");
    assert.strictEqual(lc.currentProvider, ws2);
  });

  it("N7: stale block event — old socket's block ignored after replacement", async () => {
    const ws1 = mkProvider(), ws2 = mkProvider();
    let scans = 0;
    const { lc } = build({ providers: [ws2], onBlock: async () => { scans++; } });
    await lc.start(ws1);
    ws1.emit("block", 1); await wait(12);
    ws1.websocket.emit("close"); await wait(40);
    const before = scans;
    ws1.emit("block", 2); await wait(12); // stale socket fires after ws2 is current
    assert.strictEqual(scans, before, "stale block did NOT trigger scan");
    ws2.emit("block", 3); await wait(12);
    assert.ok(scans > before, "current socket triggers scan");
  });

  it("N8: stale close — old socket's close cannot replace the current one", async () => {
    const ws1 = mkProvider(), ws2 = mkProvider(), ws3 = mkProvider();
    const { lc, pickCalls } = build({ providers: [ws2, ws3] });
    await lc.start(ws1);
    ws1.websocket.emit("close"); await wait(40);
    assert.strictEqual(lc.currentProvider, ws2);
    ws1.websocket.emit("close"); await wait(40); // stale close AFTER ws2 is current
    assert.strictEqual(pickCalls.n, 1, "no second reconnect from stale close");
    assert.strictEqual(lc.currentProvider, ws2, "ws2 untouched");
  });

  it("N9: listener cleanup — old socket 0 active bot listeners + passive guards", async () => {
    const ws1 = mkProvider(), ws2 = mkProvider();
    const { lc, pickCalls } = build({ providers: [ws2] });
    await lc.start(ws1);
    assert.deepStrictEqual(lc.botManagedCount(ws1), { block: 1, close: 1, error: 1 });
    ws1.websocket.emit("close"); await wait(40);
    assert.deepStrictEqual(lc.botManagedCount(ws1), { block: 0, close: 0, error: 0 },
      "old socket: 0 ACTIVE bot listeners");
    assert.strictEqual(ws1.listenerCount("block"), 0, "old socket: no block listener at all");
    assert.strictEqual(ws1.websocket.listenerCount("close"), 1, "passive swallow guard");
    assert.strictEqual(ws1.websocket.listenerCount("error"), 1, "passive swallow guard");
    // passive guards swallow late stale events: no throw, no reconnect, no scan
    ws1.websocket.emit("error", new Error("late-stale")); // must NOT crash
    ws1.websocket.emit("close");                           // must NOT reconnect
    await wait(30);
    assert.strictEqual(lc.currentProvider, ws2, "current socket untouched by stale events");
    assert.strictEqual(pickCalls.n, 1, "stale events triggered no reconnect");
    assert.deepStrictEqual(lc.botManagedCount(ws2), { block: 1, close: 1, error: 1 });
    assert.strictEqual(ws2.listenerCount("block"), 1);
    assert.strictEqual(ws2.websocket.listenerCount("close"), 1);
    assert.strictEqual(ws2.websocket.listenerCount("error"), 1);
  });

  it("N10: reconnect failure — retry scheduled, single chain, no crash", async () => {
    const ws1 = mkProvider(), ws2 = mkProvider();
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });
    const pickCalls = { n: 0 };
    const pickWsProvider = async () => {
      const i = pickCalls.n++;
      if (i === 0) { await gate; throw new Error("conn refused"); } // hold attempt #1 in flight
      return { wsProvider: ws2, url: "mock://ws2" };
    };
    const lc = createWsLifecycle({ pickWsProvider, onBlock: async () => {}, logger: SILENT, reconnectDelayMs: 5 });
    await lc.start(ws1);
    ws1.websocket.emit("close"); await wait(20);
    assert.strictEqual(pickCalls.n, 1, "first (in-flight) attempt made");
    assert.ok(lc.inspect().reconnecting, "single-flight active — no second timer");
    releaseFirst(); // attempt #1 fails now
    await wait(30); // 5ms delay → retry
    assert.strictEqual(pickCalls.n, 2, "exactly ONE retry (no duplicate timers)");
    assert.strictEqual(lc.currentProvider, ws2, "retry recovered");
    assert.strictEqual(lc.inspect().timerPending, false);
  });

  it("N11: 5 repeated reconnect failures — one retry chain, no explosion", async () => {
    const ws1 = mkProvider();
    const errs = [1, 2, 3, 4, 5].map(() => new Error("fail"));
    const { lc, pickCalls } = build({ providers: [mkProvider()], pickErrs: errs, delayMs: 5 });
    await lc.start(ws1);
    ws1.websocket.emit("close");
    await wait(120); // 5 failed attempts × 5ms delay
    const n = pickCalls.n;
    assert.ok(n >= 5, `at least 5 attempts made (got ${n})`);
    await wait(30);
    assert.ok(Math.abs(pickCalls.n - n) <= 2, "no timer explosion — steady single chain");
  });

  it("N12: recovery after multiple failures — ws2/ws3 fail, ws4 succeeds, scanning resumes", async () => {
    const ws1 = mkProvider();
    const ws4 = mkProvider();
    let scans = 0;
    const { lc } = build({
      providers: [ws4], pickErrs: [new Error("f1"), new Error("f2")],
      onBlock: async () => { scans++; }, delayMs: 5,
    });
    await lc.start(ws1);
    ws1.emit("block", 1); await wait(12);
    ws1.websocket.emit("close");
    await wait(80); // two failed attempts + success
    assert.strictEqual(lc.currentProvider, ws4);
    ws4.emit("block", 2); await wait(12);
    assert.ok(scans >= 2, "scanning resumed on ws4");
  });

  it("N13: execution mutex — block/close/error storms cannot run two scans concurrently", async () => {
    const ws1 = mkProvider(), ws2 = mkProvider();
    let executing = false, entries = 0;
    const onBlock = async () => {
      if (executing) return; // mirrors production scan() check-and-set (bot/index.js)
      executing = true;
      entries++;
      await wait(5);
      executing = false;
    };
    const { lc } = build({ providers: [ws2], onBlock, delayMs: 5 });
    await lc.start(ws1);
    for (let i = 0; i < 20; i++) ws1.emit("block", i); // burst
    ws1.websocket.emit("close"); await wait(60);
    for (let i = 0; i < 20; i++) ws2.emit("block", 100 + i); // burst
    await wait(120);
    assert.strictEqual(entries, 2,
      `mutex collapsed 40 block events to ${entries} executions (exactly 1 per burst)`);
  });

  it("N14: nonce safety — WS lifecycle never touches NonceManager/broadcast (structural)", async () => {
    // Runtime: full failure/reconnect cycle drives ONLY the injected callbacks.
    const ws1 = mkProvider(), ws2 = mkProvider();
    let picks = 0, blocks = 0;
    const pickWsProvider = async () => { picks++; return { wsProvider: ws2, url: "mock://ws2" }; };
    const lc = createWsLifecycle({
      pickWsProvider, onBlock: async () => { blocks++; }, logger: SILENT, reconnectDelayMs: 5,
    });
    await lc.start(ws1);
    ws1.websocket.emit("close");
    ws1.websocket.emit("error", new Error("dup"));
    await wait(40);
    ws2.emit("block", 7); await wait(12);
    assert.strictEqual(picks, 1, "one pick per flight — nothing else invoked");
    assert.ok(blocks >= 1, "only onBlock drives scans");
    // Structural proof: the factory body contains no nonce/journal/broadcast surface.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../../bot/index.js"), "utf8");
    const s = src.indexOf("function createWsLifecycle");
    const body = src.slice(s, src.indexOf("\nasync function main", s));
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // strip comments
    for (const forbidden of [
      "sendTransaction", "sendPrivateTx", "sendBundle", "rollback", "releaseDropped",
      "reserve(", "commit(", "recover(", "attachJournal", "NonceManager", "NonceJournal",
      "wallet", "broadcast",
    ]) {
      assert.ok(!code.includes(forbidden), `WS lifecycle must not reference "${forbidden}"`);
    }
  });

  it("N15: journal safety — WS failure/reconnect leaves outstanding record durable + nonce blocked", async () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { NonceManager } = require("../../bot/nonce");
    const { NonceJournal } = require("../../bot/nonce-journal");
    const W = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
    const blind = { getTransactionReceipt: async () => null, getTransaction: async () => null };
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ws-lc-j-"));
    const jp = path.join(d, "nonce-journal.json");
    // outstanding UNKNOWN (tombstone) on nonce 300 — possibly accepted on-chain
    const j0 = new NonceJournal({ path: jp }); j0.bindWallet(W, 56); j0.reserve(300);
    j0.commit(300, { hash: null, channel: "public" });
    const fileBefore = fs.readFileSync(jp, "utf8");
    // WS failure/reconnect cycle around the outstanding record
    const ws1 = mkProvider(), ws2 = mkProvider();
    const { lc } = build({ providers: [ws2], delayMs: 5 });
    await lc.start(ws1);
    ws1.websocket.emit("close"); ws1.websocket.emit("error", new Error("storm"));
    await wait(40);
    assert.strictEqual(lc.currentProvider, ws2, "WS lifecycle recovered");
    assert.strictEqual(fs.readFileSync(jp, "utf8"), fileBefore, "journal file BIT-IDENTICAL");
    // conservative recovery over the same file (reconnect-style re-attach + restart):
    // nonce 300 must STILL be blocked → next reserve is 301
    const mA = new NonceManager({ address: W, getNonce: async () => 300 }, 5);
    await mA.init(); mA.attachJournal(new NonceJournal({ path: jp }));
    await mA.recover(blind);
    assert.strictEqual(await mA.reserve(), 301, "post-cycle: nonce 300 still blocked → 301");
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("TASK 4.11-G-B — Part O: 20-cycle liveness stress", function () {
  this.timeout(30000);
  it("20 disconnect/reconnect cycles — 20 recoveries, no idle, no explosion", async () => {
    const sockets = [mkProvider()]; for (let i = 0; i < 20; i++) sockets.push(mkProvider());
    let scans = 0;
    const { lc, pickCalls } = build({
      providers: sockets.slice(1), delayMs: 5, onBlock: async () => { scans++; },
    });
    await lc.start(sockets[0]);
    let cur = sockets[0];
    for (let d = 1; d <= 20; d++) {
      cur.emit("block", d); await wait(8);       // scan on current socket
      cur.websocket.emit("close");                // disconnect
      await wait(25);                             // reconnect (5ms delay)
      cur = lc.currentProvider;
      assert.notStrictEqual(cur, sockets[d - 1], `recovered after disconnect #${d}`);
      assert.notStrictEqual(cur, null);
    }
    assert.strictEqual(lc.generation, 21, "20 replacements = generation 21");
    assert.strictEqual(pickCalls.n, 20, "exactly 20 picks — one per cycle (single-flight)");
    assert.ok(scans >= 20, `scan continued throughout (${scans})`);
    assert.strictEqual(lc.inspect().state, "CONNECTED", "no permanent idle");
  });
});
describe("TASK 4.11-G-B-C — LOW-1: synchronous rawSock/attach throw containment", function () {
  this.timeout(20000);

  // ethers-shaped provider whose .websocket GETTER throws — the real behavior
  // of a destroyed ethers WebSocketProvider, independently observed in 4.11-G-B-A
  // (node_modules/ethers/.../provider-websocket.js: get websocket() {
  //    if (this.#websocket == null) throw new Error("websocket closed") }).
  const getterThrow = (msg = "websocket closed") => {
    const p = new EventEmitter();
    Object.defineProperty(p, "websocket", { get() { throw new Error(msg); } });
    return p;
  };
  // provider whose listener registration itself throws synchronously
  class AttachThrowProvider extends EventEmitter {
    constructor() { super(); this.websocket = new EventEmitter(); }
    on() { throw new Error("listener attach failure"); }
  }

  // scripted picker: entries are a provider, null, or an Error (throw)
  function buildScript(script, { delayMs = 5, onBlock = async () => {} } = {}) {
    const pickCalls = { n: 0 };
    const pickWsProvider = async () => {
      const i = pickCalls.n++;
      const item = script[Math.min(i, script.length - 1)];
      if (item instanceof Error) throw item;
      return { wsProvider: item, url: item ? `mock://s-${i}` : null };
    };
    const lc = createWsLifecycle({ pickWsProvider, onBlock, logger: SILENT, reconnectDelayMs: delayMs });
    return { lc, pickCalls };
  }

  const waitUntil = async (fn, timeoutMs = 1000, step = 4) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (fn()) return true; await wait(step); }
    return !!fn();
  };

  let unhandled, onUnhandled;
  beforeEach(() => {
    unhandled = [];
    onUnhandled = (e) => unhandled.push(String((e && e.message) || e));
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => { process.removeListener("unhandledRejection", onUnhandled); });

  it("C1: rawSock throws during connect — contained, ONE retry scheduled, no stuck CONNECTING", async () => {
    const ws1 = mkProvider(), good = mkProvider();
    const { lc, pickCalls } = buildScript([getterThrow(), good], { delayMs: 25 });
    await lc.start(ws1);
    ws1.websocket.emit("close");
    // the throwing connect attempt must land in RECONNECT_WAIT with exactly one timer
    const sawRetry = await waitUntil(() => {
      const s = lc.inspect();
      return pickCalls.n >= 1 && s.state === "RECONNECT_WAIT" && s.timerPending === true && s.reconnecting === true;
    }, 900, 3);
    const mid = lc.inspect();
    assert.ok(sawRetry, `one retry scheduled after connect throw (state=${mid.state} timerPending=${mid.timerPending} reconnecting=${mid.reconnecting} picks=${pickCalls.n})`);
    assert.ok(!(mid.state === "CONNECTING" && mid.timerPending === false), "never stuck: CONNECTING without a pending timer");
    assert.strictEqual(unhandled.length, 0, `no unhandled rejection (${unhandled.join(" | ")})`);
    // recoverable: the scheduled retry succeeds
    assert.ok(await waitUntil(() => lc.currentProvider === good), "recovered to good provider");
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.strictEqual(lc.inspect().timerPending, false, "no orphan timer after success");
    assert.strictEqual(lc.inspect().reconnecting, false);
    assert.strictEqual(unhandled.length, 0, "still no unhandled rejection");
  });

  it("C2: retry after rawSock throw succeeds — one current provider, scanning resumes", async () => {
    const ws1 = mkProvider(), good = mkProvider();
    let scans = 0;
    const { lc, pickCalls } = buildScript([getterThrow("websocket closed"), good], {
      delayMs: 5, onBlock: async () => { scans++; },
    });
    await lc.start(ws1);
    ws1.websocket.emit("close");
    assert.ok(await waitUntil(() => lc.currentProvider === good), "attempt#2 (good) became current");
    assert.strictEqual(pickCalls.n, 2, "exactly two attempts (throw + success)");
    // G-B generation semantics PRESERVED (task Part B: do not change them):
    // generation advances monotonically per accepted provider hand-off —
    // gen1 = ws1, gen2 = the rejected socket, gen3 = good. The anti-stale guard
    // relies on object identity + currentAlive, not on the counter value, so a
    // rejected socket never becomes "current alive".
    assert.strictEqual(lc.generation, 3,
      "generation advanced monotonically across hand-offs (gen1 ws1, gen2 rejected, gen3 good)");
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    good.emit("block", 42); await wait(15);
    assert.ok(scans >= 1, "scanning resumed on the current provider");
    assert.deepStrictEqual(lc.botManagedCount(good), { block: 1, close: 1, error: 1 }, "current socket fully attached");
    assert.strictEqual(unhandled.length, 0);
  });

  it("C3: 10 sequential rawSock throws — one timer at a time, no explosion, then recovery", async () => {
    const ws1 = mkProvider(), good = mkProvider();
    const script = []; for (let i = 0; i < 10; i++) script.push(getterThrow(`closed-${i}`));
    script.push(good); // attempt #11 succeeds
    const { lc, pickCalls } = buildScript(script, { delayMs: 5 });
    await lc.start(ws1);
    ws1.websocket.emit("close");
    assert.ok(await waitUntil(() => lc.currentProvider === good, 3000, 5), "recovered after 10 throws");
    await wait(30);
    assert.strictEqual(pickCalls.n, 11, `exactly 11 sequential attempts (got ${pickCalls.n})`);
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.strictEqual(lc.inspect().timerPending, false, "no orphan timer");
    assert.strictEqual(lc.inspect().reconnecting, false);
    assert.strictEqual(unhandled.length, 0, `no unhandled rejection across 10 throws (${unhandled.join(" | ")})`);
    good.emit("block", 7); await wait(10);
    assert.strictEqual(lc.inspect().state, "CONNECTED", "still connected / reconnectable");
  });

  it("C4: rawSock throw + duplicate close/error storm — exactly ONE retry chain", async () => {
    const ws1 = mkProvider(), good = mkProvider();
    const bad = getterThrow("websocket closed");
    const { lc, pickCalls } = buildScript([bad, good], { delayMs: 15 });
    await lc.start(ws1);
    ws1.websocket.emit("close");
    await wait(6); // bad attempt in progress / about to throw
    // NOTE: the rejected provider can never carry a bot 'error' listener — attach()
    // failed BEFORE registration — so `bad.emit("error")` would be an un-handled
    // EventEmitter error (a bare-EventEmitter test artifact, not a lifecycle path).
    // Storm the channels that realistically exist: the dying current socket (ws1)
    // and the rejected provider's 'close' channel (rawSock throws → nothing attached).
    const storm = () => {
      for (let i = 0; i < 50; i++) {
        bad.emit("close");                                    // rejected provider, no listeners
        ws1.websocket.emit("close"); ws1.websocket.emit("error", new Error("dup-old"));
      }
    };
    storm();                       // storm BEFORE the contained throw executes
    await wait(20);                // rejected attempt ran (throw contained → 1 retry scheduled)
    storm();                       // storm AFTER the contained throw
    assert.ok(await waitUntil(() => lc.currentProvider === good), "recovered to good provider");
    await wait(40);
    assert.strictEqual(pickCalls.n, 2, `one retry chain only (got ${pickCalls.n})`);
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.strictEqual(lc.inspect().timerPending, false);
    assert.strictEqual(unhandled.length, 0, `no unhandled rejection (${unhandled.join(" | ")})`);
  });
  it("C5: startup attach rawSock throw — start() contained, one retry, recoverable", async () => {
    const bad = getterThrow("websocket closed");
    const good = mkProvider();
    const { lc, pickCalls } = buildScript([good], { delayMs: 5 });
    let startThrew = null;
    try { await lc.start(bad); } catch (e) { startThrew = e.message; }
    assert.strictEqual(startThrew, null, "start() did NOT propagate the attach exception");
    assert.ok(await waitUntil(() => lc.currentProvider === good), "recovered from startup attach failure");
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.strictEqual(lc.inspect().timerPending, false);
    assert.strictEqual(lc.inspect().reconnecting, false);
    assert.ok(pickCalls.n >= 1, "a retry was actually scheduled and executed");
    assert.strictEqual(unhandled.length, 0, `no unhandled rejection (${unhandled.join(" | ")})`);
  });

  it("C6: websocket getter throws — same safe failure handling (real ethers message)", async () => {
    for (const msg of ["websocket closed", "", "getter exploded"]) {
      const ws1 = mkProvider(), good = mkProvider();
      const { lc } = buildScript([getterThrow(msg), good], { delayMs: 5 });
      await lc.start(ws1);
      ws1.websocket.emit("close");
      assert.ok(await waitUntil(() => lc.currentProvider === good),
        `getter(msg="${msg}") contained + recovered`);
      assert.strictEqual(lc.inspect().state, "CONNECTED");
      assert.strictEqual(unhandled.length, 0, `no unhandled rejection (msg="${msg}")`);
    }
    // rawSock shape must not false-positive on a plain provider (no getter)
    const plain = mkProvider();
    const { lc } = buildScript([plain], { delayMs: 5 });
    const ws1 = mkProvider();
    await lc.start(ws1);
    ws1.websocket.emit("close");
    assert.ok(await waitUntil(() => lc.currentProvider === plain), "plain provider still reconnects normally");
  });

  it("C7: synchronous listener-attach exception — contained, retry scheduled, no stuck state", async () => {
    const ws1 = mkProvider(), good = mkProvider();
    const { lc, pickCalls } = buildScript([new AttachThrowProvider(), good], { delayMs: 25 });
    await lc.start(ws1);
    ws1.websocket.emit("close");
    const sawRetry = await waitUntil(() => {
      const s = lc.inspect();
      return pickCalls.n >= 1 && s.state === "RECONNECT_WAIT" && s.timerPending === true && s.reconnecting === true;
    }, 900, 3);
    assert.ok(sawRetry, `attach throw contained into RECONNECT_WAIT+1 timer (picks=${pickCalls.n})`);
    assert.strictEqual(unhandled.length, 0, `no unhandled rejection (${unhandled.join(" | ")})`);
    assert.ok(await waitUntil(() => lc.currentProvider === good), "recovered from listener-attach failure");
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.strictEqual(lc.inspect().timerPending, false);
    assert.deepStrictEqual(lc.botManagedCount(good), { block: 1, close: 1, error: 1 });
    // startup variant: an attach-throwing provider passed straight to start()
    const { lc: lc2 } = buildScript([mkProvider()], { delayMs: 5 });
    let threw = null;
    try { await lc2.start(new AttachThrowProvider()); } catch (e) { threw = e.message; }
    assert.strictEqual(threw, null, "start() contained the attach exception too");
    assert.ok(await waitUntil(() => lc2.inspect().state !== "CONNECTING" || lc2.inspect().timerPending === true),
      "startup attach-throw did not leave a stuck CONNECTING state");
  });
});

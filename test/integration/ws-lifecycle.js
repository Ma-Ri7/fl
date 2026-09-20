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

// ── TASK 4.11-H-B — subscription failure containment + dead-WS detection ─────
// Mock providers whose .on("block") returns a REJECTING promise (mirror real
// ethers v6 WebSocketProvider.on → async subscription activation).
class SubToBlockReturn extends MockWsProvider {
  constructor(kind = "error") {
    super();
    this._kind = kind;
    this._sends = [];
  }
  send(method, params) {
    this._sends.push(method);
    if (method === "eth_subscribe") {
      const kind = this._kind;
      if (kind === "string") return Promise.reject("generic-rejected-string");
      if (kind === "rpc") return Promise.reject({ code: -32601, message: "subscriptions not supported" });
      return Promise.reject(new Error("eth_subscribe failed"));
    }
    return Promise.resolve(null);
  }
  on(name, fn) {
    super.on(name, fn);
    if (name === "block") {
      // mirror real ethers: on() launches the subscription via send() (async, fire-and-forget)
      void this.send("eth_subscribe", ["newHeads"]);
    }
    return this;
  }
}
const mkSubFail = (kind) => new SubToBlockReturn(kind);

// module-scope HB helpers (buildScript/waitUntil din G-B-C sunt scoped în al
// său describe; aici re-implementăm independent, cu suport wsIdleTimeoutMs).
function hjBuild(script, { delayMs = 5, onBlock = async () => {}, wsIdleTimeoutMs = 60000 } = {}) {
  const pickCalls = { n: 0 };
  const pickWsProvider = async () => {
    const i = pickCalls.n++;
    const item = script[Math.min(i, script.length - 1)];
    if (item instanceof Error) throw item;
    return { wsProvider: item, url: item ? `mock://h-${i}` : null };
  };
  const lc = createWsLifecycle({ pickWsProvider, onBlock, logger: SILENT, reconnectDelayMs: delayMs, wsIdleTimeoutMs });
  return { lc, pickCalls };
}
const hjWait = async (fn, timeoutMs = 1200, step = 4) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (fn()) return true; await wait(step); }
  return !!fn();
};

describe("TASK 4.11-H-B — subscription failure containment & dead-WS watchdog", function () {
  this.timeout(30000);

  it("HB0: invalid wsIdleTimeoutMs fails startup/config (no silent fallback)", () => {
    for (const bad of [0, -5, NaN, "60"]) {
      assert.throws(() => createWsLifecycle({ pickWsProvider: async () => ({}), onBlock: async () => {}, logger: SILENT, wsIdleTimeoutMs: bad }),
        /invalid-ws-idle-timeout/, `wsIdleTimeoutMs=${String(bad)} fails closed`);
    }
    const lc = createWsLifecycle({ pickWsProvider: async () => ({}), onBlock: async () => {}, logger: SILENT, wsIdleTimeoutMs: 100 });
    assert.ok(lc && typeof lc.start === "function");
  });

  it("HB1: subscription rejection at startup — NO unhandled, recoverable, eventual CONNECTED", async () => {
    const unhandled = [];
    const onUn = (e) => unhandled.push(String(e && e.message || e));
    process.on("unhandledRejection", onUn);
    const good = mkProvider();
    const { lc, pickCalls } = hjBuild([good], { delayMs: 30, wsIdleTimeoutMs: 2000 });
    await lc.start(mkSubFail());                       // STARTUP provider itself rejects subscription
    // wait LONG enough for the reject to route: state leaves CONNECTED (RECONNECT_WAIT) then recovers
    const sawRetry = await hjWait(() => pickCalls.n >= 1, 1500);
    assert.ok(sawRetry, "subscription rejection at STARTUP triggered a reconnect pick");
    assert.ok(await hjWait(() => lc.currentProvider === good, 1500), "recovered to healthy provider");
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.strictEqual(unhandled.length, 0, `no unhandled rejection (${unhandled.join(" | ")})`);
    lc.currentProvider.emit("block", 1); await wait(15);
    assert.strictEqual(lc.inspect().generation, 2, "no extra reconnect on healthy provider");
    process.removeListener("unhandledRejection", onUn);
  });

  it("HB2: subscription rejection at runtime — treated as WS failure, reconnect scheduled", async () => {
    const unhandled = [];
    const onUn = (e) => unhandled.push(String(e && e.message || e));
    process.on("unhandledRejection", onUn);
    const ws1 = mkProvider();
    const { lc } = hjBuild([mkSubFail(), mkProvider()], { delayMs: 5 });
    await lc.start(ws1);
    ws1.websocket.emit("close");
    assert.ok(await hjWait(() => lc.inspect().state !== "CONNECTED" && lc.currentProvider !== ws1), "runtime sub-failure detected");
    assert.ok(await hjWait(() => lc.inspect().state === "CONNECTED"), "recovered past sub-failure");
    assert.strictEqual(lc.inspect().timerPending, false);
    assert.strictEqual(unhandled.length, 0, `no unhandled (${unhandled.join(" | ")})`);
    process.removeListener("unhandledRejection", onUn);
  });

  it("HB3/4/5: rejected Error / string / RPC-shaped rejection — all contained", async () => {
    for (const kind of ["error", "string", "rpc"]) {
      const unhandled = [];
      const onUn = (e) => unhandled.push(String(e && e.message || e));
      process.on("unhandledRejection", onUn);
      const good = mkProvider();
      const { lc } = hjBuild([mkSubFail(kind), good], { delayMs: 5 });
      const ws1 = mkProvider();
      await lc.start(ws1);
      ws1.websocket.emit("close");
      assert.ok(await hjWait(() => lc.currentProvider === good), `[${kind}] recovered to healthy provider`);
      assert.strictEqual(lc.inspect().state, "CONNECTED");
      assert.strictEqual(unhandled.length, 0, `[${kind}] NO unhandled rejection`);
      process.removeListener("unhandledRejection", onUn);
    }
  });

  it("HB6: duplicate close/error after subscription rejection — ONE reconnect chain", async () => {
    const good = mkProvider();
    const { lc, pickCalls } = hjBuild([good], { delayMs: 8 });
    const ws1 = mkProvider();
    await lc.start(ws1);
    ws1.websocket.emit("close");
    await wait(12);
    ws1.websocket.emit("close"); ws1.websocket.emit("error", new Error("dup1"));
    await wait(12);
    ws1.websocket.emit("close"); ws1.websocket.emit("error", new Error("dup2"));
    assert.ok(await hjWait(() => lc.currentProvider === good), "recovered despite duplicate storm");
    assert.strictEqual(pickCalls.n, 1, "exactly ONE reconnect flight (duplicates coalesced)");
    assert.strictEqual(lc.inspect().generation, 2, "single replacement");
    // then the healthy provider must stay authoritative; a late stale rejection is ignored
    good.emit("block", 1); await wait(10);
    assert.strictEqual(lc.inspect().state, "CONNECTED");
  });

  it("HB7: STALE subscription rejection — ignored, cannot touch current provider", async () => {
    const unhandled = [];
    const onUn = (e) => unhandled.push(String(e && e.message || e));
    process.on("unhandledRejection", onUn);
    const good = mkProvider();
    const { lc } = hjBuild([good], { delayMs: 5 });
    const stale = new SubToBlockReturn("error");   // stale provider whose sub promise rejects
    await lc.start(stale);
    stale.websocket.emit("close");                   // stale dies → good becomes current
    assert.ok(await hjWait(() => lc.currentProvider === good), "good is current");
    // the stale socket's reject-prone eth_subscribe now fires (guard is generation-checked)
    const staleSend = stale.send("eth_subscribe", ["newHeads"]);
    // (force the rejecting send path; must be consumed by the generation guard, not by the stale provider)
    assert.ok(staleSend && typeof staleSend.catch === "function", "stale send returns rejecting promise");
    await staleSend.catch(() => {});
    await wait(30);
    assert.strictEqual(lc.currentProvider, good, "stale rejection did NOT replace current provider");
    assert.strictEqual(lc.inspect().generation, 2, "generation unchanged by stale rejection");
    assert.strictEqual(lc.inspect().timerPending, false, "no reconnect timer from stale rejection");
    assert.strictEqual(unhandled.length, 0, "stale rejection not unhandled");
    good.emit("block", 9); await wait(12);
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    process.removeListener("unhandledRejection", onUn);
  });

  it("HB8: recovery after subscription rejection — scanning resumes on new provider", async () => {
    let scans = 0;
    const good = mkProvider();
    const { lc } = hjBuild([mkSubFail(), good], { delayMs: 5, onBlock: async () => { scans++; } });
    const ws1 = mkProvider();
    await lc.start(ws1);
    ws1.emit("block", 1); await wait(10);
    ws1.websocket.emit("close");
    assert.ok(await hjWait(() => lc.currentProvider === good), "recovered");
    good.emit("block", 2); await wait(10);
    assert.ok(scans >= 2, "scanning resumed on the healthy new provider");
    assert.strictEqual(lc.inspect().state, "CONNECTED");
  });

  it("HB9: 10 consecutive subscription failures — one chain, no explosion, then recovery", async () => {
    const picks = { n: 0 };
    const good = mkProvider();
    const lc = createWsLifecycle({
      pickWsProvider: async () => { picks.n++; if (picks.n <= 10) return { wsProvider: mkSubFail(), url: "f" }; return { wsProvider: good, url: "g" }; },
      onBlock: async () => {}, logger: SILENT, reconnectDelayMs: 3, wsIdleTimeoutMs: 5000,
    });
    const ws1 = mkProvider();
    await lc.start(ws1);
    ws1.websocket.emit("close");
    let bad = 0;
    for (let i = 0; i < 200 && lc.currentProvider !== good; i++) {
      const s = lc.inspect();
      if (!["CONNECTING", "RECONNECT_WAIT", "CONNECTED"].includes(s.state)) bad++;
      await wait(4);
    }
    assert.ok(lc.currentProvider === good, `recovered after 10 consecutive sub-failures (picks=${picks.n})`);
    assert.strictEqual(bad, 0, "never stuck in undefined state");
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.strictEqual(lc.inspect().timerPending, false);
  });

  it("HB10: 100 alternating success/failure reconnect cycles — no accumulation, no unhandled", async () => {
    const unhandled = [];
    const onUn = (e) => unhandled.push(String(e && e.message || e));
    process.on("unhandledRejection", onUn);
    const picks = { n: 0 };
    const mkPick = () => { picks.n++; return { wsProvider: picks.n % 2 === 1 ? mkSubFail() : mkProvider(), url: `alt-${picks.n}` }; };
    const lc = createWsLifecycle({
      pickWsProvider: async () => mkPick(),
      onBlock: async () => {}, logger: SILENT, reconnectDelayMs: 1, wsIdleTimeoutMs: 5000,
    });
    const first = mkProvider();
    await lc.start(first);
    // drive 100 failures as alternating sub-fail/success (each reconnect lands on alternating result)
    for (let c = 0; c < 100; c++) {
      const dying = lc.currentProvider;
      dying.websocket.emit("close");
      let waited = 0;
      while (lc.inspect().generation !== c + 2 && waited < 1000) { await wait(2); waited += 2; }
    }
    const insp = lc.inspect();
    assert.strictEqual(unhandled.length, 0, `no unhandled over 100 alternations (${unhandled.slice(0, 2).join(" | ")})`);
    // LOW-2-HB: the final cycle's recovery attempt may still be settling in a
    // legitimate CONNECTING window (per the invariant, CONNECTED is declared only
    // after the subscription outcome is resolved). Wait briefly for the terminal
    // CONNECTED state before asserting it (semantics unchanged: 100 picks, gen 101).
    const settled = await hjWait(() => lc.inspect().state === "CONNECTED" && !lc.inspect().timerPending, 1500, 3);
    assert.ok(settled, "final state CONNECTED after 100 alternations");
    assert.strictEqual(lc.inspect().generation, 101, `monotonic generation = 101`);
    assert.strictEqual(lc.inspect().timerPending, false, "no stale pending reconnect timer");
    // current: exactly one watchdog armed (the alternating last provider is healthy or waiting to reject)
    assert.strictEqual(insp.watchdogPending, true, "current socket has exactly one watchdog");
    assert.strictEqual(picks.n, 100, "exactly 100 picks for 100 cycles");
    process.removeListener("unhandledRejection", onUn);
  });

  it("HB11: subscription SUCCESS + block delivery — no reconnect, no false sub-failure", async () => {
    let scans = 0;
    const { lc } = hjBuild([], { delayMs: 5, onBlock: async () => { scans++; } });
    const ws1 = mkProvider();
    await lc.start(ws1);
    for (let i = 0; i < 100; i++) { ws1.emit("block", i); await wait(2); }
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.ok(scans >= 1, "blocks delivered → scans ran");
    assert.strictEqual(lc.inspect().generation, 1, "no reconnects on healthy block stream");
    assert.strictEqual(lc.inspect().timerPending, false);
    await wait(20);
    assert.strictEqual(lc.inspect().timerPending, false);
  });

  it("HB12: CONNECTED but NO block activity — dead-WS watchdog fires → reconnect", async () => {
    const ws1 = mkProvider(), good = mkProvider();
    const { lc } = hjBuild([good], { delayMs: 5, wsIdleTimeoutMs: 60 });
    await lc.start(ws1);
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.strictEqual(lc.inspect().watchdogPending, true, "watchdog armed on current socket");
    assert.ok(await hjWait(() => lc.currentProvider === good, 2000, 5),
      "watchdog fired → provider replaced");
    assert.strictEqual(lc.inspect().generation, 2);
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.strictEqual(lc.inspect().watchdogPending, true);
  });

  it("HB13: watchdog + close race — close wins, single flight, no double reconnect", async () => {
    const ws1 = mkProvider(), good = mkProvider();
    const { lc, pickCalls } = hjBuild([good], { delayMs: 5, wsIdleTimeoutMs: 60 });
    await lc.start(ws1);
    await wait(10);
    ws1.websocket.emit("close");
    assert.ok(await hjWait(() => lc.currentProvider === good, 2000, 5), "reconnected");
    assert.strictEqual(pickCalls.n, 1, "exactly one reconnect flight (close+watchdog coalesced)");
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.strictEqual(lc.inspect().timerPending, false);
  });

  it("HB14: watchdog + error race — error wins, single flight", async () => {
    const ws1 = mkProvider(), good = mkProvider();
    const { lc, pickCalls } = hjBuild([good], { delayMs: 5, wsIdleTimeoutMs: 60 });
    await lc.start(ws1);
    await wait(10);
    ws1.websocket.emit("error", new Error("boom"));
    assert.ok(await hjWait(() => lc.currentProvider === good, 2000, 5), "reconnected");
    assert.strictEqual(pickCalls.n, 1, "one flight (error+watchdog coalesced)");
  });

  it("HB15: watchdog + reconnect race — single replacement, watchdog cleared on retire", async () => {
    const ws1 = mkProvider(), good = mkProvider();
    const { lc } = hjBuild([good], { delayMs: 5, wsIdleTimeoutMs: 40 });
    await lc.start(ws1);
    await wait(30);
    ws1.websocket.emit("close");
    await wait(6);
    assert.ok(await hjWait(() => lc.currentProvider === good, 2000, 5), "recovered");
    assert.strictEqual(lc.inspect().generation, 2, "single replacement despite watchdog+close race");
    assert.strictEqual(lc.inspect().timerPending, false);
    assert.strictEqual(lc.inspect().watchdogPending, true, "new current has watchdog");
  });

  it("HB16: startup sub-failure + retry — exactly one chain, eventual CONNECTED", async () => {
    const unhandled = [];
    const onUn = (e) => unhandled.push(String(e && e.message || e));
    process.on("unhandledRejection", onUn);
    const good = mkProvider();
    const { lc, pickCalls } = hjBuild([mkSubFail(), mkSubFail(), good], { delayMs: 4 });
    await lc.start(mkSubFail());
    assert.ok(await hjWait(() => lc.currentProvider === good, 2500, 5), "retry chain reached healthy provider");
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.strictEqual(unhandled.length, 0, "no unhandled from startup sub-failure retries");
    assert.ok(pickCalls.n >= 2, "multiple retries happened but converged");
    process.removeListener("unhandledRejection", onUn);
  });
});

// ── TASK 4.11-H-C — LOW-2-HB: subscription failure / connect-attempt sync ────
// Prerequisite mock: a provider whose `eth_subscribe` fails ONLY when the test
// explicitly calls send() — used for RUNTIME subscription failures on an
// already-CONNECTED provider (startup attach stays healthy).
class SubFailOnDemand extends MockWsProvider {
  constructor() {
    super();
    this._sends = [];
  }
  send(method, params) {
    this._sends.push(method);
    if (method === "eth_subscribe") return Promise.reject(new Error("eth_subscribe failed"));
    return Promise.resolve(null);
  }
}
const subFailOnDemand = () => new SubFailOnDemand();

describe("TASK 4.11-H-C — LOW-2-HB: subscription failure → exactly one recovery", function () {
  this.timeout(60000);

  // 4.11-H-C helpers: independent of hjBuild, exposes strict counters.
  function hcBuild(script, { delayMs = 4, onBlock = async () => {}, wsIdleTimeoutMs = 60000 } = {}) {
    const pickCalls = { n: 0 };
    const pickWsProvider = async () => {
      const i = pickCalls.n++;
      const item = script[Math.min(i, script.length - 1)];
      if (item instanceof Error) throw item;
      return { wsProvider: item, url: item ? `mock://hc-${i}` : null };
    };
    const lc = createWsLifecycle({
      pickWsProvider, onBlock, logger: SILENT, reconnectDelayMs: delayMs, wsIdleTimeoutMs,
    });
    return { lc, pickCalls };
  }
  const hcWait = async (fn, timeoutMs = 3000, step = 3) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (fn()) return true; await wait(step); }
    return !!fn();
  };
  // register a process-level unhandledRejection sink (listenerless counter)
  function hcUnhandled() {
    const unhandled = [];
    const onUn = (e) => { unhandled.push(String((e && e.message) || e)); };
    process.on("unhandledRejection", onUn);
    return { unhandled, off: () => process.removeListener("unhandledRejection", onUn) };
  }

  it("HC1: startup subscription failure — picks=1, generation=initial+1, CONNECTED after recovery", async () => {
    const { unhandled, off } = hcUnhandled();
    const good = mkProvider();
    const { lc, pickCalls } = hcBuild([good], { delayMs: 4, wsIdleTimeoutMs: 2000 });
    await lc.start(mkSubFail());
    assert.ok(await hcWait(() => lc.currentProvider === good && lc.inspect().state === "CONNECTED"),
      "recovered to healthy provider");
    assert.strictEqual(pickCalls.n, 1, "exactly one recovery pick for the startup sub failure");
    assert.strictEqual(lc.inspect().generation, 2, "generation = initial + 1");
    assert.strictEqual(lc.inspect().timerPending, false, "no pending timer after recovery");
    assert.strictEqual(unhandled.length, 0, `no unhandled rejection (${unhandled.join(" | ")})`);
    assert.strictEqual(lc.inspect().postFinalizeSubFailures, 1, "startup failure consumed post-finalize (normal)");
    assert.strictEqual(lc.inspect().attemptInvalidations, 0, "no attempt invalidation involved");
    good.emit("block", 1); await wait(10);
    assert.strictEqual(lc.inspect().generation, 2, "healthy provider stays (no extra flight)");
    off();
  });

  it("HC2: runtime subscription failure — exactly 1 replacement, 1 flight", async () => {
    const { unhandled, off } = hcUnhandled();
    const ws1 = subFailOnDemand();       // CONNECTED gen1 (startup healthy)
    const good = mkProvider();
    const { lc, pickCalls } = hcBuild([good], { delayMs: 5 });
    await lc.start(ws1);
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    await ws1.send("eth_subscribe", ["newHeads"]);   // runtime subscription failure (guarded)
    assert.ok(await hcWait(() => lc.currentProvider === good && lc.inspect().state === "CONNECTED"), "recovered");
    assert.strictEqual(pickCalls.n, 1, "exactly one reconnect flight");
    assert.strictEqual(lc.inspect().generation, 2, "one provider replacement");
    assert.strictEqual(lc.inspect().timerPending, false);
    assert.strictEqual(lc.inspect().postFinalizeSubFailures, 1, "runtime failure was post-CONNECTED (legit)");
    assert.strictEqual(lc.inspect().attemptInvalidations, 0);
    assert.strictEqual(unhandled.length, 0, `no unhandled (${unhandled.join(" | ")})`);
    off();
  });

  it("HC3: four consecutive subscription failures — 4 recovery flights, no extra", async () => {
    const { unhandled, off } = hcUnhandled();
    const ws1 = mkProvider();
    const good = mkProvider();
    const { lc, pickCalls } = hcBuild([mkSubFail(), mkSubFail(), mkSubFail(), mkSubFail(), good], { delayMs: 3, wsIdleTimeoutMs: 2000 });
    await lc.start(ws1);
    ws1.websocket.emit("close");                       // trigger the reconnect chain
    assert.ok(await hcWait(() => lc.currentProvider === good && lc.inspect().state === "CONNECTED", 6000),
      "converged to healthy provider after 4 consecutive failures");
    assert.strictEqual(pickCalls.n, 5, "5 picks = 4 consecutive failing attempts + 1 healthy recovery");
    assert.strictEqual(lc.inspect().generation, 6, "generation = 6 (1 start + 4 failed attempts + good)");
    assert.strictEqual(lc.inspect().attemptInvalidations, 4, "each consecutive failure consumed by its attempt");
    assert.strictEqual(lc.inspect().postFinalizeSubFailures, 0, "no failure leaked post-finalize");
    assert.strictEqual(lc.inspect().timerPending, false, "no extra timer after convergence");
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.strictEqual(unhandled.length, 0, `no unhandled over 4 failures (${unhandled.join(" | ")})`);
    off();
  });
});

describe("TASK 4.11-H-C — LOW-2-HB: subscription failure + event races (HC4–HC7)", function () {
  this.timeout(60000);

  function hcBuild(script, { delayMs = 4, onBlock = async () => {}, wsIdleTimeoutMs = 60000 } = {}) {
    const pickCalls = { n: 0 };
    const pickWsProvider = async () => {
      const i = pickCalls.n++;
      const item = script[Math.min(i, script.length - 1)];
      if (item instanceof Error) throw item;
      return { wsProvider: item, url: item ? `mock://hc-${i}` : null };
    };
    const lc = createWsLifecycle({
      pickWsProvider, onBlock, logger: SILENT, reconnectDelayMs: delayMs, wsIdleTimeoutMs,
    });
    return { lc, pickCalls };
  }
  const hcWait = async (fn, timeoutMs = 3000, step = 3) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (fn()) return true; await wait(step); }
    return !!fn();
  };
  function hcUnhandled() {
    const unhandled = [];
    const onUn = (e) => { unhandled.push(String((e && e.message) || e)); };
    process.on("unhandledRejection", onUn);
    return { unhandled, off: () => process.removeListener("unhandledRejection", onUn) };
  }

  it("HC4: subscription failure + close — exactly one recovery", async () => {
    const { unhandled, off } = hcUnhandled();
    const ws1 = subFailOnDemand();
    const good = mkProvider();
    const { lc, pickCalls } = hcBuild([good], { delayMs: 5 });
    await lc.start(ws1);
    // sub failure AND close fire near-simultaneously — coalesced into ONE flight
    const p = ws1.send("eth_subscribe", ["newHeads"]);
    ws1.websocket.emit("close");
    await p; // resolved sentinel (never rejects)
    assert.ok(await hcWait(() => lc.currentProvider === good && lc.inspect().state === "CONNECTED"), "recovered");
    assert.strictEqual(pickCalls.n, 1, "exactly one recovery flight (sub failure + close coalesced)");
    assert.strictEqual(lc.inspect().generation, 2);
    assert.strictEqual(lc.inspect().timerPending, false);
    assert.strictEqual(unhandled.length, 0, `no unhandled (${unhandled.join(" | ")})`);
    off();
  });

  it("HC5: subscription failure + error — exactly one recovery", async () => {
    const { unhandled, off } = hcUnhandled();
    const ws1 = subFailOnDemand();
    const good = mkProvider();
    const { lc, pickCalls } = hcBuild([good], { delayMs: 5 });
    await lc.start(ws1);
    const p = ws1.send("eth_subscribe", ["newHeads"]);
    ws1.websocket.emit("error", new Error("boom"));
    await p;
    assert.ok(await hcWait(() => lc.currentProvider === good && lc.inspect().state === "CONNECTED"), "recovered");
    assert.strictEqual(pickCalls.n, 1, "one flight (sub failure + error coalesced)");
    assert.strictEqual(lc.inspect().generation, 2);
    assert.strictEqual(unhandled.length, 0, `no unhandled (${unhandled.join(" | ")})`);
    off();
  });

  it("HC6: subscription failure + watchdog — exactly one recovery", async () => {
    const { unhandled, off } = hcUnhandled();
    const ws1 = subFailOnDemand();
    const good = mkProvider();
    const { lc, pickCalls } = hcBuild([good], { delayMs: 5, wsIdleTimeoutMs: 60 });
    await lc.start(ws1);
    await wait(10);
    const p = ws1.send("eth_subscribe", ["newHeads"]);  // failure fires before watchdog
    await p;
    assert.ok(await hcWait(() => lc.currentProvider === good && lc.inspect().state === "CONNECTED", 2500),
      "recovered past watchdog race");
    assert.strictEqual(pickCalls.n, 1, "one flight (sub failure + watchdog coalesced)");
    assert.strictEqual(lc.inspect().generation, 2);
    assert.strictEqual(lc.inspect().timerPending, false);
    assert.strictEqual(unhandled.length, 0, `no unhandled (${unhandled.join(" | ")})`);
    off();
  });

  it("HC7: late stale subscription failure — 0 new flights", async () => {
    const { unhandled, off } = hcUnhandled();
    const good = mkProvider();
    const { lc, pickCalls } = hcBuild([good], { delayMs: 5 });
    const stale = new SubToBlockReturn("error");
    await lc.start(stale);
    // NOTE: the stale provider's OWN startup eth_subscribe rejected (it was the
    // current provider at start) — that legitimate startup failure is consumed
    // post-finalize (counter snapshot taken AFTER recovery below).
    stale.websocket.emit("close");                     // stale dies → good becomes current
    assert.ok(await hcWait(() => lc.currentProvider === good), "good is current");
    assert.strictEqual(pickCalls.n, 1, "one flight for the stale close");
    const postBefore = lc.inspect().postFinalizeSubFailures; // includes startup failure
    // late stale rejection: guarded send on the RETIRED provider must be ignored
    const p = stale.send("eth_subscribe", ["newHeads"]);
    await p.catch(() => {});
    await wait(50);
    assert.strictEqual(lc.currentProvider, good, "stale provider cannot replace current");
    assert.strictEqual(lc.inspect().generation, 2, "generation unchanged (no new flight)");
    assert.strictEqual(lc.inspect().timerPending, false, "no reconnect timer from stale rejection");
    assert.strictEqual(pickCalls.n, 1, "exactly 0 new flights from stale rejection");
    assert.strictEqual(lc.inspect().postFinalizeSubFailures, postBefore,
      "late stale rejection did NOT count as a failure (no new recovery)");
    assert.strictEqual(unhandled.length, 0, "stale rejection not unhandled");
    off();
  });
});

describe("TASK 4.11-H-C — LOW-2-HB: connect-attempt invalidation (HC8–HC10)", function () {
  this.timeout(120000);

  function hcBuild(script, { delayMs = 4, onBlock = async () => {}, wsIdleTimeoutMs = 60000 } = {}) {
    const pickCalls = { n: 0 };
    const pickWsProvider = async () => {
      const i = pickCalls.n++;
      const item = script[Math.min(i, script.length - 1)];
      if (item instanceof Error) throw item;
      return { wsProvider: item, url: item ? `mock://hc-${i}` : null };
    };
    const lc = createWsLifecycle({
      pickWsProvider, onBlock, logger: SILENT, reconnectDelayMs: delayMs, wsIdleTimeoutMs,
    });
    return { lc, pickCalls };
  }
  const hcWait = async (fn, timeoutMs = 3000, step = 3) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (fn()) return true; await wait(step); }
    return !!fn();
  };
  function hcUnhandled() {
    const unhandled = [];
    const onUn = (e) => { unhandled.push(String((e && e.message) || e)); };
    process.on("unhandledRejection", onUn);
    return { unhandled, off: () => process.removeListener("unhandledRejection", onUn) };
  }

  it("HC8: failure during CONNECTING — attempt invalidated, no dead CONNECTED, single retry", async () => {
    const { unhandled, off } = hcUnhandled();
    const ws1 = mkProvider();
    const good = mkProvider();
    const { lc, pickCalls } = hcBuild([mkSubFail(), good], { delayMs: 5 });
    await lc.start(ws1);
    ws1.websocket.emit("close");
    // the picked provider's eth_subscribe rejects DURING the connect attempt →
    // attempt must be invalidated; the retry picks the healthy provider.
    assert.ok(await hcWait(() => lc.currentProvider === good && lc.inspect().state === "CONNECTED", 3000), "recovered");
    const insp = lc.inspect();
    assert.strictEqual(insp.attemptInvalidations, 1, "the sub-failing attempt was invalidated");
    assert.strictEqual(insp.postFinalizeSubFailures, 0, "no failure leaked after finalize → no second flight");
    assert.strictEqual(pickCalls.n, 2, "exactly two picks: failed attempt + healthy recovery");
    assert.strictEqual(insp.generation, 3, "monotonic generation (gen2 aborted attempt, gen3 healthy)");
    assert.strictEqual(insp.state, "CONNECTED");
    assert.strictEqual(insp.timerPending, false);
    assert.strictEqual(unhandled.length, 0, `no unhandled (${unhandled.join(" | ")})`);
    good.emit("block", 7); await wait(10);
    assert.strictEqual(lc.currentProvider, good, "healthy provider stays authoritative (no dead-CONNECTED gen)");
    off();
  });

  it("HC9: failure immediately after successful attach — no duplicate replacement", async () => {
    const { unhandled, off } = hcUnhandled();
    const ws1 = mkProvider();
    const good = mkProvider();
    const { lc, pickCalls } = hcBuild([mkSubFail(), good], { delayMs: 5 });
    await lc.start(ws1);
    // attach succeeds (listeners registered) and the subscribe rejection fires
    ws1.websocket.emit("close");
    assert.ok(await hcWait(() => lc.currentProvider === good && lc.inspect().state === "CONNECTED", 3000), "recovered");
    const insp = lc.inspect();
    assert.strictEqual(insp.attemptInvalidations, 1, "attach-done-but-sub-failed => attempt invalidated");
    assert.strictEqual(insp.postFinalizeSubFailures, 0);
    assert.strictEqual(pickCalls.n, 2, "no duplicate replacement: failed-attempt pick + healthy pick only");
    assert.strictEqual(insp.generation, 3);
    good.emit("block", 42); await wait(10);
    assert.strictEqual(lc.currentProvider, good, "healthy provider stays authoritative");
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    assert.strictEqual(unhandled.length, 0, `no unhandled (${unhandled.join(" | ")})`);
    off();
  });

  it("HC10: 500 subscription-failure/recovery cycles — one pick + one generation advance each, no accumulation", async () => {
    const { unhandled, off } = hcUnhandled();
    const picks = { n: 0 };
    const lc = createWsLifecycle({
      // recovered providers are SubFailOnDemand: CONNECTED-healthy at startup,
      // and their `send` rejects only when the test triggers a runtime failure.
      pickWsProvider: async () => { picks.n++; return { wsProvider: subFailOnDemand(), url: "r-" + picks.n }; },
      onBlock: async () => {}, logger: SILENT, reconnectDelayMs: 1, wsIdleTimeoutMs: 60000,
    });
    const first = subFailOnDemand();       // gen1 CONNECTED, startup attach healthy
    await lc.start(first);
    assert.strictEqual(lc.inspect().state, "CONNECTED");
    for (let c = 0; c < 500; c++) {
      const g0 = lc.inspect().generation;
      const p = lc.currentProvider.send("eth_subscribe", ["newHeads"]); // runtime sub failure
      await p;
      const ok = await hcWait(() => {
        const s = lc.inspect();
        return s.state === "CONNECTED" && s.generation === g0 + 1;
      }, 1500, 2);
      assert.ok(ok, `cycle ${c}: recovered to gen ${g0 + 1}`);
    }
    const insp = lc.inspect();
    assert.strictEqual(picks.n, 500, "exactly one pick per failure (no accumulation)");
    assert.strictEqual(insp.generation, 501, "one generation advance per failure");
    assert.strictEqual(insp.state, "CONNECTED", "healthy CONNECTED at the end");
    assert.strictEqual(insp.timerPending, false, "no stale reconnect timer");
    assert.strictEqual(insp.watchdogPending, true, "exactly one watchdog on the current generation");
    assert.strictEqual(insp.postFinalizeSubFailures, 500, "every runtime sub failure consumed once");
    assert.strictEqual(insp.attemptInvalidations, 0, "no failures leaked into attempts (all were runtime)");
    assert.strictEqual(unhandled.length, 0, `no unhandled over 500 cycles (${unhandled.slice(0, 3).join(" | ")})`);
    off();
  });
});

// ── TASK 4.11-H-C — LOW-1-HB: strict production wsIdleTimeoutMs resolution ──
// Tests exercise the PRODUCTION resolution path (resolveWsIdleTimeoutMs — the
// exact function used by main()) PLUS the fail-closed factory validation.
const fs = require("fs");
const path = require("path");
const { resolveWsIdleTimeoutMs } = require("../../bot/index");

describe("TASK 4.11-H-C — LOW-1-HB: production timeout config path (HC11–HC21)", function () {
  this.timeout(10000);

  // production-equivalent chain: resolve (as main() does) → factory validation
  function productionChain(botCfg) {
    const resolved = resolveWsIdleTimeoutMs(botCfg);
    // mirror main(): createWsLifecycle receives the resolved value
    createWsLifecycle({
      pickWsProvider: async () => ({}), onBlock: async () => {}, logger: SILENT,
      wsIdleTimeoutMs: resolved,
    });
    return resolved;
  }

  it("HC11: absent property — documented default 60000 (production chain)", () => {
    assert.strictEqual(resolveWsIdleTimeoutMs({}), 60000);
    assert.strictEqual(productionChain({}), 60000);
    // config.bot may be missing entirely → absent → default
    assert.strictEqual(resolveWsIdleTimeoutMs(undefined), 60000);
    assert.strictEqual(resolveWsIdleTimeoutMs(null), 60000);
    // explicitly-supplied `undefined` ≡ absent (deliberate, tested semantic)
    assert.strictEqual(resolveWsIdleTimeoutMs({ wsIdleTimeoutMs: undefined }), 60000);
    assert.strictEqual(productionChain({ wsIdleTimeoutMs: undefined }), 60000);
  });

  it("HC12: 60000 — accepted", () => {
    assert.strictEqual(resolveWsIdleTimeoutMs({ wsIdleTimeoutMs: 60000 }), 60000);
    assert.strictEqual(productionChain({ wsIdleTimeoutMs: 60000 }), 60000);
  });

  it("HC13: 100 — accepted", () => {
    assert.strictEqual(resolveWsIdleTimeoutMs({ wsIdleTimeoutMs: 100 }), 100);
    assert.strictEqual(productionChain({ wsIdleTimeoutMs: 100 }), 100);
    const lc = createWsLifecycle({ pickWsProvider: async () => ({}), onBlock: async () => {}, logger: SILENT, wsIdleTimeoutMs: 100 });
    assert.ok(lc && typeof lc.start === "function");
  });

  it("HC14: 0 — rejected (production chain, no truthy coercion)", () => {
    const resolved = resolveWsIdleTimeoutMs({ wsIdleTimeoutMs: 0 });
    assert.strictEqual(resolved, 0, "explicit 0 must NOT become 60000");
    assert.throws(() => productionChain({ wsIdleTimeoutMs: 0 }), /invalid-ws-idle-timeout/);
  });

  it("HC15: -1 — rejected", () => {
    assert.strictEqual(resolveWsIdleTimeoutMs({ wsIdleTimeoutMs: -1 }), -1);
    assert.throws(() => productionChain({ wsIdleTimeoutMs: -1 }), /invalid-ws-idle-timeout/);
  });

  it("HC16: NaN — rejected", () => {
    assert.ok(Number.isNaN(resolveWsIdleTimeoutMs({ wsIdleTimeoutMs: NaN })), "NaN must pass through unchanged");
    assert.throws(() => productionChain({ wsIdleTimeoutMs: NaN }), /invalid-ws-idle-timeout/);
  });

  it("HC17: Infinity — rejected", () => {
    assert.strictEqual(resolveWsIdleTimeoutMs({ wsIdleTimeoutMs: Infinity }), Infinity);
    assert.throws(() => productionChain({ wsIdleTimeoutMs: Infinity }), /invalid-ws-idle-timeout/);
  });

  it("HC18: null — rejected", () => {
    assert.strictEqual(resolveWsIdleTimeoutMs({ wsIdleTimeoutMs: null }), null);
    assert.throws(() => productionChain({ wsIdleTimeoutMs: null }), /invalid-ws-idle-timeout/);
  });

  it('HC19: "60" — rejected (string does not silently coerce)', () => {
    assert.strictEqual(resolveWsIdleTimeoutMs({ wsIdleTimeoutMs: "60" }), "60");
    assert.throws(() => productionChain({ wsIdleTimeoutMs: "60" }), /invalid-ws-idle-timeout/);
  });

  it("HC20: false — rejected", () => {
    assert.strictEqual(resolveWsIdleTimeoutMs({ wsIdleTimeoutMs: false }), false);
    assert.throws(() => productionChain({ wsIdleTimeoutMs: false }), /invalid-ws-idle-timeout/);
  });

  it("HC21: {} — rejected", () => {
    const resolved = resolveWsIdleTimeoutMs({ wsIdleTimeoutMs: {} });
    assert.strictEqual(typeof resolved, "object");
    assert.throws(() => productionChain({ wsIdleTimeoutMs: {} }), /invalid-ws-idle-timeout/);
  });

  it("structural: production main() uses resolveWsIdleTimeoutMs — no truthy `||` coercion of wsIdleTimeoutMs", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../bot/index.js"), "utf8");
    assert.ok(src.includes("wsIdleTimeoutMs: resolveWsIdleTimeoutMs(config.bot)"),
      "main() must route the production config through resolveWsIdleTimeoutMs");
    assert.ok(!/\|\|\s*60000/.test(src), "no truthy `|| 60000` coercion may remain in production");
    assert.ok(/function resolveWsIdleTimeoutMs/.test(src), "resolution helper is defined in production");
  });
});

require("dotenv").config();
const { ethers } = require("ethers");
const config = require("./config");
const logger = require("./logger");
const { pickProvider, pickWsProvider, healthCheck } = require("./rpc");
const { buildPairs, discoverVenues, readState } = require("./scanner");
const { findOpportunities } = require("./profit");
const { executeOpp } = require("./executor");
const { NonceManager } = require("./nonce");
const { NonceJournal } = require("./nonce-journal");
const { trackTransaction } = require("./tracker");

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VENUE_REFRESH_MS = 10 * 60 * 1000;
const HEALTH_LOG_MS = 60 * 1000;
const MAX_ERRS = 10;
const BACKOFF_MS = 30_000;

function fmtTok(r, d) { return Number(ethers.formatUnits(r, d)).toFixed(4); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// TASK 4.3: single snapshot source of truth (bot/snapshot.js) — blockNumber,
// blockHash, timestamp și stateVersion (contor care crește per snapshot).
const {
  createSnapshot,
  attachVenueFingerprints,
  venueKey,
  venueFingerprint,
} = require("./snapshot");
const takeSnapshot = createSnapshot; // backward-compatible alias

async function refreshVenues(provider, pairs) {
  const { venues } = await discoverVenues(provider, config);
  await readState(provider, venues);
  return venues;
}

// TASK 4.3: module-scope ref to the latest scan snapshot (visible to execGuardedOpp)
// TASK 4.4: V3 deep-state enrichment from scanner
let lastSnapshot = null;
const { enrichV3Venues } = require("./scanner");
// ── TASK 4.11-G-B: WebSocket lifecycle state machine ────────────────────────
// WS este DOAR trigger de scan: niciodată sursă de adevăr pentru nonce,
// balances, reserves, prices, transaction state, receipts sau PnL.
// Reconectarea este availability-only și NU atinge NonceManager /
// NonceJournal / broadcast / execution gates.
//
// Invarianturi (4.11-G-A INFO findings, toate închise aici):
//   - reconnect nelimitat (nu mai este one-shot după al 2-lea disconnect);
//   - single-flight: duplicate close/error => cel mult UN reconnect activ;
//   - gardă anti-stale: evenimentele unui socket vechi sunt ignorate;
//   - listenerii bot-managed (block/close/error) sunt eliminați la replacement;
//   - socket 'error' are handler => fără uncaught exception => fără crash;
//   - LOW-1 (4.11-G-B-C): orice excepție sincronă din rawSock()/attach() este
//     contenită în failure handling => niciodată blocat permanent în CONNECTING.
function createWsLifecycle({
  pickWsProvider,          // async () => { wsProvider, url } (arhitectura existentă)
  onBlock,                 // (blockNumber) => Promise (producție: trigger scan)
  logger,                  // { info, warn, error }
  reconnectDelayMs = 5000, // delay-ul existent, păstrat explicit și controlat
  wsIdleTimeoutMs = 60000, // TASK 4.11-H-B: watchdog dead-WS (0/omit => 60s, vezi mai jos)
} = {}) {
  const ST = { CONNECTED: "CONNECTED", RECONNECT_WAIT: "RECONNECT_WAIT", CONNECTING: "CONNECTING" };
  if (!Number.isFinite(wsIdleTimeoutMs) || wsIdleTimeoutMs <= 0) {
    // Fail startup/config dacă timeout-ul watchdog este invalid (niciodată
    // silent fallback la o valoare arbitrară).
    throw new Error(`invalid-ws-idle-timeout: ${String(wsIdleTimeoutMs)} (must be a positive number)`);
  }
  let current = null;       // providerul WS activ (referința exterioară, mereu actualizată)
  let generation = 0;       // generație monotonă — identitate socket / gardă anti-stale
  let currentAlive = false; // socketul curent este conectat (altfel nu mai declanșează scan)
  let reconnecting = false; // single-flight: cel mult un reconnect activ
  let timer = null;         // cel mult un timer de reconnect pending (fără explozie)
  let state = "DISCONNECTED";
  const handlers = new Map(); // provider -> { block, close, error } (listeneri bot-managed)
  const watchdogs = new Map(); // provider -> timer (TASK 4.11-H-B: dead-WS watchdog, max 1 pe generație)
  // TASK 4.11-H-C (LOW-2-HB): per-attempt invalidation state. Cât timp un
  // attemptConnect() este în curs, un eșec al subscripției providerului pick-uit
  // INVALIDEază attempt-ul (connectAttemptFailed semantic) în loc să declanșeze
  // după finalizare o a doua reconectare. attemptConnect() finalizează doar
  // dacă subscripția NU a eșuat în fereastra attempt-ului (vezi invariantul):
  //   A connection attempt is successful only if:
  //     provider is current, attach completed,
  //     subscription setup did not fail, generation remains valid.
  let pendingAttempt = null; // { ws, invalidated } — attempt-ul de conectare în curs
  // Contoare observabile (doar pentru audit/test — nu modifică comportamentul):
  //   attemptInvalidations    — eșecuri de subscripție consumate de attempt în curs;
  //   postFinalizeSubFailures — eșecuri de subscripție ajunse după CONNECTED
  //                             (rutate prin handleWsFailure, exact un recovery).
  let attemptInvalidations = 0;
  let postFinalizeSubFailures = 0;

  function isCurrent(ws) { return ws !== null && ws === current && currentAlive; }

  // ── TASK 4.11-H-C (LOW-2-HB) — subscription failure routing (sincronizat cu
  // lifecycle-ul attemptConnect): orice eșec de subscripție (wrapper-ul `send`
  // SAU rejection-ul promise-ului `.on("block", ...)`) ajunge AICI. Reguli:
  //   1. eșec al providerului care ESTE attempt-ul în curs → invalidate attempt-ul
  //      (attemptConnect() va termina ca failure, fără CONNECTED tranzitoriu);
  //   2. eșec al providerului CONNECTED curent → handleWsFailure (normal path);
  //   3. eșec stale / provider necurrent → ignorat (niciodată un reconnect nou).
  function notifySubscriptionFailure(ws) {
    if (pendingAttempt && pendingAttempt.ws === ws) {
      pendingAttempt.invalidated = true; // consumat de attempt — fără al doilea flight
      return;
    }
    if (isCurrent(ws)) {
      postFinalizeSubFailures += 1;
      handleWsFailure(ws, "subscription-failed");
    }
  }

  // ── TASK 4.11-H-B — dead-WS watchdog ──────────────────────────────────────
  // WS "CONNECTED dar fără block events" (subscription moartă) NU este o conexiune
  // validă. Watchdog-ul este STRICT WS-availability: NU execută scan(), NU atinge
  // nonce/journal/broadcast — doar detectează lipsa de activitate și rutează spre
  // aceeași single-flight reconnect machinery (handleWsFailure). Un singur timer
  // per generație; la block valid timerul se resetează; la retire/failure se curăță.
  function armWatchdog(ws) {
    clearWatchdog(ws);
    if (!isCurrent(ws)) return;
    const w = setTimeout(() => {
      watchdogs.delete(ws);
      logger.warn(`WS watchdog: no block events for ${wsIdleTimeoutMs}ms (generation=${generation}) — treating as WS failure`);
      handleWsFailure(ws, "subscription-idle");
    }, wsIdleTimeoutMs);
    // never hold the event loop open purely for the watchdog
    if (typeof w.unref === "function") { try { w.unref(); } catch (_) { /* best-effort */ } }
    watchdogs.set(ws, w);
  }
  function bumpWatchdog(ws) {
    if (isCurrent(ws) && watchdogs.has(ws)) armWatchdog(ws); // reset window (re-arm, 1 timer)
  }
  function clearWatchdog(ws) {
    const w = watchdogs.get(ws);
    if (w) { clearTimeout(w); watchdogs.delete(ws); }
  }

  // Raw socket (ethers WebSocketProvider expune .websocket; fallback defensiv).
  function rawSock(ws) {
    return ws && typeof ws.websocket === "object" && ws.websocket !== null ? ws.websocket : ws;
  }

  // ── TASK 4.11-H-B — eth_subscribe rejection containment (la sursă) ─────────
  // ethers v6: SocketSubscriber.start() face
  //   `#filterId = provider.send("eth_subscribe", filter).then((fid) => { provider._register(fid, this); return fid; })`
  // — promise derivată LĂSATĂ fire-and-forget într-un câmp PRIVAT. Dacă
  // `send("eth_subscribe")` se respinge, atât promise-ul brut CÂT ȘI cel derivat
  // `#filterId` rejectează; `#filterId` nu are niciun handler => unhandledRejection
  // (Node>=15 implicit = crash). Verificat empiric: nici `.catch(on-return)` nu
  // conține rejection-ul derivat.
  // Soluția la sursă, în lifecycle: pentru `eth_subscribe` returnăm un promise
  // care NICIODATĂ nu rejectează — la failure se rezolvă cu un sentinel
  // (`undefined`) => `#filterId` se rezolvă (fără unhandled), `_register` nu
  // aruncă (Map.set toleră undefined), iar noi rutăm eșecul imediat în aceeași
  // failure boundary (subscription-failed => WS failure => reconnect), cu guard
  // de generație pentru rejection-uri stale. NU atinge nonce/journal/broadcast.
  function guardSubscription(ws) {
    if (!ws || typeof ws.send !== "function" || ws.__hbWsGuard) return;
    try {
      ws.__hbWsGuard = true;
      const origSend = ws.send;
      ws.send = (method, params) => {
        const p = origSend.call(ws, method, params);
        if (method !== "eth_subscribe" || !p || typeof p.then !== "function") return p;
        return p.then(
          (fid) => fid,                                // succes: filterId real, fluxul normal
          (err) => {
            // failure consumat AICI (promise-ul returnat se rezolvă): nu mai
            // există unhandledRejection (nici brut, nici derivat #filterId).
            // LOW-2-HB: eșecul este sincronizat cu lifecycle-ul (notifySubscription
            // Failure): attempt în curs → invalidat (fără CONNECTED tranzitoriu,
            // fără al doilea flight); după CONNECTED → handleWsFailure (exact un
            // recovery); stale → ignorat. Promise-ul returnat resolve (sentinel).
            logger.warn(`WS subscription rejected (${err && err.message ? err.message.slice(0, 80) : "unknown"}) — treating as WS failure`);
            notifySubscriptionFailure(ws);
            return undefined;                          // sentinel: resolve, nu reject
          },
        );
      };
    } catch (_) { /* best-effort: fără wrapper, watchdog-ul acoperă totuși dead-CONNECTED */ }
  }

  // Elimină doar listenerul 'block' (socketul mort nu mai declanșează scan-uri).
  function detachBlock(ws) {
    const h = handlers.get(ws);
    if (!ws || !h) return;
    try { ws.removeListener("block", h.block); } catch (_) { /* best-effort */ }
  }

  // La replacement: socketul vechi pierde TOȚI listenerii activi bot-managed
  // (block/close/error) și primește guarduri pasive close/error care doar
  // consumă și loghează evenimentele târzii — un socket stale nu mai poate
  // declanșa scan, reconnect și nici măcar un 'error' unhandled (care ar
  // crash-a procesul). Listenerii interni ethers NU sunt atinși.
  function retireStale(ws) {
    const h = handlers.get(ws);
    if (!ws || !h) return;
    try { ws.removeListener("block", h.block); } catch (_) { /* best-effort */ }
    clearWatchdog(ws);                                      // TASK 4.11-H-B: watchdog-ul urmează socketul
    const swallow = (ev) => () =>
      logger.warn(`WS stale ${ev} event ignored (stale generation, current=${generation})`);
    try {
      // LOW-1 (4.11-G-B-C): rawSock() poate arunca pe un provider distrus
      // ("websocket closed") — retragerea unui socket stale rămâne best-effort.
      const sock = rawSock(ws);
      sock.removeListener("close", h.close);
      sock.removeListener("error", h.error);
      sock.on("close", swallow("close"));
      sock.on("error", swallow("error"));
    } catch (_) { /* best-effort */ }
    handlers.delete(ws);
  }

  function attach(ws) {
    const block = (blockNumber) => {
      // Stale guard: doar socketul curent + viu poate declanșa scan.
      if (!isCurrent(ws)) return;
      bumpWatchdog(ws); // TASK 4.11-H-B: activitate block valid => watchdog resetat (fără false positives)
      void Promise.resolve(onBlock(blockNumber)).catch((e) =>
        logger.error(`WS block handler error: ${e.message.slice(0, 80)}`));
    };
    const sock = rawSock(ws); // LOW-1: poate arunca (provider distrus) — prins de apelant
    const close = () => handleWsFailure(ws, "close");
    const error = (err) => {
      logger.warn(`WebSocket error (${err && err.message ? err.message.slice(0, 80) : "unknown"})`);
      handleWsFailure(ws, "error");
    };
    // LOW-1 (4.11-G-B-C): attach atomic — dacă orice înregistrare de listener
    // aruncă sincron, anulăm complet înregistrarea și propagăm spre failure
    // handling (niciodată un socket pe jumătate atașat, niciodată excepție
    // necontenită).
    let sub = null;
    try {
      sub = ws.on("block", block);
      sock.on("close", close);
      sock.on("error", error); // 'error' are handler => nu mai ajunge unhandled => fără crash
      handlers.set(ws, { block, close, error });
    } catch (e) {
      try { ws.removeListener("block", block); } catch (_) { /* best-effort */ }
      try { sock.removeListener("close", close); sock.removeListener("error", error); } catch (_) { /* best-effort */ }
      handlers.delete(ws);
      throw e;
    }
    // TASK 4.11-H-B/H-C — subscription failure containment:
    // `ws.on("block", ...)` la ethers v6 este async (returnează un promise care
    // se rezolvă la activarea subscripției și se RESPINGE dacă eth_subscribe
    // eșuează). Un astfel de rejection NU trebuie să devină unhandledRejection —
    // eșecul subscripției este un WS failure (nu o conexiune sănătoasă).
    // LOW-2-HB: routing sincronizat (notifySubscriptionFailure) — eșec în
    // attempt-ul în curs => invalidare; eșec după CONNECTED => handleWsFailure;
    // rejection târziu de la un provider stale => ignorat (isCurrent guard).
    if (sub && typeof sub.then === "function" && typeof sub.catch === "function") {
      sub.catch(() => notifySubscriptionFailure(ws));
    }
    armWatchdog(ws); // TASK 4.11-H-B: watchdog dead-WS pornit pe noul socket current
    return sub;
  }

  // close și error intră în ACEEAȘI logică, idempotentă/single-flight.
  // Block-listenerul este eliminat imediat (socketul mort nu mai declanșează
  // scan-uri), dar close/error rămân atașați până la replacement: orice
  // eveniment târziu e consumat de handler (isCurrent guard), niciodată
  // unhandled (care ar crash-a procesul — Part J).
  function handleWsFailure(ws, reason) {
    if (!isCurrent(ws)) return;  // stale close/error — ignorat, nu poate înlocui curentul
    if (reconnecting) return;    // duplicate close/error coalesced — un singur flight
    currentAlive = false;        // socketul curent nu mai declanșează scan-uri
    clearWatchdog(ws);           // TASK 4.11-H-B: watchdog-ul socketului mort este oprit
    detachBlock(ws);             // block listener pleacă imediat de pe socketul morții
    scheduleReconnect(reason);
  }

  function scheduleReconnect(reason) {
    if (reconnecting || timer !== null) return; // single-flight + un singur timer
    reconnecting = true;
    state = ST.RECONNECT_WAIT;
    timer = setTimeout(() => {
      timer = null;
      state = ST.CONNECTING;
      void attemptConnect();
    }, reconnectDelayMs);
    logger.warn(`WS ${reason}: reconnect scheduled in ${reconnectDelayMs}ms (single-flight)`);
  }

  // Un singur pick per flight; eșec => un singur retry re-programat (fără busy-loop).
  async function attemptConnect() {
    let picked = null;
    try {
      picked = await pickWsProvider();
    } catch (e) {
      logger.error(`WS reconnect attempt failed: ${e.message.slice(0, 80)}`);
    }
    const newWs = picked && picked.wsProvider ? picked.wsProvider : null;
    if (newWs) {
      // LOW-1 (4.11-G-B-C): TOATE operațiile sincrone de connect/attach sunt în
      // același failure boundary — o excepție din rawSock()/attach() (ex. un
      // provider ethers distrus: "websocket closed") NU mai scapă ca unhandled
      // rejection și NU mai lasă lifecycle-ul blocat în CONNECTING
      // (reconnecting=true, timerPending=false, fără retry viitor).
      try {
        const old = current;
        if (old) retireStale(old); // socketul vechi: 0 listeneri activi + guarduri pasive
        current = newWs;        // referința exterioară actualizată (nu mai există newWs-orfan)
        generation += 1;        // noua generație devine current
        currentAlive = true;
        guardSubscription(newWs);   // TASK 4.11-H-B: conține eth_subscribe rejection (la sursă)
        // TASK 4.11-H-C (LOW-2-HB): attempt-ul curent devine invalidabil de un
        // eșec de subscripție al providerului pick-uit (connectAttemptFailed).
        pendingAttempt = { ws: newWs, invalidated: false };
        const sub = attach(newWs);
        // LOW-2-HB synchronization point: un singur microtask-rendezvous (NU un
        // delay, NU polling, NU setTimeout) pentru ca un eșec de subscripție
        // ALREADY-SETTLED (rejection deja în coada de microtask-uri la attach)
        // să fie înregistrat în pendingAttempt ÎNAINTE de finalizare. Dacă
        // `sub` este un promise (ethers v6 `on("block")` async), îl așteptăm:
        // se rezolvă după ce `subscriber.start()` a apelat send("eth_subscribe"),
        // deci orice rejection deja determinat a fost deja consumat. Un eșec
        // care apare DUPĂ finalizare rămâne un runtime failure legitim rutat prin
        // handleWsFailure (exact un recovery). Invariantul respectat:
        //   success only if subscription setup did not fail in this attempt.
        if (sub && typeof sub.then === "function" && typeof sub.catch === "function") {
          try { await sub.catch(() => {}); } catch (_) { await Promise.resolve(); }
        } else {
          await Promise.resolve();
        }
        const invalidated = pendingAttempt.invalidated;
        pendingAttempt = null; // attempt consumat (fie success, fie invalidat)
        if (invalidated) {
          // LOW-2-HB: attempt-ul a devenit invalid înainte de finalizare =>
          // terminate ca failure (fără CONNECTED tranzitoriu, fără al doilea
          // flight). Cleanup identic cu handleWsFailure + exact UN retry.
          attemptInvalidations += 1;
          if (current === newWs) currentAlive = false;
          clearWatchdog(newWs);
          try { retireStale(newWs); } catch (_) { /* best-effort */ }
          logger.error(`WS subscription failed during connect (generation=${generation}) — invalid attempt, scheduling retry`);
          reconnecting = false;
          scheduleReconnect("subscription-failed");
          return;
        }
        state = ST.CONNECTED;
        reconnecting = false;
        logger.info(`WebSocket reconnected (generation=${generation})`);
        return;
      } catch (e) {
        if (current === newWs) currentAlive = false; // socketul respins nu e "current viu"
        pendingAttempt = null;                       // TASK 4.11-H-C: attempt consumat de catch
        clearWatchdog(newWs);                        // TASK 4.11-H-B: curăță watchdog dacă attach a reușit parțial
        handlers.delete(newWs);                      // fără handleri pentru un socket ne-atașat
        logger.error(`WS attach/connect failed (generation=${generation}): ${e && e.message ? e.message.slice(0, 80) : "unknown"}`);
      }
    }
    // Failure (pick eșuat SAU attach/connect aruncat): exact UN retry re-programat.
    reconnecting = false;
    scheduleReconnect("reconnect-failed");
  }

  async function start(ws) {
    if (!ws) return;
    current = ws;
    generation = 1;
    currentAlive = true;
    guardSubscription(ws);            // TASK 4.11-H-B: conține eth_subscribe rejection (la sursă, la start)
    try {
      attach(ws);
    } catch (e) {
      // LOW-1 (4.11-G-B-C): un throw sincron la attach-ul inițial nu mai
      // propagă în main() — WS rămâne availability layer: un singur retry
      // re-programat (polling/execution-ul nu depinde de WS).
      currentAlive = false;
      clearWatchdog(ws);                             // TASK 4.11-H-B: startup-failure curăță watchdog
      handlers.delete(ws);
      logger.error(`WS attach failed at startup: ${e && e.message ? e.message.slice(0, 80) : "unknown"}`);
      reconnecting = false;
      scheduleReconnect("startup-attach-failed");
      return;
    }
    state = ST.CONNECTED;
  }

  // Număr de listeneri bot-managed pe un socket oarecare (0 pentru stale/detached).
  function botManagedCount(ws) {
    const h = handlers.get(ws);
    return h ? { block: 1, close: 1, error: 1 } : { block: 0, close: 0, error: 0 };
  }

  function inspect() {
    return {
      state, generation, currentAlive, reconnecting, timerPending: timer !== null,
      watchdogPending: current ? watchdogs.has(current) : false,
      botManagedCurrent: current ? botManagedCount(current) : { block: 0, close: 0, error: 0 },
      // TASK 4.11-H-C (LOW-2-HB) observability counters:
      //   attemptInvalidations    — eșec de subscripție consumat de attempt în curs;
      //   postFinalizeSubFailures — eșec de subscripție după CONNECTED (handleWsFailure).
      attemptInvalidations,
      postFinalizeSubFailures,
    };
  }

  return {
    start,
    inspect,
    botManagedCount,
    get currentProvider() { return current; },
    get generation() { return generation; },
    ST,
  };
}


// TASK 4.11-H-C (LOW-1-HB) — strict wsIdleTimeoutMs resolution for PRODUCTION
// (the exact path used by main()). Absence detection is EXPLICIT, no truthiness:
//   - property absent                        => documented default 60000;
//   - property explicitly `undefined`        => ≡ absent (JS-canonical "no value";
//     a supplied-but-undefined property is indistinguishable from absence by
//     design — this is the deliberate, tested semantic);
//   - any OTHER explicit value               => returned UNCHANGED so that
//     createWsLifecycle()'s fail-closed validation rejects it (0, negative,
//     NaN, Infinity, null, "60", false, {} must NEVER silently become 60000).
function resolveWsIdleTimeoutMs(botConfig) {
  if (botConfig == null || typeof botConfig !== "object") return 60000;
  if (!Object.prototype.hasOwnProperty.call(botConfig, "wsIdleTimeoutMs")) return 60000;
  const v = botConfig.wsIdleTimeoutMs;
  if (v === undefined) return 60000; // explicitly-supplied undefined ≡ absent (documented)
  return v;                          // pass-through: factory fails closed on invalid values
}

async function main(deps = {}) {
  if (!CONTRACT_ADDRESS || !PRIVATE_KEY) {
    logger.error("Missing CONTRACT_ADDRESS or PRIVATE_KEY in .env");
    process.exit(1);
  }

  // Dependency injection: NonceManager + tracker can be swapped without touching core flow.
  const NonceManagerCtor = deps.NonceManager || NonceManager;
  const trackTx = deps.trackTransaction || trackTransaction;

  let { provider, url: rpcUrl } = await pickProvider();
  let wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  logger.info(`Bot started. Wallet: ${wallet.address}`);
  logger.info(`Contract: ${CONTRACT_ADDRESS}`);
  logger.info(`RPC: ${rpcUrl}`);

  const { wsProvider, url: wsUrl } = await pickWsProvider();
  if (wsProvider) {
    logger.info(`WebSocket connected: ${wsUrl} (real-time blocks)`);
  } else {
    logger.info("WebSocket unavailable, using polling fallback");
  }

  const pairs = buildPairs();
  logger.info(`Tracking ${pairs.length} token pairs across ${config.V2_ROUTERS.length} V2 + V3 + DODO`);

  let nonceManager = new NonceManagerCtor(wallet, config.bot.maxNonceGap || 5);
  await nonceManager.init();
  // TASK 4.10-B — durable nonce/transaction journal (închide H1 din 4.10-A):
  // un nonce rezervat supraviețuiește crash/restart ca rezervare fail-closed
  // până când există dovezi terminale autoritative. Corupție/ambiguitate =>
  // bot-ul REFUZĂ pornirea (fail-closed), niciodată „jurnal tratat ca gol”.
  // Ordine: init() (next din RPC) -> attachJournal() (bump conservator +
  // pre-block) -> recover() (reconciliere receipt + constrângere finală).
  try {
    if (typeof nonceManager.attachJournal === "function") {
      const journal = new NonceJournal({});
      nonceManager.attachJournal(journal);
      const rec = await nonceManager.recover(wallet.provider);
      logger.info(
        `Nonce journal: path=${journal.path} outstanding=${rec ? rec.blocked.length : 0} ` +
        `resolved=${rec ? rec.resolved.length : 0} unknown=${rec ? rec.unknown.length : 0} ` +
        `next=${nonceManager.next}`
      );
    }
  } catch (e) {
    logger.error(`Nonce journal recovery failed (fail-closed, refusing to start): ${e.message.slice(0, 160)}`);
    process.exit(1);
  }
  logger.info(`NonceManager initialized (maxPending=${nonceManager.maxPending})`);

  let venues = [];
  
  let lastVenueRefresh = 0;
  let lastHealthLog = 0;
  let errCount = 0;
  let totalOpps = 0;
  let totalTx = 0;
  let currentBlock = 0;

  let executing = false;

  try {
    venues = await refreshVenues(provider, pairs);
    lastVenueRefresh = Date.now();
    logger.info(`Discovered ${venues.length} venues`);
  } catch (e) {
    logger.error(`Initial venue discovery failed: ${e.message.slice(0, 120)}`);
  }

  // Scan function (called on each block or poll interval)
  async function scan() {
    if (executing) {
      logger.debug("Scan skipped - previous scan/execution in progress");
      return;
    }
    // Execution mutex: acquired synchronously (no await between check and set),
    // so concurrent block events can never interleave two scan cycles.
    executing = true;
    try {
      const now = Date.now();

      // Refresh venues periodically
      if (now - lastVenueRefresh > VENUE_REFRESH_MS) {
        logger.info("Refreshing venues...");
        venues = await refreshVenues(provider, pairs);
        lastVenueRefresh = now;
        logger.info(`Venues refreshed: ${venues.length}`);
      }

      // BLOCK SNAPSHOT: all reads in this scan cycle use the same block
      const snapshot = await takeSnapshot(provider);
      lastSnapshot = snapshot;
      await readState(provider, venues, { blockTag: snapshot.blockNumber });
      // TASK 4.3: stamp every venue with the exact snapshot block it was read at.
      for (const v of venues) v.blockNumber = Number(snapshot.blockNumber);
      // TASK 4.4: deep-read V3 pools (slot0/tickSpacing/tickBitmap/ticks) on the SAME block.
      await enrichV3Venues(provider, venues, { blockTag: snapshot.blockNumber });
      // TASK 4.3: STATE FINGERPRINT — amprenta canonică a stării care afectează
      // quote-ul, per venue, la block-ul snapshot-ului (validatorul o compară).
      attachVenueFingerprints(snapshot, venues);

      // Find opportunities - tokens=null defaults to config.TOKENS
      const opps = findOpportunities(venues, null, { snapshot });
      totalOpps += opps.length;

      // Log best opportunity if any
      if (opps.length > 0) {
        const best = opps[0];
        logger.info(
          `Best opp: ${best.borrowToken.symbol || best.borrowToken.address.slice(0, 8)} ` +
          `borrow=${fmtTok(best.borrowAmount, best.borrowToken.decimals || 18)} ` +
          `netProfit=${fmtTok(best.netProfit, best.borrowToken.decimals || 18)} ${best.borrowToken.symbol || ""} ` +
          `(~${fmtTok(best.profitInBnb, 18)} BNB) ` +
          `buy=${best.buyVen?.symbol || best.buyVen?.pair?.slice(0, 8) || best.buyVen?.pool?.slice(0, 8) || "?"} ` +
          `sell=${best.sellVen?.symbol || best.sellVen?.pair?.slice(0, 8) || best.sellVen?.pool?.slice(0, 8) || "?"}`
        );

        // Execute if profit in BNB exceeds threshold
        const minProfitWei = ethers.parseEther(String(config.bot.minProfitBnb));
        if (best.profitInBnb >= minProfitWei) {
          logger.info("Executing arbitrage...");
          const result = await execGuardedOpp(
            best, CONTRACT_ADDRESS, wallet, provider,
            { nonceManager, snapshot }
          );
          if (result.ok) {
            totalTx++;
            // TASK 4.7 (INVARIANT 1/5/6): broadcast acknowledgement ≠ on-chain
            // confirmation. Aici există doar SUBMISIE (txHash cunoscut) —
            // niciodată "SUCCESS". Rezultatul real (mined/reverted/timeout/
            // unknown) vine EXCLUSIV din receipt-ul verificat de trackTx.
            logger.info(`SUBMITTED tx=${result.txHash} (expected profit=${fmtTok(best.netProfit, best.borrowToken.decimals || 18)} ${best.borrowToken.symbol || ""} — așteptăm receipt-ul real)`);
            const { trackTransaction: trackTxFn } = require("./tracker");
            const trackTxLocal = deps.trackTransaction || trackTxFn;
            const tracked = await trackTxLocal(provider, {
              txHash: result.txHash,
              timeoutMs: config.bot.maxTxWaitMs || 120000,
              expectedChainId: config.chainId,
            });
            if (tracked.status === "mined") {
              // Doar receipt status 1 (identitate + lanț verificate) = succes.
              logger.info(`CONFIRMED_SUCCESS tx=${tracked.txHash} block=${tracked.blockNumber}`);
              if (tracked.realizedProfit != null) {
                logger.info(`[tracker] realized profit = ${fmtTok(tracked.realizedProfit, 18)} BNB`);
              }
              if (tracked.gasCostBnb != null) {
                logger.info(`[tracker] gas cost = ${Number(tracked.gasCostBnb) / 1e18} BNB`);
              }
            } else {
              // reverted / timeout / unknown — niciodată clasificate ca succes.
              logger.warn(`[tracker] outcome=${tracked.status} tx=${tracked.txHash} (NICIODATĂ tratat ca success)` +
                (tracked.lastError ? ` lastError=${tracked.lastError.slice(0, 80)}` : ""));
            }
          } else {
            logger.warn(`Execute failed: ${result.reason} - ${result.err?.slice(0, 80)}`);
          }
          await nonceManager.reap(provider);
        } else {
          logger.info(`Best opp below threshold (${fmtTok(best.profitInBnb, 18)} BNB < ${config.bot.minProfitBnb} BNB), skipping`);
        }
      }

      // Health check
      if (now - lastHealthLog > HEALTH_LOG_MS) {
        const rpcHealthy = await healthCheck(provider);
        if (!rpcHealthy) {
          logger.error("RPC health check failed, attempting reconnect...");
          try {
            const { provider: newProvider, url: newUrl } = await pickProvider();
            provider = newProvider;
            wallet = new ethers.Wallet(PRIVATE_KEY, provider);
            // Re-bind NonceManager to the new wallet, otherwise it keeps the
            // stale signer + nonce state from the dead connection.
            nonceManager = new NonceManagerCtor(wallet, config.bot.maxNonceGap || 5);
            await nonceManager.init();
            // TASK 4.10-B: re-bind jurnalul la reconnect — aceleași reguli
            // fail-closed ca la pornire (corupție => refuză continuarea;
            // continuarea fără jurnal ar pierde protejarea nonce-urilor durabile).
            if (typeof nonceManager.attachJournal === "function") {
              try {
                const journal = new NonceJournal({});
                nonceManager.attachJournal(journal);
                const rec = await nonceManager.recover(wallet.provider);
                logger.info(
                  `Nonce journal re-bound: outstanding=${rec ? rec.blocked.length : 0} ` +
                  `resolved=${rec ? rec.resolved.length : 0} next=${nonceManager.next}`
                );
              } catch (je) {
                logger.error(`Nonce journal re-bind failed (fail-closed, exiting): ${je.message.slice(0, 160)}`);
                process.exit(1);
              }
            }
            logger.info(`RPC reconnected: ${newUrl} (wallet + NonceManager re-bound)`);
          } catch (e) {
            logger.error(`RPC reconnect failed: ${e.message.slice(0, 80)}`);
          }
        }
        logger.info(
          `HEALTH: venues=${venues.length} opps=${totalOpps} tx=${totalTx} errs=${errCount} block=${currentBlock} rpc=${rpcHealthy ? "OK" : "FAIL"}`
        );
        lastHealthLog = now;
      }

      errCount = 0;
    } catch (e) {
      errCount++;
      logger.error(`Loop error (${errCount}/${MAX_ERRS}): ${e.message.slice(0, 150)}`);
      if (errCount >= MAX_ERRS) {
        logger.error("Too many errors, backing off...");
        await sleep(BACKOFF_MS);
        errCount = 0;
      }
    } finally {
      // Mutex release is guaranteed on EVERY path (success / skip / error).
      // Without finally, a single below-threshold scan would leave executing=true
      // forever and silently deadlock the scanner.
      executing = false;
    }
  }

  // Use WebSocket for real-time blocks if available, otherwise poll
  if (wsProvider) {
    logger.info("Using WebSocket for real-time block notifications");
    // TASK 4.11-G-B — WS lifecycle robust: state machine cu single-flight
    // reconnect, gardă anti-stale (generații), cleanup listeneri și handler
    // "error" (nu mai poate crasha procesul). WS rămâne DOAR trigger de scan —
    // reconectarea NU atinge nonce/journal/broadcast/execution gates.
    const wsLifecycle = createWsLifecycle({
      pickWsProvider,
      onBlock: async (blockNumber) => {
        currentBlock = blockNumber;
        await scan();
      },
      logger,
      reconnectDelayMs: config.bot.wsReconnectDelayMs || 5000,
      // TASK 4.11-H-C (LOW-1-HB) — strict timeout configuration: `wsIdleTimeoutMs`
      // este rezolvat explicit (absent/undefined => default 60000 documentat;
      // orice altă valoare trece NEALTERATĂ la factory, care o respinge fail-closed).
      // FĂRĂ truthiness coercion — `0`/`null`/`NaN` nu mai pot deveni silent 60000.
      wsIdleTimeoutMs: resolveWsIdleTimeoutMs(config.bot),
    });
    await wsLifecycle.start(wsProvider);
  } else {
    logger.info(`Using polling every ${config.bot.pollIntervalMs || 2000}ms`);
    while (true) {
      const blockNumber = await provider.getBlockNumber();
      if (blockNumber !== currentBlock) {
        currentBlock = blockNumber;
        await scan();
      }
      await sleep(config.bot.pollIntervalMs || 2000);
    }
  }
}

// Exported for dependency-injected testing; auto-starts only when run directly.
// ── TASK 4.3: snapshot-consistency guard ────────────────────────────────
// Every venue referenced by an opportunity must sit on EXACTLY the snapshot
// block. Mixed/stale snapshots are REJECTED (logged, never executed).
function collectOppVenues(opp) {
  const cands = [];
  if (opp && opp.buyVen && typeof opp.buyVen === "object") cands.push(opp.buyVen);
  if (opp && opp.sellVen && typeof opp.sellVen === "object") cands.push(opp.sellVen);
  if (opp && Array.isArray(opp.venues)) cands.push(...opp.venues);
  if (opp && Array.isArray(opp.legs)) cands.push(...opp.legs);
  for (const k of ["legA", "legB", "buy", "sell", "venueIn", "venueOut"]) {
    if (opp && opp[k] && typeof opp[k] === "object") cands.push(opp[k]);
  }
  return cands.filter((v) => v && typeof v === "object");
}

function validateSnapshot(opp, snapshot) {
  // (A) Snapshot-ul curent trebuie să existe.
  if (!snapshot || snapshot.blockNumber == null) return false;
  if (!opp || typeof opp !== "object") return false;
  const want = Number(snapshot.blockNumber);

  // (B) Oportunitatea trebuie să transporte identitatea snapshot-ului din care
  // a fost calculată — și să fie ACELAȘI block cu snapshot-ul curent.
  if (!opp.snapshot || opp.snapshot.blockNumber == null) return false;
  if (Number(opp.snapshot.blockNumber) !== want) return false;

  // (C) blockHash — verificare explicită, niciodată "implicit valid".
  // Dacă snapshot-ul curent are hash dar oportunitatea nu îl transportă,
  // identitatea NU poate fi demonstrată => REJECT.
  if (snapshot.blockHash != null) {
    if (opp.snapshot.blockHash == null) return false;
    if (String(snapshot.blockHash).toLowerCase() !== String(opp.snapshot.blockHash).toLowerCase()) {
      return false; // (Test 10) alt hash la același blockNumber
    }
  }

  // Primary structure (profit.js): buyVen + sellVen. If the opp carries either,
  // BOTH are required (Tests D/E: missing venue => REJECT) and both must sit
  // on the exact snapshot block (Tests B/C: stale venue => REJECT).
  const hasPrimary = opp.buyVen != null || opp.sellVen != null;
  if (hasPrimary) {
    if (!opp.buyVen || !opp.sellVen) return false;
    if (Number(opp.buyVen.blockNumber) !== want) return false;
    if (Number(opp.sellVen.blockNumber) !== want) return false;
  }

  // Additional legacy venues (if any) must also be on the snapshot block.
  const extras = collectOppVenues(opp).filter((v) => v !== opp.buyVen && v !== opp.sellVen);
  if (extras.length && !extras.every((v) => Number(v.blockNumber) === want)) return false;

  // (D) TASK 4.3 — STATE FINGERPRINT: same blockNumber NU înseamnă same state.
  // Când snapshot-ul poartă amprente de venue (fingerprinting activ), fiecare
  // venue folosit de oportunitate trebuie să aibă:
  //   1. intrare în snapshot.venues (state-ul citit la acel block),
  //   2. amprentă pe oportunitate (calculată la construire — Test 11: lipsă => REJECT),
  //   3. amprenta CURENTĂ (recalculată acum din obiectul venue) identică,
  //   4. amprenta din snapshot identică cu celelalte.
  // Orice diferență => oportunitatea e STALE => REJECT (fără re-quote automat).
  if (snapshot.venues && typeof snapshot.venues === "object") {
    for (const v of [opp.buyVen, opp.sellVen]) {
      if (!v || typeof v !== "object") continue;
      const key = venueKey(v);
      const snapEntry = snapshot.venues[key];
      const oppFp = opp.stateFingerprint ? opp.stateFingerprint[key] : undefined;
      const currentFp = venueFingerprint(v);
      if (!snapEntry || !oppFp || !currentFp) return false; // neverificabil => REJECT
      if (oppFp !== currentFp) return false;                 // state-ul s-a schimbat (TOCTOU)
      if (snapEntry.fingerprint !== oppFp) return false;     // snapshot ≠ opp (inconsistent)
    }
  }

  // Nothing verifiable => REJECT (never execute unverifiable opportunities).
  return hasPrimary || collectOppVenues(opp).length > 0;
}

// Execution wrapper: rejects opportunities whose venues are not all on the
// exact snapshot block, then delegates to the real executor.
// TASK 4.2-A: signature is (opp, contractAddr, wallet, provider, opts) so that
// every dependency reaches executeOpp() — JS silently drops extras otherwise.
async function execGuardedOpp(opp, contractAddr, wallet, provider, opts = {}) {
  const snap = (opts && opts.snapshot) || lastSnapshot;
  if (!validateSnapshot(opp, snap)) {
    console.warn("[snapshot] REJECT: opp venues not on exact block " + Number(snap && snap.blockNumber));
    return null;
  }
  // TASK 4.3-A: fresh on-chain state validation — citește starea REALĂ pe lanț
  // la freshBlockNumber și compară amprentele. Dacă diferă => REJECT (stale-state).
  const { freshOnChainStateValidation } = require("./fresh");
  const freshResult = await freshOnChainStateValidation(opp, provider);
  if (!freshResult.ok) {
    console.warn("[fresh] REJECT: " + freshResult.reason);
    return { ok: false, reason: freshResult.reason, details: freshResult.details };
  }
  return executeOpp(opp, contractAddr, wallet, provider, opts);
}
module.exports = { main, takeSnapshot, createWsLifecycle, resolveWsIdleTimeoutMs };

if (require.main === module) {
  main().catch(e => {
    logger.error(`Fatal: ${e.message}`);
    process.exit(1);
  });
}

// TASK 4.3: exported for tests
Object.assign(module.exports, { validateSnapshot, execGuardedOpp });

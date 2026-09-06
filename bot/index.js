require("dotenv").config();
const { ethers } = require("ethers");
const config = require("./config");
const logger = require("./logger");
const { pickProvider, pickWsProvider, healthCheck } = require("./rpc");
const { buildPairs, discoverVenues, readState } = require("./scanner");
const { findOpportunities } = require("./profit");
const { executeOpp } = require("./executor");
const { NonceManager } = require("./nonce");
const { trackTransaction } = require("./tracker");

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VENUE_REFRESH_MS = 10 * 60 * 1000;
const HEALTH_LOG_MS = 60 * 1000;
const MAX_ERRS = 10;
const BACKOFF_MS = 30_000;

function fmtTok(r, d) { return Number(ethers.formatUnits(r, d)).toFixed(4); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function takeSnapshot(provider) {
  const block = await provider.getBlock("latest");
  return {
    blockNumber: block.number,
    blockHash: block.hash,
    timestamp: BigInt(block.timestamp),
    stateVersion: 0n,
  };
}

async function refreshVenues(provider, pairs) {
  const { venues } = await discoverVenues(provider, config);
  await readState(provider, venues);
  return venues;
}

// TASK 4.3: module-scope ref to the latest scan snapshot (visible to execGuardedOpp)
// TASK 4.4: V3 deep-state enrichment from scanner
let lastSnapshot = null;
const { enrichV3Venues } = require("./scanner");

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
            logger.info(`SUCCESS tx=${result.txHash} block=${result.blockNumber} profit=${fmtTok(best.netProfit, best.borrowToken.decimals || 18)} ${best.borrowToken.symbol || ""} (~${fmtTok(best.profitInBnb, 18)} BNB)`);

            // Tracker: follow tx to receipt and compute real P&L
            if (result.txHash) {
              const tracked = await trackTx(provider, {
                txHash: result.txHash,
                timeoutMs: config.bot.maxTxWaitMs || 120000,
              });
              if (tracked.realizedProfit != null) {
                logger.info(`[tracker] realized profit = ${fmtTok(tracked.realizedProfit, 18)} BNB`);
              }
              if (tracked.gasCostBnb != null) {
                logger.info(`[tracker] gas cost = ${Number(tracked.gasCostBnb) / 1e18} BNB`);
              }
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
    wsProvider.on("block", async (blockNumber) => {
      currentBlock = blockNumber;
      await scan();
    });

    // WebSocket reconnection logic
    wsProvider.websocket.on("close", () => {
      logger.warn("WebSocket disconnected, attempting reconnect...");
      setTimeout(async () => {
        try {
          const { wsProvider: newWs, url: newUrl } = await pickWsProvider();
          if (newWs) {
            newWs.on("block", async (blockNumber) => {
              currentBlock = blockNumber;
              await scan();
            });
            logger.info(`WebSocket reconnected: ${newUrl}`);
          }
        } catch (e) {
          logger.error(`WebSocket reconnect failed: ${e.message.slice(0, 80)}`);
        }
      }, 5000);
    });
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
  if (opp && Array.isArray(opp.venues)) cands.push(...opp.venues);
  if (opp && Array.isArray(opp.legs)) cands.push(...opp.legs);
  for (const k of ["legA", "legB", "buy", "sell", "venueIn", "venueOut"]) {
    if (opp && opp[k] && typeof opp[k] === "object") cands.push(opp[k]);
  }
  return cands.filter((v) => v && typeof v === "object");
}

function validateSnapshot(opp, snapshot) {
  if (!snapshot || snapshot.blockNumber == null) return false;
  const vs = collectOppVenues(opp);
  if (!vs.length) return false; // nothing verifiable -> reject
  const want = Number(snapshot.blockNumber);
  return vs.every((v) => Number(v.blockNumber) === want);
}

// Execution wrapper: rejects opportunities whose venues are not all on the
// exact snapshot block, then delegates to the real executor.
async function execGuardedOpp(opp, cfg, opts = {}) {
  const snap = (opts && opts.snapshot) || lastSnapshot;
  if (!validateSnapshot(opp, snap)) {
    console.warn("[snapshot] REJECT: opp venues not on exact block " + Number(snap && snap.blockNumber));
    return null;
  }
  return executeOpp(opp, cfg, opts);
}
module.exports = { main, takeSnapshot };

if (require.main === module) {
  main().catch(e => {
    logger.error(`Fatal: ${e.message}`);
    process.exit(1);
  });
}

// TASK 4.3: exported for tests
Object.assign(module.exports, { validateSnapshot, execGuardedOpp });

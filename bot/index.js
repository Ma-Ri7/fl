require("dotenv").config();
const { ethers } = require("ethers");
const config = require("./config");
const logger = require("./logger");
const { pickProvider, pickWsProvider, healthCheck } = require("./rpc");
const { buildPairs, discoverVenues, readState } = require("./scanner");
const { findOpportunities } = require("./profit");
const { executeOpp } = require("./executor");

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VENUE_REFRESH_MS = 10 * 60 * 1000;
const HEALTH_LOG_MS = 60 * 1000;
const MAX_ERRS = 10;
const BACKOFF_MS = 30_000;

function fmtTok(r, d) { return Number(ethers.formatUnits(r, d)).toFixed(4); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function refreshVenues(provider, pairs, reservesCache) {
  const { venues } = await discoverVenues(provider, config);
  await readState(provider, venues, reservesCache);
  return venues;
}

async function main() {
  if (!CONTRACT_ADDRESS || !PRIVATE_KEY) {
    logger.error("Missing CONTRACT_ADDRESS or PRIVATE_KEY in .env");
    process.exit(1);
  }

  const { provider, url: rpcUrl } = await pickProvider();
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  logger.info(`Bot started. Wallet: ${wallet.address}`);
  logger.info(`Contract: ${CONTRACT_ADDRESS}`);
  logger.info(`RPC: ${rpcUrl}`);

  // Try to setup WebSocket for real-time blocks (falls back to polling)
  const { wsProvider, url: wsUrl } = await pickWsProvider();
  if (wsProvider) {
    logger.info(`WebSocket connected: ${wsUrl} (real-time blocks)`);
  } else {
    logger.info("WebSocket unavailable, using polling fallback");
  }

  const pairs = buildPairs();
  logger.info(`Tracking ${pairs.length} token pairs across ${config.V2_ROUTERS.length} V2 + V3 + DODO`);

  let venues = [];
  let reservesCache = {};
  let lastVenueRefresh = 0;
  let lastHealthLog = 0;
  let errCount = 0;
  let totalOpps = 0;
  let totalTx = 0;
  let currentBlock = 0;

  // Initial venue discovery
  try {
    venues = await refreshVenues(provider, pairs, reservesCache);
    lastVenueRefresh = Date.now();
    logger.info(`Discovered ${venues.length} venues`);
  } catch (e) {
    logger.error(`Initial venue discovery failed: ${e.message.slice(0, 120)}`);
  }

  // Scan function (called on each block or poll interval)
  async function scan() {
    try {
      const now = Date.now();

      // Refresh venues periodically
      if (now - lastVenueRefresh > VENUE_REFRESH_MS) {
        logger.info("Refreshing venues...");
        venues = await refreshVenues(provider, pairs, reservesCache);
        lastVenueRefresh = now;
        logger.info(`Venues refreshed: ${venues.length}`);
      }

      // Read state (reserves / liquidity / prices)
      await readState(provider, venues, reservesCache);

      // Find opportunities
      const opps = findOpportunities(venues, []);
      totalOpps += opps.length;

      // Log best opportunity if any
      if (opps.length > 0) {
        const best = opps[0];
        logger.info(
          `Best opp: ${best.borrowToken.symbol || best.borrowToken.address.slice(0, 8)} ` +
          `borrow=${fmtTok(best.borrowAmount, best.borrowToken.decimals || 18)} ` +
          `netProfit=${fmtTok(best.netProfit, best.borrowToken.decimals || 18)} ${best.borrowToken.symbol || ""} ` +
          `(~${fmtTok(best.profitInBnb, 18)} BNB) ` +
          `buy=${best.buyVen.kind}@${best.buyVen.pair?.slice(0, 8) || best.buyVen.pool?.slice(0, 8) || "?"} ` +
          `sell=${best.sellVen.kind}@${best.sellVen.pair?.slice(0, 8) || best.sellVen.pool?.slice(0, 8) || "?"}`
        );

        // Execute if profit in BNB exceeds threshold
        const minProfitWei = ethers.parseEther(String(config.bot.minProfitBnb));
        if (best.profitInBnb >= minProfitWei) {
          logger.info(`Executing arbitrage...`);
          const result = await executeOpp(best, CONTRACT_ADDRESS, wallet, provider);
          if (result.ok) {
            totalTx++;
            logger.info(`SUCCESS tx=${result.txHash} block=${result.blockNumber} profit=${fmtTok(best.netProfit, best.borrowToken.decimals || 18)} ${best.borrowToken.symbol || ""} (~${fmtTok(best.profitInBnb, 18)} BNB)`);
          } else {
            logger.warn(`Execute failed: ${result.reason} - ${result.err?.slice(0, 80)}`);
          }
        } else {
          logger.info(`Best opp below threshold (${fmtTok(best.profitInBnb, 18)} BNB < ${config.bot.minProfitBnb} BNB), skipping`);
        }
      }

      // Health check - verify RPC is still responsive
      if (now - lastHealthLog > HEALTH_LOG_MS) {
        const rpcHealthy = await healthCheck(provider);
        if (!rpcHealthy) {
          logger.error("RPC health check failed, attempting reconnect...");
          try {
            const { provider: newProvider, url: newUrl } = await pickProvider();
            provider = newProvider;
            logger.info(`RPC reconnected: ${newUrl}`);
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
            wsProvider = newWs;
            logger.info(`WebSocket reconnected: ${newUrl}`);
            wsProvider.on("block", async (blockNumber) => {
              currentBlock = blockNumber;
              await scan();
            });
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

main().catch(e => {
  logger.error(`Fatal: ${e.message}`);
  process.exit(1);
});


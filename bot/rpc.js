// RPC provider selection - optimized for Ankr (primary) with public fallbacks.
// For production, set BSC_RPC_URL in .env to your Ankr endpoint.
// Ankr provides unlimited requests + WebSocket support for real-time blocks.
const { ethers } = require("ethers");

const PUBLIC_RPCS = [
  "https://bsc.publicnode.com",
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://1rpc.io/bnb",
];

/**
 * Picks the first responsive RPC (env BSC_RPC_URL has priority).
 * @returns {Promise<{provider: ethers.JsonRpcProvider, url: string}>}
 */
async function pickProvider() {
  const urls = [];
  if (process.env.BSC_RPC_URL) urls.push(process.env.BSC_RPC_URL);
  urls.push(...PUBLIC_RPCS);
  for (const url of urls) {
    try {
      const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
      await provider.getBlockNumber();
      return { provider, url };
    } catch (_) { /* try next */ }
  }
  throw new Error("No working BSC RPC found (set BSC_RPC_URL in .env)");
}

/**
 * Creates a WebSocket provider for real-time block notifications.
 * Falls back to null if WebSocket URL is not available.
 * @returns {Promise<{wsProvider: ethers.WebSocketProvider|null, wsUrl: string|null}>}
 */
async function pickWsProvider() {
  // Ankr WebSocket URL format: wss://rpc.ankr.com/bsc/ws/{apiKey}
  // Or use BSC_WS_URL env var for any WebSocket provider
  const wsUrls = [];
  if (process.env.BSC_WS_URL) wsUrls.push(process.env.BSC_WS_URL);
  if (process.env.BSC_RPC_URL && process.env.BSC_RPC_URL.includes("ankr")) {
    // Auto-derive WebSocket URL from Ankr HTTP endpoint
    const apiKey = process.env.BSC_RPC_URL.split("/").pop();
    wsUrls.push(`wss://rpc.ankr.com/bsc/ws/${apiKey}`);
  }
  // Public WebSocket fallback (less reliable)
  wsUrls.push("wss://bsc-ws-node.nariox.org");

  for (const url of wsUrls) {
    try {
      const wsProvider = new ethers.WebSocketProvider(url);
      // Wait for connection
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("WS timeout")), 5000);
        wsProvider.once("block", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      return { wsProvider, url };
    } catch (_) { /* try next */ }
  }
  return { wsProvider: null, wsUrl: null };
}

/**
 * Health check - verifies the provider is still responsive.
 * @param {ethers.JsonRpcProvider} provider
 * @returns {Promise<boolean>}
 */
async function healthCheck(provider) {
  try {
    await provider.getBlockNumber();
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { pickProvider, pickWsProvider, healthCheck, PUBLIC_RPCS };
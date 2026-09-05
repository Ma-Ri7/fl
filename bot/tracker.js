// FLASH — TX Tracker + P&L (audit item 7/8, PHASE 12).
// Urmărește tranzacțiile transmise (public sau privat) până la receipt,
// extrage profitul realizat din evenimentul ArbitrageExecuted și calculează
// costul real de gas (gasUsed * effectiveGasPrice) — nu doar gasLimit.
const logger = require("./logger");

let iface = null;
try {
  const abi = require("../artifacts/contracts/FlashLoanArbitrage.sol/FlashLoanArbitrage.json").abi;
  const { ethers } = require("ethers");
  iface = new ethers.Interface(abi);
} catch (_) {
  /* artifacts lipsesc (nu s-a compilat) — tracker-ul doar raportează receipt */
}

function parseArbitrageExecuted(receipt) {
  if (!iface || !receipt) return null;
  for (const log of receipt.logs || []) {
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "ArbitrageExecuted") {
        return {
          token: parsed.args.token,
          profit: parsed.args.profit,
          recipient: parsed.args.recipient,
        };
      }
    } catch (_) { /* not our event */ }
  }
  return null;
}

/**
 * Așteaptă confirmarea unei tranzacții și calculează P&L-ul realizat.
 * @param {ethers.Provider} provider
 * @param {object} opts { txHash, expectedProfit, tokenDecimals=18, timeoutMs=120000 }
 * @returns {Promise<{status:'mined'|'timeout'|'error', blockNumber?, realizedProfit?, gasCostBnb?, gasUsed?, txHash, event?}>}
 */
async function trackTransaction(provider, opts = {}) {
  const { txHash, timeoutMs = 120000 } = opts;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt && receipt.blockNumber) {
        const ev = parseArbitrageExecuted(receipt);
        const gasCostBnb = receipt.gasUsed * (receipt.gasPrice || 0n);
        const realizedProfit = ev ? ev.profit : null;
        logger.info(
          `[tracker] tx=${txHash.slice(0, 14)}… status=mined block=${receipt.blockNumber} ` +
          `gasUsed=${receipt.gasUsed} gasCost=${Number(gasCostBnb) / 1e18} BNB ` +
          `profit=${realizedProfit === null ? "n/a" : Number(realizedProfit) / 1e18}`
        );
        return {
          status: "mined",
          txHash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
          gasCostBnb,
          realizedProfit,
          event: ev,
        };
      }
    } catch (e) {
      logger.warn(`[tracker] receipt error ${e.message.slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  logger.warn(`[tracker] tx=${txHash.slice(0, 14)}… timeout după ${timeoutMs}ms (posibil inclus târziu)`);
  return { status: "timeout", txHash };
}

module.exports = { trackTransaction, parseArbitrageExecuted };

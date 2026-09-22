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
 * Așteaptă confirmarea unei tranzacții și clasifică rezultatul on-chain.
 *
 * TASK 4.7 — POST-BROADCAST OUTCOME & RECEIPT INTEGRITY:
 *   - "mined" înseamnă DOAR receipt cu status 1 (execuție reușită);
 *   - receipt cu status 0 => "reverted" (INVARIANT 2/3 — niciodată "mined");
 *   - receipt-ul trebuie să aparțină txHash-ului cerut (INVARIANT 7) —
 *     transactionHash lipsă/diferit => "unknown";
 *   - provider-ul trebuie să dovedească chainId 56 (INVARIANT 8) —
 *     rețea lipsă/erone/diferită => "unknown";
 *   - lipsă receipt / eroare RPC => "timeout"/"unknown" — niciodată succes
 *     (INVARIANT 4/6: broadcast acknowledgement ≠ confirmation).
 * @param {ethers.Provider} provider
 * @param {object} opts { txHash, expectedChainId=56, timeoutMs=120000 }
 * @returns {Promise<{status:'mined'|'reverted'|'timeout'|'unknown', txHash,
 *   blockNumber?, gasUsed?, effectiveGasPrice?, gasCostBnb?, realizedProfit?,
 *   event?, lastError?}>}
 */
async function trackTransaction(provider, opts = {}) {
  const { txHash, timeoutMs = 120000, expectedChainId = 56 } = opts;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // INVARIANT 8 — chain identity la momentul observării.
    try {
      const net = await provider.getNetwork();
      if (!net || BigInt(net.chainId) !== BigInt(expectedChainId)) {
        return { status: "unknown", txHash, lastError: `chain mismatch (expected ${expectedChainId}, got ${net ? net.chainId : "n/a"})` };
      }
    } catch (e) {
      return { status: "unknown", txHash, lastError: `network unavailable: ${e.message.slice(0, 80)}` };
    }
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt && receipt.blockNumber) {
        // INVARIANT 7 — receipt identity binding: transactionHash lipsă sau
        // diferit de hash-ul cerut => observare străină => "unknown".
        // TASK 4.11-L-B (§14): ethers v6 receipts expose the hash as `hash`; the
        // legacy/internal shape used `transactionHash`. Resolve either name so the
        // identity binding is really enforced for live v6 observations instead of
        // being silently skipped (a hash-less receipt is still not a mismatch).
        const observedHash = receipt.hash != null ? receipt.hash : receipt.transactionHash;
        if (observedHash != null) {
          const rh = typeof observedHash === "string" ? observedHash.toLowerCase() : null;
          if (rh === null || rh !== txHash.toLowerCase()) {
            return { status: "unknown", txHash, lastError: "receipt hash mismatch (foreign receipt)" };
          }
        }
        const ev = parseArbitrageExecuted(receipt);
        // Gas-ul real provine din receipt: gasUsed × effectiveGasPrice.
        // (vârful vechi gasPrice || 0n produccea cost=0 pentru tx-uri 1559.)
        const gasCostBnb = receipt.gasUsed * (receipt.effectiveGasPrice || receipt.gasPrice || 0n);
        // INVARIANT 2 — succes DOAR cu status === 1 (explicit). Orice altă
        // valoare (0, undefined, string, null) NU este succes.
        if (receipt.status === 0) {
          // INVARIANT 3 — revert DEFINITIV, niciodată "mined" și niciodată UNKNOWN.
          logger.warn(`[tracker] tx=${txHash.slice(0, 14)}… status=reverted block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`);
          return {
            status: "reverted",
            txHash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
            effectiveGasPrice: receipt.effectiveGasPrice,
            gasCostBnb,
          };
        }
        if (receipt.status !== 1) {
          // Receipt malformat (status lipsă/erat) — fail-closed, niciodată succes.
          return { status: "unknown", txHash, lastError: `invalid receipt status (${String(receipt.status)})` };
        }
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
          // TASK 4.11-L-B (§14): report the resolved gas price (`gasPrice` on v6),
          // consistent with the gasCostBnb computation above.
          effectiveGasPrice: receipt.effectiveGasPrice != null ? receipt.effectiveGasPrice : receipt.gasPrice,
          gasCostBnb,
          realizedProfit,
          event: ev,
        };
      }
    } catch (e) {
      // eroare RPC — transientă: rămânem în buclă până la timeout (INVARIANT 4).
      logger.warn(`[tracker] receipt error ${e.message.slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  logger.warn(`[tracker] tx=${txHash.slice(0, 14)}… timeout după ${timeoutMs}ms (posibil inclus târziu)`);
  return { status: "timeout", txHash };
}

module.exports = { trackTransaction, parseArbitrageExecuted };

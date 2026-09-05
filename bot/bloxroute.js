// FLASH — BloXroute private mempool integration for BSC.
// Sends transactions directly to validators, bypassing the public mempool.
// This eliminates frontrunning: MEV bots cannot see your tx before it's included.
//
// API docs: https://docs.bloxroute.com/apis/mev-solution/bsc-bundle
// Endpoint: https://mev.api.blxrbdn.com (BSC mainnet)
//
// Usage:
//   const bloxroute = require('./bloxroute');
//   const result = await bloxroute.sendBundle({ wallet, to, data, gasLimit, gasPrice, targetBlock });
const { ethers } = require("ethers");

const BLOXROUTE_API = "https://mev.api.blxrbdn.com";
const BUNDLE_API = "https://api.blxrbdn.com" + "/bundle"; // legacy fallback

/**
 * Send a private transaction via BloXroute.
 * The tx is forwarded directly to BSC validators and never enters the public mempool.
 *
 * STATUS SEMANTICS (audit item 7 — CRITICAL):
 *  - ok:true, status:'accepted' → tx primit de BloXroute (txHash cunoscut).
 *  - ok:false, status:'failed'  → respins ÎNAINTE de acceptare (definitiv).
 *    DOAR acest caz permite fallback la public mempool.
 *  - ok:false, status:'unknown' → eroare de rețea/timpout: tx POATE fi fost
 *    acceptat. NU se mai trimite public cu același nonce (risc dublă execuție);
 *    tracker-ul urmărește hash-ul, iar NonceManager nu reutilizează nonce-ul.
 *
 * @param {object} opts
 * @param {ethers.Wallet} opts.wallet        - signer (only address + signTransaction used)
 * @param {string} opts.to                  - target contract address
 * @param {string} opts.data                - encoded calldata
 * @param {bigint} opts.gasLimit            - gas limit (wei)
 * @param {bigint} opts.maxFeePerGas        - max fee per gas (EIP-1559)
 * @param {bigint} opts.maxPriorityFeePerGas- miner tip (EIP-1559)
 * @param {number} [opts.targetBlock]       - specific block number to target (default: next block)
 * @param {number} [opts.nonce]             - nonce rezervat de NonceManager (obligatoriu în producție)
 * @param {string} [opts.bloxrouteToken]    - BloXroute auth token (or BLOXROUTE_API_TOKEN env)
 * @returns {Promise<{ok: boolean, status:'accepted'|'failed'|'unknown', txHash?: string, block?: number, error?: string}>}
 */
async function sendPrivateTx(opts) {
  const token = opts.bloxrouteToken || process.env.BLOXROUTE_API_TOKEN;
  if (!token) return { ok: false, status: "failed", error: "no-token" };

  const wallet = opts.wallet;
  const feeData = await wallet.provider.getFeeData();
  const maxFeePerGas = opts.maxFeePerGas || feeData.maxFeePerGas || 5000000000n;
  const maxPriorityFeePerGas = opts.maxPriorityFeePerGas || feeData.maxPriorityFeePerGas || 1000000000n;

  // Build the EIP-1559 transaction
  const tx = {
    type: 2,
    to: opts.to,
    data: opts.data,
    gasLimit: opts.gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce: opts.nonce !== undefined ? opts.nonce : await wallet.getNonce("pending"),
    chainId: 56,
  };

  // Sign locally (private key never leaves this machine)
  const signedTx = await wallet.signTransaction(tx);

  // Submit to BloXroute
  const body = {
    id: "1",
    jsonrpc: "2.0",
    method: "blxr_submit_bundle",
    params: {
      transactions: [signedTx],
      block_number: opts.targetBlock ? "0x" + opts.targetBlock.toString(16) : "latest",
      // Optional: set min timestamp/max timestamp for time-sensitive txs
    },
  };

  try {
    const res = await fetch(BLOXROUTE_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": token,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.error) return { ok: false, status: "failed", error: json.error.message };
    return { ok: true, status: "accepted", txHash: json.result?.tx_hash, block: json.result?.block_number };
  } catch (e) {
    // rețea/timpout → stare NECUNOSCUTĂ: nu se fac alte submit-uri cu acest nonce
    return { ok: false, status: "unknown", error: e.message };
  }
}

/**
 * Send a bundle of transactions atomically (all-or-nothing).
 * Useful for multi-leg arbitrage or when you want to combine multiple ops.
 *
 * @param {object} opts
 * @param {string[]} opts.signedTxs        - array of signed raw transactions
 * @param {number} [opts.targetBlock]      - target block number
 * @param {string} [opts.bloxrouteToken]   - auth token
 * @returns {Promise<{ok: boolean, bundleId?: string, error?: string}>}
 */
async function sendBundle(opts) {
  const token = opts.bloxrouteToken || process.env.BLOXROUTE_API_TOKEN;
  if (!token) return { ok: false, error: "no-token" };

  const body = {
    id: "1",
    jsonrpc: "2.0",
    method: "blxr_submit_bundle",
    params: {
      transactions: opts.signedTxs,
      block_number: opts.targetBlock ? "0x" + opts.targetBlock.toString(16) : "latest",
    },
  };

  try {
    const res = await fetch(BLOXROUTE_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": token,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.error) return { ok: false, error: json.error.message };
    return { ok: true, bundleId: json.result?.bundle_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Check if BloXroute is configured and reachable.
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
  const token = process.env.BLOXROUTE_API_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(BLOXROUTE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": token },
      body: JSON.stringify({ id: "1", jsonrpc: "2.0", method: "blxr_tx", params: {} }),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

module.exports = { sendPrivateTx, sendBundle, isAvailable, BLOXROUTE_API };

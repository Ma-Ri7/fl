// FLASH — BloXroute private mempool integration for BSC.
// Sends transactions directly to validators, bypassing the public mempool.
// This eliminates frontrunning: MEV bots cannot see your tx before it's included.
//
// API docs: https://docs.bloxroute.com/apis/mev-solution/bsc-bundle
// Endpoint: https://mev.api.blxrbdn.com (BSC mainnet)
//
// Usage:
//   const bloxroute = require('./bloxroute');
//   const result = await bloxroute.sendPrivateTx({ wallet, to, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas, nonce });
const { ethers, keccak256 } = require("ethers");

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
  // TASK 4.6-D (PHASE 11/14): bound-ul de fee și nonce-ul sunt CÂMPURI DE
  // IDENTITATE validate de 4.6-C + executorul (approveTx). Ele sunt OBLIGATORII
  // și se folosesc EXACT cum au fost aprobate — NICIODATĂ re-citite din
  // feeData sau substituite cu fallback-uri arbitrare (vârful vechi
  // "|| 5 gwei / || 1 gwei" ocolea economic guard-ul și muta identitatea).
  if (
    typeof opts.maxFeePerGas !== "bigint" ||
    opts.maxFeePerGas <= 0n
  ) {
    return { ok: false, status: "failed", error: "missing-fee-bound" };
  }
  if (
    typeof opts.maxPriorityFeePerGas !== "bigint" ||
    opts.maxPriorityFeePerGas < 0n ||
    opts.maxPriorityFeePerGas > opts.maxFeePerGas
  ) {
    return { ok: false, status: "failed", error: "invalid-priority-tip" };
  }
  if (opts.nonce === undefined || opts.nonce === null) {
    // Reconstrucția nonce-ului din wallet este interzisă (PHASE 9): nonce-ul
    // face parte din identitatea aprobată și rezervată de NonceManager.
    return { ok: false, status: "failed", error: "missing-nonce" };
  }
  // RPC CONSISTENCY (PHASE 6/13): rețeaua provider-ului wallet-ului trebuie să
  // fie BSC (chainId 56). Eșec definitiv ÎNAINTE de acceptare => "failed".
  try {
    const net = await wallet.provider.getNetwork();
    if (BigInt(net.chainId) !== 56n) {
      return { ok: false, status: "failed", error: `chainid-mismatch:${net.chainId}` };
    }
  } catch (e) {
    return { ok: false, status: "failed", error: "network-unavailable" };
  }

  // Build the EIP-1559 transaction — exact câmpurile aprobate, fără completări.
  const tx = {
    type: 2,
    to: opts.to,
    data: opts.data,
    gasLimit: opts.gasLimit,
    maxFeePerGas: opts.maxFeePerGas,
    maxPriorityFeePerGas: opts.maxPriorityFeePerGas,
    nonce: opts.nonce,
    chainId: 56,
  };

  // Sign locally (private key never leaves this machine)
  const signedTx = await wallet.signTransaction(tx);
  // TASK 4.6-D (PHASE 18): hash-ul tranzacției SEMNATE local — executorul îl
  // folosește pentru a lega răspunsul relay-ului de identitatea aprobată.
  const signedHash = keccak256(signedTx);

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
    return { ok: true, status: "accepted", txHash: json.result?.tx_hash, signedHash, block: json.result?.block_number };
  } catch (e) {
    // rețea/timpout → stare NECUNOSCUTĂ: nu se fac alte submit-uri cu acest nonce
    return { ok: false, status: "unknown", error: e.message };
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

module.exports = { sendPrivateTx, isAvailable, BLOXROUTE_API };

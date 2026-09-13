// FLASH — Broadcast integrity & RPC consistency (TASK 4.6-D).
//
// Strat formal între cost/gas guard (4.6-C) și submisie. Răspunde la:
//   „Tranzacția care este validată economic și simulată este EXACT tranzacția
//    estimată, track-uită și broadcast-uită?”
//
// Principii:
//   - IDENTITATE = fingerprint canonic keccak256 peste:
//       chainId, to, data, value, nonce, gasLimit, type + fee params
//     (legacy: gasPrice; EIP-1559: maxFeePerGas + maxPriorityFeePerGas).
//   - Reprezentare canonică deterministă; valori echivalente => fingerprint
//     identic; orice schimbare de semantică => fingerprint diferit.
//   - Mutația unui singur octet din calldata invalidează identitatea.
//   - chainId = 56 (BSC mainnet), verificat și contra rețelei provider-ului.
//   - Relay ambiguous (timeout / reset / răspuns malformat / status necunoscut)
//     => UNKNOWN; NICIODATĂ fallback public automat.
//   - Fail-closed: validez/mut/malformat => REJECT, niciodată substitute.
//   - Pur (doar keccak256 din ethers — fără provider/wallet), BigInt-only,
//     determinist, rejection codes machine-readable.
//   - NU atinge 4.5-C/D (tracker/nonce lifecycle), 4.5-E/F (P&L),
//     4.6-A/B/C (economic/slippage/gas) — doar le leagă prin identitate.

const { keccak256, toUtf8Bytes } = require("ethers");

const EXPECTED_CHAIN_ID = 56n;

const REJECTION_CODES = Object.freeze({
  MISSING_TX: "MISSING_TX",
  INVALID_CHAIN_ID: "INVALID_CHAIN_ID",
  INVALID_TARGET: "INVALID_TARGET",
  INVALID_VALUE: "INVALID_VALUE",
  INVALID_NONCE: "INVALID_NONCE",
  INVALID_GAS_LIMIT: "INVALID_GAS_LIMIT",
  INVALID_FEE: "INVALID_FEE",
  INVALID_TYPE: "INVALID_TYPE",
  INVALID_CALLDATA: "INVALID_CALLDATA",
  TX_MUTATED: "TX_MUTATED",
  PROVIDER_CHAIN_MISMATCH: "PROVIDER_CHAIN_MISMATCH",
  PROVIDER_NETWORK_UNAVAILABLE: "PROVIDER_NETWORK_UNAVAILABLE",
  INVALID_TX_HASH: "INVALID_TX_HASH",
  AMBIGUOUS_RELAY_RESULT: "AMBIGUOUS_RELAY_RESULT",
});

// Ordinea câmpurilor din reprezentarea canonică — folosită pentru a raporta
// exact care câmp a fost mutat la verificare.
const FIELDS = Object.freeze([
  "chainId", "to", "data", "value", "nonce", "gasLimit", "type", "fees",
]);
const CONTENT_FIELDS = Object.freeze([
  "chainId", "to", "data", "value", "gasLimit",
]);

function reject(code, reason, field) {
  return { ok: false, rejection: { code, reason, field: field || null } };
}

/** BigInt sau null — acceptă DOAR BigInt >= 0 sau Number întreg safe >= 0. */
function toBigIntOrNull(v) {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number" && Number.isInteger(v) && Number.isSafeInteger(v)) {
    return v >= 0 ? BigInt(v) : null;
  }
  return null;
}

/** Nonce valid: întreg în [0, 2^32-1]. Orice alt tip/format => null. */
function toNonceOrNull(v) {
  if (typeof v === "bigint") {
    return v >= 0n && v <= 0xffffffffn ? v : null;
  }
  if (typeof v === "number" && Number.isInteger(v) && Number.isSafeInteger(v)) {
    return v >= 0 && v <= 0xffffffff ? BigInt(v) : null;
  }
  return null;
}

/** Chain ID valid: întreg strict pozitiv (Number safe sau BigInt). */
function toChainIdOrNull(v) {
  if (typeof v === "bigint") return v > 0n ? v : null;
  if (typeof v === "number" && Number.isInteger(v) && Number.isSafeInteger(v)) {
    return v > 0 ? BigInt(v) : null;
  }
  return null;
}

/** 0x-prefixed hex bytes, lungime pară. */
function isHexData(s) {
  return (
    typeof s === "string" &&
    s.length >= 2 &&
    s.length % 2 === 0 &&
    /^0x[0-9a-fA-F]*$/.test(s)
  );
}

/** Adresă EVM strictă (0x + 40 hex, nonzero) => lowercase, altfel null. */
function normAddress(a) {
  if (typeof a !== "string") return null;
  const t = a.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return null;
  if (/^0x0{40}$/i.test(t)) return null;
  return t.toLowerCase();
}

/** Tip tranzacție: 0 (legacy) sau 2 (EIP-1559). undefined/null => 0. */
function normType(t) {
  if (t === 0 || t === "0") return 0;
  if (t === 2 || t === "2") return 2;
  if (typeof t === "bigint" && (t === 0n || t === 2n)) return Number(t);
  if (t === undefined || t === null) return 0;
  return null;
}

/** Calldata cu selector: cel puțin 0x + 4 bytes (selector + args). */
function validateSelectorData(data) {
  if (!isHexData(data)) return reject(REJECTION_CODES.INVALID_CALLDATA, "calldata must be 0x-prefixed even-length hex", "data");
  if (data.length < 10) return reject(REJECTION_CODES.INVALID_CALLDATA, "calldata too short for function selector", "data");
  return { ok: true };
}

/** Părțile canonice, în ordinea FIELDS. */
function canonicalParts(t) {
  const feePart =
    t.type === 2
      ? `fees:maxfee:${t.maxFeePerGas.toString()}|maxtip:${t.maxPriorityFeePerGas.toString()}`
      : `fees:gasprice:${t.gasPrice.toString()}`;
  return [
    `chain:${t.chainId.toString()}`,
    `to:${t.to}`,
    `data:${t.data.toLowerCase()}`,
    `value:${t.value.toString()}`,
    `nonce:${t.nonce.toString()}`,
    `gas:${t.gasLimit.toString()}`,
    `type:${t.type}`,
    feePart,
  ];
}

/** Reprezentare canonică deterministă (string). */
function canonicalTx(t) {
  return canonicalParts(t).join("|");
}

/** Fingerprint keccak256 al reprezentării canonice. */
function fingerprintTx(t) {
  return keccak256(toUtf8Bytes(canonicalTx(t)));
}

/** Părțile canonice ale conținutului (fără nonce/type/fees). */
function canonicalContentParts(c) {
  return [
    `chain:${c.chainId.toString()}`,
    `to:${c.to}`,
    `data:${c.data.toLowerCase()}`,
    `value:${c.value.toString()}`,
    `gas:${c.gasLimit.toString()}`,
  ];
}

function canonicalContent(c) {
  return canonicalContentParts(c).join("|");
}

function fingerprintContent(c) {
  return keccak256(toUtf8Bytes(canonicalContent(c)));
}

/**
 * Validează + normalizează o tranzacție candidată (BigInt-only).
 * @returns {ok:true, tx:canonic} sau {ok:false, rejection:{code,reason,field}}
 */
function validateTx(raw) {
  if (raw == null || typeof raw !== "object") {
    return reject(REJECTION_CODES.MISSING_TX, "transaction missing or not an object");
  }
  const chainId = toChainIdOrNull(raw.chainId);
  if (chainId === null) {
    return reject(REJECTION_CODES.INVALID_CHAIN_ID, "missing/malformed chainId", "chainId");
  }
  if (chainId !== EXPECTED_CHAIN_ID) {
    return reject(REJECTION_CODES.INVALID_CHAIN_ID, `chainId must be ${EXPECTED_CHAIN_ID} (got ${chainId})`, "chainId");
  }
  const to = normAddress(raw.to);
  if (to === null) {
    return reject(REJECTION_CODES.INVALID_TARGET, "missing/malformed/zero target address", "to");
  }
  const sel = validateSelectorData(raw.data);
  if (!sel.ok) return sel;
  const data = raw.data.toLowerCase();
  const value = toBigIntOrNull(raw.value);
  if (value === null || value < 0n) {
    return reject(REJECTION_CODES.INVALID_VALUE, "missing/malformed/negative value", "value");
  }
  const nonce = toNonceOrNull(raw.nonce);
  if (nonce === null) {
    return reject(REJECTION_CODES.INVALID_NONCE, "missing/malformed nonce", "nonce");
  }
  const gasLimit = toBigIntOrNull(raw.gasLimit);
  if (gasLimit === null || gasLimit <= 0n) {
    return reject(REJECTION_CODES.INVALID_GAS_LIMIT, "missing/malformed/zero gasLimit", "gasLimit");
  }
  const type = normType(raw.type);
  if (type === null) {
    return reject(REJECTION_CODES.INVALID_TYPE, "unsupported transaction type", "type");
  }
  const hasMaxFee = raw.maxFeePerGas !== undefined && raw.maxFeePerGas !== null;
  const hasMaxTip = raw.maxPriorityFeePerGas !== undefined && raw.maxPriorityFeePerGas !== null;
  const hasGasPrice = raw.gasPrice !== undefined && raw.gasPrice !== null;
  if (type === 0) {
    if (hasMaxFee || hasMaxTip) {
      return reject(REJECTION_CODES.INVALID_FEE, "EIP-1559 fee fields on legacy transaction", "fees");
    }
    const gasPrice = toBigIntOrNull(raw.gasPrice);
    if (gasPrice === null || gasPrice <= 0n) {
      return reject(REJECTION_CODES.INVALID_FEE, "legacy transaction requires positive gasPrice", "fees");
    }
    return {
      ok: true,
      tx: { chainId, to, data, value, nonce, gasLimit, type, gasPrice },
    };
  }
  // EIP-1559
  if (hasGasPrice) {
    return reject(REJECTION_CODES.INVALID_FEE, "gasPrice on EIP-1559 transaction", "fees");
  }
  const maxFeePerGas = toBigIntOrNull(raw.maxFeePerGas);
  if (maxFeePerGas === null || maxFeePerGas <= 0n) {
    return reject(REJECTION_CODES.INVALID_FEE, "EIP-1559 transaction requires positive maxFeePerGas", "fees");
  }
  const maxPriorityFeePerGas = toBigIntOrNull(raw.maxPriorityFeePerGas);
  if (maxPriorityFeePerGas === null || maxPriorityFeePerGas < 0n) {
    return reject(REJECTION_CODES.INVALID_FEE, "EIP-1559 transaction requires maxPriorityFeePerGas >= 0", "fees");
  }
  if (maxPriorityFeePerGas > maxFeePerGas) {
    return reject(REJECTION_CODES.INVALID_FEE, "priority tip above max fee", "fees");
  }
  return {
    ok: true,
    tx: { chainId, to, data, value, nonce, gasLimit, type, maxFeePerGas, maxPriorityFeePerGas },
  };
}

/**
 * Aprobă o identitate completă de tranzacție: validează, îngheață snapshot-ul
 * canonic și produce fingerprint-ul (keccak256).
 */
function approveTx(raw) {
  const v = validateTx(raw);
  if (!v.ok) return v;
  return { ok: true, tx: Object.freeze({ ...v.tx }), fingerprint: fingerprintTx(v.tx) };
}

/**
 * Aprobarea conținutului (înainte de rezervarea nonce-ului): chainId/to/data/
 * value/gasLimit. Mutația ulterioară a oricăruia => TX_MUTATED la verificare.
 */
function approveContent(raw) {
  if (raw == null || typeof raw !== "object") {
    return reject(REJECTION_CODES.MISSING_TX, "content missing or not an object");
  }
  const chainId = toChainIdOrNull(raw.chainId);
  if (chainId === null || chainId !== EXPECTED_CHAIN_ID) {
    return reject(REJECTION_CODES.INVALID_CHAIN_ID, `chainId must be ${EXPECTED_CHAIN_ID}`, "chainId");
  }
  const to = normAddress(raw.to);
  if (to === null) {
    return reject(REJECTION_CODES.INVALID_TARGET, "missing/malformed/zero target address", "to");
  }
  const sel = validateSelectorData(raw.data);
  if (!sel.ok) return sel;
  const value = toBigIntOrNull(raw.value);
  if (value === null || value < 0n) {
    return reject(REJECTION_CODES.INVALID_VALUE, "missing/malformed/negative value", "value");
  }
  const gasLimit = toBigIntOrNull(raw.gasLimit);
  if (gasLimit === null || gasLimit <= 0n) {
    return reject(REJECTION_CODES.INVALID_GAS_LIMIT, "missing/malformed/zero gasLimit", "gasLimit");
  }
  const content = Object.freeze({ chainId, to, data: raw.data.toLowerCase(), value, gasLimit });
  return { ok: true, content, fingerprint: fingerprintContent(content) };
}

/**
 * Verifică o tranzacție candidată contra identității aprobate. Orice diferență
 * semantică (inclusiv un singur octet din calldata) => TX_MUTATED cu câmpul.
 * Candidatul structural invalid => TX_MUTATED field="malformed".
 */
function verifyTx(approved, candidate) {
  const v = validateTx(candidate);
  if (!v.ok) {
    return { ok: false, rejection: { code: REJECTION_CODES.TX_MUTATED, reason: v.rejection.reason, field: v.rejection.field || "malformed" } };
  }
  const a = canonicalParts(approved.tx);
  const c = canonicalParts(v.tx);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== c[i]) {
      return { ok: false, rejection: { code: REJECTION_CODES.TX_MUTATED, reason: `field mutated: ${FIELDS[i]}`, field: FIELDS[i] } };
    }
  }
  return { ok: true, tx: v.tx };
}

/**
 * Verifică că o tranzacție completă (aprobată pe o cale de submisie) păstrează
 * EXACT conținutul aprobat (chainId/to/data/value/gasLimit).
 */
function verifyContent(content, fullTx) {
  const a = canonicalContentParts(content);
  const c = canonicalContentParts(fullTx);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== c[i]) {
      return { ok: false, rejection: { code: REJECTION_CODES.TX_MUTATED, reason: `content mutated: ${CONTENT_FIELDS[i]}`, field: CONTENT_FIELDS[i] } };
    }
  }
  return { ok: true };
}

/**
 * RPC consistency: rețeaua provider-ului trebuie să corespundă chainId-ului
 * aprobat. Rețea indisponibilă/lipsă => PROVIDER_NETWORK_UNAVAILABLE.
 * Mismatch => PROVIDER_CHAIN_MISMATCH.
 */
function verifyProviderNetwork(approved, network) {
  if (network == null || typeof network !== "object") {
    return reject(REJECTION_CODES.PROVIDER_NETWORK_UNAVAILABLE, "provider network unavailable");
  }
  const cid = toChainIdOrNull(network.chainId);
  if (cid === null) {
    return reject(REJECTION_CODES.PROVIDER_NETWORK_UNAVAILABLE, "provider network has no usable chainId");
  }
  if (cid !== approved.chainId) {
    return reject(REJECTION_CODES.PROVIDER_CHAIN_MISMATCH, `provider chainId ${cid} != approved ${approved.chainId}`);
  }
  return { ok: true };
}

/** Hash de tranzacție strict (0x + 64 hex) sau null. */
function validateTxHash(h) {
  return typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h) ? h : null;
}

/**
 * Clasifică rezultatul relay-ului privat:
 *   - "accepted"        => ok:true, status:"accepted"
 *   - "failed-definite" => ok:false, status:"failed" (respins ÎNAINTE de
 *                          acceptare — singurul caz cu fallback public permis)
 *   - "ambiguous"       => orice altceva (unknown, missing, malformat)
 */
function classifyRelayResult(result) {
  if (result == null || typeof result !== "object") return "ambiguous";
  if (result.ok === true && result.status === "accepted") return "accepted";
  if (result.ok === false && result.status === "failed") return "failed-definite";
  return "ambiguous";
}

/**
 * Leagă rezultatul relay-ului de identitatea aprobată.
 *
 * TASK 4.6-D-R (LOW-2): signedHash este OBLIGATORIU pentru acceptare.
 * Un txHash "valid-looking" NELEGAT de tranzacția semnată local NU este
 * suficient — lipsă/malformat/neegal cu signedHash => UNKNOWN (fail-closed).
 *   - txHash trebuie să fie format-valid (0x + 64 hex);
 *   - signedHash (hash-ul tranzacției semnate local) trebuie să existe, să fie
 *     format-valid și IDENTIC cu txHash.
 * @returns {ok:true, hash} sau {ok:false, code}
 */
function verifyRelayIdentity(result) {
  if (classifyRelayResult(result) !== "accepted") {
    return { ok: false, code: REJECTION_CODES.AMBIGUOUS_RELAY_RESULT };
  }
  const hash = validateTxHash(result.txHash);
  if (!hash) {
    return { ok: false, code: REJECTION_CODES.INVALID_TX_HASH };
  }
  const sh = validateTxHash(result.signedHash);
  if (!sh || sh.toLowerCase() !== hash.toLowerCase()) {
    // signedHash lipsă, malformat sau neegal cu txHash => identitatea
    // tranzacției semnate-aprobate NU poate fi provată => UNKNOWN.
    return { ok: false, code: REJECTION_CODES.AMBIGUOUS_RELAY_RESULT };
  }
  return { ok: true, hash };
}

/**
 * Leagă record-ul tracker-ului de identitatea aprobată: nonce EXACT același,
 * txHash (dacă există) format-valid.
 */
function verifyTrackerRecord(rec, approvedTx) {
  if (rec == null || typeof rec !== "object") {
    return reject(REJECTION_CODES.TX_MUTATED, "tracker record missing", "tracker");
  }
  const recNonce = toNonceOrNull(rec.nonce);
  if (recNonce === null || recNonce !== approvedTx.nonce) {
    return reject(REJECTION_CODES.TX_MUTATED, "tracker nonce != approved nonce", "nonce");
  }
  if (rec.txHash !== null && rec.txHash !== undefined && validateTxHash(rec.txHash) === null) {
    return reject(REJECTION_CODES.INVALID_TX_HASH, "tracker holds malformed txHash", "txHash");
  }
  return { ok: true };
}

module.exports = {
  EXPECTED_CHAIN_ID,
  REJECTION_CODES,
  FIELDS,
  toBigIntOrNull,
  toNonceOrNull,
  toChainIdOrNull,
  isHexData,
  normAddress,
  normType,
  canonicalParts,
  canonicalTx,
  fingerprintTx,
  canonicalContent,
  fingerprintContent,
  validateTx,
  approveTx,
  approveContent,
  verifyTx,
  verifyContent,
  verifyProviderNetwork,
  validateTxHash,
  classifyRelayResult,
  verifyRelayIdentity,
  verifyTrackerRecord,
};

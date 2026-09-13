// TASK 4.6-D — Broadcast Integrity & RPC Consistency.
//
// Stratul formal între cost/gas guard (4.6-C) și broadcast:
//   approved (validated + simulated + estimated) == tracked == broadcast,
//   sau NO BROADCAST. Toate mutațiile neautorizate (inclusiv 1 byte calldata)
//   invalidează identitatea; relay ambiguous => UNKNOWN, fără fallback public.
const { expect } = require("chai");
const bi = require("../../bot/broadcast-integrity");
const bloxroute = require("../../bot/bloxroute"); // API-ul real (LOW-1 coverage)

// Capturează clasele REALE înainte de orice stubbing de module.
const RealNonceManager = require("../../bot/nonce").NonceManager;
const { TransactionTracker } = require("../../bot/tx-tracker");

const CHAIN = 56;
const CONTRACT = "0x" + "f1".repeat(20);
const SELDATA = "0x12345678" + "aa".repeat(32); // selector + words
const H64 = "0x" + "ab".repeat(32);
const H64B = "0x" + "cd".repeat(32);
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const BASE = "0x" + "9a".repeat(20);
const E18 = 10n ** 18n;
const WALLET_A = "0x" + "e1".repeat(20);

const LEGACY = {
  chainId: CHAIN, to: CONTRACT, data: SELDATA, value: 0n, nonce: 7,
  gasLimit: 120000n, type: 0, gasPrice: 3000000000n,
};
const E1559 = {
  chainId: CHAIN, to: CONTRACT, data: SELDATA, value: 0n, nonce: 7,
  gasLimit: 120000n, type: 2, maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n,
};

// --- Fixture opportunity (profitabilă, model 4.5-D) -------------------------
function makeDiOpp(over = {}) {
  const tokWbnb = { address: WBNB, decimals: 18, symbol: "WBNB" };
  const tokBase = { address: BASE, decimals: 18, symbol: "BASE" };
  return {
    sourceKind: "v2",
    borrowToken: tokWbnb,
    baseToken: tokBase,
    borrowAmount: 1000n * E18,
    minProfit: 5n * E18,
    minOutA: 990n * E18,
    minOutB: 1980n * E18,
    sourceVen: { kind: "v2", pair: "0x" + "a1".repeat(20), tokenA: tokWbnb, tokenB: tokBase, feeBps: 25, blockNumber: 100 },
    buyVen: { kind: "v2", router: "0x" + "b2".repeat(20), feeBps: 25, tokenA: tokWbnb, tokenB: tokBase, reserveA: 1_000_000n * E18, reserveB: 1_000_000n * E18, blockNumber: 100 },
    sellVen: { kind: "v2", router: "0x" + "c3".repeat(20), feeBps: 25, tokenA: tokWbnb, tokenB: tokBase, reserveA: 1_000_000n * E18, reserveB: 500_000n * E18, blockNumber: 100 },
    ...over,
  };
}

// buildCalldata cu timp fixat => calldata deterministă pentru mutații țintite.
function withFixedTime(ms, fn) {
  const orig = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = orig; }
}
const FIXED_MS = 1750000000000;
const executor = require("../../bot/executor");
const BASE_CD = withFixedTime(FIXED_MS, () => executor.buildCalldata(makeDiOpp()).data);

function cdMutated(fn) {
  return withFixedTime(FIXED_MS, () => executor.buildCalldata(fn(makeDiOpp())).data);
}

// --- Mock-uri executor (modelul 4.5-D: real nonce + real tracker) -----------
function makeWallet(sent = [], address = WALLET_A, startNonce = 100, sendResult) {
  let n = startNonce;
  return {
    address,
    getAddress: async () => address,
    call: async () => "0x" + "00".repeat(31) + "7b",
    estimateGas: async () => 100000n,
    async getNonce() { return n; },
    sendTransaction(tx) { sent.push(tx); return sendResult || { hash: H64 }; },
  };
}
function makeProvider(opts = {}) {
  return {
    getBlockNumber: async () => 100,
    getFeeData: async () => (opts.feeData || { gasPrice: 1n }),
    getNetwork: opts.network === undefined ? async () => ({ chainId: 56n }) : opts.network,
  };
}
function withIsolatedExecutor(bloxrouteHandler, fn) {
  const paths = {
    scanner: require.resolve("../../bot/scanner"),
    bloxroute: require.resolve("../../bot/bloxroute"),
  };
  const saved = {};
  for (const k of Object.keys(paths)) saved[k] = require.cache[paths[k]];
  const fakeMod = (exports) => ({ id: paths.scanner, filename: paths.scanner, loaded: true, exports });
  require.cache[paths.scanner] = fakeMod({ readState: async () => {}, pairKey: (a, b) => (a < b ? a + b : b + a) });
  require.cache[paths.bloxroute] = fakeMod({
    isAvailable: async () => true,
    sendPrivateTx: bloxrouteHandler,
  });
  delete require.cache[require.resolve("../../bot/executor")];
  const ex = require("../../bot/executor");
  try {
    return fn(ex);
  } finally {
    for (const k of Object.keys(paths)) {
      if (saved[k]) require.cache[paths[k]] = saved[k];
      else delete require.cache[paths[k]];
    }
    delete require.cache[require.resolve("../../bot/executor")];
  }
}

describe("TASK 4.6-D — Broadcast integrity & RPC consistency", function () {
  describe("A — chainId", function () {
    it("1. chainId 56 accepted", function () {
      const r = bi.approveTx(LEGACY);
      expect(r.ok).to.equal(true);
      expect(r.tx.chainId).to.equal(56n);
    });
    it("2. chainId 1 rejected", function () {
      const r = bi.approveTx({ ...LEGACY, chainId: 1 });
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("INVALID_CHAIN_ID");
    });
    it("3. missing chainId rejected", function () {
      const { chainId, ...rest } = LEGACY;
      expect(bi.approveTx(rest).rejection.code).to.equal("INVALID_CHAIN_ID");
    });
    it("4. malformed chainId (string/fractional/negative) rejected", function () {
      expect(bi.approveTx({ ...LEGACY, chainId: "56" }).ok).to.equal(false);
      expect(bi.approveTx({ ...LEGACY, chainId: 56.5 }).ok).to.equal(false);
      expect(bi.approveTx({ ...LEGACY, chainId: -56 }).ok).to.equal(false);
    });
  });

  describe("B — target", function () {
    it("5. zero address rejected at approval", function () {
      const r = bi.approveTx({ ...LEGACY, to: "0x" + "0".repeat(40) });
      expect(r.rejection.code).to.equal("INVALID_TARGET");
    });
    it("6. mutated to rejected (TX_MUTATED field=to)", function () {
      const ap = bi.approveTx(LEGACY);
      const v = bi.verifyTx(ap, { ...LEGACY, to: "0x" + "f2".repeat(20) });
      expect(v.ok).to.equal(false);
      expect(v.rejection.code).to.equal("TX_MUTATED");
      expect(v.rejection.field).to.equal("to");
    });
  });

  describe("C — calldata integrity (buildCalldata real fixture)", function () {
    it("7. unchanged calldata accepted; buildCalldata determinist la timp fixat", function () {
      const again = withFixedTime(FIXED_MS, () => executor.buildCalldata(makeDiOpp()).data);
      expect(again).to.equal(BASE_CD);
      const ap = bi.approveTx({ ...LEGACY, to: CONTRACT, data: BASE_CD });
      expect(bi.verifyTx(ap, { ...LEGACY, data: BASE_CD }).ok).to.equal(true);
    });
    it("8. selector mutation rejected", function () {
      const ap = bi.approveTx({ ...LEGACY, data: BASE_CD });
      const mutated = "0xdeadbeef" + BASE_CD.slice(10);
      const v = bi.verifyTx(ap, { ...LEGACY, data: mutated });
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("data");
    });
    it("9. flashloan amount mutation rejected", function () {
      const ap = bi.approveTx({ ...LEGACY, data: BASE_CD });
      const v = bi.verifyTx(ap, { ...LEGACY, data: cdMutated((o) => ({ ...o, borrowAmount: o.borrowAmount + 1n })) });
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("data");
    });
    it("10. leg mutation rejected (buyVen router)", function () {
      const ap = bi.approveTx({ ...LEGACY, data: BASE_CD });
      const v = bi.verifyTx(ap, { ...LEGACY, data: cdMutated((o) => ({ ...o, buyVen: { ...o.buyVen, router: "0x" + "b4".repeat(20) } })) });
      expect(v.ok).to.equal(false);
    });
    it("11. minOutA mutation rejected", function () {
      const ap = bi.approveTx({ ...LEGACY, data: BASE_CD });
      const v = bi.verifyTx(ap, { ...LEGACY, data: cdMutated((o) => ({ ...o, minOutA: o.minOutA + 1n })) });
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("data");
    });
    it("12. minOutB mutation rejected", function () {
      const ap = bi.approveTx({ ...LEGACY, data: BASE_CD });
      const v = bi.verifyTx(ap, { ...LEGACY, data: cdMutated((o) => ({ ...o, minOutB: o.minOutB + 1n })) });
      expect(v.ok).to.equal(false);
    });
    it("13. minProfit mutation rejected", function () {
      const ap = bi.approveTx({ ...LEGACY, data: BASE_CD });
      const v = bi.verifyTx(ap, { ...LEGACY, data: cdMutated((o) => ({ ...o, minProfit: o.minProfit + 1n })) });
      expect(v.ok).to.equal(false);
    });
    it("14. deadline mutation rejected", function () {
      const ap = bi.approveTx({ ...LEGACY, data: BASE_CD });
      const v = bi.verifyTx(ap, { ...LEGACY, data: withFixedTime(FIXED_MS + 1000, () => executor.buildCalldata(makeDiOpp()).data) });
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("data");
    });
    it("15. one-byte calldata mutation rejected (last byte flip)", function () {
      const ap = bi.approveTx({ ...LEGACY, data: BASE_CD });
      const last = BASE_CD.slice(-1);
      const flipped = last === "a" ? "b" : "a";
      const v = bi.verifyTx(ap, { ...LEGACY, data: BASE_CD.slice(0, -1) + flipped });
      expect(v.ok).to.equal(false);
      expect(v.rejection.code).to.equal("TX_MUTATED");
    });
    it("16. malformed calldata rejected at approval (too short / odd / non-hex)", function () {
      expect(bi.approveTx({ ...LEGACY, data: "0x12" }).rejection.code).to.equal("INVALID_CALLDATA");
      expect(bi.approveTx({ ...LEGACY, data: "0x123" }).rejection.code).to.equal("INVALID_CALLDATA");
      expect(bi.approveTx({ ...LEGACY, data: "0xzz345678" + "aa".repeat(32) }).rejection.code).to.equal("INVALID_CALLDATA");
    });
  });

  describe("D — value", function () {
    it("17. unchanged value accepted", function () {
      const ap = bi.approveTx(LEGACY);
      expect(bi.verifyTx(ap, { ...LEGACY, value: 0n }).ok).to.equal(true);
    });
    it("18. changed value rejected (TX_MUTATED field=value)", function () {
      const ap = bi.approveTx(LEGACY);
      const v = bi.verifyTx(ap, { ...LEGACY, value: 1n });
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("value");
    });
    it("19. negative / fractional value rejected at approval", function () {
      expect(bi.approveTx({ ...LEGACY, value: -1n }).rejection.code).to.equal("INVALID_VALUE");
      expect(bi.approveTx({ ...LEGACY, value: 1.5 }).rejection.code).to.equal("INVALID_VALUE");
    });
  });

  describe("E — nonce", function () {
    it("20. unchanged nonce accepted", function () {
      const ap = bi.approveTx(LEGACY);
      expect(bi.verifyTx(ap, { ...LEGACY, nonce: 7 }).ok).to.equal(true);
    });
    it("21. nonce + 1 rejected", function () {
      const ap = bi.approveTx(LEGACY);
      const v = bi.verifyTx(ap, { ...LEGACY, nonce: 8 });
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("nonce");
    });
    it("22. nonce - 1 rejected", function () {
      const ap = bi.approveTx(LEGACY);
      const v = bi.verifyTx(ap, { ...LEGACY, nonce: 6 });
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("nonce");
    });
  });

  describe("F — gasLimit", function () {
    it("23. unchanged gasLimit accepted", function () {
      const ap = bi.approveTx(LEGACY);
      expect(bi.verifyTx(ap, { ...LEGACY, gasLimit: 120000n }).ok).to.equal(true);
    });
    it("24. increased gasLimit rejected", function () {
      const ap = bi.approveTx(LEGACY);
      const v = bi.verifyTx(ap, { ...LEGACY, gasLimit: 120001n });
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("gasLimit");
    });
    it("25. decreased gasLimit rejected", function () {
      const ap = bi.approveTx(LEGACY);
      const v = bi.verifyTx(ap, { ...LEGACY, gasLimit: 119999n });
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("gasLimit");
    });
  });

  describe("G — fees", function () {
    it("26. unchanged legacy gasPrice accepted", function () {
      const ap = bi.approveTx(LEGACY);
      expect(bi.verifyTx(ap, LEGACY).ok).to.equal(true);
    });
    it("27. mutated legacy gasPrice rejected (TX_MUTATED field=fees)", function () {
      const ap = bi.approveTx(LEGACY);
      const v = bi.verifyTx(ap, { ...LEGACY, gasPrice: 3000000001n });
      expect(v.ok).to.equal(false);
      expect(v.rejection.code).to.equal("TX_MUTATED");
      expect(v.rejection.field).to.equal("fees");
    });
    it("28. unchanged EIP-1559 fees accepted", function () {
      const ap = bi.approveTx(E1559);
      expect(bi.verifyTx(ap, E1559).ok).to.equal(true);
    });
    it("29. mutated maxFeePerGas rejected", function () {
      const ap = bi.approveTx(E1559);
      const v = bi.verifyTx(ap, { ...E1559, maxFeePerGas: 3000000001n });
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("fees");
    });
    it("30. mutated maxPriorityFeePerGas rejected", function () {
      const ap = bi.approveTx(E1559);
      const v = bi.verifyTx(ap, { ...E1559, maxPriorityFeePerGas: 1000000001n });
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("fees");
    });
    it("31. tip above max fee rejected at approval", function () {
      const r = bi.approveTx({ ...E1559, maxPriorityFeePerGas: 3000000001n });
      expect(r.rejection.code).to.equal("INVALID_FEE");
    });
    it("32. mixed fee mechanisms rejected (type 0 + maxFee; type 2 + gasPrice)", function () {
      expect(bi.approveTx({ ...LEGACY, maxFeePerGas: 1n }).rejection.code).to.equal("INVALID_FEE");
      expect(bi.approveTx({ ...E1559, gasPrice: 1n }).rejection.code).to.equal("INVALID_FEE");
    });
  });

  describe("H — transaction type", function () {
    it("33. unchanged type accepted", function () {
      const ap = bi.approveTx(E1559);
      expect(bi.verifyTx(ap, { ...E1559 }).ok).to.equal(true);
    });
    it("34. legacy → EIP-1559 mutation rejected (field=type)", function () {
      const ap = bi.approveTx(LEGACY);
      const v = bi.verifyTx(ap, E1559);
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("type");
    });
    it("35. EIP-1559 → legacy mutation rejected (field=type)", function () {
      const ap = bi.approveTx(E1559);
      const v = bi.verifyTx(ap, LEGACY);
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("type");
    });
  });

  describe("I — RPC consistency (provider chain identity)", function () {
    const ap = bi.approveTx(LEGACY);
    it("36. provider chain 56 accepted", function () {
      expect(bi.verifyProviderNetwork(ap.tx, { chainId: 56n }).ok).to.equal(true);
      expect(bi.verifyProviderNetwork(ap.tx, { chainId: 56 }).ok).to.equal(true);
    });
    it("37. provider chain 1 rejected (PROVIDER_CHAIN_MISMATCH)", function () {
      const r = bi.verifyProviderNetwork(ap.tx, { chainId: 1n });
      expect(r.ok).to.equal(false);
      expect(r.rejection.code).to.equal("PROVIDER_CHAIN_MISMATCH");
    });
    it("38. missing provider network rejected (PROVIDER_NETWORK_UNAVAILABLE)", function () {
      expect(bi.verifyProviderNetwork(ap.tx, null).rejection.code).to.equal("PROVIDER_NETWORK_UNAVAILABLE");
      expect(bi.verifyProviderNetwork(ap.tx, undefined).rejection.code).to.equal("PROVIDER_NETWORK_UNAVAILABLE");
    });
    it("39. network with malformed chainId rejected (PROVIDER_NETWORK_UNAVAILABLE)", function () {
      expect(bi.verifyProviderNetwork(ap.tx, {}).rejection.code).to.equal("PROVIDER_NETWORK_UNAVAILABLE");
      expect(bi.verifyProviderNetwork(ap.tx, { chainId: "0x38" }).rejection.code).to.equal("PROVIDER_NETWORK_UNAVAILABLE");
    });
  });

  describe("J — relay result classification + identity binding", function () {
    it("40. accepted → 'accepted'", function () {
      expect(bi.classifyRelayResult({ ok: true, status: "accepted" })).to.equal("accepted");
    });
    it("41. failed → 'failed-definite'", function () {
      expect(bi.classifyRelayResult({ ok: false, status: "failed", error: "x" })).to.equal("failed-definite");
    });
    it("42. timeout / connection reset (status unknown) → ambiguous", function () {
      expect(bi.classifyRelayResult({ ok: false, status: "unknown", error: "timeout" })).to.equal("ambiguous");
      expect(bi.classifyRelayResult({ ok: false, status: "unknown", error: "ECONNRESET" })).to.equal("ambiguous");
    });
    it("43. null / malformed result → ambiguous", function () {
      expect(bi.classifyRelayResult(null)).to.equal("ambiguous");
      expect(bi.classifyRelayResult(undefined)).to.equal("ambiguous");
      expect(bi.classifyRelayResult("boom")).to.equal("ambiguous");
    });
    it("44. ok:true without recognized status → ambiguous", function () {
      expect(bi.classifyRelayResult({ ok: true })).to.equal("ambiguous");
      expect(bi.classifyRelayResult({ ok: true, status: "weird" })).to.equal("ambiguous");
    });
    it("45. verifyRelayIdentity: valid txHash WITHOUT signedHash → UNKNOWN (LOW-2)", function () {
      // signedHash este OBLIGATORIU — un hash valid-looking nelegat de tranzacția
      // semnată local NU este suficient pentru acceptare (fail-closed).
      const r = bi.verifyRelayIdentity({ ok: true, status: "accepted", txHash: H64 });
      expect(r.ok).to.equal(false);
      expect(r.code).to.equal("AMBIGUOUS_RELAY_RESULT");
    });
    it("46. verifyRelayIdentity: malformed hash → INVALID_TX_HASH", function () {
      expect(bi.verifyRelayIdentity({ ok: true, status: "accepted", txHash: "bundle-123-not-a-hash" }).code).to.equal("INVALID_TX_HASH");
      expect(bi.verifyRelayIdentity({ ok: true, status: "accepted", txHash: "0x" + "ab".repeat(31) }).code).to.equal("INVALID_TX_HASH");
    });
    it("47. verifyRelayIdentity: txHash != signedHash → AMBIGUOUS_RELAY_RESULT", function () {
      const r = bi.verifyRelayIdentity({ ok: true, status: "accepted", txHash: H64, signedHash: H64B });
      expect(r.ok).to.equal(false);
      expect(r.code).to.equal("AMBIGUOUS_RELAY_RESULT");
    });
    it("48. verifyRelayIdentity: txHash == signedHash → ok", function () {
      expect(bi.verifyRelayIdentity({ ok: true, status: "accepted", txHash: H64, signedHash: H64 }).ok).to.equal(true);
    });
  });

  describe("J2 — LOW-2: signedHash OBLIGATORIU pentru acceptare (fail-closed)", function () {
    it("LOW2-1. signedHash valid + matching txHash → accepted", function () {
      const r = bi.verifyRelayIdentity({ ok: true, status: "accepted", txHash: H64, signedHash: H64 });
      expect(r.ok).to.equal(true);
      expect(r.hash).to.equal(H64);
    });
    it("LOW2-2. signedHash valid + mismatching txHash → UNKNOWN", function () {
      const r = bi.verifyRelayIdentity({ ok: true, status: "accepted", txHash: H64, signedHash: H64B });
      expect(r.ok).to.equal(false);
      expect(r.code).to.equal("AMBIGUOUS_RELAY_RESULT");
    });
    it("LOW2-3. missing signedHash + valid txHash → UNKNOWN (never ACCEPTED)", function () {
      const r = bi.verifyRelayIdentity({ ok: true, status: "accepted", txHash: H64 });
      expect(r.ok).to.equal(false);
      expect(r.code).to.equal("AMBIGUOUS_RELAY_RESULT");
    });
    it("LOW2-4. missing signedHash + missing txHash → UNKNOWN", function () {
      const r = bi.verifyRelayIdentity({ ok: true, status: "accepted" });
      expect(r.ok).to.equal(false);
      expect(r.code).to.equal("INVALID_TX_HASH");
    });
    it("LOW2-5. malformed signedHash → UNKNOWN", function () {
      const r = bi.verifyRelayIdentity({ ok: true, status: "accepted", txHash: H64, signedHash: "not-a-hash" });
      expect(r.ok).to.equal(false);
      expect(r.code).to.equal("AMBIGUOUS_RELAY_RESULT");
    });
    it("LOW2-6. malformed txHash → UNKNOWN", function () {
      const r = bi.verifyRelayIdentity({ ok: true, status: "accepted", txHash: "0x1234", signedHash: H64 });
      expect(r.ok).to.equal(false);
      expect(r.code).to.equal("INVALID_TX_HASH");
    });
  });

  describe("K — hash validation", function () {
    it("49. valid 64-hex accepted; wrong length / non-hex / non-string rejected", function () {
      expect(bi.validateTxHash(H64)).to.equal(H64);
      expect(bi.validateTxHash("0x" + "ab".repeat(31))).to.equal(null);
      expect(bi.validateTxHash("0x" + "ab".repeat(33))).to.equal(null);
      expect(bi.validateTxHash("0x" + "zz".repeat(32))).to.equal(null);
      expect(bi.validateTxHash(null)).to.equal(null);
      expect(bi.validateTxHash(12345)).to.equal(null);
    });
  });

  describe("L — immutability & canonical equivalence", function () {
    it("50. reconstructed equivalent (checksummed to, bigint nonce) → same fingerprint", function () {
      const checksummed = require("ethers").getAddress(CONTRACT);
      const a = bi.approveTx(LEGACY);
      const b = bi.approveTx({ ...LEGACY, to: checksummed, nonce: 7n });
      expect(b.fingerprint).to.equal(a.fingerprint);
      expect(bi.verifyTx(a, { ...LEGACY, to: checksummed, nonce: 7n }).ok).to.equal(true);
    });
    it("51. approved snapshot frozen + fingerprint immutable la mutarea inputului", function () {
      const raw = { ...LEGACY };
      const ap = bi.approveTx(raw);
      raw.gasPrice = 999999n; // mutație DUPĂ aprobare — nu afectează snapshot-ul
      expect(ap.fingerprint).to.equal(bi.approveTx(LEGACY).fingerprint);
      expect(() => new Function("tx", '"use strict"; tx.gasPrice = 1n;')(ap.tx)).to.throw();
      expect(Object.isFrozen(ap.tx)).to.equal(true);
      expect(bi.verifyTx(ap, { ...LEGACY, gasPrice: 999999n }).ok).to.equal(false);
    });
    it("52. structurally invalid candidate → TX_MUTATED cu câmpul original", function () {
      const ap = bi.approveTx(LEGACY);
      const v = bi.verifyTx(ap, { ...LEGACY, chainId: "bogus" });
      expect(v.ok).to.equal(false);
      expect(v.rejection.code).to.equal("TX_MUTATED");
      expect(v.rejection.field).to.equal("chainId");
    });
  });

  describe("M — content approval (pre-nonce) & content binding", function () {
    it("53. approveContent deterministic + fingerprint stabil", function () {
      const base = { chainId: CHAIN, to: CONTRACT, data: BASE_CD, value: 0n, gasLimit: 120000n };
      const c1 = bi.approveContent(base);
      const c2 = bi.approveContent(base);
      expect(c1.ok).to.equal(true);
      expect(c1.fingerprint).to.equal(c2.fingerprint);
    });
    it("54. full tx care păstrează conținutul → verifyContent ok", function () {
      const c = bi.approveContent({ chainId: CHAIN, to: CONTRACT, data: BASE_CD, value: 0n, gasLimit: 120000n });
      const full = bi.approveTx({ chainId: CHAIN, to: CONTRACT, data: BASE_CD, value: 0n, nonce: 7, gasLimit: 120000n, type: 0, gasPrice: 1n });
      expect(bi.verifyContent(c.content, full.tx).ok).to.equal(true);
    });
    it("55. mutarea conținutului între aprobare și tx complet → TX_MUTATED cu câmp", function () {
      const c = bi.approveContent({ chainId: CHAIN, to: CONTRACT, data: BASE_CD, value: 0n, gasLimit: 120000n });
      const mutated = bi.approveTx({ chainId: CHAIN, to: CONTRACT, data: BASE_CD, value: 0n, nonce: 7, gasLimit: 120001n, type: 0, gasPrice: 1n });
      const v = bi.verifyContent(c.content, mutated.tx);
      expect(v.ok).to.equal(false);
      expect(v.rejection.field).to.equal("gasLimit");
      const mutatedTo = bi.approveTx({ ...LEGACY, to: "0x" + "f2".repeat(20), data: BASE_CD });
      expect(bi.verifyContent(c.content, mutatedTo.tx).rejection.field).to.equal("to");
    });
    it("56. approveContent validează fail-closed (chain/target/calldata/gas/missing)", function () {
      const base = { chainId: CHAIN, to: CONTRACT, data: BASE_CD, value: 0n, gasLimit: 120000n };
      expect(bi.approveContent({ ...base, chainId: 1 }).rejection.code).to.equal("INVALID_CHAIN_ID");
      expect(bi.approveContent({ ...base, to: "0x0" }).rejection.code).to.equal("INVALID_TARGET");
      expect(bi.approveContent({ ...base, data: "0x12" }).rejection.code).to.equal("INVALID_CALLDATA");
      expect(bi.approveContent({ ...base, gasLimit: 0n }).rejection.code).to.equal("INVALID_GAS_LIMIT");
      expect(bi.approveContent(null).rejection.code).to.equal("MISSING_TX");
    });
  });

  describe("N — tracker binding", function () {
    const ap = bi.approveTx(LEGACY);
    it("57. record cu nonce identic → ok", function () {
      expect(bi.verifyTrackerRecord({ nonce: 7, txHash: null }, ap.tx).ok).to.equal(true);
      expect(bi.verifyTrackerRecord({ nonce: 7, txHash: H64 }, ap.tx).ok).to.equal(true);
    });
    it("58. nonce nepotrivit / record lipsă / txHash malformat → fail-closed", function () {
      expect(bi.verifyTrackerRecord({ nonce: 8, txHash: null }, ap.tx).rejection.field).to.equal("nonce");
      expect(bi.verifyTrackerRecord(null, ap.tx).rejection.code).to.equal("TX_MUTATED");
      expect(bi.verifyTrackerRecord({ nonce: 7, txHash: "not-a-hash" }, ap.tx).rejection.code).to.equal("INVALID_TX_HASH");
    });
  });

  describe("O — LOW-1: nicio primitiv de broadcast privat neprotejat (sendBundle eliminat)", function () {
    it("59. sendBundle NU este exportat din bot/bloxroute (API-ul real reflectă eliminarea)", function () {
      // sendBundle era un primitiv de broadcast care trimitea orice tranzacțiile
      // semnate pe lângă stratul de identitate 4.6-D. Niciun caller nu exista;
      // a fost ELIMINAT complet (nu doar redenumit/ignorat).
      expect(typeof bloxroute.sendBundle).to.equal("undefined");
      // Singurul primitiv privat rămâs (sendPrivateTx) este integrat cu identitatea.
      expect(typeof bloxroute.sendPrivateTx).to.equal("function");
    });
    it("60. bot/bloxroute importă fără eroare și expune doar API-ul validat", function () {
      expect(typeof bloxroute.isAvailable).to.equal("function");
      expect(bloxroute.BLOXROUTE_API).to.be.a("string");
    });
  });
});

// TASK 4.9 — Nonce Lifecycle / Reap Safety (LOW-6 remediation)
// TASK 4.9-B — Receipt Identity (LOW-2) + releaseDropped Authority (LOW-1)
//
// Fail-closed reap semantics:
//   RELEASE RULE:     a COMMITTED (pending) slot is released ONLY by defensible
//                     evidence — a VALID receipt whose transactionHash matches
//                     the tracked hash (status 0/1 => nonce consumed) OR an
//                     explicit releaseDropped() authorized by a TransactionTracker
//                     record in state DROPPED (proof { tracker, recordId }).
//   UNCERTAINTY RULE: receipt == null / RPC error / malformed receipt / foreign
//                     receipt (different transactionHash) NEVER releases the
//                     slot. Absence from a single RPC is not proof of a
//                     definitive drop.
//   AUTHORITY RULE:   raw caller-supplied { reason, source, nonce, chainId,
//                     detectedAt } metadata is NOT sufficient for releaseDropped
//                     — a verifiable link to a real DROPPED lifecycle is
//                     required (TASK 4.9-B, LOW-1).
//
// These tests prove the REAL effect on nonce reuse, not just return values:
// a protected nonce must NOT be allocatable to a new transaction.
const { expect } = require("chai");
const { NonceManager } = require("../../bot/nonce");
const { TransactionTracker } = require("../../bot/tx-tracker");

const WALLET = "0x70997970C51812dc3A010C7d01b50b0429c0d3c8";
const BLOCK_HASH = "0x" + "be".repeat(32);

function makeWallet(address = "0x" + "a1".repeat(20), startNonce = 100) {
  let nonce = startNonce;
  return { address, async getNonce() { return nonce; }, _setNonce(n) { nonce = n; } };
}

function makeManager(opts = {}) {
  const wallet = makeWallet(opts.address, opts.startNonce !== undefined ? opts.startNonce : 100);
  return new NonceManager(wallet, opts.maxPending || 10);
}

const HASH = "0x" + "ab".repeat(32);
const OTHER_HASH = "0x" + "cd".repeat(32);

// provider stub: control getTransactionReceipt / getTransaction per test
function makeProvider({ receipt, tx, receiptThrows = false, txThrows = false }) {
  return {
    async getTransactionReceipt() {
      if (receiptThrows) throw new Error("receipt RPC timeout");
      return receipt;
    },
    async getTransaction() {
      if (txThrows) throw new Error("getTransaction RPC timeout");
      return tx;
    },
  };
}

async function commitPending(mgr, nonce) {
  mgr.commit(nonce, HASH);
  return nonce;
}

// Build a TransactionTracker record in state DROPPED (markDropped with valid
// evidence bound to `nonce` and chainId 56) and return { tracker, id }.
// Used as the verifiable proof for releaseDropped (TASK 4.9-B, LOW-1).
// TASK 4.9-D (LOW-1): default record txHash = HASH so the proof is coherent
// with slots committed via commitPending (hash H); pass overrides.txHash to
// exercise mismatch/casing/tombstone scenarios explicitly.
function droppedTracker(nonce, overrides = {}) {
  const tracker = new TransactionTracker();
  const rec = tracker.create({ wallet: WALLET, nonce });
  tracker.markSubmitted(rec.id, overrides.txHash !== undefined ? overrides.txHash : HASH, { wallet: WALLET });
  tracker.markPending(rec.id, WALLET);
  tracker.markDropped(rec.id, {
    reason: overrides.reason !== undefined ? overrides.reason : "onchain-nonce-advanced",
    source: overrides.source !== undefined ? overrides.source : "tracker-4.8",
    nonce,
    chainId: overrides.chainId !== undefined ? overrides.chainId : 56,
    detectedAt: overrides.detectedAt !== undefined ? overrides.detectedAt : Date.now(),
  }, WALLET);
  return { tracker, id: rec.id, recordId: rec.id };
}

// Build a tracker record that is NOT in state DROPPED (e.g. PENDING / UNKNOWN).
function pendingTracker(nonce) {
  const tracker = new TransactionTracker();
  const rec = tracker.create({ wallet: WALLET, nonce });
  tracker.markSubmitted(rec.id, OTHER_HASH, { wallet: WALLET });
  tracker.markPending(rec.id, WALLET);
  return { tracker, id: rec.id };
}

// A valid receipt FOR the tracked hash (status 0 or 1) with full shape.
function consumedReceipt(status, overrides = {}) {
  return { status, transactionHash: HASH, blockNumber: 500, blockHash: BLOCK_HASH, ...overrides };
}

describe("TASK 4.9 — Nonce Reap Safety (fail-closed)", function () {
  it("TEST 1 — pending + receipt null + getTransaction null => NOT released, NOT reusable", async function () {
    const mgr = makeManager({ startNonce: 10 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const prov = makeProvider({ receipt: null, tx: null });
    await mgr.reap(prov);
    // slot still owned by manager
    expect(mgr.pending.has(n)).to.equal(true);
    // protected: next reserve skips it
    expect(await mgr.reserve()).to.equal(11);
  });

  it("TEST 2 — pending + receipt null + getTransaction present => stays protected", async function () {
    const mgr = makeManager({ startNonce: 20 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const prov = makeProvider({ receipt: null, tx: { hash: HASH, nonce: n } });
    await mgr.reap(prov);
    expect(mgr.pending.has(n)).to.equal(true);
    expect(await mgr.reserve()).to.equal(21);
  });

  it("TEST 3 — pending + receipt status 1 => success lifecycle preserved (nonce consumed)", async function () {
    const mgr = makeManager({ startNonce: 30 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const prov = makeProvider({ receipt: consumedReceipt(1), tx: null });
    await mgr.reap(prov);
    // receipt exists => slot cleared (nonce consumed on-chain)
    expect(mgr.pending.has(n)).to.equal(false);
  });

  it("TEST 4 — pending + receipt status 0 => revert lifecycle preserved, no premature reuse", async function () {
    const mgr = makeManager({ startNonce: 40 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const prov = makeProvider({ receipt: consumedReceipt(0), tx: null });
    await mgr.reap(prov);
    expect(mgr.pending.has(n)).to.equal(false);
  });
  it("TEST 5 — getTransaction() throws => fail-closed, NOT released", async function () {
    const mgr = makeManager({ startNonce: 50 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const prov = makeProvider({ receipt: null, tx: null, txThrows: true });
    await mgr.reap(prov);
    expect(mgr.pending.has(n)).to.equal(true);
    expect(await mgr.reserve()).to.equal(51);
  });

  it("TEST 6 — getTransactionReceipt() throws => fail-closed, NOT released", async function () {
    const mgr = makeManager({ startNonce: 60 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const prov = makeProvider({ receipt: null, tx: null, receiptThrows: true });
    await mgr.reap(prov);
    expect(mgr.pending.has(n)).to.equal(true);
    expect(await mgr.reserve()).to.equal(61);
  });

  it("TEST 7 — temporarily invisible tx (null) => NOT definitively dropped", async function () {
    const mgr = makeManager({ startNonce: 70 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const prov = makeProvider({ receipt: null, tx: null });
    // multiple observations of absence
    await mgr.reap(prov);
    await mgr.reap(prov);
    expect(mgr.pending.has(n)).to.equal(true);
    expect(await mgr.reserve()).to.equal(71);
  });

  it("TEST 8 — repeated reap() cannot turn uncertainty into accidental release", async function () {
    const mgr = makeManager({ startNonce: 80 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const prov = makeProvider({ receipt: null, tx: null });
    for (let i = 0; i < 10; i++) await mgr.reap(prov);
    expect(mgr.pending.has(n)).to.equal(true);
  });

  it("TEST 9 — nonce reuse attempt after uncertain reap is blocked", async function () {
    const mgr = makeManager({ startNonce: 90 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const prov = makeProvider({ receipt: null, tx: null });
    await mgr.reap(prov);
    const next = await mgr.reserve();
    expect(next).to.equal(n + 1);
    expect(next).to.not.equal(n);
    // even attempting to use the old nonce is impossible via the manager
    expect(mgr.pending.has(n)).to.equal(true);
  });

  it("TEST 10 — reconciliation cannot turn uncertainty into free nonce", async function () {
    const mgr = makeManager({ startNonce: 100 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const prov = makeProvider({ receipt: null, tx: null });
    await mgr.reap(prov);
    // reconcile with same chain pending value: next stays monotonic, slot stays
    await mgr.reconcile({ getPendingNonce: async () => n });
    expect(mgr.pending.has(n)).to.equal(true);
    expect(await mgr.reserve()).to.equal(101);
  });
  it("TEST A — valid receipt, matching hash, status 1 => consumed", async function () {
    const mgr = makeManager({ startNonce: 110 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    await mgr.reap(makeProvider({ receipt: consumedReceipt(1), tx: null }));
    expect(mgr.pending.has(n)).to.equal(false);
  });

  it("TEST B — valid receipt, matching hash, status 0 => consumed, NOT reissued as unused", async function () {
    const mgr = makeManager({ startNonce: 115 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    await mgr.reap(makeProvider({ receipt: consumedReceipt(0), tx: null }));
    expect(mgr.pending.has(n)).to.equal(false);
    // revert burns the nonce — the next allocation skips it
    expect(await mgr.reserve()).to.equal(116);
  });

  it("TEST C — truthy receipt WITHOUT transactionHash => protected (LOW-2)", async function () {
    const mgr = makeManager({ startNonce: 120 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const prov = makeProvider({ receipt: { status: 1, blockNumber: 500, blockHash: BLOCK_HASH }, tx: null });
    await mgr.reap(prov);
    expect(mgr.pending.has(n)).to.equal(true);
    expect(await mgr.reserve()).to.equal(121);
  });

  it("TEST D — foreign-hash receipt => protected (LOW-2)", async function () {
    const mgr = makeManager({ startNonce: 125 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const prov = makeProvider({ receipt: { status: 1, transactionHash: OTHER_HASH, blockNumber: 500, blockHash: BLOCK_HASH }, tx: null });
    await mgr.reap(prov);
    expect(mgr.pending.has(n)).to.equal(true);
    expect(await mgr.reserve()).to.equal(126);
  });

  it("TEST E — malformed truthy receipt => protected (LOW-2)", async function () {
    const mgr = makeManager({ startNonce: 130 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    await mgr.reap(makeProvider({ receipt: { foo: 1 }, tx: null }));
    expect(mgr.pending.has(n)).to.equal(true);
    expect(await mgr.reserve()).to.equal(131);
  });

  it("TEST F — receipt null => protected", async function () {
    const mgr = makeManager({ startNonce: 135 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    await mgr.reap(makeProvider({ receipt: null, tx: null }));
    expect(mgr.pending.has(n)).to.equal(true);
  });

  it("TEST G — receipt RPC throws => protected", async function () {
    const mgr = makeManager({ startNonce: 140 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    await mgr.reap(makeProvider({ receipt: null, tx: null, receiptThrows: true }));
    expect(mgr.pending.has(n)).to.equal(true);
    expect(await mgr.reserve()).to.equal(141);
  });

  it("TEST H — foreign receipt then correct receipt: released only after correct receipt", async function () {
    const mgr = makeManager({ startNonce: 145 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    await mgr.reap(makeProvider({ receipt: { status: 1, transactionHash: OTHER_HASH, blockNumber: 500, blockHash: BLOCK_HASH }, tx: null }));
    expect(mgr.pending.has(n)).to.equal(true);
    await mgr.reap(makeProvider({ receipt: consumedReceipt(1), tx: null }));
    expect(mgr.pending.has(n)).to.equal(false);
  });

  it("TEST I — foreign receipt then reserve(): protected nonce cannot be reused", async function () {
    const mgr = makeManager({ startNonce: 150 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    await mgr.reap(makeProvider({ receipt: { status: 1, transactionHash: OTHER_HASH, blockNumber: 500, blockHash: BLOCK_HASH }, tx: null }));
    const next = await mgr.reserve();
    expect(next).to.not.equal(n);
    expect(mgr.pending.has(n)).to.equal(true);
  });

  it("TEST J — shape-valid evidence WITHOUT tracker DROPPED proof => REJECTED (LOW-1)", async function () {
    const mgr = makeManager({ startNonce: 155 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    let err = null;
    try {
      mgr.releaseDropped(n, {
        reason: "onchain-nonce-advanced",
        source: "tracker-4.8",
        nonce: n,
        chainId: 56,
        detectedAt: Date.now(),
      });
    } catch (e) { err = e; }
    expect(err).to.not.equal(null);
    // TASK 4.9-D (LOW-2): the real-TransactionTracker boundary fires BEFORE
    // any metadata validation — raw caller-supplied evidence can never release.
    expect(err.message).to.include("release-invalid-tracker");
    expect(mgr.pending.has(n)).to.equal(true);
    expect(await mgr.reserve()).to.equal(n + 1);
  });

  it("TEST K — tracker record state != DROPPED => REJECTED", async function () {
    const mgr = makeManager({ startNonce: 160 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const { tracker, id } = pendingTracker(n); // PENDING state
    let err = null;
    try { mgr.releaseDropped(n, { tracker, recordId: id }); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-tracker-not-dropped");
    expect(mgr.pending.has(n)).to.equal(true);
  });

  it("TEST L — DROPPED record + nonce mismatch => REJECTED", async function () {
    const mgr = makeManager({ startNonce: 165 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const { tracker, id } = droppedTracker(n + 1); // record nonce differs
    let err = null;
    try { mgr.releaseDropped(n, { tracker, recordId: id }); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-nonce-mismatch");
    expect(mgr.pending.has(n)).to.equal(true);
  });

  it("TEST M — DROPPED record + chainId != 56 => REJECTED", async function () {
    const mgr = makeManager({ startNonce: 170 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const { tracker, id } = droppedTracker(n, { chainId: 1 });
    let err = null;
    try { mgr.releaseDropped(n, { tracker, recordId: id }); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-chain-mismatch");
    expect(mgr.pending.has(n)).to.equal(true);
  });

  it("TEST N — DROPPED record + correct nonce + chain 56 => release ACCEPTED", async function () {
    const mgr = makeManager({ startNonce: 175 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const { tracker, id } = droppedTracker(n);
    const released = mgr.releaseDropped(n, { tracker, recordId: id });
    expect(released).to.equal(n);
    expect(mgr.pending.has(n)).to.equal(false);
  });

  it("TEST O — latest nonce: released ONLY after a valid DROPPED proof; reuse only then", async function () {
    // Half 1: WITHOUT valid proof the slot is released-never — protected.
    const m1 = makeManager({ startNonce: 180 });
    const n = await m1.reserve();
    commitPending(m1, n);
    expect(await m1.reserve()).to.equal(n + 1);
    expect(m1.pending.has(n)).to.equal(true); // still protected
    // Half 2: WITH a valid DROPPED proof the most-recent slot becomes reusable.
    const m2 = makeManager({ startNonce: 180 });
    const n2 = await m2.reserve();
    commitPending(m2, n2);
    const proof = droppedTracker(n2);
    m2.releaseDropped(n2, proof);
    expect(m2.pending.has(n2)).to.equal(false);
    expect(await m2.reserve()).to.equal(n2);
  });
  it("TEST P — replayed proof cannot produce a second release or duplicate reuse", async function () {
    const mgr = makeManager({ startNonce: 185 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const proof = droppedTracker(n);
    mgr.releaseDropped(n, proof);
    expect(mgr.pending.has(n)).to.equal(false);
    // same proof replayed after release => rejected (slot no longer pending)
    let err = null;
    try { mgr.releaseDropped(n, proof); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-not-pending");
    // the released slot was handed out exactly once (single, intentional reuse);
    // normal sequence resumes after it — never duplicated
    expect(await mgr.reserve()).to.equal(n);
    expect(await mgr.reserve()).to.equal(n + 1);
  });

  it("TEST Q — repeated release is rejected / idempotent safe (no DOUBLE reuse)", async function () {
    const mgr = makeManager({ startNonce: 190 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const proof = droppedTracker(n);
    mgr.releaseDropped(n, proof);
    // the single valid release makes the most-recent slot reusable exactly once
    const r = await mgr.reserve();
    expect(r).to.equal(n);
    expect(mgr.reserved.has(n)).to.equal(true); // freshly allocated, not duplicated
    // any repeat release attempt is rejected (slot is not pending anymore)
    let err = null;
    try { mgr.releaseDropped(n, proof); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-not-pending");
  });

  it("TEST R — proof for transaction A cannot release nonce of transaction B", async function () {
    const mgr = makeManager({ startNonce: 195 });
    const a = await mgr.reserve(); // nonce 195 (tx A)
    const b = await mgr.reserve(); // nonce 196 (tx B)
    commitPending(mgr, a);
    commitPending(mgr, b);
    const proofA = droppedTracker(a);
    let err = null;
    try { mgr.releaseDropped(b, proofA); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-nonce-mismatch");
    expect(mgr.pending.has(b)).to.equal(true);
    // correct proof for B releases only B
    const proofB = droppedTracker(b);
    mgr.releaseDropped(b, proofB);
    expect(mgr.pending.has(b)).to.equal(false);
    expect(mgr.pending.has(a)).to.equal(true);
  });

  it("releaseDropped on a non-pending slot is rejected", async function () {
    const mgr = makeManager({ startNonce: 200 });
    const proof = droppedTracker(999);
    let err = null;
    try { mgr.releaseDropped(999, proof); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-not-pending");
  });

  it("releaseDropped on a middle (gapped) slot frees it but does NOT create unsafe gap-reuse", async function () {
    const mgr = makeManager({ startNonce: 205 });
    const a = await mgr.reserve();
    const b = await mgr.reserve();
    commitPending(mgr, a);
    commitPending(mgr, b);
    // release the EARLIER slot a -> no rewind (b is pending -> would create a gap)
    const proofA = droppedTracker(a);
    mgr.releaseDropped(a, proofA);
    expect(mgr.pending.has(a)).to.equal(false);
    // next stays protected above b (no gap reuse)
    expect(await mgr.reserve()).to.equal(207);
  });

  // ---- TASK 4.9-D — LOW-1 (N9C-L1): slot hash ↔ record txHash coherence ----

  it("4.9-D TEST A — matching hashes (slot HASH, record HASH) => release accepted", async function () {
    const mgr = makeManager({ startNonce: 210 });
    const n = await mgr.reserve();
    commitPending(mgr, n); // slot hash HASH
    const { tracker, id } = droppedTracker(n, { txHash: HASH });
    const released = mgr.releaseDropped(n, { tracker, recordId: id });
    expect(released).to.equal(n);
    expect(mgr.pending.has(n)).to.equal(false);
  });

  it("4.9-D TEST B — matching hashes with different casing => accepted", async function () {
    const mgr = makeManager({ startNonce: 215 });
    const n = await mgr.reserve();
    commitPending(mgr, n); // slot hash HASH lowercase
    const upperHex = "0x" + HASH.slice(2).toUpperCase(); // same tx, uppercase hex
    const { tracker, id } = droppedTracker(n, { txHash: upperHex });
    const released = mgr.releaseDropped(n, { tracker, recordId: id });
    expect(released).to.equal(n);
    expect(mgr.pending.has(n)).to.equal(false);
  });

  it("4.9-D TEST C — different hashes => REJECTED, slot intact, no reuse", async function () {
    const mgr = makeManager({ startNonce: 220 });
    const n = await mgr.reserve();
    commitPending(mgr, n); // slot hash HASH
    const nextBefore = mgr.next;
    const blockedBefore = mgr.blocked.size;
    const { tracker, id } = droppedTracker(n, { txHash: OTHER_HASH }); // H2
    let err = null;
    try { mgr.releaseDropped(n, { tracker, recordId: id }); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-txhash-mismatch");
    // invariants: pending intact, next unchanged, blocked unchanged, no reuse
    expect(mgr.pending.has(n)).to.equal(true);
    expect(mgr.next).to.equal(nextBefore);
    expect(mgr.blocked.size).to.equal(blockedBefore);
    expect(await mgr.reserve()).to.equal(n + 1);
  });

  it("4.9-D TEST D — replacement-style H2 record must NOT release HASH slot (audit N9C-L1)", async function () {
    const mgr = makeManager({ startNonce: 225 });
    const n = await mgr.reserve();
    mgr.commit(n, HASH); // ORIGINAL pending transaction hash HASH
    // DROPPED record for the SAME nonce but a DIFFERENT transaction (hash H2)
    const { tracker, id } = droppedTracker(n, { txHash: OTHER_HASH });
    let err = null;
    try { mgr.releaseDropped(n, { tracker, recordId: id }); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-txhash-mismatch");
    // the original HASH slot remains live and protected — nonce NOT reusable
    expect(mgr.pending.has(n)).to.equal(true);
    expect(await mgr.reserve()).to.not.equal(n);
  });

  it("4.9-D TEST E — tombstone null-hash slot keeps 4.9-B semantics", async function () {
    // E1: tombstone slot (hash null) + tombstone DROPPED record (txHash null)
    const mgr = makeManager({ startNonce: 230 });
    const n = await mgr.reserve();
    mgr.commit(n, null); // tombstone slot
    const t = new TransactionTracker();
    const r = t.create({ wallet: WALLET, nonce: n });
    t.transition(r.id, "UNKNOWN");
    t.markDropped(r.id, { reason: "r", source: "s", nonce: n, chainId: 56, detectedAt: Date.now() }, WALLET);
    const released = mgr.releaseDropped(n, { tracker: t, recordId: r.id });
    expect(released).to.equal(n);
    expect(mgr.pending.has(n)).to.equal(false);
    // E2: tombstone slot (hash null) + record WITH a hash => coherence not
    //     applicable (slot hash null), 4.9-B tombstone semantics preserved
    const mgr2 = makeManager({ startNonce: 235 });
    const n2 = await mgr2.reserve();
    mgr2.commit(n2, null);
    const { tracker, id } = droppedTracker(n2, { txHash: HASH });
    const released2 = mgr2.releaseDropped(n2, { tracker, recordId: id });
    expect(released2).to.equal(n2);
    expect(mgr2.pending.has(n2)).to.equal(false);
  });

  // ---- TASK 4.9-D — LOW-2 (N9C-L2): real TransactionTracker boundary -------

  it("4.9-D TEST F — fake duck-typed tracker => REJECTED before any mutation", async function () {
    const mgr = makeManager({ startNonce: 240 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const nextBefore = mgr.next;
    const fake = {
      get: () => ({
        id: "tx-fake",
        state: "DROPPED",
        nonce: n,
        txHash: HASH,
        droppedEvidence: { chainId: 56n, reason: "r", source: "s", detectedAt: Date.now() },
      }),
    };
    let err = null;
    try { mgr.releaseDropped(n, { tracker: fake, recordId: "tx-fake" }); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-invalid-tracker");
    // invariants: pending intact, next unchanged, no reuse
    expect(mgr.pending.has(n)).to.equal(true);
    expect(mgr.next).to.equal(nextBefore);
    expect(await mgr.reserve()).to.equal(n + 1);
  });

  it("4.9-D TEST G — real TransactionTracker accepted (valid DROPPED proof)", async function () {
    const mgr = makeManager({ startNonce: 245 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const { tracker, id } = droppedTracker(n, { txHash: HASH });
    expect(tracker instanceof TransactionTracker).to.equal(true);
    const released = mgr.releaseDropped(n, { tracker, recordId: id });
    expect(released).to.equal(n);
    expect(mgr.pending.has(n)).to.equal(false);
  });

  it("4.9-D TEST H — wrong tracker instance => REJECTED, no nonce mutation", async function () {
    const mgr = makeManager({ startNonce: 250 });
    const n = await mgr.reserve();
    commitPending(mgr, n);
    const nextBefore = mgr.next;
    class FakeTrackerShaped {
      get(id) {
        return {
          id,
          state: "DROPPED",
          nonce: n,
          txHash: HASH,
          droppedEvidence: { chainId: 56n, reason: "r", source: "s", detectedAt: Date.now() },
        };
      }
    }
    const wrong = new FakeTrackerShaped();
    let err = null;
    try { mgr.releaseDropped(n, { tracker: wrong, recordId: "tx-1" }); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-invalid-tracker");
    // invariants: pending intact, next unchanged, no reuse
    expect(mgr.pending.has(n)).to.equal(true);
    expect(mgr.next).to.equal(nextBefore);
    expect(await mgr.reserve()).to.equal(n + 1);
  });

  // ---- TASK 4.9-F — N9E-B1: hashless DROPPED proof must NOT release ------
  // ---- a committed non-tombstone slot ------------------------------------

  it("4.9-F TEST I — committed slot + hashless DROPPED record REJECTED", async function () {
    const mgr = makeManager({ startNonce: 260 });
    const n = await mgr.reserve();
    mgr.commit(n, HASH);
    const t = new TransactionTracker();
    const r = t.create({ wallet: WALLET, nonce: n });
    t.transition(r.id, "UNKNOWN");
    t.markDropped(r.id, { reason: "r", source: "s", nonce: n, chainId: 56, detectedAt: Date.now() }, WALLET);
    const nextBefore = mgr.next;
    const blockedBefore = mgr.blocked.size;
    let err = null;
    try { mgr.releaseDropped(n, { tracker: t, recordId: r.id }); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-missing-txhash");
    expect(mgr.pending.has(n)).to.equal(true);
    expect(mgr.next).to.equal(nextBefore);
    expect(mgr.blocked.size).to.equal(blockedBefore);
    expect(await mgr.reserve()).to.equal(n + 1);
  });

  it("4.9-F TEST J — committed slot + different txHash H2 REJECTED", async function () {
    const mgr = makeManager({ startNonce: 265 });
    const n = await mgr.reserve();
    mgr.commit(n, HASH);
    const nextBefore = mgr.next;
    const { tracker, id } = droppedTracker(n, { txHash: OTHER_HASH });
    let err = null;
    try { mgr.releaseDropped(n, { tracker, recordId: id }); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-txhash-mismatch");
    expect(mgr.pending.has(n)).to.equal(true);
    expect(mgr.next).to.equal(nextBefore);
    expect(await mgr.reserve()).to.equal(n + 1);
  });

  it("4.9-F TEST K — committed slot + exact matching txHash ACCEPTED", async function () {
    const mgr = makeManager({ startNonce: 270 });
    const n = await mgr.reserve();
    mgr.commit(n, HASH);
    const { tracker, id } = droppedTracker(n, { txHash: HASH });
    const released = mgr.releaseDropped(n, { tracker, recordId: id });
    expect(released).to.equal(n);
    expect(mgr.pending.has(n)).to.equal(false);
  });

  it("4.9-F TEST L — committed slot + uppercase txHash ACCEPTED", async function () {
    const mgr = makeManager({ startNonce: 275 });
    const n = await mgr.reserve();
    mgr.commit(n, HASH);
    const upperHex = "0x" + HASH.slice(2).toUpperCase();
    const { tracker, id } = droppedTracker(n, { txHash: upperHex });
    const released = mgr.releaseDropped(n, { tracker, recordId: id });
    expect(released).to.equal(n);
    expect(mgr.pending.has(n)).to.equal(false);
  });

  it("4.9-F TEST M — tombstone slot + null record txHash ACCEPTED", async function () {
    const mgr = makeManager({ startNonce: 280 });
    const n = await mgr.reserve();
    mgr.commit(n, null);
    const t = new TransactionTracker();
    const r = t.create({ wallet: WALLET, nonce: n });
    t.transition(r.id, "UNKNOWN");
    t.markDropped(r.id, { reason: "r", source: "s", nonce: n, chainId: 56, detectedAt: Date.now() }, WALLET);
    const released = mgr.releaseDropped(n, { tracker: t, recordId: r.id });
    expect(released).to.equal(n);
    expect(mgr.pending.has(n)).to.equal(false);
  });

  it("4.9-F TEST N — tombstone slot + non-null record txHash ACCEPTED", async function () {
    const mgr = makeManager({ startNonce: 285 });
    const n = await mgr.reserve();
    mgr.commit(n, null);
    const { tracker, id } = droppedTracker(n, { txHash: HASH });
    const released = mgr.releaseDropped(n, { tracker, recordId: id });
    expect(released).to.equal(n);
    expect(mgr.pending.has(n)).to.equal(false);
  });

  it("4.9-F TEST O — hashless proof cannot release, next reserve is N+1", async function () {
    const mgr = makeManager({ startNonce: 290 });
    const n = await mgr.reserve();
    mgr.commit(n, HASH);
    const t = new TransactionTracker();
    const r = t.create({ wallet: WALLET, nonce: n });
    t.transition(r.id, "UNKNOWN");
    t.markDropped(r.id, { reason: "r", source: "s", nonce: n, chainId: 56, detectedAt: Date.now() }, WALLET);
    let err = null;
    try { mgr.releaseDropped(n, { tracker: t, recordId: r.id }); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-missing-txhash");
    expect(await mgr.reserve()).to.equal(n + 1);
  });

  it("4.9-F TEST P — hashless reject then valid proof accept same slot", async function () {
    const mgr = makeManager({ startNonce: 295 });
    const n = await mgr.reserve();
    mgr.commit(n, HASH);
    const t1 = new TransactionTracker();
    const r1 = t1.create({ wallet: WALLET, nonce: n });
    t1.transition(r1.id, "UNKNOWN");
    t1.markDropped(r1.id, { reason: "r", source: "s", nonce: n, chainId: 56, detectedAt: Date.now() }, WALLET);
    let err = null;
    try { mgr.releaseDropped(n, { tracker: t1, recordId: r1.id }); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-missing-txhash");
    expect(mgr.pending.has(n)).to.equal(true);
    const { tracker, id } = droppedTracker(n, { txHash: HASH });
    const released = mgr.releaseDropped(n, { tracker, recordId: id });
    expect(released).to.equal(n);
    expect(mgr.pending.has(n)).to.equal(false);
  });

  it("4.9-F TEST Q — adversarial record shapes on committed slot REJECT", async function () {
    const shapes = [
      { label: "missing txHash", build: (rec) => { delete rec.txHash; } },
      { label: "empty txHash", build: (rec) => { rec.txHash = ""; } },
      { label: "whitespace txHash", build: (rec) => { rec.txHash = "   "; } },
    ];
    for (let i = 0; i < shapes.length; i++) {
      const mgr = makeManager({ startNonce: 300 + i * 10 });
      const n = await mgr.reserve();
      mgr.commit(n, HASH);
      const t = new TransactionTracker();
      const r = t.create({ wallet: WALLET, nonce: n });
      t.markSubmitted(r.id, HASH, { wallet: WALLET });
      t.markPending(r.id, WALLET);
      t.markDropped(r.id, { reason: "r", source: "s", nonce: n, chainId: 56, detectedAt: Date.now() }, WALLET);
      shapes[i].build(t._records.get(r.id));
      const nextBefore = mgr.next;
      const blockedBefore = mgr.blocked.size;
      let err = null;
      try { mgr.releaseDropped(n, { tracker: t, recordId: r.id }); } catch (e) { err = e; }
      expect(err, shapes[i].label).to.not.equal(null);
      expect(err.message, shapes[i].label).to.match(/release-missing-txhash|release-invalid-identity|release-txhash-mismatch/);
      expect(mgr.pending.has(n), shapes[i].label).to.equal(true);
      expect(mgr.next, shapes[i].label).to.equal(nextBefore);
      expect(mgr.blocked.size, shapes[i].label).to.equal(blockedBefore);
      expect(await mgr.reserve(), shapes[i].label).to.equal(n + 1);
    }
  });

  it("4.9-F TEST R — record txHash undefined on committed slot REJECTED", async function () {
    const mgr = makeManager({ startNonce: 340 });
    const n = await mgr.reserve();
    mgr.commit(n, HASH);
    const t = new TransactionTracker();
    const r = t.create({ wallet: WALLET, nonce: n });
    t.markSubmitted(r.id, HASH, { wallet: WALLET });
    t.markPending(r.id, WALLET);
    t.markDropped(r.id, { reason: "r", source: "s", nonce: n, chainId: 56, detectedAt: Date.now() }, WALLET);
    t._records.get(r.id).txHash = undefined;
    const nextBefore = mgr.next;
    let err = null;
    try { mgr.releaseDropped(n, { tracker: t, recordId: r.id }); } catch (e) { err = e; }
    expect(err && err.message).to.include("release-missing-txhash");
    expect(mgr.pending.has(n)).to.equal(true);
    expect(mgr.next).to.equal(nextBefore);
    expect(await mgr.reserve()).to.equal(n + 1);
  });
});

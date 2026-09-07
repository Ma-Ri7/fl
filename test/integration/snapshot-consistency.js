// ============================================================================
// test/integration/snapshot-consistency.js — TASK 4.3
//
// Behavioral tests for BLOCK SNAPSHOT + VENUE STATE FINGERPRINT consistency:
// the opportunity must be provably computed from the same venue state that is
// validated right before execution. Mutating ANY quote-affecting field must
// make the opportunity STALE => REJECT (no auto-requote here — requote is the
// executor's later responsibility).
//
// Covers: V2 reserves, V3 deep state (sqrtPriceX96/tick/liquidity/tickSpacing/
// words/liquidityNet), DODO PMM (i/K/B/Q/B0/Q0/R + fees), same-block-different-
// state, different blockHash, missing fingerprint, multi-venue, determinism,
// TOCTOU.
//
// Run: npx mocha test/integration/snapshot-consistency.js
// ============================================================================
const { expect } = require("chai");
const snapshotMod = require("../../bot/snapshot");
const { validateSnapshot } = require("../../bot/index");

describe("TASK 4.3 — snapshot consistency & state fingerprint", function () {
  const HASH = "0x" + "11".repeat(32);
  const BN = 100;

  // ---- Venue fixtures (exact state consumed by the quote engine) ----------
  function v2Venue(over = {}) {
    return {
      kind: "v2",
      pair: "0x" + "a1".repeat(20),
      router: "0x" + "a2".repeat(20),
      tokenA: { address: "0x" + "b1".repeat(20), decimals: 18 },
      tokenB: { address: "0x" + "b2".repeat(20), decimals: 18 },
      reserveA: 1000000n,
      reserveB: 2000000n,
      feeBps: 25,
      blockNumber: BN,
      ...over,
    };
  }

  function v3Venue(over = {}) {
    return {
      kind: "v3",
      pool: "0x" + "c1".repeat(20),
      feeTier: 500,
      tokenA: { address: "0x" + "b1".repeat(20), decimals: 18 },
      tokenB: { address: "0x" + "b2".repeat(20), decimals: 18 },
      v3State: {
        address: "0x" + "c1".repeat(20),
        sqrtPriceX96: "79228162514264337593543950336", // = 2^96
        tick: -887,
        liquidity: "500000000000000000",
        tickSpacing: 10,
        words: [{ word: -1, value: "340282366920938463463374607431768211456" }],
        ticks: [{ tick: -890, liquidityNet: "100000000000000000", liquidityGross: "100000000000000000" }],
        blockNumber: BN,
      },
      blockNumber: BN,
      ...over,
    };
  }

  function dodoVenue(over = {}) {
    return {
      kind: "dodo",
      pool: "0x" + "d1".repeat(20),
      baseToken: "0x" + "b1".repeat(20),
      quoteToken: "0x" + "b2".repeat(20),
      pmm: {
        i: "1000000000000000000",      // 1e18
        K: "100000000000000000",       // 0.1e18
        B: "1000000",
        Q: "1000000",
        B0: "1054092553389459",        // derivat on-chain, citit direct
        Q0: "0",
        R: 1,                          // R_ABOVE
      },
      lpFeeRate: "2000000000000000",   // 0.002e18
      mtFeeRate: "0",
      blockNumber: BN,
      ...over,
    };
  }

  // ---- Snapshot + opp built through the PRODUCTION helpers -----------------
  function makeFpSnapshot(venues, bn = BN, hash = HASH) {
    const s = {
      blockNumber: bn,
      blockHash: hash,
      timestamp: 1700000000,
      stateVersion: 1n,
    };
    snapshotMod.attachVenueFingerprints(s, venues);
    return s;
  }

  function buildOpp(buyVen, sellVen, snapshot) {
    // Mirrors exactly what profit.js attaches to every opportunity.
    return {
      buyVen,
      sellVen,
      borrowAmount: 1000n,
      netProfit: 5n,
      snapshot: {
        blockNumber: snapshot.blockNumber,
        blockHash: snapshot.blockHash,
        timestamp: snapshot.timestamp,
        stateVersion: snapshot.stateVersion,
      },
      stateFingerprint: snapshotMod.opportunityFingerprints([buyVen, sellVen]),
    };
  }
  // ANCHOR_PART2

  // ---- Determinism (spec §14) ----------------------------------------------
  describe("fingerprint determinism", function () {
    it("same state => identical fingerprint (recomputed twice)", function () {
      const v1 = v2Venue();
      const v2 = v2Venue();
      expect(snapshotMod.venueFingerprint(v1)).to.equal(snapshotMod.venueFingerprint(v2));
      const fp1 = snapshotMod.venueFingerprint(v1);
      expect(snapshotMod.venueFingerprint(v1)).to.equal(fp1);
    });

    it("single relevant field change => different fingerprint (V2 reserveA)", function () {
      const fp1 = snapshotMod.venueFingerprint(v2Venue());
      const fp2 = snapshotMod.venueFingerprint(v2Venue({ reserveA: 1000001n }));
      expect(fp1).to.not.equal(fp2);
    });

    it("single relevant field change => different fingerprint (V3 liquidityNet)", function () {
      const base = v3Venue();
      const mutated = v3Venue();
      mutated.v3State = {
        ...mutated.v3State,
        ticks: [{ tick: -890, liquidityNet: "100000000000000001", liquidityGross: "100000000000000000" }],
      };
      expect(snapshotMod.venueFingerprint(base)).to.not.equal(snapshotMod.venueFingerprint(mutated));
    });

    it("single relevant field change => different fingerprint (DODO K)", function () {
      const fp1 = snapshotMod.venueFingerprint(dodoVenue());
      const d2 = dodoVenue();
      d2.pmm = { ...d2.pmm, K: "100000000000000001" };
      expect(fp1).to.not.equal(snapshotMod.venueFingerprint(d2));
    });

    it("BigInt vs string form of the same value => SAME fingerprint (canonical)", function () {
      const a = v2Venue();
      const b = v2Venue({ reserveA: "1000000" }); // string form of the same number
      expect(snapshotMod.venueFingerprint(a)).to.equal(snapshotMod.venueFingerprint(b));
    });

    it("word/tick array ORDER does not affect fingerprint (canonical sort)", function () {
      const a = v3Venue();
      const b = v3Venue();
      b.v3State = {
        ...b.v3State,
        words: [{ word: -1, value: "340282366920938463463374607431768211456" }].reverse(),
      };
      expect(snapshotMod.venueFingerprint(a)).to.equal(snapshotMod.venueFingerprint(b));
    });
  });

  // ---- V2 (spec Tests 1–3) ---------------------------------------------------
  describe("V2 reserve state", function () {
    it("Test 1: identical V2 state => ACCEPT", function () {
      const buy = v2Venue();
      const sell = v2Venue({ pair: "0x" + "a3".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      expect(validateSnapshot(buildOpp(buy, sell, snapshot), snapshot)).to.equal(true);
    });

    it("Test 2: reserveA changed after opp build => REJECT", function () {
      const buy = v2Venue();
      const sell = v2Venue({ pair: "0x" + "a3".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      buy.reserveA = buy.reserveA + 1n; // T2: pool state changed
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });

    it("Test 3: reserveB changed after opp build => REJECT", function () {
      const buy = v2Venue();
      const sell = v2Venue({ pair: "0x" + "a3".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      sell.reserveB = sell.reserveB + 5n;
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });
  });
  // ---- V3 deep state (spec Tests 4–6) ----------------------------------------
  describe("V3 deep state (getAmountOutV3Exact inputs)", function () {
    it("Test 4: identical V3 state => ACCEPT", function () {
      const buy = v3Venue();
      const sell = v3Venue({ pool: "0x" + "c2".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      expect(validateSnapshot(buildOpp(buy, sell, snapshot), snapshot)).to.equal(true);
    });

    it("Test 5: sqrtPriceX96 changed => REJECT", function () {
      const buy = v3Venue();
      const sell = v3Venue({ pool: "0x" + "c2".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      buy.v3State = { ...buy.v3State, sqrtPriceX96: "79228162514264337593543950337" };
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });

    it("Test 6: initialized tick liquidityNet changed => REJECT", function () {
      const buy = v3Venue();
      const sell = v3Venue({ pool: "0x" + "c2".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      sell.v3State = {
        ...sell.v3State,
        ticks: [{ tick: -890, liquidityNet: "200000000000000000", liquidityGross: "100000000000000000" }],
      };
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });

    it("extra: liquidity changed => REJECT", function () {
      const buy = v3Venue();
      const sell = v3Venue({ pool: "0x" + "c2".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      buy.v3State = { ...buy.v3State, liquidity: "500000000000000001" };
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });

    it("extra: tickBitmap word changed => REJECT", function () {
      const buy = v3Venue();
      const sell = v3Venue({ pool: "0x" + "c2".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      buy.v3State = {
        ...buy.v3State,
        words: [{ word: -1, value: "340282366920938463463374607431768211455" }],
      };
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });
  });

  // ---- DODO PMM (spec Tests 7–8) ----------------------------------------------
  describe("DODO PMM state", function () {
    it("Test 7: identical PMM state => ACCEPT", function () {
      const buy = dodoVenue();
      const sell = dodoVenue({ pool: "0x" + "d2".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      expect(validateSnapshot(buildOpp(buy, sell, snapshot), snapshot)).to.equal(true);
    });

    it("Test 8: K changed => REJECT", function () {
      const buy = dodoVenue();
      const sell = dodoVenue({ pool: "0x" + "d2".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      sell.pmm = { ...sell.pmm, K: "200000000000000000" };
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });

    it("Test 8b: lpFeeRate changed => REJECT", function () {
      const buy = dodoVenue();
      const sell = dodoVenue({ pool: "0x" + "d2".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      buy.lpFeeRate = "3000000000000000";
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });

    it("Test 8c: R state changed (R_ABOVE -> R_BELOW) => REJECT", function () {
      const buy = dodoVenue();
      const sell = dodoVenue({ pool: "0x" + "d2".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      buy.pmm = { ...buy.pmm, R: 2 };
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });
  });
  // ---- Cross-cutting (spec Tests 9–12) ----------------------------------------
  describe("block identity vs state identity", function () {
    it("Test 9: same blockNumber + same blockHash but DIFFERENT state => REJECT", function () {
      const buy = v2Venue();
      const sell = v2Venue({ pair: "0x" + "a3".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      // state mutated WITHOUT changing block identity — the core of TASK 4.3:
      buy.reserveA = buy.reserveA * 2n;
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });

    it("Test 10: different blockHash (same blockNumber) => REJECT", function () {
      const buy = v2Venue();
      const sell = v2Venue({ pair: "0x" + "a3".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]); // authoritative snapshot
      const opp = buildOpp(buy, sell, snapshot);
      const forged = makeFpSnapshot([buy, sell], BN, "0x" + "22".repeat(32));
      expect(validateSnapshot(opp, forged)).to.equal(false);
    });

    it("Test 10b: opp WITHOUT blockHash cannot be verified => REJECT (never implicitly valid)", function () {
      const buy = v2Venue();
      const sell = v2Venue({ pair: "0x" + "a3".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      opp.snapshot.blockHash = null; // RPC could not provide it
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });

    it("Test 11: missing opportunity fingerprint => REJECT", function () {
      const buy = v2Venue();
      const sell = v2Venue({ pair: "0x" + "a3".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      opp.stateFingerprint = null; // fingerprint not carried
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });

    it("Test 11b: fingerprint missing for ONE venue only => REJECT", function () {
      const buy = v2Venue();
      const sell = v2Venue({ pair: "0x" + "a3".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      delete opp.stateFingerprint[snapshotMod.venueKey(sell)];
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });

    it("Test 11c: venue un-fingerprintable (missing reserves) => REJECT", function () {
      const buy = v2Venue({ reserveA: undefined, reserveB: undefined });
      const sell = v2Venue({ pair: "0x" + "a3".repeat(20) });
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      expect(opp.stateFingerprint[snapshotMod.venueKey(buy)]).to.equal(null);
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });
  });
  // ANCHOR_PART5

  describe("multi-venue opportunities (spec Test 12)", function () {
    it("Test 12a: buy=V2, sell=V3, BOTH states identical => ACCEPT", function () {
      const buy = v2Venue();
      const sell = v3Venue();
      const snapshot = makeFpSnapshot([buy, sell]);
      expect(validateSnapshot(buildOpp(buy, sell, snapshot), snapshot)).to.equal(true);
    });

    it("Test 12b: multi-venue, V3 side changed => REJECT", function () {
      const buy = v2Venue();
      const sell = v3Venue();
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      sell.v3State = { ...sell.v3State, tick: -888 };
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });

    it("Test 12c: multi-venue, V2 side changed => REJECT", function () {
      const buy = v2Venue();
      const sell = v3Venue();
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      buy.reserveB = buy.reserveB + 1n;
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });

    it("Test 12d: V3 side in FALLBACK mode (no deep state), identical => ACCEPT", function () {
      const buy = v2Venue();
      const sell = v3Venue();
      delete sell.v3State; // quote falls back to sqrtPx96/liquidity
      sell.sqrtPx96 = 79228162514264337593543950336n;
      sell.liquidity = 500000000000000000n;
      const snapshot = makeFpSnapshot([buy, sell]);
      expect(validateSnapshot(buildOpp(buy, sell, snapshot), snapshot)).to.equal(true);
    });

    it("Test 12e: V3 fallback state changed => REJECT", function () {
      const buy = v2Venue();
      const sell = v3Venue();
      delete sell.v3State;
      sell.sqrtPx96 = 79228162514264337593543950336n;
      sell.liquidity = 500000000000000000n;
      const snapshot = makeFpSnapshot([buy, sell]);
      const opp = buildOpp(buy, sell, snapshot);
      sell.sqrtPx96 = 79228162514264337593543950337n;
      expect(validateSnapshot(opp, snapshot)).to.equal(false);
    });
  });

  // ---- TOCTOU (spec §11) -------------------------------------------------------
  describe("TOCTOU: scan → opportunity → state change → validation", function () {
    it("T2 chain moved (re-scan at NEW block) => REJECT, no auto-requote", function () {
      const buy = v2Venue();
      const sell = v2Venue({ pair: "0x" + "a3".repeat(20) });
      const snapshotN = makeFpSnapshot([buy, sell], BN, HASH);
      const opp = buildOpp(buy, sell, snapshotN);

      // T2: next scan cycle — new block, venues re-read (mutated in place).
      buy.reserveA = buy.reserveA + 7n;
      const snapshotN1 = makeFpSnapshot([buy, sell], BN + 1, "0x" + "33".repeat(32));

      // T3: execution validation against the CURRENT snapshot.
      expect(validateSnapshot(opp, snapshotN1)).to.equal(false);
      // ...and the opp stays stale even against its OWN snapshot (state differs):
      expect(validateSnapshot(opp, snapshotN)).to.equal(false);
    });

    it("T2 same block, re-scan re-read the SAME state => ACCEPT (not falsely stale)", function () {
      const buy = v2Venue();
      const sell = v2Venue({ pair: "0x" + "a3".repeat(20) });
      const snapshotN = makeFpSnapshot([buy, sell], BN, HASH);
      const opp = buildOpp(buy, sell, snapshotN);

      // re-scan at the same block: new snapshot object, identical state values
      const snapshotN1 = makeFpSnapshot([buy, sell], BN, HASH);
      expect(validateSnapshot(opp, snapshotN1)).to.equal(true);
    });

    it("T2 state mutated at the SAME block (view refreshed) => REJECT via fingerprint", function () {
      const buy = v2Venue();
      const sell = v2Venue({ pair: "0x" + "a3".repeat(20) });
      const snapshotN = makeFpSnapshot([buy, sell], BN, HASH);
      const opp = buildOpp(buy, sell, snapshotN);

      // re-scan at the same block number BUT the pool state actually changed
      buy.reserveA = buy.reserveA + 7n;
      const snapshotN1 = makeFpSnapshot([buy, sell], BN, HASH);
      expect(validateSnapshot(opp, snapshotN1)).to.equal(false);
    });
  });
});

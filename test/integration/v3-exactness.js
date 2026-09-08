const { expect } = require("chai");
const v3lib = require("../../lib/v3");

const SPACING = 10;
const FEE = 500;
const LIQUIDITY = 500000000000000000n;
const SQRT_LO = v3lib.getSqrtRatioAtTick(-890);
const SQRT_HI = v3lib.getSqrtRatioAtTick(-880);
const SQRT_PX96 = SQRT_LO + (SQRT_HI - SQRT_LO) / 2n;
const SQRT_880 = v3lib.getSqrtRatioAtTick(-880);
const SQRT_890 = v3lib.getSqrtRatioAtTick(-890);
const SQRT_PX96_880 = SQRT_890 + (SQRT_880 - SQRT_890) / 2n;
const TICK = -890;

function setup(wordsMap, tick, over) {
  const params = {
    amountIn: 1000n,
    zeroForOne: false,
    fee: FEE,
    tickSpacing: SPACING,
    words: wordsMap,
    ticks: new Map(),
    sqrtPx96: SQRT_PX96,
    liquidity: LIQUIDITY,
    tick: tick,
  };
  if (over) Object.assign(params, over);
  return params;
}

function expectGt(a, b) { expect(a > b, a.toString()+" > "+b.toString()).to.be.true; }
function expectGte(a, b) { expect(a >= b, a.toString()+" >= "+b.toString()).to.be.true; }
function expectEq(a, b) { expect(a === b, a.toString()+" === "+b.toString()).to.be.true; }

/**
 * TASK 4.4-A-FIX — the exact engine now FAILS CLOSED on a bitmap word that is
 * absent from the Map (UNKNOWN) instead of treating it as 0n (EMPTY).
 *
 * These fixtures therefore build a COMPLETE bitmap: every word in the pool's
 * whole tick range is present, EMPTY (0n) unless it carries one of our
 * initialized ticks. That is the honest precondition for testing pure
 * tick-crossing math — "the bitmap is fully known" — and it no longer relies
 * on absent words being silently read as empty. Traversal then terminates at
 * the MIN/MAX price clamp exactly like a real pool.
 *
 * Incomplete-bitmap behaviour is covered separately by the
 * "UNKNOWN bitmap word fails closed" suite below.
 */
const WORD_LO = -400;
const WORD_HI = 400;

function completeBitmap() {
  const m = new Map();
  for (let w = WORD_LO; w <= WORD_HI; w++) m.set(w, 0n);
  return m;
}

function buildTicksUp(n, tick) {
  const ticks = new Map();
  const bits = [];
  for (let i = 0; i < n; i++) {
    const t = tick + (i + 1) * SPACING;
    ticks.set(t, 0n);
    const { wordPos, bitPos } = v3lib.position(t, SPACING);
    bits.push({ wordPos, bitPos });
  }
  const wordsMap = completeBitmap();
  const startBit = v3lib.position(tick, SPACING);
  bits.push(startBit);
  for (const { wordPos, bitPos } of bits) {
    wordsMap.set(wordPos, (wordsMap.get(wordPos) || 0n) | (1n << BigInt(bitPos)));
  }
  return { ticks, words: wordsMap };
}

function buildTicksDown(n, tick) {
  const ticks = new Map();
  const bits = [];
  for (let i = 0; i < n; i++) {
    const t = tick - (i + 1) * SPACING;
    ticks.set(t, 0n);
    const { wordPos, bitPos } = v3lib.position(t, SPACING);
    bits.push({ wordPos, bitPos });
  }
  const wordsMap = completeBitmap();
  const startBit = v3lib.position(tick, SPACING);
  bits.push(startBit);
  for (const { wordPos, bitPos } of bits) {
    wordsMap.set(wordPos, (wordsMap.get(wordPos) || 0n) | (1n << BigInt(bitPos)));
  }
  return { ticks, words: wordsMap };
}

describe("TASK 4.4-A - V3 exact quote mathematical correctness", function () {

  describe("tick bitmap integrity", function () {
    it("lte=true finds the initialized tick AT or BELOW the current tick", function () {
      const words = new Map([[-1, (1n << 166n) | (1n << 167n) | (1n << 168n)]]);
      const res = v3lib.nextInitializedTickWithinOneWord(words, -890, SPACING, true);
      expect(res.initialized).to.equal(true);
      expectEq(BigInt(res.tickNext), -890n);
    });
    it("lte=false finds the initialized tick ABOVE the current tick", function () {
      const words = new Map([[-1, (1n << 166n) | (1n << 167n) | (1n << 168n)]]);
      const res = v3lib.nextInitializedTickWithinOneWord(words, -890, SPACING, false);
      expect(res.initialized).to.equal(true);
      expectEq(BigInt(res.tickNext), -880n);
    });
    it("lte=true from non-aligned tick -891 skips to -900", function () {
      const words = new Map([[-1, (1n << 166n) | (1n << 167n) | (1n << 168n)]]);
      const res = v3lib.nextInitializedTickWithinOneWord(words, -891, SPACING, true);
      expect(res.initialized).to.equal(true);
      expectEq(BigInt(res.tickNext), -900n);
    });
    it("position() aligns non-aligned negative tick correctly", function () {
      const pos891 = v3lib.position(-891, SPACING);
      expect(pos891.compressed).to.equal(-90);
      expect(pos891.bitPos).to.equal(166);
    });
  });

  describe("single tick crossing", function () {
    it("crosses from -890 to -880 (zeroForOne=false)", function () {
      const { ticks, words } = buildTicksUp(1, -890);
      const params = setup(words, -890, { amountIn: 10n ** 18n, zeroForOne: false, ticks });
      const r = v3lib.getAmountOutV3Exact(params);
      expectGt(r.amountOut, 0n);
      expect(r.crossed).to.equal(1);
    });
    it("crosses from -880 to -890 (zeroForOne=true)", function () {
      const { ticks, words } = buildTicksDown(1, -880);
      const params = setup(words, -880, { amountIn: 10n ** 18n, zeroForOne: true, ticks, sqrtPx96: SQRT_PX96_880 });
      const r = v3lib.getAmountOutV3Exact(params);
      expectGt(r.amountOut, 0n);
      expect(r.crossed).to.equal(1);
    });
  });
  describe("multiple tick crossings (zeroForOne=false)", function () {
    it("2 tick crossings", function () {
      const { ticks, words } = buildTicksUp(2, -890);
      const params = setup(words, -890, { amountIn: 10n ** 30n, zeroForOne: false, ticks });
      const r = v3lib.getAmountOutV3Exact(params);
      expect(r.crossed).to.be.gte(2);
      expectGt(r.amountOut, 0n);
    });
    it("5 tick crossings", function () {
      const { ticks, words } = buildTicksUp(5, -890);
      const params = setup(words, -890, { amountIn: 10n ** 30n, zeroForOne: false, ticks });
      const r = v3lib.getAmountOutV3Exact(params);
      expect(r.crossed).to.be.gte(5);
    });
    it("10 tick crossings", function () {
      const { ticks, words } = buildTicksUp(10, -890);
      const params = setup(words, -890, { amountIn: 10n ** 31n, zeroForOne: false, ticks });
      const r = v3lib.getAmountOutV3Exact(params);
      expect(r.crossed).to.be.gte(10);
    });
    it("20+ tick crossings", function () {
      const { ticks, words } = buildTicksUp(25, -890);
      const params = setup(words, -890, { amountIn: 10n ** 31n, zeroForOne: false, ticks });
      const r = v3lib.getAmountOutV3Exact(params);
      expect(r.crossed).to.be.gte(20);
    });
  });

  describe("multiple tick crossings (zeroForOne=true)", function () {
    it("2 tick crossings going down", function () {
      const { ticks, words } = buildTicksDown(2, -880);
      const params = setup(words, -880, { amountIn: 10n ** 30n, zeroForOne: true, ticks, sqrtPx96: SQRT_PX96_880 });
      const r = v3lib.getAmountOutV3Exact(params);
      expect(r.crossed).to.be.gte(2);
    });
    it("5 tick crossings going down", function () {
      const { ticks, words } = buildTicksDown(5, -880);
      const params = setup(words, -880, { amountIn: 10n ** 30n, zeroForOne: true, ticks, sqrtPx96: SQRT_PX96_880 });
      const r = v3lib.getAmountOutV3Exact(params);
      expect(r.crossed).to.be.gte(5);
    });
    it("10 tick crossings going down", function () {
      const { ticks, words } = buildTicksDown(10, -880);
      const params = setup(words, -880, { amountIn: 10n ** 31n, zeroForOne: true, ticks, sqrtPx96: SQRT_PX96_880 });
      const r = v3lib.getAmountOutV3Exact(params);
      expect(r.crossed).to.be.gte(10);
    });
  });
  describe("partial tick movement", function () {
    it("amount does not reach the next tick", function () {
      const params = setup(new Map([[-1, 0n]]), -890, { amountIn: 10n ** 3n, zeroForOne: false });
      const r = v3lib.getAmountOutV3Exact(params);
      expect(r.crossed).to.equal(0);
      expectGt(r.amountOut, 0n);
    });
  });

  describe("exact tick boundary", function () {
    it("amount reaches the next tick boundary", function () {
      const { ticks, words } = buildTicksUp(1, -890);
      const params = setup(words, -890, { amountIn: 10n ** 18n, zeroForOne: false, ticks });
      const r = v3lib.getAmountOutV3Exact(params);
      expect(r.crossed).to.be.gte(1);
    });
  });

  describe("large vs small input", function () {
    it("small amount: still produces a result", function () {
      const params = setup(new Map([[-1, 0n]]), -890, { amountIn: 1n, zeroForOne: false });
      const r = v3lib.getAmountOutV3Exact(params);
      expectGte(r.amountOut, 0n);
    });
    it("large amount: drains across multiple ticks", function () {
      const { ticks, words } = buildTicksUp(2, -890);
      const params = setup(words, -890, { amountIn: 10n ** 30n, zeroForOne: false, ticks });
      const r = v3lib.getAmountOutV3Exact(params);
      expectGt(r.amountOut, 0n);
    });
  });

  describe("direction: token0->token1 vs token1->token0", function () {
    it("token1->token0 (zeroForOne=false) produces output", function () {
      const { ticks, words } = buildTicksUp(1, -890);
      const params = setup(words, -890, { amountIn: 10n ** 18n, zeroForOne: false, ticks });
      const r = v3lib.getAmountOutV3Exact(params);
      expectGt(r.amountOut, 0n);
    });
    it("token0->token1 (zeroForOne=true) produces output", function () {
      const { ticks, words } = buildTicksDown(1, -880);
      const params = setup(words, -880, { amountIn: 10n ** 18n, zeroForOne: true, ticks, sqrtPx96: SQRT_PX96_880 });
      const r = v3lib.getAmountOutV3Exact(params);
      expectGt(r.amountOut, 0n);
    });
  });

  describe("return shape", function () {
    it("getAmountOutV3Exact returns the expected fields", function () {
      const { ticks, words } = buildTicksUp(1, -890);
      const params = setup(words, -890, { amountIn: 10n ** 18n, zeroForOne: false, ticks });
      const r = v3lib.getAmountOutV3Exact(params);
      expect(r).to.have.property("crossed");
      expect(r).to.have.property("sqrtPFinal");
      expect(r).to.have.property("tickFinal");
      expect(r).to.have.property("amountOut");
      expect(typeof r.crossed).to.equal("number");
      expect(typeof r.sqrtPFinal).to.equal("bigint");
      expect(typeof r.tickFinal).to.equal("number");
      expect(typeof r.amountOut).to.equal("bigint");
    });
  });

  describe("no silent fallback to approximation (bot/profit.js venueOutput)", function () {
    const { venueOutput } = require("../../bot/profit");
    const amm = require("../../lib/amm");

    const TOK_A = "0x" + "b1".repeat(20);
    const TOK_B = "0x" + "b2".repeat(20);

    // Legacy approximate-model fields, deliberately POISONED with values that
    // make lib/amm.getAmountOutV3() return a clearly NON-ZERO number. So if any
    // silent fallback survived, venueOutput() would return ~1e18 instead of 0n
    // and these tests would catch it.
    const POISON_SQRT_PX96 = 1n << 96n;
    const POISON_LIQUIDITY = 10n ** 24n;

    // Deep state serialised exactly the way scanner.enrichV3Venues() writes it
    // (strings), and built from the SAME complete bitmap the comparison uses.
    function deepStateJson(over) {
      const { ticks, words } = buildTicksUp(1, -890);
      return Object.assign({
        sqrtPriceX96: SQRT_PX96.toString(),
        tick: TICK,
        liquidity: LIQUIDITY.toString(),
        tickSpacing: SPACING,
        words: [...words.entries()].map(([w, v]) => ({ word: w, value: v.toString() })),
        ticks: [...ticks.entries()].map(([t, net]) => ({ tick: t, liquidityNet: net.toString() })),
      }, over || {});
    }

    function v3VenueWithDeepState(over) {
      return {
        kind: "v3",
        pool: "0x" + "c1".repeat(20),
        feeTier: FEE,
        tokenA: { address: TOK_A, decimals: 18 },
        tokenB: { address: TOK_B, decimals: 18 },
        sqrtPx96: POISON_SQRT_PX96,
        liquidity: POISON_LIQUIDITY,
        v3State: deepStateJson(),
        ...over,
      };
    }

    it("the poisoned legacy fields WOULD yield a non-zero approximate quote", function () {
      // Sanity check on the poison itself: without it the "no fallback"
      // assertions below would be vacuous (0n either way).
      expectGt(amm.getAmountOutV3(10n ** 18n, POISON_SQRT_PX96, POISON_LIQUIDITY, true, 500n), 0n);
    });

    it("uses the EXACT engine when deep v3State is present", function () {
      const venue = v3VenueWithDeepState();
      const got = venueOutput(venue, TOK_A, 10n ** 18n);

      const { ticks, words } = buildTicksUp(1, -890);
      const exact = v3lib.getAmountOutV3Exact(
        setup(words, -890, { amountIn: 10n ** 18n, zeroForOne: true, ticks })
      ).amountOut;

      expectEq(got, exact);
      expectGt(got, 0n);
      // And it is NOT the approximate number.
      expect(got === amm.getAmountOutV3(10n ** 18n, POISON_SQRT_PX96, POISON_LIQUIDITY, true, 500n))
        .to.equal(false);
    });

    it("returns 0n when deep v3State is ABSENT (no approximate fallback)", function () {
      const venue = v3VenueWithDeepState();
      delete venue.v3State;
      expectEq(venueOutput(venue, TOK_A, 10n ** 18n), 0n);
    });

    it("returns 0n when v3State.words is empty (no approximate fallback)", function () {
      const venue = v3VenueWithDeepState();
      venue.v3State = deepStateJson({ words: [], ticks: [] });
      expectEq(venueOutput(venue, TOK_A, 10n ** 18n), 0n);
    });

    it("returns 0n when the exact engine THROWS (no approximate fallback)", function () {
      // tickSpacing 0 makes the exact engine throw; legacy fallback must NOT run.
      const venue = v3VenueWithDeepState();
      venue.v3State = deepStateJson({ tickSpacing: 0 });

      let threw = false;
      try {
        const { ticks, words } = buildTicksUp(1, -890);
        v3lib.getAmountOutV3Exact(
          setup(words, -890, { amountIn: 10n ** 18n, zeroForOne: true, ticks, tickSpacing: 0 })
        );
      } catch (_) { threw = true; }
      expect(threw, "engine should throw on tickSpacing=0").to.equal(true);

      expectEq(venueOutput(venue, TOK_A, 10n ** 18n), 0n);
    });

    it("returns 0n for non-positive input", function () {
      const venue = v3VenueWithDeepState();
      expectEq(venueOutput(venue, TOK_A, 0n), 0n);
    });
  });

  describe("getNextSqrtPriceFromInput direction (regression: add flag)", function () {
    it("zeroForOne=true moves sqrtPrice DOWN when adding token0", function () {
      // Regression for the add=false bug: adding token0 must DECREASE the price.
      const next = v3lib.getNextSqrtPriceFromInput(SQRT_PX96, LIQUIDITY, 10n ** 15n, true);
      expect(next < SQRT_PX96, "adding token0 must lower sqrtPrice").to.equal(true);
    });

    it("zeroForOne=false moves sqrtPrice UP when adding token1", function () {
      const next = v3lib.getNextSqrtPriceFromInput(SQRT_PX96, LIQUIDITY, 10n ** 15n, false);
      expect(next > SQRT_PX96, "adding token1 must raise sqrtPrice").to.equal(true);
    });

    it("returns input price unchanged for zero amount", function () {
      expectEq(v3lib.getNextSqrtPriceFromInput(SQRT_PX96, LIQUIDITY, 0n, true), SQRT_PX96);
      expectEq(v3lib.getNextSqrtPriceFromInput(SQRT_PX96, LIQUIDITY, 0n, false), SQRT_PX96);
    });
  });

  // ==========================================================================
  // TASK 4.4-A-FIX — UNKNOWN bitmap word must FAIL CLOSED.
  //
  //   word present with value 0n  => EMPTY   => known state, quote may continue
  //   word absent from the Map    => UNKNOWN => throw "missing-tickbitmap-word"
  //
  // Treating UNKNOWN as EMPTY would let the engine conclude "no initialized
  // ticks over there" and emit a plausible-looking quote built from data that
  // was never read — which for a bot that moves real funds is the worst
  // possible failure mode.
  // ==========================================================================
  describe("UNKNOWN bitmap word fails closed (EMPTY != UNKNOWN)", function () {
    const { venueOutput } = require("../../bot/profit");
    const amm = require("../../lib/amm");
    const MISSING = "missing-tickbitmap-word";

    const L_D = 10n ** 12n;
    const SQRT_2550 = v3lib.getSqrtRatioAtTick(-2550);
    const SQRT_2560 = v3lib.getSqrtRatioAtTick(-2560);

    function expectMissingWord(fn) {
      let msg = null;
      try { fn(); } catch (e) { msg = e.message; }
      expect(msg, "expected the exact engine to fail closed").to.equal(MISSING);
    }

    // ---- TEST A: missing word, zeroForOne (lte=true) ------------------------
    describe("TEST A - missing word, zeroForOne=true", function () {
      it("getAmountOutV3Exact throws missing-tickbitmap-word (empty Map)", function () {
        expectMissingWord(() => v3lib.getAmountOutV3Exact(
          setup(new Map(), -890, { amountIn: 1000n, zeroForOne: true, liquidity: L_D })
        ));
      });

      it("still throws when an UNRELATED word is present (not just an empty Map)", function () {
        // word -2 is known and empty, but the traversal needs word -1.
        expectMissingWord(() => v3lib.getAmountOutV3Exact(
          setup(new Map([[-2, 0n]]), -890, { amountIn: 1000n, zeroForOne: true, liquidity: L_D })
        ));
      });

      it("nextInitializedTickWithinOneWord(lte=true) throws on the missing word", function () {
        expectMissingWord(() => v3lib.nextInitializedTickWithinOneWord(new Map(), -890, SPACING, true));
        expectMissingWord(() => v3lib.nextInitializedTickWithinOneWord(new Map([[-2, 0n]]), -890, SPACING, true));
      });

      it("does NOT return 0 as a substitute quote", function () {
        // The engine must throw, never silently yield amountOut 0.
        let returned = "no-throw";
        try {
          returned = v3lib.getAmountOutV3Exact(
            setup(new Map(), -890, { amountIn: 1000n, zeroForOne: true, liquidity: L_D })
          );
        } catch (_) { returned = null; }
        expect(returned, "engine returned a value instead of throwing").to.equal(null);
      });
    });

    // ---- TEST B: missing word, oneForZero (lte=false) -----------------------
    describe("TEST B - missing word, zeroForOne=false", function () {
      it("getAmountOutV3Exact throws missing-tickbitmap-word (empty Map)", function () {
        expectMissingWord(() => v3lib.getAmountOutV3Exact(
          setup(new Map(), -890, { amountIn: 1000n, zeroForOne: false, liquidity: L_D })
        ));
      });

      it("still throws when an UNRELATED word is present", function () {
        expectMissingWord(() => v3lib.getAmountOutV3Exact(
          setup(new Map([[-2, 0n]]), -890, { amountIn: 1000n, zeroForOne: false, liquidity: L_D })
        ));
      });

      it("nextInitializedTickWithinOneWord(lte=false) throws on the missing word", function () {
        // lte=false reads position(compressed + 1) -> word -1 for tick -890.
        expectMissingWord(() => v3lib.nextInitializedTickWithinOneWord(new Map(), -890, SPACING, false));
        expectMissingWord(() => v3lib.nextInitializedTickWithinOneWord(new Map([[-2, 0n]]), -890, SPACING, false));
      });
    });

    // ---- TEST C: explicit EMPTY word stays valid ----------------------------
    describe("TEST C - explicit EMPTY word (0n) is VALID, not UNKNOWN", function () {
      it("nextInitializedTickWithinOneWord does NOT throw for words.set(pos, 0n)", function () {
        const down = v3lib.nextInitializedTickWithinOneWord(new Map([[-1, 0n]]), -890, SPACING, true);
        expect(down.initialized, "empty word has no initialized tick").to.equal(false);
        expectEq(BigInt(down.tickNext), -2560n);

        const up = v3lib.nextInitializedTickWithinOneWord(new Map([[-1, 0n]]), -890, SPACING, false);
        expect(up.initialized).to.equal(false);
        expectEq(BigInt(up.tickNext), -10n);
      });

      it("getAmountOutV3Exact continues and quotes with an explicit EMPTY word (zeroForOne=true)", function () {
        const r = v3lib.getAmountOutV3Exact(
          setup(new Map([[-1, 0n]]), -890, { amountIn: 1000n, zeroForOne: true, liquidity: L_D })
        );
        expectEq(BigInt(r.crossed), 0n);
        expectGt(r.amountOut, 0n);
      });

      it("getAmountOutV3Exact continues and quotes with an explicit EMPTY word (zeroForOne=false)", function () {
        const r = v3lib.getAmountOutV3Exact(
          setup(new Map([[-1, 0n]]), -890, { amountIn: 1000n, zeroForOne: false, liquidity: L_D })
        );
        expectEq(BigInt(r.crossed), 0n);
        expectGt(r.amountOut, 0n);
      });

      it("EMPTY and UNKNOWN are observably different for the SAME wordPos", function () {
        // Same tick, same spacing, same direction. Only presence in the Map differs.
        const empty = new Map([[-1, 0n]]);
        const unknown = new Map();
        expect(empty.has(-1)).to.equal(true);
        expect(unknown.has(-1)).to.equal(false);

        let emptyThrew = false, unknownThrew = false;
        try { v3lib.nextInitializedTickWithinOneWord(empty, -890, SPACING, true); } catch (_) { emptyThrew = true; }
        try { v3lib.nextInitializedTickWithinOneWord(unknown, -890, SPACING, true); } catch (_) { unknownThrew = true; }
        expect(emptyThrew, "EMPTY word must NOT throw").to.equal(false);
        expect(unknownThrew, "UNKNOWN word MUST throw").to.equal(true);
      });

      it("a word present but not a BigInt is treated as UNKNOWN (fail closed)", function () {
        expectMissingWord(() => v3lib.nextInitializedTickWithinOneWord(new Map([[-1, "0"]]), -890, SPACING, true));
        expectMissingWord(() => v3lib.nextInitializedTickWithinOneWord(new Map([[-1, 0]]), -890, SPACING, true));
        expectMissingWord(() => v3lib.nextInitializedTickWithinOneWord(new Map([[-1, undefined]]), -890, SPACING, true));
      });

      it("an absent/invalid words Map is treated as UNKNOWN (fail closed)", function () {
        expectMissingWord(() => v3lib.nextInitializedTickWithinOneWord(undefined, -890, SPACING, true));
        expectMissingWord(() => v3lib.nextInitializedTickWithinOneWord(null, -890, SPACING, false));
      });
    });

    // ---- TEST D: missing word AFTER a tick crossing (the critical case) -----
    describe("TEST D - missing word AFTER a tick crossing", function () {
      // tick -2550 sits in word -1 (compressed -255, bitPos 1); the initialized
      // tick -2560 is bit 0 of word -1; the very next step down needs word -2
      // (compressed -257, bitPos 255). So word -2 is only reached AFTER crossing.
      const TICKS_D = () => new Map([[-2560, 0n]]);

      it("CONTROL: with word -2 explicitly EMPTY the engine crosses and quotes", function () {
        const r = v3lib.getAmountOutV3Exact({
          amountIn: 10n ** 9n, zeroForOne: true, fee: FEE, tickSpacing: SPACING,
          words: new Map([[-1, 1n], [-2, 0n]]),
          ticks: TICKS_D(),
          sqrtPx96: SQRT_2550, liquidity: L_D, tick: -2550,
        });
        // Proves the traversal really did cross -2560 and move into word -2.
        expectEq(BigInt(r.crossed), 1n);
        expectEq(BigInt(r.tickFinal), -2561n);
        expectGt(r.amountOut, 0n);
      });

      it("with word -2 ABSENT the engine throws instead of quoting", function () {
        expectMissingWord(() => v3lib.getAmountOutV3Exact({
          amountIn: 10n ** 9n, zeroForOne: true, fee: FEE, tickSpacing: SPACING,
          words: new Map([[-1, 1n]]), // word -2 deliberately NOT provided
          ticks: TICKS_D(),
          sqrtPx96: SQRT_2550, liquidity: L_D, tick: -2550,
        }));
      });

      it("throws for a larger amount too (crossing is amount-independent)", function () {
        expectMissingWord(() => v3lib.getAmountOutV3Exact({
          amountIn: 10n ** 10n, zeroForOne: true, fee: FEE, tickSpacing: SPACING,
          words: new Map([[-1, 1n]]),
          ticks: TICKS_D(),
          sqrtPx96: SQRT_2550, liquidity: L_D, tick: -2550,
        }));
      });

      it("throws when the price sits EXACTLY on the initialized tick boundary", function () {
        // Zero-consumption crossing: sqrtPx96 == getSqrtRatioAtTick(-2560), so the
        // engine crosses -2560 immediately and then needs word -2. Deterministic
        // for ANY amountIn.
        expectMissingWord(() => v3lib.getAmountOutV3Exact({
          amountIn: 1000n, zeroForOne: true, fee: FEE, tickSpacing: SPACING,
          words: new Map([[-1, 1n]]),
          ticks: TICKS_D(),
          sqrtPx96: SQRT_2560, liquidity: L_D, tick: -2560,
        }));
      });

      it("CONTROL: same boundary case with word -2 EMPTY crosses and quotes", function () {
        const r = v3lib.getAmountOutV3Exact({
          amountIn: 1000n, zeroForOne: true, fee: FEE, tickSpacing: SPACING,
          words: new Map([[-1, 1n], [-2, 0n]]),
          ticks: TICKS_D(),
          sqrtPx96: SQRT_2560, liquidity: L_D, tick: -2560,
        });
        expectEq(BigInt(r.crossed), 1n);
        expectEq(BigInt(r.tickFinal), -2561n);
        expectGt(r.amountOut, 0n);
      });

      it("never returns a plausible-looking quote from an incomplete bitmap", function () {
        // Whatever the amount, ONCE the traversal needs word -2 it must throw.
        // (Amounts too small to reach the -2560 boundary never ask for word -2,
        // so they legitimately stay inside word -1 and do not belong here.)
        for (const amt of [10n ** 9n, 10n ** 10n, 10n ** 12n, 10n ** 15n, 10n ** 18n]) {
          let got = "no-throw";
          try {
            got = v3lib.getAmountOutV3Exact({
              amountIn: amt, zeroForOne: true, fee: FEE, tickSpacing: SPACING,
              words: new Map([[-1, 1n]]),
              ticks: TICKS_D(),
              sqrtPx96: SQRT_2550, liquidity: L_D, tick: -2550,
            });
          } catch (e) { got = e.message; }
          expect(got, "amountIn=" + amt).to.equal(MISSING);
        }
      });
    });

    // ---- TEST E: venueOutput() integration ---------------------------------
    describe("TEST E - venueOutput() turns the failure into 0n (no approximate quote)", function () {
      const TOK_A = "0x" + "b1".repeat(20);
      const TOK_B = "0x" + "b2".repeat(20);
      const POISON_SQRT_PX96 = 1n << 96n;
      const POISON_LIQUIDITY = 10n ** 24n;

      function venueWithIncompleteBitmap() {
        return {
          kind: "v3",
          pool: "0x" + "c1".repeat(20),
          feeTier: FEE,
          tokenA: { address: TOK_A, decimals: 18 },
          tokenB: { address: TOK_B, decimals: 18 },
          // Poisoned so the legacy approximate model WOULD answer ~9.99e17.
          sqrtPx96: POISON_SQRT_PX96,
          liquidity: POISON_LIQUIDITY,
          v3State: {
            sqrtPriceX96: SQRT_2550.toString(),
            tick: -2550,
            liquidity: L_D.toString(),
            tickSpacing: SPACING,
            words: [{ word: -1, value: "1" }], // word -2 ABSENT => UNKNOWN
            ticks: [{ tick: -2560, liquidityNet: "0" }],
          },
        };
      }

      it("the approximate model would have answered non-zero for these venues", function () {
        expectGt(amm.getAmountOutV3(10n ** 9n, POISON_SQRT_PX96, POISON_LIQUIDITY, true, 500n), 0n);
      });

      it("venueOutput returns 0n when the bitmap word is missing", function () {
        const venue = venueWithIncompleteBitmap();
        // Confirm the engine really does fail closed for this exact state.
        const words = new Map(venue.v3State.words.map((w) => [Number(w.word), BigInt(w.value)]));
        const ticks = new Map(venue.v3State.ticks.map((t) => [Number(t.tick), BigInt(t.liquidityNet)]));
        expectMissingWord(() => v3lib.getAmountOutV3Exact({
          amountIn: 10n ** 9n, zeroForOne: true, fee: FEE, tickSpacing: SPACING,
          words, ticks,
          sqrtPx96: BigInt(venue.v3State.sqrtPriceX96),
          liquidity: BigInt(venue.v3State.liquidity),
          tick: venue.v3State.tick,
        }));

        expectEq(venueOutput(venue, TOK_A, 10n ** 9n), 0n);
      });

      it("venueOutput does NOT fall back to the approximate V3 quote", function () {
        const venue = venueWithIncompleteBitmap();
        const got = venueOutput(venue, TOK_A, 10n ** 9n);
        const approximate = amm.getAmountOutV3(10n ** 9n, POISON_SQRT_PX96, POISON_LIQUIDITY, true, 500n);
        expectGt(approximate, 0n);
        expectEq(got, 0n);
        expect(got === approximate, "must not equal the approximate quote").to.equal(false);
      });

      it("bot/profit.js no longer imports the approximate V3 model at all", function () {
        const src = require("fs").readFileSync(require.resolve("../../bot/profit"), "utf8");
        // The only V3 quote path left must be the exact engine.
        expect(src.includes("getAmountOutV3Exact"), "exact engine must be used").to.equal(true);
        expect(/\bgetAmountOutV3\b(?!Exact)/.test(src), "approximate getAmountOutV3 must be gone").to.equal(false);
      });

      it("venueOutput returns 0n in the opposite direction too", function () {
        const venue = venueWithIncompleteBitmap();
        // TOK_B is tokenB => zeroForOne = false (upward). Word -1 is present, and
        // only an amount large enough to travel past the end of word -1 reaches
        // the UNKNOWN word 0 — that is the threshold this test exercises.
        expectMissingWord(() => v3lib.getAmountOutV3Exact({
          amountIn: 10n ** 12n, zeroForOne: false, fee: FEE, tickSpacing: SPACING,
          words: new Map(venue.v3State.words.map((w) => [Number(w.word), BigInt(w.value)])),
          ticks: new Map(venue.v3State.ticks.map((t) => [Number(t.tick), BigInt(t.liquidityNet)])),
          sqrtPx96: BigInt(venue.v3State.sqrtPriceX96),
          liquidity: BigInt(venue.v3State.liquidity),
          tick: venue.v3State.tick,
        }));
        expectEq(venueOutput(venue, TOK_B, 10n ** 12n), 0n);
      });

      it("small amounts that never leave the known word still quote normally", function () {
        // Correct behaviour: fail-closed is about UNKNOWN state, not about small
        // swaps. If the swap fits entirely inside the words that WERE read, the
        // quote is exact and must go through.
        const venue = venueWithIncompleteBitmap();
        const got = venueOutput(venue, TOK_B, 10n ** 9n);
        expectGt(got, 0n);
      });
    });
  });

  describe("scanner reads ALL V3 state at the SAME blockTag", function () {
    const { ethers } = require("ethers");
    const scanner = require("../../bot/scanner");
    const { MULTICALL3 } = require("../../bot/config");

    const MC3_ABI = [
      "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
    ];
    const POOL = "0x" + "c1".repeat(20);
    const SEL = {
      slot0: ethers.id("slot0()").slice(0, 10),
      liquidity: ethers.id("liquidity()").slice(0, 10),
      tickSpacing: ethers.id("tickSpacing()").slice(0, 10),
      tickBitmap: ethers.id("tickBitmap(int16)").slice(0, 10),
      ticks: ethers.id("ticks(int24)").slice(0, 10),
    };

    // A provider that RECORDS the blockTag of every eth_call it serves.
    function makeRecordingProvider(blockTag) {
      const cod = ethers.AbiCoder.defaultAbiCoder();
      const mc3Iface = new ethers.Interface(MC3_ABI);
      const seenBlockTags = [];
      const state = new Map();

      // slot0 -> (sqrtPriceX96, tick, ...)
      state.set(POOL + "|" + SEL.slot0, cod.encode(
        ["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"],
        [SQRT_PX96, TICK, 0, 0, 0, 0, false]
      ));
      state.set(POOL + "|" + SEL.liquidity, cod.encode(["uint128"], [LIQUIDITY]));
      state.set(POOL + "|" + SEL.tickSpacing, cod.encode(["int24"], [SPACING]));
      // tickBitmap: REALISTIC — only the word holding the current tick carries
      // bits; neighbouring words read back EMPTY (0) but are still SUCCESSFULLY
      // READ, so scanner keeps them in the words Map. That distinction is what
      // makes EMPTY != UNKNOWN observable: had scanner dropped the zero words,
      // traversal past word -1 would fail closed with missing-tickbitmap-word.
      const wordVal = (1n << 167n) | (1n << 168n); // bits for ticks -890 / -880
      // ticks: initialized with liquidityNet 0.
      state.set("tick", cod.encode(
        ["uint128", "int128", "uint256", "uint256", "int56", "uint160", "uint32", "bool"],
        [0n, 0n, 0n, 0n, 0n, 0n, 0n, true]
      ));

      return {
        seenBlockTags,
        async call(tx) {
          seenBlockTags.push(tx.blockTag === undefined ? "latest" : tx.blockTag);
          const [calls] = mc3Iface.decodeFunctionData("aggregate3", tx.data);
          const results = [];
          for (const c of calls) {
            const target = c.target.toLowerCase();
            const sel = c.callData.slice(0, 10).toLowerCase();
            if (sel === SEL.tickBitmap.toLowerCase()) {
              // Decode the requested word position and answer per-word.
              // NB: slice(10) drops "0x"+8 selector chars, so re-add the 0x prefix.
              const [wp] = cod.decode(["int16"], "0x" + c.callData.slice(10));
              const val = Number(wp) === -1 ? wordVal : 0n;
              results.push([true, cod.encode(["uint256"], [val])]);
              continue;
            }
            let rd = state.get(target + "|" + sel);
            if (rd === undefined && sel === SEL.ticks.toLowerCase()) rd = state.get("tick");
            results.push(rd === undefined ? [false, "0x"] : [true, rd]);
          }
          return mc3Iface.encodeFunctionResult("aggregate3", [results]);
        },
      };
    }

    it("slot0, liquidity, tickSpacing, tickBitmap and ticks all use ONE blockTag", async function () {
      const BLOCK = 123456789;
      const provider = makeRecordingProvider(BLOCK);
      const venue = { kind: "v3", pool: POOL, feeTier: FEE, isV3: true };

      const out = await scanner.enrichV3Venues(provider, [venue], { blockTag: BLOCK });
      expect(out.length).to.equal(1);

      const s = venue.v3State;
      expect(s, "v3State must be attached").to.exist;
      // All required fields for getAmountOutV3Exact are present.
      expect(s.sqrtPriceX96).to.equal(SQRT_PX96.toString());
      expect(s.tick).to.equal(TICK);
      expect(s.liquidity).to.equal(LIQUIDITY.toString());
      expect(s.tickSpacing).to.equal(SPACING);
      expect(Array.isArray(s.words)).to.equal(true);
      expect(Array.isArray(s.ticks)).to.equal(true);
      expect(s.blockNumber).to.equal(BLOCK);

      // THE KEY ASSERTION: every single eth_call was pinned to the same block.
      expect(provider.seenBlockTags.length, "expected multiple multicall batches").to.be.gte(3);
      for (const tag of provider.seenBlockTags) {
        expect(tag, "read escaped the snapshot blockTag: " + tag).to.equal(BLOCK);
      }
      const unique = [...new Set(provider.seenBlockTags)];
      expect(unique.length, "reads spanned multiple blocks: " + unique.join(",")).to.equal(1);
    });

    it("liquidityNet is captured for initialized ticks", async function () {
      const BLOCK = 987654321;
      const provider = makeRecordingProvider(BLOCK);
      const venue = { kind: "v3", pool: POOL, feeTier: FEE, isV3: true };
      await scanner.enrichV3Venues(provider, [venue], { blockTag: BLOCK });

      const s = venue.v3State;
      expect(s.ticks.length, "expected initialized ticks").to.be.gte(1);
      for (const t of s.ticks) {
        expect(t).to.have.property("tick");
        expect(t).to.have.property("liquidityNet");
        expect(t).to.have.property("liquidityGross");
        // liquidityNet must survive a BigInt round-trip (signed values included).
        expect(() => BigInt(t.liquidityNet)).to.not.throw();
      }
    });

    it("the enriched state feeds getAmountOutV3Exact end-to-end", async function () {
      const BLOCK = 555555555;
      const provider = makeRecordingProvider(BLOCK);
      const venue = { kind: "v3", pool: POOL, feeTier: FEE, isV3: true };
      await scanner.enrichV3Venues(provider, [venue], { blockTag: BLOCK });

      const s = venue.v3State;
      // EMPTY != UNKNOWN, at the scanner level: neighbour words read back 0 but
      // were read SUCCESSFULLY, so they must be present in s.words. If scanner
      // dropped them the exact engine would (correctly) fail closed below.
      const words = new Map(s.words.map((w) => [Number(w.word), BigInt(w.value)]));
      expect(words.has(-1), "current word must be present").to.equal(true);
      expect(words.get(-1), "current word must carry the -890/-880 bits")
        .to.equal((1n << 167n) | (1n << 168n));
      const emptyNeighbours = [...words.entries()].filter(([, v]) => v === 0n);
      expect(emptyNeighbours.length, "successfully-read EMPTY words must be kept").to.be.gte(1);

      const r = v3lib.getAmountOutV3Exact({
        amountIn: 10n ** 15n,
        zeroForOne: false,
        fee: FEE,
        tickSpacing: s.tickSpacing,
        words,
        ticks: new Map(s.ticks.map((t) => [Number(t.tick), BigInt(t.liquidityNet)])),
        sqrtPx96: s.sqrtPriceX96,
        liquidity: s.liquidity,
        tick: s.tick,
      });
      expectGt(r.amountOut, 0n);
      expect(r.crossed, "should have crossed the initialized tick at -880").to.be.gte(1);
    });
  });

});
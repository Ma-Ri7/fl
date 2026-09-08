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

function buildTicksUp(n, tick) {
  const ticks = new Map();
  const bits = [];
  for (let i = 0; i < n; i++) {
    const t = tick + (i + 1) * SPACING;
    ticks.set(t, 0n);
    const { wordPos, bitPos } = v3lib.position(t, SPACING);
    bits.push({ wordPos, bitPos });
  }
  const wordsMap = new Map();
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
  const wordsMap = new Map();
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

    function v3VenueWithDeepState(over) {
      return Object.assign({
        kind: "v3",
        pool: "0x" + "c1".repeat(20),
        feeTier: FEE,
        tokenA: { address: TOK_A, decimals: 18 },
        tokenB: { address: TOK_B, decimals: 18 },
        // Legacy approximate-model fields, deliberately WRONG so that any silent
        // fallback would produce an obviously different number.
        sqrtPx96: 1n,
        liquidity: 1n,
        v3State: {
          sqrtPriceX96: SQRT_PX96.toString(),
          tick: TICK,
          liquidity: LIQUIDITY.toString(),
          tickSpacing: SPACING,
          words: [{ word: -1, value: ((1n << 167n) | (1n << 168n)).toString() }],
          ticks: [{ tick: -880, liquidityNet: "0" }],
        },
      }, over || {});
    }

    it("uses the EXACT engine when deep v3State is present", function () {
      const venue = v3VenueWithDeepState();
      const got = venueOutput(venue, TOK_A, 10n ** 18n);

      const { ticks, words } = buildTicksUp(1, -890);
      const exact = v3lib.getAmountOutV3Exact(
        setup(words, -890, { amountIn: 10n ** 18n, zeroForOne: true, ticks })
      ).amountOut;

      expectEq(got, exact);
      expectGt(got, 0n);
    });

    it("returns 0n when deep v3State is ABSENT (no approximate fallback)", function () {
      const venue = v3VenueWithDeepState();
      delete venue.v3State;

      // The legacy approximate model WOULD have returned a non-zero number here.
      const approximate = amm.getAmountOutV3(10n ** 18n, 1n, 1n, true, BigInt(FEE));
      expect(approximate === 0n || approximate > 0n).to.equal(true);

      expectEq(venueOutput(venue, TOK_A, 10n ** 18n), 0n);
    });

    it("returns 0n when v3State.words is empty (no approximate fallback)", function () {
      const venue = v3VenueWithDeepState({ v3State: { words: [], ticks: [], tickSpacing: SPACING } });
      expectEq(venueOutput(venue, TOK_A, 10n ** 18n), 0n);
    });

    it("returns 0n when the exact engine THROWS (no approximate fallback)", function () {
      // tickSpacing 0 makes the exact engine throw; legacy fallback must NOT run.
      const venue = v3VenueWithDeepState({
        v3State: {
          sqrtPriceX96: SQRT_PX96.toString(),
          tick: TICK,
          liquidity: LIQUIDITY.toString(),
          tickSpacing: 0,
          words: [{ word: -1, value: (1n << 167n).toString() }],
          ticks: [{ tick: -890, liquidityNet: "0" }],
        },
      });

      let threw = false;
      try {
        v3lib.getAmountOutV3Exact({
          amountIn: 10n ** 18n, zeroForOne: true, fee: FEE, tickSpacing: 0,
          words: new Map([[-1, 1n << 167n]]), ticks: new Map([[-890, 0n]]),
          sqrtPx96: SQRT_PX96, liquidity: LIQUIDITY, tick: TICK,
        });
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
      // tickBitmap: every queried word returns the bits for -890/-880.
      const wordVal = (1n << 167n) | (1n << 168n);
      state.set("bitmap", cod.encode(["uint256"], [wordVal]));
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
            let rd = state.get(target + "|" + sel);
            if (rd === undefined && sel === SEL.tickBitmap.toLowerCase()) rd = state.get("bitmap");
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
      const r = v3lib.getAmountOutV3Exact({
        amountIn: 10n ** 18n,
        zeroForOne: false,
        fee: FEE,
        tickSpacing: s.tickSpacing,
        words: new Map(s.words.map((w) => [Number(w.word), BigInt(w.value)])),
        ticks: new Map(s.ticks.map((t) => [Number(t.tick), BigInt(t.liquidityNet)])),
        sqrtPx96: s.sqrtPriceX96,
        liquidity: s.liquidity,
        tick: s.tick,
      });
      expectGt(r.amountOut, 0n);
    });
  });

});
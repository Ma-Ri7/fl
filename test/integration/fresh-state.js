// ============================================================================
// test/integration/fresh-state.js — TASK 4.3-A
//
// Behavioral tests for FRESH ON-CHAIN STATE VALIDATION:
//   freshOnChainStateValidation() reads the REAL on-chain state at
//   freshBlockNumber (via provider + Multicall3), computes fresh fingerprints
//   and compares them with the opportunity's fingerprints. Any difference
//   => REJECT "stale-state". No auto-requote (Phase 10).
//
// Covers (spec §15): Tests A–O.
//
// Run: npx mocha test/integration/fresh-state.js
// ============================================================================
const { expect } = require("chai");
const { ethers } = require("ethers");
const { MULTICALL3 } = require("../../bot/config");
const snapshotMod = require("../../bot/snapshot");
const freshMod = require("../../bot/fresh");

// ---------------------------------------------------------------------------
// Function selectors (4-byte) for the calls issued by scanner.readState /
// enrichV3Venues. Computed once via ethers.id() for exactness.
// ---------------------------------------------------------------------------
const SEL = {
  getReserves: ethers.id("getReserves()").slice(0, 10),
  slot0: ethers.id("slot0()").slice(0, 10),
  liquidity: ethers.id("liquidity()").slice(0, 10),
  tickSpacing: ethers.id("tickSpacing()").slice(0, 10),
  tickBitmap: ethers.id("tickBitmap(int16)").slice(0, 10),
  ticks: ethers.id("ticks(int24)").slice(0, 10),
  baseToken: ethers.id("_BASE_TOKEN_()").slice(0, 10),
  quoteToken: ethers.id("_QUOTE_TOKEN_()").slice(0, 10),
  baseReserve: ethers.id("_BASE_RESERVE_()").slice(0, 10),
  quoteReserve: ethers.id("_QUOTE_RESERVE_()").slice(0, 10),
  pmm: ethers.id("getPMMStateForCall()").slice(0, 10),
  fees: ethers.id("getUserFeeRate(address)").slice(0, 10),
};

const MC3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
];

// ---------------------------------------------------------------------------
// MockProvider — handles Multicall3 aggregate3 calls by decoding each individual
// call and returning registered return data.
// ---------------------------------------------------------------------------
class MockProvider {
  constructor(blockNumber = 101, blockHash = "0x" + "ab".repeat(32)) {
    this._blockNumber = blockNumber;
    this._blockHash = blockHash;
    this._state = new Map();
    this._mc3Iface = new ethers.Interface(MC3_ABI);
  }

  setBlockNumber(n) { this._blockNumber = n; }
  setBlockHash(h) { this._blockHash = h; }

  // callDataPrefix: full hex of selector + encoded args (e.g. "0x5339c296" for
  // tickBitmap, or "0x5339c296" + encoded word for a specific word position).
  // Using the full prefix lets the mock distinguish tickBitmap(word) / ticks(tick)
  // calls for different word/tick positions.
  setCallReturn(target, callDataPrefix, returnData) {
    this._state.set(`${target.toLowerCase()}|${callDataPrefix.toLowerCase()}`, returnData);
  }

  async getBlockNumber() { return this._blockNumber; }
  async getBlock(n) {
    return { hash: this._blockHash, timestamp: 1700000000, number: n || this._blockNumber };
  }

  async call(tx) {
    const [calls] = this._mc3Iface.decodeFunctionData("aggregate3", tx.data);
    const results = [];
    for (const c of calls) {
      const target = c.target.toLowerCase();
      const callData = c.callData.toLowerCase();
      const returnData = this._state.get(`${target}|${callData}`);
      if (returnData !== undefined) {
        results.push([true, returnData]);
      } else {
        results.push([false, "0x"]);
      }
    }
    return this._mc3Iface.encodeFunctionResult("aggregate3", [results]);
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers — encode the return data exactly as the real contracts would.
// ---------------------------------------------------------------------------
function encodeGetReserves(r0, r1) {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint112", "uint112", "uint32"], [r0, r1, 0]);
}
function encodeSlot0(sqrtPriceX96, tick) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"],
    [sqrtPriceX96, tick, 0, 0, 0, 0, false]
  );
}
function encodeLiquidity(liq) {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint128"], [liq]);
}
function encodeTickSpacing(spacing) {
  return ethers.AbiCoder.defaultAbiCoder().encode(["int24"], [spacing]);
}
function encodeTickBitmap(wordValue) {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [wordValue]);
}
function encodeTick(liquidityGross, liquidityNet) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint128", "int128", "uint256", "uint256", "int56", "uint160", "uint32", "bool"],
    [liquidityGross, liquidityNet, 0, 0, 0, 0, 0, true]
  );
}
// Full call data prefix for tickBitmap(int16 word): selector + encoded word.
function tickBitmapCallData(word) {
  const cod = ethers.AbiCoder.defaultAbiCoder();
  return SEL.tickBitmap + cod.encode(["int16"], [word]).slice(2);
}
// Full call data prefix for ticks(int24 tick): selector + encoded tick.
function ticksCallData(tick) {
  const cod = ethers.AbiCoder.defaultAbiCoder();
  return SEL.ticks + cod.encode(["int24"], [tick]).slice(2);
}
// Full call data prefix for getUserFeeRate(address): selector + encoded address.
function feesCallData(userAddr) {
  const cod = ethers.AbiCoder.defaultAbiCoder();
  return SEL.fees + cod.encode(["address"], [userAddr]).slice(2);
}
function encodeAddress(addr) {
  return ethers.AbiCoder.defaultAbiCoder().encode(["address"], [addr]);
}
function encodeUint256(v) {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [v]);
}
function encodePMM(i, K, B, Q, B0, Q0, R) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
    [i, K, B, Q, B0, Q0, R]
  );
}
function encodeFees(lpFeeRate, mtFeeRate) {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [lpFeeRate, mtFeeRate]);
}

// ---------------------------------------------------------------------------
// Venue builders — mirror the structure produced by scanner.readState /
// enrichV3Venues. tokenA.address < tokenB.address so reserveA=reserve0.
// ---------------------------------------------------------------------------
const TOK_A = "0x" + "b1".repeat(20); // lower address
const TOK_B = "0x" + "b2".repeat(20); // higher address

function v2Venue(over = {}) {
  return {
    kind: "v2",
    pair: "0x" + "a1".repeat(20),
    router: "0x" + "a2".repeat(20),
    tokenA: { address: TOK_A, decimals: 18 },
    tokenB: { address: TOK_B, decimals: 18 },
    reserveA: 1000000n,
    reserveB: 2000000n,
    feeBps: 25,
    blockNumber: 100,
    ...over,
  };
}

function v3Venue(over = {}) {
  return {
    kind: "v3",
    pool: "0x" + "c1".repeat(20),
    feeTier: 500,
    tokenA: { address: TOK_A, decimals: 18 },
    tokenB: { address: TOK_B, decimals: 18 },
    v3State: {
      address: "0x" + "c1".repeat(20),
      sqrtPriceX96: "79228162514264337593543950336", // 2^96
      tick: -887,
      liquidity: "500000000000000000",
      tickSpacing: 10,
      words: [{ word: -1, value: (1n << 167n).toString() }], // bit 167 => tick -890
      ticks: [{ tick: -890, liquidityNet: "100000000000000000", liquidityGross: "100000000000000000" }],
      blockNumber: 100,
    },
    blockNumber: 100,
    ...over,
  };
}

function dodoVenue(over = {}) {
  return {
    kind: "dodo",
    pool: "0x" + "d1".repeat(20),
    baseToken: TOK_A,
    quoteToken: TOK_B,
    pmm: {
      i: "1000000000000000000",
      K: "100000000000000000",
      B: "1000000",
      Q: "1000000",
      B0: "1054092553389459",
      Q0: "0",
      R: 1,
    },
    lpFeeRate: "2000000000000000",
    mtFeeRate: "0",
    blockNumber: 100,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// State registration helpers — register the mock return data for each call that
// scanner.readState / enrichV3Venues will issue for a given venue.
// ---------------------------------------------------------------------------
function registerV2State(provider, venue, reserveA, reserveB) {
  provider.setCallReturn(venue.pair, SEL.getReserves, encodeGetReserves(reserveA, reserveB));
}

function registerV3State(provider, venue, state) {
  const pool = venue.pool;
  provider.setCallReturn(pool, SEL.slot0, encodeSlot0(state.sqrtPriceX96, state.tick));
  provider.setCallReturn(pool, SEL.liquidity, encodeLiquidity(state.liquidity));
  provider.setCallReturn(pool, SEL.tickSpacing, encodeTickSpacing(state.tickSpacing));

  // Compute word positions exactly as enrichV3Venues does.
  const compressed = Math.floor(state.tick / state.tickSpacing);
  const wordPos = Math.floor(compressed / 256);

  // Register bitmap ONLY for the current word position. Other word positions
  // are not registered => mock returns failure => skipped by enrichV3Venues.
  provider.setCallReturn(pool, tickBitmapCallData(wordPos), encodeTickBitmap(state.bitmapWordValue));

  // Compute initialized tick positions from the bitmap and register tick data.
  const wordVal = state.bitmapWordValue;
  for (let bit = 0; bit < 256; bit++) {
    if (((wordVal >> BigInt(bit)) & 1n) === 0n) continue;
    const tickPos = (wordPos * 256 + bit) * state.tickSpacing;
    provider.setCallReturn(pool, ticksCallData(tickPos), encodeTick(state.liquidityGross, state.liquidityNet));
  }
}

function registerDODOState(provider, venue, state) {
  const pool = venue.pool;
  provider.setCallReturn(pool, SEL.baseToken, encodeAddress(state.baseToken));
  provider.setCallReturn(pool, SEL.quoteToken, encodeAddress(state.quoteToken));
  provider.setCallReturn(pool, SEL.baseReserve, encodeUint256(state.baseReserve));
  provider.setCallReturn(pool, SEL.quoteReserve, encodeUint256(state.quoteReserve));
  provider.setCallReturn(pool, SEL.pmm, encodePMM(state.i, state.K, state.B, state.Q, state.B0, state.Q0, state.R));
  // readState passes ethers.ZeroAddress as the user arg to getUserFeeRate.
  provider.setCallReturn(pool, feesCallData(ethers.ZeroAddress), encodeFees(state.lpFeeRate, state.mtFeeRate));
}

// ---------------------------------------------------------------------------
// Opp builder — builds an opportunity with snapshot + stateFingerprint.
// ---------------------------------------------------------------------------
function buildOpp(buyVen, sellVen, snapshotBlock = 100, hash = "0x" + "hh".repeat(32)) {
  const snapshot = { blockNumber: snapshotBlock, blockHash: hash, timestamp: 1700000000, stateVersion: 1n };
  const venues = [buyVen, sellVen].filter(Boolean);
  const stateFingerprint = snapshotMod.opportunityFingerprints(venues);
  return { buyVen, sellVen, snapshot, stateFingerprint, borrowAmount: 1000n, netProfit: 5n };
}

// ===========================================================================
// TESTS
// ===========================================================================
describe("TASK 4.3-A — fresh on-chain state validation", function () {
  const HASH = "0x" + "hh".repeat(32);

  describe("V2 fresh state (Tests A, B)", function () {
    it("Test A: fresh V2 unchanged => ACCEPT", async function () {
      const ven = v2Venue();
      const opp = buildOpp(ven, null);
      const provider = new MockProvider(101, HASH);
      registerV2State(provider, ven, 1000000n, 2000000n);
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(true);
      expect(result.venuesChecked).to.equal(1);
    });

    it("Test B: fresh V2 changed => REJECT", async function () {
      const ven = v2Venue();
      const opp = buildOpp(ven, null);
      const provider = new MockProvider(101, HASH);
      registerV2State(provider, ven, 1000001n, 2000000n);
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("stale-state");
    });
  });

  describe("V3 fresh state (Tests C, D, E, F)", function () {
    it("Test C: fresh V3 unchanged => ACCEPT", async function () {
      const ven = v3Venue();
      const opp = buildOpp(ven, null);
      const provider = new MockProvider(101, HASH);
      registerV3State(provider, ven, {
        sqrtPriceX96: 79228162514264337593543950336n,
        tick: -887, liquidity: 500000000000000000n, tickSpacing: 10,
        bitmapWordValue: 1n << 167n,
        liquidityNet: 100000000000000000n, liquidityGross: 100000000000000000n,
      });
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(true);
    });

    it("Test D: fresh V3 tick changed => REJECT", async function () {
      const ven = v3Venue();
      const opp = buildOpp(ven, null);
      const provider = new MockProvider(101, HASH);
      registerV3State(provider, ven, {
        sqrtPriceX96: 79228162514264337593543950336n,
        tick: -888, liquidity: 500000000000000000n, tickSpacing: 10,
        bitmapWordValue: 1n << 167n,
        liquidityNet: 100000000000000000n, liquidityGross: 100000000000000000n,
      });
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("stale-state");
    });

    it("Test E: fresh V3 liquidityNet changed => REJECT", async function () {
      const ven = v3Venue();
      const opp = buildOpp(ven, null);
      const provider = new MockProvider(101, HASH);
      registerV3State(provider, ven, {
        sqrtPriceX96: 79228162514264337593543950336n,
        tick: -887, liquidity: 500000000000000000n, tickSpacing: 10,
        bitmapWordValue: 1n << 167n,
        liquidityNet: 100000000000000001n, liquidityGross: 100000000000000000n,
      });
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("stale-state");
    });

    it("Test F: fresh V3 bitmap changed => REJECT", async function () {
      const ven = v3Venue();
      const opp = buildOpp(ven, null);
      const provider = new MockProvider(101, HASH);
      registerV3State(provider, ven, {
        sqrtPriceX96: 79228162514264337593543950336n,
        tick: -887, liquidity: 500000000000000000n, tickSpacing: 10,
        bitmapWordValue: 170141183460469231731687303715884105728n,
        liquidityNet: 100000000000000000n, liquidityGross: 100000000000000000n,
      });
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("stale-state");
    });
  });

  describe("DODO fresh state (Tests G, H, I)", function () {
    it("Test G: fresh DODO unchanged => ACCEPT", async function () {
      const ven = dodoVenue();
      const opp = buildOpp(ven, null);
      const provider = new MockProvider(101, HASH);
      registerDODOState(provider, ven, {
        baseToken: TOK_A, quoteToken: TOK_B,
        baseReserve: 1000000n, quoteReserve: 1000000n,
        i: 1000000000000000000n, K: 100000000000000000n,
        B: 1000000n, Q: 1000000n, B0: 1054092553389459n, Q0: 0n, R: 1n,
        lpFeeRate: 2000000000000000n, mtFeeRate: 0n,
      });
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(true);
    });

    it("Test H: fresh DODO K changed => REJECT", async function () {
      const ven = dodoVenue();
      const opp = buildOpp(ven, null);
      const provider = new MockProvider(101, HASH);
      registerDODOState(provider, ven, {
        baseToken: TOK_A, quoteToken: TOK_B,
        baseReserve: 1000000n, quoteReserve: 1000000n,
        i: 1000000000000000000n, K: 100000000000000001n,
        B: 1000000n, Q: 1000000n, B0: 1054092553389459n, Q0: 0n, R: 1n,
        lpFeeRate: 2000000000000000n, mtFeeRate: 0n,
      });
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("stale-state");
    });

    it("Test I: fresh DODO B/Q/R changed => REJECT", async function () {
      const ven = dodoVenue();
      const opp = buildOpp(ven, null);
      const provider = new MockProvider(101, HASH);
      registerDODOState(provider, ven, {
        baseToken: TOK_A, quoteToken: TOK_B,
        baseReserve: 1000000n, quoteReserve: 1000000n,
        i: 1000000000000000000n, K: 100000000000000000n,
        B: 1000001n, Q: 1000000n, B0: 1054092553389459n, Q0: 0n, R: 2n,
        lpFeeRate: 2000000000000000n, mtFeeRate: 0n,
      });
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("stale-state");
    });
  });

  describe("block identity vs state identity (Tests J, K)", function () {
    it("Test J: new block but identical state => ACCEPT", async function () {
      const ven = v2Venue();
      const opp = buildOpp(ven, null, 100);
      const provider = new MockProvider(101, HASH);
      registerV2State(provider, ven, 1000000n, 2000000n);
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(true);
      expect(result.freshBlockNumber).to.equal(101);
    });

    it("Test K: new block + changed state => REJECT", async function () {
      const ven = v2Venue();
      const opp = buildOpp(ven, null, 100);
      const provider = new MockProvider(101, HASH);
      registerV2State(provider, ven, 900000n, 2000000n);
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("stale-state");
    });
  });

  describe("edge cases (Tests L, M)", function () {
    it("Test L: fresh blockHash unavailable => REJECT", async function () {
      const ven = v2Venue();
      const opp = buildOpp(ven, null);
      const provider = {
        getBlockNumber: async () => 101,
        getBlock: async () => ({ timestamp: 1700000000 }),
      };
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("block-hash-unavailable");
    });

    it("Test M: fresh venue missing (not fingerprinted) => REJECT", async function () {
      const ven = v2Venue();
      const opp = buildOpp(ven, null);
      opp.buyVen = v2Venue({ pair: "0x" + "ff".repeat(20) });
      const provider = new MockProvider(101, HASH);
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("venue-not-fingerprinted");
    });
  });

  describe("multiple venues (Test N)", function () {
    it("Test N1: V2 same + V3 same => ACCEPT", async function () {
      const buy = v2Venue();
      const sell = v3Venue();
      const opp = buildOpp(buy, sell);
      const provider = new MockProvider(101, HASH);
      registerV2State(provider, buy, 1000000n, 2000000n);
      registerV3State(provider, sell, {
        sqrtPriceX96: 79228162514264337593543950336n,
        tick: -887, liquidity: 500000000000000000n, tickSpacing: 10,
        bitmapWordValue: 1n << 167n,
        liquidityNet: 100000000000000000n, liquidityGross: 100000000000000000n,
      });
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(true);
      expect(result.venuesChecked).to.equal(2);
    });

    it("Test N2: V2 same + V3 changed => REJECT", async function () {
      const buy = v2Venue();
      const sell = v3Venue();
      const opp = buildOpp(buy, sell);
      const provider = new MockProvider(101, HASH);
      registerV2State(provider, buy, 1000000n, 2000000n);
      registerV3State(provider, sell, {
        sqrtPriceX96: 79228162514264337593543950336n,
        tick: -888, liquidity: 500000000000000000n, tickSpacing: 10,
        bitmapWordValue: 1n << 167n,
        liquidityNet: 100000000000000000n, liquidityGross: 100000000000000000n,
      });
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("stale-state");
    });

    it("Test N3: V2 changed + V3 same => REJECT", async function () {
      const buy = v2Venue();
      const sell = v3Venue();
      const opp = buildOpp(buy, sell);
      const provider = new MockProvider(101, HASH);
      registerV2State(provider, buy, 900000n, 2000000n);
      registerV3State(provider, sell, {
        sqrtPriceX96: 79228162514264337593543950336n,
        tick: -887, liquidity: 500000000000000000n, tickSpacing: 10,
        bitmapWordValue: 1n << 167n,
        liquidityNet: 100000000000000000n, liquidityGross: 100000000000000000n,
      });
      const result = await freshMod.freshOnChainStateValidation(opp, provider);
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal("stale-state");
    });
  });

  describe("executeOpp NOT called on stale state (Test O)", function () {
    it("Test O: fresh state changed => execGuardedOpp returns ok:false, executeOpp calls === 0", async function () {
      const executorPath = require.resolve("../../bot/executor");
      const realExecutor = require.cache[executorPath];
      let executeCalls = 0;
      require.cache[executorPath] = {
        id: executorPath, filename: executorPath, loaded: true,
        exports: { executeOpp: async () => { executeCalls++; return { ok: true }; } },
      };

      delete require.cache[require.resolve("../../bot/index")];
      const index = require("../../bot/index");

      try {
        // Two venues required (validateSnapshot needs both buyVen + sellVen).
        const buy = v2Venue();
        const sell = v2Venue({ pair: "0x" + "a3".repeat(20) });
        const opp = buildOpp(buy, sell);
        const provider = new MockProvider(101, HASH);
        // buy venue: fresh state changed (stale); sell venue: fresh state unchanged.
        registerV2State(provider, buy, 900000n, 2000000n);
        registerV2State(provider, sell, 1000000n, 2000000n);

        const result = await index.execGuardedOpp(
          opp, "0xContract",
          { getAddress: async () => "0xWallet" },
          provider,
          { snapshot: opp.snapshot }
        );

        expect(result.ok).to.equal(false);
        expect(result.reason).to.equal("stale-state");
        expect(executeCalls).to.equal(0);
      } finally {
        require.cache[executorPath] = realExecutor;
        delete require.cache[require.resolve("../../bot/index")];
      }
    });
  });
});

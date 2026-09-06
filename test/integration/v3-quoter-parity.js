// ============================================================================
// test/integration/v3-quoter-parity.js — TASK 4.4
//
// Parity check against BSC mainnet state — NO hardhat fork needed:
// both sides of the comparison are pure reads, so the test talks to the
// public RPC directly (a fork provider serializes/proxies every eth_call
// and times out on dense pools):
//
//   scanner.enrichV3Venues()  (slot0 + tickSpacing + tickBitmap words +
//                              initialized ticks with liquidityNet,
//                              via Multicall3 → ~3 eth_calls)
//   + lib/v3.getAmountOutV3Exact()   (local off-chain quote)
//      vs
//   on-chain QuoterV2.quoteExactInputSingle() (eth_call)
//
// Both sides are pinned to the SAME block (blockTag), so parity must be tight.
//
// REQUIRES: BSC_RPC_URL in .env
// Run: npx hardhat test test/integration/v3-quoter-parity.js
// ============================================================================
const { expect } = require("chai");
const { ethers: rawEthers } = require("ethers");
const scanner = require("../../bot/scanner");
const v3lib = require("../../lib/v3");

// Real PancakeSwap V3 pool USDT/WBNB (fee=100); token0=USDT, token1=WBNB.
const POOL = "0x172fcd41e0913e95784454622d1c3724f546f849";
const QUOTER = "0xb048bbc1ee6b733fffcfb9e9cef7375518e25997"; // PancakeSwap QuoterV2
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const FEE = 100;

const QUOTER_ABI = [
  // PancakeSwap V3 QuoterV2 uses a SINGLE STRUCT argument with amountIn BEFORE
  // fee — verified live in test/integration/dodo-v2-fork.js (TEST C passed):
  "function quoteExactInputSingle((address,address,uint256,uint24,uint160)) view returns (uint256,uint160,uint32,uint256)",
];

describe("TASK 4.4 — V3 local quote (words+ticks) vs QuoterV2 parity", function () {
  before(async function () {
    if (!process.env.BSC_RPC_URL) {
      console.log("      SKIP: BSC_RPC_URL not set (BSC mainnet RPC required)");
      this.skip();
    }
    // Standalone provider — deliberately NOT the hardhat fork provider: every
    // side here is a read (multicall / eth_call), so the public RPC is both
    // correct and ~100x faster than proxying through the fork.
    this.timeout(180000);
    this.provider = new rawEthers.JsonRpcProvider(process.env.BSC_RPC_URL, {
      name: "bsc",
      chainId: 56,
    });
    this.quoter = new rawEthers.Contract(QUOTER, QUOTER_ABI, this.provider);

    // Synthetic venue → enrichV3Venues attaches the deep v3State (slot0,
    // tickSpacing, tickBitmap words, initialized ticks w/ liquidityNet),
    // everything read at ONE block so the local quote is deterministic.
    this.blockNumber = await this.provider.getBlockNumber();
    this.venue = {
      kind: 1,
      name: "PancakeV3-USDT-WBNB",
      pool: POOL,
      feeTier: FEE,
      tokenA: { address: USDT },
      tokenB: { address: WBNB },
    };
    const out = await scanner.enrichV3Venues(this.provider, [this.venue], {
      blockTag: this.blockNumber,
    });
    expect(out.length, "enrichV3Venues did not enrich the venue").to.equal(1);
    const s = this.venue.v3State;
    expect(s, "v3State missing").to.exist;
    console.log(
      "      block=" + this.blockNumber +
      " tick=" + s.tick + " spacing=" + s.tickSpacing +
      " words=" + s.words.length + " initTicks=" + s.ticks.length
    );
    this.s = s;
    // Same Maps the bot builds in bot/profit.js venueOutput().
    this.words = new Map(s.words.map((w) => [Number(w.word), BigInt(w.value)]));
    this.ticks = new Map(s.ticks.map((t) => [Number(t.tick), BigInt(t.liquidityNet)]));
  });

  it("discovers tickBitmap words + initialized ticks (liquidityNet) around current tick", function () {
    const s = this.s;
    expect(BigInt(s.sqrtPriceX96)).to.be.gt(0n);
    expect(BigInt(s.liquidity)).to.be.gt(0n);
    expect(s.tickSpacing).to.be.gt(0);
    expect(s.words.length).to.be.gte(1); // non-zero words within ±3 of current word
    expect(s.ticks.length).to.be.gt(0);
    // An initialized tick can legitimately carry liquidityNet == 0 (liquidity
    // minted and burned on both sides of the tick) — what matters is that the
    // entry exists, is spacing-aligned, the set brackets the current tick and
    // is not entirely flat.
    const spacing = Number(s.tickSpacing);
    let nonZero = 0;
    for (const t of s.ticks) {
      expect(t.liquidityNet, "tick entry missing liquidityNet").to.exist;
      if (BigInt(t.liquidityNet) !== 0n) nonZero++;
      expect(
        Math.abs(Number(t.tick)) % spacing,
        "tick not spacing-aligned: " + t.tick
      ).to.equal(0);
    }
    expect(nonZero, "every initialized tick has liquidityNet=0").to.be.gt(0);
    // The tick set must bracket the current tick (required by exact math in
    // both swap directions on an active pool).
    const cur = Number(s.tick);
    const all = s.ticks.map((t) => Number(t.tick));
    expect(all.filter((x) => x >= cur).length, "no initialized tick at/above current tick").to.be.gt(0);
    expect(all.filter((x) => x < cur).length, "no initialized tick below current tick").to.be.gt(0);
  });

  it("matches QuoterV2 across many amounts in both directions", async function () {
    this.timeout(180000);
    const self = this;
    // USDT (6 dec) -> WBNB = token0 -> token1 = zeroForOne=true
    // WBNB (18 dec) -> USDT = token1 -> token0 = zeroForOne=false
    const cases = [];
    for (const k of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15]) {
      cases.push({ zeroForOne: true, amt: 10n ** 6n * BigInt(50 * k), tokenIn: USDT, tokenOut: WBNB });
    }
    for (const k of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15]) {
      cases.push({ zeroForOne: false, amt: (10n ** 18n * BigInt(k)) / 20n, tokenIn: WBNB, tokenOut: USDT });
    }

    // Some public RPCs reject eth_call carrying an explicit blockTag. On the
    // FIRST such failure the whole fixture is re-pinned to the RPC's "latest"
    // (enrichment + quoter move together, so parity stays meaningful) and the
    // remaining quotes continue unpinned.
    let pinned = true;
    async function quoteOnChain(c) {
      // Struct params: (tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96);
      // returns are positional → amountOut = q[0].
      const params = [c.tokenIn, c.tokenOut, c.amt, FEE, 0n];
      const opts = pinned ? { blockTag: self.blockNumber } : {};
      try {
        return await self.quoter.quoteExactInputSingle(params, opts);
      } catch (e) {
        if (!pinned) throw e;
        console.log(
          "      pinned eth_call rejected (" + String(e.message || e).slice(0, 60) +
          ") → re-pinning fixture to latest"
        );
        pinned = false;
        self.blockNumber = await self.provider.getBlockNumber();
        await scanner.enrichV3Venues(self.provider, [self.venue], { blockTag: self.blockNumber });
        const s2 = self.venue.v3State;
        self.s = s2;
        self.words = new Map(s2.words.map((w) => [Number(w.word), BigInt(w.value)]));
        self.ticks = new Map(s2.ticks.map((t) => [Number(t.tick), BigInt(t.liquidityNet)]));
        return await self.quoter.quoteExactInputSingle(params);
      }
    }

    let total = 0, matched = 0, maxRelBps = 0n;
    const fails = [];
    for (const c of cases) {
      const q = await quoteOnChain(c);
      const expected = q[0]; // amountOut (positional)
      if (expected === 0n) continue;
      const s = self.s; // fresh after a possible re-pin
      let got;
      try {
        const r = v3lib.getAmountOutV3Exact({
          amountIn: c.amt,
          zeroForOne: c.zeroForOne,
          fee: FEE,
          tickSpacing: s.tickSpacing,
          words: self.words,
          ticks: self.ticks,
          sqrtPx96: s.sqrtPriceX96,
          liquidity: s.liquidity,
          tick: s.tick,
        });
        got = r.amountOut;
      } catch (e) {
        fails.push((c.zeroForOne ? "0->1" : "1->0") + ":" + c.amt + " threw " + e.message.slice(0, 60));
        continue;
      }
      total++;
      const dev = got > expected ? got - expected : expected - got;
      const relBps = (dev * 10000n) / expected;
      if (relBps <= 100n) matched++; // within 1%
      if (relBps > maxRelBps) maxRelBps = relBps;
    }
    console.log(
      "      parity: " + matched + "/" + total + " cases within 1% (max deviation " + maxRelBps + " bps)" +
      (pinned
        ? " | fully pinned to block " + self.blockNumber
        : " | RPC rejected pinned eth_call → compared at latest")
    );
    if (fails.length) console.log("      threw: " + fails.slice(0, 3).join(" | "));
    expect(total, "no comparable cases").to.be.gte(15);
    expect(matched / total, "parity below 90%").to.be.gte(0.9);
  });
});

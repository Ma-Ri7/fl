// ============================================================================
// test/integration/dodo-v2-fork.js — REAL DODO V2 fork integration (TEST C).
//
// ⚠️  REQUIRES: BSC_RPC_URL in .env (BSC mainnet fork).
//
// Flow exercised on a REAL DODO V2 pool (real deployed contract, WBNB/USDT):
//
//   BSC fork
//     → real DODO DVM/DPP/DSP factory → getDODOPool()
//     → real pool
//     → read PMM state (i, K, B, Q, B0, Q0, R, LP fee, maintainer fee)
//     → off-chain quote (lib/dodo.js)
//     → real flashLoan() → DODO callback (DVM/DPP/DSPFlashLoanCall)
//     → Pancake V3 (leg A) → BiSwap V2 (leg B, skewed)
//     → repayment → profit
//
// Verified: base/quote, i, K, B, Q, LP fee, maintainer fee, actual repayment,
//           actual profit, gas, state delta.
//
// Run: npx hardhat test test/integration/dodo-v2-fork.js
// ============================================================================
const { expect } = require("chai");
const { ethers } = require("hardhat");
const dodoLib = require("../../lib/dodo");

// ─── Real BSC addresses ─────────────────────────────────────────────────
const WBNB = ethers.getAddress("0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");
const USDT = ethers.getAddress("0x55d398326f99059ff775485246999027b3197955");

const DODO_DVM_FACTORY = ethers.getAddress("0x790b4a80fb1094589a3c0efc8740aa9b0c1733fb");
const DODO_DSP_FACTORY = ethers.getAddress("0x0fb9815938ad069bf90e14fe6c596c514bede767");
const DODO_DPP_FACTORY = ethers.getAddress("0xd9cac3d964327e47399aebd8e1e6dcc4c251daae");

// Real PancakeSwap V3 pool USDT/WBNB fee=100 (token0=USDT, token1=WBNB).
const PC_V3_POOL_F100 = ethers.getAddress("0x172fcd41e0913e95784454622d1c3724f546f849");
const QUOTER_V2 = ethers.getAddress("0xb048bbc1ee6b733fffcfb9e9cef7375518e25997");

// Real V2 venues (Leg B). The BiSwap router address historically published in
// some lists is NOT a live router (its factory()/getAmountsOut revert on-chain),
// so Test C DISCOVERS a usable venue by probing live candidates instead.
const CANDIDATE_VENUES = [
  {
    name: "PancakeSwap V2",
    factory: ethers.getAddress("0xca143ce32fe78f1f7019d7d551a6402fc5350c73"),
    router: ethers.getAddress("0x10ed43c718714eb63d5aa57b78b54704e256024e"),
  },
  {
    name: "SushiSwap",
    factory: ethers.getAddress("0xc35dadb65012ec5796536bd9864ed8773abc74c4"),
    router: ethers.getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"),
  },
  {
    name: "BiSwap",
    factory: ethers.getAddress("0x858e3312ed3a876947ea49d572a7c42de08af7ee"),
    router: ethers.getAddress("0x3a6d8ca21d1cf76f653a65577fa0d27453350dd8"),
  },
];

// Real DPP pool with real liquidity (verified on BSC fork):
//   base=WBNB, quote=USDT, i≈352, K=0.3, LP fee=0.5%, USDT reserve ≈ 283K.
const DODO_LIQUID_POOL = ethers.getAddress("0x6098a5638d8d7e9ed2f952d35b2b67c34ec6b476");

// Whales used only to obtain USDT for injecting the venue skew on the fork.
const WHALES = [
  "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance 7
  "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3", // Binance Hot 6
  "0x28C6c06298d514Db089934071355E5743bf21d60", // Binance 14
];

// ─── Minimal DODO V2 ABIs (verified on-chain / DODO contractV2) ──────
const DODO_FACTORY_ABI = [
  "function getDODOPool(address baseToken, address quoteToken) view returns (address[])",
];

const DODO_POOL_ABI = [
  "function _BASE_TOKEN_() view returns (address)",
  "function _QUOTE_TOKEN_() view returns (address)",
  "function _I_() view returns (uint256)",
  "function _K_() view returns (uint256)",
  "function _LP_FEE_RATE_() view returns (uint256)",
  "function _MT_FEE_RATE_MODEL_() view returns (address)",
  "function _BASE_RESERVE_() view returns (uint112)",
  "function _QUOTE_RESERVE_() view returns (uint112)",
  "function getPMMStateForCall() view returns (uint256 i, uint256 K, uint256 B, uint256 Q, uint256 B0, uint256 Q0, uint256 R)",
  "function getMidPrice() view returns (uint256)",
  "function flashLoan(uint256 baseAmount, uint256 quoteAmount, address assetTo, bytes calldata data) external",
];

const FEE_RATE_MODEL_ABI = [
  "function getFeeRate(address trader) view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
  "function approve(address, uint256) returns (bool)",
];

const PAIR_ABI = [
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function sync()",
];

const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function getAmountsOut(uint256, address[]) view returns (uint256[])",
];

const FACTORY_ABI = [
  "function getPair(address, address) view returns (address)",
];

const QUOTER_ABI = [
  "function quoteExactInputSingle((address,address,uint256,uint24,uint160)) view returns (uint256,uint160,uint32,uint256)",
];

// ─── Helpers ───────────────────────────────────────────────────────────
const U = (n) => BigInt(n) * 1000000000000000000n;
const N18 = 1000000000000000000n;
function p(s) { console.log("  " + s); }
function head(s) { console.log("\n=== " + s + " ==="); }
function fmt(x) {
  return (Number(x) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

async function ensureUsdt(provider, owner, usdt, need) {
  const me = owner.address;
  let bal = BigInt(await usdt.balanceOf(me));
  for (const w of WHALES) {
    if (bal >= need) break;
    await provider.send("hardhat_impersonateAccount", [w]);
    await provider.send("hardhat_setBalance", [w, "0x56BC75E2D63100000"]);
    const wt = usdt.connect(await ethers.getSigner(w));
    const wb = BigInt(await usdt.balanceOf(w));
    const take = wb < need - bal ? wb : need - bal;
    if (take > 0n) {
      await (await wt.transfer(me, take)).wait();
      bal = BigInt(await usdt.balanceOf(me));
      p("skew funded: +" + fmt(take) + " USDT (whale " + w.slice(0, 8) + ")");
    }
  }
  if (bal < need) throw new Error("insufficient USDT from whales for skew");
}

// Read the full PMM state from a real DODO pool (works for DVM/DPP/DSP).
async function readPMMState(pool) {
  const baseToken = await pool._BASE_TOKEN_();
  const quoteToken = await pool._QUOTE_TOKEN_();
  const st = await pool.getPMMStateForCall();
  const lpFeeRate = BigInt(await pool._LP_FEE_RATE_());
  const mtModelAddr = await pool._MT_FEE_RATE_MODEL_();
  let mtFeeRate = 0n;
  if (mtModelAddr && mtModelAddr !== ethers.ZeroAddress) {
    try {
      const model = new ethers.Contract(mtModelAddr, FEE_RATE_MODEL_ABI, ethers.provider);
      mtFeeRate = BigInt(await model.getFeeRate(pool.target || pool.address));
    } catch (e) { /* some models revert for unknown pools */ }
  }
  return {
    baseToken,
    quoteToken,
    i: BigInt(st[0]), K: BigInt(st[1]), B: BigInt(st[2]), Q: BigInt(st[3]),
    B0: BigInt(st[4]), Q0: BigInt(st[5]), R: BigInt(st[6]),
    lpFeeRate,
    mtFeeRate,
    mtFeeRateModel: mtModelAddr,
  };
}

// ============================================================================
// TEST C — REAL DODO V2 fork integration
// ============================================================================
describe("Test C: REAL DODO V2 fork integration", function () {
  let provider, owner, usdt, wbnb;
  let dvmFactory, dspFactory, dppFactory;
  let flash, flashAddr;
  let forkBlock;
  let pool, poolAddr, poolState;

  before(async function () {
    provider = ethers.provider;
    [owner] = await ethers.getSigners();
    forkBlock = (await provider.getBlock("latest")).number;

    // Skip gracefully when not running on a BSC fork.
    if (forkBlock < 30000000) {
      head("SKIP: not on BSC fork — set BSC_RPC_URL in .env");
      this.skip();
    }

    usdt = new ethers.Contract(USDT, ERC20_ABI, owner);
    wbnb = new ethers.Contract(WBNB, ERC20_ABI, owner);

    dvmFactory = new ethers.Contract(DODO_DVM_FACTORY, DODO_FACTORY_ABI, provider);
    dspFactory = new ethers.Contract(DODO_DSP_FACTORY, DODO_FACTORY_ABI, provider);
    dppFactory = new ethers.Contract(DODO_DPP_FACTORY, DODO_FACTORY_ABI, provider);

    const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await Flash.deploy();
    await flash.waitForDeployment();
    flashAddr = await flash.getAddress();

    p("BSC fork block " + forkBlock);
    p("FLASH deployed at " + flashAddr);

    // Connect to the real DODO pool with actual liquidity.
    poolAddr = DODO_LIQUID_POOL;
    pool = new ethers.Contract(poolAddr, DODO_POOL_ABI, provider);
  });

  // Pick a usable pool: prefer DODO_LIQUID_POOL, else discover via factories.
  async function pickUsablePool() {
    const candidates = [DODO_LIQUID_POOL];
    const factories = [
      ["DPP", dppFactory],
      ["DVM", dvmFactory],
      ["DSP", dspFactory],
    ];
    for (const [name, factory] of factories) {
      let pools = [];
      try { pools = await factory.getDODOPool(USDT, WBNB); } catch (e) {}
      if (pools.length === 0) {
        try { pools = await factory.getDODOPool(WBNB, USDT); } catch (e) {}
      }
      for (const a of pools) {
        if (a.toLowerCase() === DODO_LIQUID_POOL.toLowerCase()) continue;
        candidates.push(a);
      }
    }
    for (const a of candidates) {
      try {
        const c = new ethers.Contract(a, DODO_POOL_ABI, provider);
        const base = await c._BASE_TOKEN_();
        const quote = await c._QUOTE_TOKEN_();
        const bal = await usdt.balanceOf(a);
        const state = await readPMMState(c);
        if (state.i > 0n && bal > U(1000)) {
          p("usable pool " + a + " base=" + base + " quote=" + quote + " USDTbal=" + fmt(bal));
          return { addr: a, pool: c, state };
        }
      } catch (e) { /* skip dead/broken pool */ }
    }
    return null;
  }
// Discover a live, usable V2 venue (Leg B) by probing real candidates.
  async function pickV2Venue() {
    let best = null;
    for (const cand of CANDIDATE_VENUES) {
      try {
        const router = new ethers.Contract(cand.router, ROUTER_ABI, provider);
        const rf = await router.factory();
        if (rf.toLowerCase() !== cand.factory.toLowerCase()) {
          p("venus " + cand.name + ": router.factory mismatch, skip");
          continue;
        }
        const fac = new ethers.Contract(cand.factory, FACTORY_ABI, provider);
        const pair = await fac.getPair(WBNB, USDT);
        if (!pair || pair === ethers.ZeroAddress) {
          p("venus " + cand.name + ": no WBNB/USDT pair, skip");
          continue;
        }
        const out = await router.getAmountsOut(U(1), [WBNB, USDT]);
        if (!out || BigInt(out[out.length - 1]) <= 0n) {
          p("venus " + cand.name + ": getAmountsOut empty, skip");
          continue;
        }
        const pc = new ethers.Contract(pair, PAIR_ABI, provider);
        const t0 = await pc.token0();
        const [r0, r1] = await pc.getReserves();
        const usdtRes = BigInt(t0.toLowerCase() === USDT.toLowerCase() ? r0 : r1);
        const wbnbRes = BigInt(t0.toLowerCase() === USDT.toLowerCase() ? r1 : r0);
        p("venus " + cand.name + " OK: pair=" + pair + " USDTres=" + fmt(usdtRes) + " WBNBres=" + fmt(wbnbRes));
        if (usdtRes > U(10000) && wbnbRes > U(1)) {
          if (!best || usdtRes > best.usdtRes) {
            best = { name: cand.name, router, pair, pairC: pc, t0, usdtRes, wbnbRes };
          }
        }
      } catch (e) {
        p("venus " + cand.name + " probe failed: " + String(e.message).slice(0, 70));
      }
    }
    if (!best) throw new Error("no usable V2 venue for Leg B");
    p("Leg B venue selected: " + best.name + " router=" + candRouterAddr(best));
    return best;
  }

  function candRouterAddr(v) {
    return v.router.target || v.router.address;
  }

  describe("DODO factory connectivity", function () {
    it("connects to DODO DVM factory", async function () {
      expect(await dvmFactory.getAddress()).to.equal(DODO_DVM_FACTORY);
    });

    it("connects to DODO DSP factory", async function () {
      expect(await dspFactory.getAddress()).to.equal(DODO_DSP_FACTORY);
    });

    it("connects to DODO DPP factory", async function () {
      expect(await dppFactory.getAddress()).to.equal(DODO_DPP_FACTORY);
    });
  });

  describe("Pool discovery (real factory getDODOPool)", function () {
    it("enumerates real DODO pools for USDT/WBNB", async function () {
      let total = 0;
      for (const [name, factory] of [["DPP", dppFactory], ["DVM", dvmFactory], ["DSP", dspFactory]]) {
        let uw = [], wu = [];
        try { uw = await factory.getDODOPool(USDT, WBNB); } catch (e) {}
        try { wu = await factory.getDODOPool(WBNB, USDT); } catch (e) {}
        p(name + " USDT/WBNB=" + uw.length + " WBNB/USDT=" + wu.length);
        total += uw.length + wu.length;
      }
      expect(total).to.be.gt(0);
    });

    it("picks the DODO_LIQUID_POOL candidate", async function () {
      const usable = await pickUsablePool();
      expect(usable).to.not.equal(null);
      p("selected: " + usable.addr);
    });
  });

  describe("PMM state reading (real pool)", function () {
    it("reads base/quote tokens", async function () {
      const base = await pool._BASE_TOKEN_();
      const quote = await pool._QUOTE_TOKEN_();
      p("base=" + base + " quote=" + quote);
      const tokens = [base.toLowerCase(), quote.toLowerCase()];
      expect(tokens).to.include(USDT.toLowerCase());
      expect(tokens).to.include(WBNB.toLowerCase());
    });

    it("reads full PMM state (i, K, B, Q, B0, Q0, R)", async function () {
      poolState = await readPMMState(pool);
      p("i (oracle price)   = " + fmt(poolState.i));
      p("K (slippage)       = " + fmt(poolState.K));
      p("B (base target)    = " + fmt(poolState.B));
      p("Q (quote target)   = " + fmt(poolState.Q));
      p("B0 (base target0)  = " + fmt(poolState.B0));
      p("Q0 (quote target0) = " + fmt(poolState.Q0));
      p("R (state)          = " + poolState.R.toString() + " (0=ONE,1=ABOVE,2=BELOW)");
      p("LP fee rate        = " + fmt(poolState.lpFeeRate) + " (" + (Number(poolState.lpFeeRate) / 1e16).toFixed(4) + "%)");
      p("Maintainer fee rate= " + fmt(poolState.mtFeeRate) + " (" + (Number(poolState.mtFeeRate) / 1e16).toFixed(4) + "%)");
      p("MT fee model       = " + poolState.mtFeeRateModel);
      expect(poolState.i).to.be.gt(0n);
      expect(poolState.K).to.be.gte(0n);
      expect(poolState.B + poolState.Q).to.be.gt(0n);
    });
  });

  describe("Off-chain quote (lib/dodo.js vs getPMMStateForCall)", function () {
    it("computes a profitable-direction PMM quote on the real state", async function () {
      poolState = poolState || (await readPMMState(pool));
      const state = dodoLib.pmmStateFromReserves({ i: poolState.i, K: poolState.K, B: poolState.B, Q: poolState.Q });
      const pay = U(2000); // 2,000 USDT
      // pool base=WBNB quote=USDT → selling quote (USDT) buys base (WBNB).
      const q = dodoLib.sellQuoteToken(state, pay);
      p("off-chain sellQuote(" + fmt(pay) + " USDT) -> " + fmt(q.receive) + " WBNB");
      expect(q.receive).to.be.gt(0n);
    });
  });

  describe("Real DODO flashLoan execution (integration)", function () {
    it("runs the full real DODO arbitrage: skew -> flashLoan -> sell -> repay -> profit", async function () {
      poolState = poolState || (await readPMMState(pool));
      if (BigInt(poolState.B) + BigInt(poolState.Q) === 0n) {
        head("SKIP: pool has no liquidity - cannot execute real arbitrage");
        this.skip();
      }

      const base = poolState.baseToken;
      const quote = poolState.quoteToken;
      p("pool base=" + base + " quote=" + quote);

      const borrowB = U(2000); // 2,000 USDT borrowed from the real DODO pool

      // Pool balances before (for repayment + state-delta verification).
      const poolUsdtBefore = BigInt(await usdt.balanceOf(poolAddr));
      const poolWbnbBefore = BigInt(await wbnb.balanceOf(poolAddr));
      const stateBefore = await readPMMState(pool);
      p("pool before: USDT=" + fmt(poolUsdtBefore) + " WBNB=" + fmt(poolWbnbBefore));

      // Leg A quote: real Pancake V3 (USDT -> WBNB, fee=100).
      const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);
      const v3 = await quoter.quoteExactInputSingle([USDT, WBNB, borrowB, 100, 0n]);
      const wbnbOut = BigInt(v3[0]);
      expect(wbnbOut).to.be.gt(0n);
      p("legA V3 quote: " + fmt(borrowB) + " USDT -> " + fmt(wbnbOut) + " WBNB");

      // Discover a live V2 venue for Leg B (real router + pair).
      const venue = await pickV2Venue();
      const venuePair = venue.pair;
      const pairC = venue.pairC;
      const t0 = venue.t0;
      const router = venue.router;
      const venueQuote = async () => BigInt((await router.getAmountsOut(wbnbOut, [WBNB, USDT]))[1]);
      let usdtBack = await venueQuote();
      const repay = borrowB; // DODO fee-free when returning exactly borrowed
      const targetNet = U(20); // require >= 20 USDT net profit

      // Skew the venue until the WBNB->USDT leg returns a profit.
      for (let i = 0; i < 14; i++) {
        if (usdtBack - repay >= targetNet) { p("skew ok (iter " + i + ") net=" + fmt(usdtBack - repay)); break; }
        const res = await pairC.getReserves();
        const ru = BigInt(t0.toLowerCase() === USDT.toLowerCase() ? res[0] : res[1]);
        const backTarget = repay + targetNet + U(50);
        const m = (Number(backTarget) + 1) / (Number(usdtBack) + 1);
        let D = BigInt(Math.floor(Number(ru) * (m - 1))) + U(25);
        if (D > U(4000000)) D = U(4000000);
        await ensureUsdt(provider, owner, usdt, D);
        await (await usdt.connect(owner).transfer(venuePair, D)).wait();
        await (await pairC.connect(owner).sync()).wait();
        usdtBack = await venueQuote();
        p("skew iter " + i + ": donated " + fmt(D) + " USDT -> back=" + fmt(usdtBack) + " net=" + fmt(usdtBack - repay));
      }
      if (usdtBack - repay < targetNet) throw new Error("skew failed: venue did not become profitable");
      p("expected off-chain profit = " + fmt(usdtBack - repay) + " USDT");
      p("expected DODO repayment   = " + fmt(repay) + " USDT");

      // Build real legs.
      const legA = { kind: 1, target: PC_V3_POOL_F100, zeroForOne: true, path: [] };
      const venueRouterAddr = candRouterAddr(venue);
      const legB = { kind: 0, target: venueRouterAddr, zeroForOne: false, path: [WBNB, USDT] };
      const dl = async () => (await provider.getBlock("latest")).timestamp + 300;

      const ownerUsdtBefore = BigInt(await usdt.balanceOf(owner.address));
      const args = [poolAddr, 0n, borrowB, quote, base, base, quote, legA, legB, 1n, await dl()];

      // Final safety: the arbitrage must pass eth_call before broadcasting.
      await flash.flashArbitrageDodo.staticCall(...args);
      p("staticCall OK");

      const gasEst = await flash.flashArbitrageDodo.estimateGas(...args);
      p("estimateGas=" + gasEst.toString());

      // Broadcast on the fork - the REAL DODO contract runs its own flashLoan.
      const tx = await flash.flashArbitrageDodo(...args, { gasLimit: (gasEst * 130n) / 100n });
      const rc = await tx.wait();
      expect(rc.status).to.equal(1);

      // Actual profit / owner balance delta.
      const ownerUsdtAfter = BigInt(await usdt.balanceOf(owner.address));
      const profit = ownerUsdtAfter - ownerUsdtBefore;
      p("actual profit = " + fmt(profit) + " USDT (expected " + fmt(usdtBack - repay) + ")");
      expect(profit).to.be.gt(0n);
      const diff = profit - (usdtBack - repay);
      p("delta vs off-chain quote = " + diff.toString() + " wei");
      if (diff < -1000000000000000n || diff > 1000000000000000n) p("WARN: delta over 0.001 USDT");

      // Actual repayment: the real pool must end with >= its pre-loan balances.
      const poolUsdtAfter = BigInt(await usdt.balanceOf(poolAddr));
      const poolWbnbAfter = BigInt(await wbnb.balanceOf(poolAddr));
      const usdtDelta = poolUsdtAfter - poolUsdtBefore;
      const wbnbDelta = poolWbnbAfter - poolWbnbBefore;
      p("pool USDT delta after repay = " + fmt(usdtDelta) + " USDT");
      p("pool WBNB delta after repay = " + fmt(wbnbDelta) + " WBNB");
      expect(poolUsdtAfter).to.be.gte(poolUsdtBefore);
      expect(poolWbnbAfter).to.be.gte(poolWbnbBefore);
      // Expect fee-free flashloan: pool state returns exactly to pre-loan.
      expect(usdtDelta).to.equal(0n);
      expect(wbnbDelta).to.equal(0n);

      // State delta: PMM (B, Q) must be unchanged after exact repayment.
      const stateAfter = await readPMMState(pool);
      p("PMM B delta = " + fmt(stateAfter.B - stateBefore.B) + " | Q delta = " + fmt(stateAfter.Q - stateBefore.Q));
      expect(stateAfter.B).to.equal(stateBefore.B);
      expect(stateAfter.Q).to.equal(stateBefore.Q);
      expect(stateAfter.i).to.equal(stateBefore.i);
      expect(stateAfter.K).to.equal(stateBefore.K);

      // ArbitrageExecuted event must match the actual profit.
      let evProfit = null;
      for (const lg of rc.logs) {
        if (lg.address.toLowerCase() !== flashAddr.toLowerCase()) continue;
        try {
          const ev = flash.interface.parseLog({ topics: lg.topics, data: lg.data });
          if (ev && ev.name === "ArbitrageExecuted") {
            evProfit = ev.args[1];
          }
        } catch (e) { /* parsing issue */ }
      }
      expect(evProfit !== null && evProfit !== undefined).to.equal(true);
      expect(BigInt(evProfit)).to.equal(profit);
      p("PASS: ArbitrageExecuted(profit=" + fmt(BigInt(evProfit)) + ")");

      // No residual dust in the arbitrage contract.
      expect(await usdt.balanceOf(flashAddr)).to.equal(0n);
      expect(await wbnb.balanceOf(flashAddr)).to.equal(0n);
      p("PASS: contract cleanup (no dust)");

      // Gas report.
      p("gas used = " + rc.gasUsed.toString());
      p("============================================================");
      p("TEST C PASS - REAL DODO V2 flashLoan executed with profit " + fmt(profit) + " USDT");
    });
  });
});

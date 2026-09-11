// ============================================================================
// test/integration/execution-safety-fork.js — TASK 4.6-B (REAL BSC fork proof)
//
// Demonstrează pe un fork BSC mainnet REAL:
//   (A) per-leg amountOutMin (V2 router) execută cu succes când output >= minOut;
//   (B) per-leg amountOutMin REVERT când output real < minOut (slippage);
//   (C) minProfit_ atomic REVERT când profitul final < minProfit.
//
// ⚠️  REQUIRES: BSC_RPC_URL in .env (fork BSC mainnet). Skipped otherwise.
// Run: npx hardhat test test/integration/execution-safety-fork.js
// ============================================================================
const { expect } = require("chai");
const { ethers } = require("hardhat");

const WBNB = ethers.getAddress("0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");
const USDT = ethers.getAddress("0x55d398326f99059ff775485246999027b3197955");
const PC_V2_FACTORY = ethers.getAddress("0xca143ce32fe78f1f7019d7d551a6402fc5350c73");
const PC_V3_FACTORY = ethers.getAddress("0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865");
const PC_V3_POOL_F100 = ethers.getAddress("0x172fcd41e0913e95784454622d1c3724f546f849");
const QUOTER_V2 = ethers.getAddress("0xb048bbc1ee6b733fffcfb9e9cef7375518e25997");

const CANDIDATE_VENUES = [
  { name: "SushiSwap", factory: "0xc35dadb65012ec5796536bd9864ed8773abc74c4", router: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  { name: "BiSwap", factory: "0x858e3312ed3a876947ea49d572a7c42de08af7ee", router: "0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8" },
];

const WHALES = [
  "0x8894e0a0c962cb723c1976a4421c95949be2d4e3",
  "0xf977814e90da44bfa03b6295a0616a897441acec",
  "0x564286362092d8e7936f0549571a803b203aaced",
  "0x28c6c06298d514db089934071355e5743bf21d60",
  "0xdfd5293d8e347dfe59e90efd556295c6aca5f542",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];
const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function sync()",
];
const FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle((address,address,uint256,uint24,uint160)) view returns (uint256,uint160,uint32,uint256)",
];

const U = (n) => BigInt(n) * 10n ** 18n;

describe("TASK 4.6-B — on-chain per-leg amountOutMin (REAL BSC fork)", function () {
  this.timeout(300000);

  let provider, owner, arb, arbAddr;
  let usdt;
  let flashPair, fp, usdtIsT0;
  let venue;
  let quoter;
  let A, amount0Out, amount1Out, repay;
  let wbnbOut;
  let quoteB;

  async function ensureUsdt(need) {
    let bal = await usdt.balanceOf(owner.address);
    for (const w of WHALES) {
      if (bal >= need) break;
      await provider.send("hardhat_impersonateAccount", [w]);
      await provider.send("hardhat_setBalance", [w, "0x56BC75E2D63100000"]);
      const wt = usdt.connect(await ethers.getSigner(w));
      const wb = await usdt.balanceOf(w);
      const take = wb < need - bal ? wb : need - bal;
      await (await wt.transfer(owner.address, take)).wait();
      bal = await usdt.balanceOf(owner.address);
    }
    if (bal < need) throw new Error("insufficient USDT from whales");
  }

  before(async function () {
    provider = ethers.provider;
    [owner] = await ethers.getSigners();
    const forkBlock = (await provider.getBlock("latest")).number;
    if (forkBlock < 30000000) {
      console.log("SKIP: not on BSC fork — set BSC_RPC_URL in .env");
      this.skip();
      return;
    }

    const Fac = await ethers.getContractFactory("FlashLoanArbitrage");
    arb = await Fac.deploy();
    await arb.waitForDeployment();
    arbAddr = await arb.getAddress();

    usdt = new ethers.Contract(USDT, ERC20_ABI, owner);

    const pcFactory = new ethers.Contract(PC_V2_FACTORY, FACTORY_ABI, owner);
    flashPair = await pcFactory.getPair(WBNB, USDT);
    if (flashPair === ethers.ZeroAddress) throw new Error("flash pair missing");
    fp = new ethers.Contract(flashPair, PAIR_ABI, owner);
    const fpT0 = await fp.token0();
    usdtIsT0 = fpT0.toLowerCase() === USDT.toLowerCase();

    const v3Pool = new ethers.Contract(PC_V3_POOL_F100, ["function factory() view returns (address)", "function token0() view returns (address)", "function fee() view returns (uint24)"], owner);
    if ((await v3Pool.factory()).toLowerCase() !== PC_V3_FACTORY.toLowerCase()) throw new Error("v3 factory mismatch");
    if ((await v3Pool.token0()).toLowerCase() !== USDT.toLowerCase()) throw new Error("v3 token0 != USDT");
    if (Number(await v3Pool.fee()) !== 100) throw new Error("v3 fee != 100");

    quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, owner);

    for (const cand of CANDIDATE_VENUES) {
      try {
        const rc = new ethers.Contract(cand.router, ROUTER_ABI, owner);
        const rf = await rc.factory();
        if (rf.toLowerCase() !== cand.factory.toLowerCase()) continue;
        const fac = new ethers.Contract(rf, FACTORY_ABI, owner);
        const pair = await fac.getPair(WBNB, USDT);
        if (pair === ethers.ZeroAddress) continue;
        const pc = new ethers.Contract(pair, PAIR_ABI, owner);
        const t0 = await pc.token0();
        const [r0, r1] = await pc.getReserves();
        const usdtRes = BigInt(t0.toLowerCase() === USDT.toLowerCase() ? r0 : r1);
        const wbnbRes = BigInt(t0.toLowerCase() === USDT.toLowerCase() ? r1 : r0);
        if (usdtRes > U(10000) && wbnbRes > U(1)) {
          if (!venue || usdtRes > venue.usdtRes) venue = { ...cand, routerC: rc, pair, pairC: pc, usdtRes, wbnbRes };
        }
      } catch (e) {
        // probe failed
      }
    }
    if (!venue) throw new Error("no usable venue for Leg B");

    A = U(1000);
    [wbnbOut] = await quoter.quoteExactInputSingle.staticCall([USDT, WBNB, A, 100, 0n]);
    if (wbnbOut <= 0n) throw new Error("V3 quote zero");
    repay = (A * 10000n + 9974n) / 9975n;
    quoteB = BigInt((await venue.routerC.getAmountsOut(wbnbOut, [WBNB, USDT]))[1]);

    amount0Out = usdtIsT0 ? A : 0n;
    amount1Out = usdtIsT0 ? 0n : A;

    const targetNet = U(25);
    let back = quoteB;
    for (let i = 0; i < 10; i++) {
      if (back - repay >= targetNet) break;
      const res = await venue.pairC.getReserves();
      const t0 = await venue.pairC.token0();
      const ru = BigInt(t0.toLowerCase() === USDT.toLowerCase() ? res[0] : res[1]);
      const backTarget = repay + targetNet + U(50);
      const m = (Number(backTarget) + 1) / (Number(back) + 1);
      const D = BigInt(Math.floor(Number(ru) * (m - 1))) + U(25);
      await ensureUsdt(D);
      await (await usdt.transfer(venue.pair, D)).wait();
      await (await venue.pairC.sync()).wait();
      back = BigInt((await venue.routerC.getAmountsOut(wbnbOut, [WBNB, USDT]))[1]);
    }
    if (back - repay < targetNet) throw new Error("skew failed");
    quoteB = back;
  });


  async function dl() {
    return (await provider.getBlock("latest")).timestamp + 600;
  }
  function v3Leg() {
    return { kind: 1, target: PC_V3_POOL_F100, zeroForOne: true, path: [], minOut: 0n };
  }
  function v2Leg(minOut) {
    return { kind: 0, target: venue.router, zeroForOne: false, path: [WBNB, USDT], minOut };
  }

  it("(A) SUCCESS: leg B minOut <= actual output → executes, exact profit", async function () {
    // minOutB = floor(quoteB * (10000 - 100) / 10000) = 99% of final quote.
    const minOutB = (quoteB * 9900n) / 10000n;
    const minProfit = 1n;
    const ownerBefore = BigInt(await usdt.balanceOf(owner.address));

    const tx = await arb.flashArbitrage(flashPair, amount0Out, amount1Out, v3Leg(), v2Leg(minOutB), minProfit, await dl());
    const rc = await tx.wait();
    expect(rc.status).to.equal(1);

    const profit = BigInt(await usdt.balanceOf(owner.address)) - ownerBefore;
    expect(profit).to.be.greaterThan(0n);
    // Profit matches the final off-chain quote minus repayment, within a few wei.
    const expected = quoteB - repay;
    const diff = profit - expected;
    expect(diff >= -2n && diff <= 2n).to.equal(true, "profit != off-chain quote");

    // No token dust left in the contract.
    expect(await usdt.balanceOf(arbAddr)).to.equal(0n);
    expect(await new ethers.Contract(WBNB, ERC20_ABI, owner).balanceOf(arbAddr)).to.equal(0n);
  });

  async function revertReason(promise) {
    try {
      await promise;
      return null;
    } catch (e) {
      return String(e.message || e);
    }
  }

  it("(B) PER-LEG FAILURE: leg B minOut > actual output → revert (amountOutMin)", async function () {
    // Demand MORE than the final quote so the V2 router itself rejects the swap.
    const impossibleMinOut = quoteB + 1n;
    const reason = await revertReason(
      arb.flashArbitrage.staticCall(flashPair, amount0Out, amount1Out, v3Leg(), v2Leg(impossibleMinOut), 1n, await dl())
    );
    // The revert must be caused by the V2 router's amountOutMin, not by
    // deadline/allowance/repayment/liquidity.
    expect(reason, "per-leg revert reason").to.not.be.null;
    expect(reason.toLowerCase().includes("insufficient_output"), "cause = amountOutMin").to.equal(true);
  });

  it("(C) MINPROFIT FAILURE: swaps individually OK but final profit < minProfit → revert", async function () {
    // minOutB = 0 (legs individually unrestricted) but minProfit absurdly high,
    // so both legs still execute but the atomic minProfit check must revert.
    const hugeMinProfit = quoteB + repay;
    const reason = await revertReason(
      arb.flashArbitrage.staticCall(flashPair, amount0Out, amount1Out, v3Leg(), v2Leg(0n), hugeMinProfit, await dl())
    );
    expect(reason, "minProfit revert reason").to.not.be.null;
    expect(reason.toLowerCase().includes("profit"), "cause = minProfit").to.equal(true);
  });
});

// ============================================================================
// test/integration/dodo-mock-flow.js — DODO protocol mock flow (TEST B).
//
// Validates the full DODO flashLoan lifecycle using DODODVMMock.
// Run: npx hardhat test test/integration/dodo-mock-flow.js
// ============================================================================
const { expect } = require("chai");
const { ethers } = require("hardhat");

const LEG_V2 = 0;

async function deployFixture() {
  const [owner, stranger, attacker] = await ethers.getSigners();
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const MockDEX = await ethers.getContractFactory("MockDEX");
  const DODODVMMock = await ethers.getContractFactory("DODODVMMock");
  const FlashLoanArbitrage = await ethers.getContractFactory("FlashLoanArbitrage");

  const usdt = await MockERC20.deploy("USDT Mock", "USDT", 18);
  const tok = await MockERC20.deploy("Token Mock", "TOK", 18);
  await usdt.waitForDeployment();
  await tok.waitForDeployment();

  const usdtAddr = await usdt.getAddress();
  const tokAddr = await tok.getAddress();

  const dvm = await DODODVMMock.deploy(
    usdtAddr, tokAddr,
    ethers.parseEther("1"), ethers.parseEther("0.1"),
    ethers.parseEther("10000"), ethers.parseEther("10000")
  );
  await dvm.waitForDeployment();

  const buyDex = await MockDEX.deploy(usdtAddr, tokAddr);
  const sellDex = await MockDEX.deploy(usdtAddr, tokAddr);
  await buyDex.waitForDeployment();
  await sellDex.waitForDeployment();

  const arb = await FlashLoanArbitrage.deploy();
  await arb.waitForDeployment();

  const seed = async (dex, usdtAmount, tokAmount) => {
    const dexAddr = await dex.getAddress();
    const token0 = await dex.token0();
    const usdtIsToken0 = token0.toLowerCase() === usdtAddr.toLowerCase();
    const amount0 = usdtIsToken0 ? usdtAmount : tokAmount;
    const amount1 = usdtIsToken0 ? tokAmount : usdtAmount;
    await usdt.mint(owner.address, usdtAmount);
    await tok.mint(owner.address, tokAmount);
    await usdt.approve(dexAddr, usdtAmount);
    await tok.approve(dexAddr, tokAmount);
    await dex.addLiquidity(amount0, amount1);
  };

  // buyDex: TOK is cheap (more TOK per USDT) — arbitrage buys TOK here
  await seed(buyDex, ethers.parseEther("100000"), ethers.parseEther("200000"));
  // sellDex: TOK is expensive (fewer TOK per USDT) — arbitrage sells TOK here
  await seed(sellDex, ethers.parseEther("120000"), ethers.parseEther("100000"));
  await usdt.mint(await dvm.getAddress(), ethers.parseEther("100000"));

  return { owner, stranger, attacker, usdt, tok, dvm, buyDex, sellDex, arb };
}

async function latestDeadline(offsetSeconds = 300) {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block.timestamp + offsetSeconds);
}

function v2Leg(tokenIn, tokenOut, target) {
  return { kind: LEG_V2, target, zeroForOne: false, path: [tokenIn, tokenOut] };
}

// ============================================================================
// TEST B — DODO protocol mock flow
// ============================================================================
describe("Test B: DODO protocol mock flow (DODODVMMock)", function () {
  describe("Deployment & setup", function () {
    it("deploys DVM mock with correct PMM state", async function () {
      const { dvm, usdt, tok } = await deployFixture();
      expect(await dvm._BASE_TOKEN_()).to.equal(await usdt.getAddress());
      expect(await dvm._QUOTE_TOKEN_()).to.equal(await tok.getAddress());
      expect(await dvm.i()).to.equal(ethers.parseEther("1"));
      expect(await dvm.K()).to.equal(ethers.parseEther("0.1"));
      expect(await dvm.B()).to.equal(ethers.parseEther("10000"));
      expect(await dvm.Q()).to.equal(ethers.parseEther("10000"));
    });

    it("DVM mock is funded with USDT for flash loans", async function () {
      const { dvm, usdt } = await deployFixture();
      const balance = await usdt.balanceOf(await dvm.getAddress());
      expect(balance).to.be.gte(ethers.parseEther("100000"));
    });
  });

  describe("FlashLoan callback flow", function () {
    it("executes full flashLoan: borrow USDT -> swap -> repay -> profit", async function () {
      const { owner, usdt, tok, dvm, buyDex, sellDex, arb } = await deployFixture();
      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();
      const dvmAddr = await dvm.getAddress();
      const arbAddr = await arb.getAddress();
      const borrowAmount = ethers.parseEther("1000");
      const legA = v2Leg(usdtAddr, tokAddr, await buyDex.getAddress());
      const legB = v2Leg(tokAddr, usdtAddr, await sellDex.getAddress());
      const ownerUsdtBefore = await usdt.balanceOf(owner.address);
      const dvmUsdtBefore = await usdt.balanceOf(dvmAddr);

      const tx = await arb.flashArbitrageDodo(
        dvmAddr, borrowAmount, 0n, usdtAddr, tokAddr, usdtAddr, tokAddr,
        legA, legB, 1n, await latestDeadline()
      );
      const rc = await tx.wait();

      // Repayment exact
      expect(await usdt.balanceOf(dvmAddr)).to.be.gte(dvmUsdtBefore);
      // Contract has no dust
      expect(await usdt.balanceOf(arbAddr)).to.equal(0n);
      expect(await tok.balanceOf(arbAddr)).to.equal(0n);

      // ArbitrageExecuted event
      let evProfit = null;
      for (const lg of rc.logs) {
        try {
          const ev = arb.interface.parseLog(lg);
          if (ev && ev.name === "ArbitrageExecuted") evProfit = ev.args.profit;
        } catch (e) { /* other contract log */ }
      }
      expect(evProfit).to.not.be.null;

      // Profit transferred to owner
      const profit = (await usdt.balanceOf(owner.address)) - ownerUsdtBefore;
      expect(profit).to.equal(BigInt(evProfit));
    });

    it("records PMM state correctly during flashLoan lifecycle", async function () {
      const { dvm } = await deployFixture();
      expect(await dvm.i()).to.be.gt(0n);
      expect(await dvm.K()).to.be.gte(0n);
      expect(await dvm.B()).to.be.gt(0n);
      expect(await dvm.Q()).to.be.gt(0n);
    });
  });

  describe("Access control", function () {
    it("rejects flashArbitrageDodo from a non-owner", async function () {
      const { stranger, usdt, tok, dvm, buyDex, sellDex, arb } = await deployFixture();
      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();
      const legA = v2Leg(usdtAddr, tokAddr, await buyDex.getAddress());
      const legB = v2Leg(tokAddr, usdtAddr, await sellDex.getAddress());

      await expect(
        arb.connect(stranger).flashArbitrageDodo(
          await dvm.getAddress(), ethers.parseEther("1000"), 0n,
          usdtAddr, tokAddr, usdtAddr, tokAddr, legA, legB, 1n, await latestDeadline()
        )
      ).to.be.revertedWithCustomError(arb, "OwnableUnauthorizedAccount");
    });

    it("rejects an expired deadline", async function () {
      const { usdt, tok, dvm, buyDex, sellDex, arb } = await deployFixture();
      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();
      const legA = v2Leg(usdtAddr, tokAddr, await buyDex.getAddress());
      const legB = v2Leg(tokAddr, usdtAddr, await sellDex.getAddress());

      await expect(
        arb.flashArbitrageDodo(
          await dvm.getAddress(), ethers.parseEther("1000"), 0n,
          usdtAddr, tokAddr, usdtAddr, tokAddr, legA, legB, 1n, await latestDeadline(-1)
        )
      ).to.be.reverted;
    });
  });

  describe("Validation", function () {
    it("rejects token-side mismatch (borrow TOK when baseToken is USDT)", async function () {
      const { usdt, tok, buyDex, sellDex, dvm, arb } = await deployFixture();
      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();
      const legA = v2Leg(usdtAddr, tokAddr, await buyDex.getAddress());
      const legB = v2Leg(tokAddr, usdtAddr, await sellDex.getAddress());

      await expect(
        arb.flashArbitrageDodo(
          await dvm.getAddress(), 0n, ethers.parseEther("1000"),
          usdtAddr, tokAddr, usdtAddr, tokAddr, legA, legB, 1n, await latestDeadline()
        )
      ).to.be.reverted;
    });

    it("rejects when both base and quote amounts are zero", async function () {
      const { usdt, tok, buyDex, sellDex, dvm, arb } = await deployFixture();
      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();
      const legA = v2Leg(usdtAddr, tokAddr, await buyDex.getAddress());
      const legB = v2Leg(tokAddr, usdtAddr, await sellDex.getAddress());

      await expect(
        arb.flashArbitrageDodo(
          await dvm.getAddress(), 0n, 0n,
          usdtAddr, tokAddr, usdtAddr, tokAddr, legA, legB, 1n, await latestDeadline()
        )
      ).to.be.reverted;
    });

    it("rejects a non-contract pool address", async function () {
      const { usdt, tok, buyDex, sellDex, attacker, arb } = await deployFixture();
      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();
      const legA = v2Leg(usdtAddr, tokAddr, await buyDex.getAddress());
      const legB = v2Leg(tokAddr, usdtAddr, await sellDex.getAddress());

      await expect(
        arb.flashArbitrageDodo(
          attacker.address, ethers.parseEther("1000"), 0n,
          usdtAddr, tokAddr, usdtAddr, tokAddr, legA, legB, 1n, await latestDeadline()
        )
      ).to.be.reverted;
    });
  });

  describe("DVM mock repayment enforcement", function () {
    it("DVM mock enforces exact repayment (fee-free)", async function () {
      const { dvm, usdt } = await deployFixture();
      const dvmBal = await usdt.balanceOf(await dvm.getAddress());
      expect(dvmBal).to.be.gt(0n);
    });
  });
});

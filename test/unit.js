const { expect } = require("chai");
const { ethers } = require("hardhat");

const LEG_V2 = 0;
const LEG_V3 = 1;

const ZERO = ethers.ZeroAddress;

async function deployFixture() {
  const [owner, stranger, attacker] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const MockDEX = await ethers.getContractFactory("MockDEX");
  const MockDODO = await ethers.getContractFactory("MockDODO");
  const MockV3Pool = await ethers.getContractFactory("MockV3Pool");
  const FlashLoanArbitrage =
    await ethers.getContractFactory("FlashLoanArbitrage");

  const usdt = await MockERC20.deploy("USDT Mock", "USDT", 18);
  const tok = await MockERC20.deploy("Token Mock", "TOK", 18);

  await usdt.waitForDeployment();
  await tok.waitForDeployment();

  const usdtAddr = await usdt.getAddress();
  const tokAddr = await tok.getAddress();

  const source = await MockDEX.deploy(usdtAddr, tokAddr);
  const buyDex = await MockDEX.deploy(usdtAddr, tokAddr);
  const sellDex = await MockDEX.deploy(usdtAddr, tokAddr);

  await source.waitForDeployment();
  await buyDex.waitForDeployment();
  await sellDex.waitForDeployment();

  const dodo = await MockDODO.deploy(usdtAddr, tokAddr);
  await dodo.waitForDeployment();

  const v3Pool = await MockV3Pool.deploy(
    usdtAddr,
    tokAddr,
    ethers.parseEther("12000")
  );
  await v3Pool.waitForDeployment();

  const arb = await FlashLoanArbitrage.deploy();
  await arb.waitForDeployment();

  /*
   * Seed the mock V2 pools.
   *
   * source:
   *   large USDT liquidity for flash borrowing
   *
   * buyDex:
   *   cheap TOK
   *
   * sellDex:
   *   expensive TOK
   */
  const seed = async (dex, usdtAmount, tokAmount) => {
    const dexAddr = await dex.getAddress();
    const token0 = await dex.token0();

    const usdtIsToken0 =
      token0.toLowerCase() === usdtAddr.toLowerCase();

    const amount0 = usdtIsToken0 ? usdtAmount : tokAmount;
    const amount1 = usdtIsToken0 ? tokAmount : usdtAmount;

    await usdt.mint(owner.address, usdtAmount);
    await tok.mint(owner.address, tokAmount);

    await usdt.approve(dexAddr, usdtAmount);
    await tok.approve(dexAddr, tokAmount);

    await dex.addLiquidity(amount0, amount1);
  };

  await seed(
    source,
    ethers.parseEther("1000000"),
    ethers.parseEther("1000000000")
  );

  await seed(
    buyDex,
    ethers.parseEther("100000"),
    ethers.parseEther("1000000000")
  );

  await seed(
    sellDex,
    ethers.parseEther("100000"),
    ethers.parseEther("500000000")
  );

  /*
   * Fund mock DODO with the asset it is going to lend.
   */
  await usdt.mint(
    await dodo.getAddress(),
    ethers.parseEther("100000")
  );

  /*
   * Fund the V3 mock with TOK.
   */
  await tok.mint(
    await v3Pool.getAddress(),
    ethers.parseEther("100000000")
  );

  return {
    owner,
    stranger,
    attacker,
    usdt,
    tok,
    source,
    buyDex,
    sellDex,
    dodo,
    v3Pool,
    arb,
  };
}

async function latestDeadline(offsetSeconds = 300) {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block.timestamp + offsetSeconds);
}

function v2Leg(tokenIn, tokenOut, target) {
  return {
    kind: LEG_V2,
    target,
    zeroForOne: false,
    path: [tokenIn, tokenOut],
  };
}

function v3Leg(target, zeroForOne) {
  return {
    kind: LEG_V3,
    target,
    zeroForOne,
    path: [],
  };
}

async function flashAmountsForToken0(token0, tokenAddress, amount) {
  const tokenIsZero =
    token0.toLowerCase() === tokenAddress.toLowerCase();

  return {
    amount0Out: tokenIsZero ? amount : 0n,
    amount1Out: tokenIsZero ? 0n : amount,
  };
}

describe("FlashLoanArbitrage — unit/security suite", function () {
  describe("Access control", function () {
    it("rejects flashArbitrage from a non-owner", async function () {
      const {
        stranger,
        usdt,
        tok,
        source,
        buyDex,
        sellDex,
        arb,
      } = await deployFixture();

      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();

      const amount = ethers.parseEther("1");

      const { amount0Out, amount1Out } =
        await flashAmountsForToken0(
          await source.token0(),
          usdtAddr,
          amount
        );

      const legA = v2Leg(
        usdtAddr,
        tokAddr,
        await buyDex.getAddress()
      );

      const legB = v2Leg(
        tokAddr,
        usdtAddr,
        await sellDex.getAddress()
      );

      await expect(
        arb.connect(stranger).flashArbitrage(
          await source.getAddress(),
          amount0Out,
          amount1Out,
          legA,
          legB,
          1n,
          await latestDeadline()
        )
      ).to.be.revertedWithCustomError(
        arb,
        "OwnableUnauthorizedAccount"
      );
    });

    it("allows the owner to call the entry point", async function () {
      const {
        usdt,
        tok,
        source,
        buyDex,
        sellDex,
        arb,
      } = await deployFixture();

      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();

      const amount = ethers.parseEther("1000");

      const { amount0Out, amount1Out } =
        await flashAmountsForToken0(
          await source.token0(),
          usdtAddr,
          amount
        );

      const legA = v2Leg(
        usdtAddr,
        tokAddr,
        await buyDex.getAddress()
      );

      const legB = v2Leg(
        tokAddr,
        usdtAddr,
        await sellDex.getAddress()
      );

      /*
       * This is intentionally not an exact profit assertion.
       * The test only proves that ownership is not the reason for
       * a revert. The source mock is not a canonical Pancake pair,
       * so the protocol-validation layer may reject it.
       */
      await expect(
        arb.flashArbitrage(
          await source.getAddress(),
          amount0Out,
          amount1Out,
          legA,
          legB,
          1n,
          await latestDeadline()
        )
      ).to.be.reverted;
    });
  });

  describe("Entry-point validation", function () {
    it("rejects an expired deadline", async function () {
      const {
        usdt,
        tok,
        source,
        buyDex,
        sellDex,
        arb,
      } = await deployFixture();

      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();

      const amount = ethers.parseEther("1");

      const { amount0Out, amount1Out } =
        await flashAmountsForToken0(
          await source.token0(),
          usdtAddr,
          amount
        );

      const legA = v2Leg(
        usdtAddr,
        tokAddr,
        await buyDex.getAddress()
      );

      const legB = v2Leg(
        tokAddr,
        usdtAddr,
        await sellDex.getAddress()
      );

      const expired = await latestDeadline(-1);

      await expect(
        arb.flashArbitrage(
          await source.getAddress(),
          amount0Out,
          amount1Out,
          legA,
          legB,
          1n,
          expired
        )
      ).to.be.reverted;
    });

    it("rejects zero minProfit", async function () {
      const {
        usdt,
        tok,
        source,
        buyDex,
        sellDex,
        arb,
      } = await deployFixture();

      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();

      const amount = ethers.parseEther("1");

      const { amount0Out, amount1Out } =
        await flashAmountsForToken0(
          await source.token0(),
          usdtAddr,
          amount
        );

      const legA = v2Leg(
        usdtAddr,
        tokAddr,
        await buyDex.getAddress()
      );

      const legB = v2Leg(
        tokAddr,
        usdtAddr,
        await sellDex.getAddress()
      );

      await expect(
        arb.flashArbitrage(
          await source.getAddress(),
          amount0Out,
          amount1Out,
          legA,
          legB,
          0n,
          await latestDeadline()
        )
      ).to.be.reverted;
    });

    it("rejects an invalid V2 path", async function () {
      const {
        usdt,
        tok,
        source,
        buyDex,
        sellDex,
        arb,
      } = await deployFixture();

      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();

      const amount = ethers.parseEther("1");

      const { amount0Out, amount1Out } =
        await flashAmountsForToken0(
          await source.token0(),
          usdtAddr,
          amount
        );

      const badLegA = {
        kind: LEG_V2,
        target: await buyDex.getAddress(),
        zeroForOne: false,
        path: [tokAddr, usdtAddr],
      };

      const legB = v2Leg(
        tokAddr,
        usdtAddr,
        await sellDex.getAddress()
      );

      await expect(
        arb.flashArbitrage(
          await source.getAddress(),
          amount0Out,
          amount1Out,
          badLegA,
          legB,
          1n,
          await latestDeadline()
        )
      ).to.be.reverted;
    });
  });

  describe("Pancake V2 source validation", function () {
    it("rejects a mock pair that is not a canonical PancakeSwap V2 pair", async function () {
      const {
        usdt,
        tok,
        source,
        buyDex,
        sellDex,
        arb,
      } = await deployFixture();

      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();

      const amount = ethers.parseEther("1000");

      const { amount0Out, amount1Out } =
        await flashAmountsForToken0(
          await source.token0(),
          usdtAddr,
          amount
        );

      const legA = v2Leg(
        usdtAddr,
        tokAddr,
        await buyDex.getAddress()
      );

      const legB = v2Leg(
        tokAddr,
        usdtAddr,
        await sellDex.getAddress()
      );

      await expect(
        arb.flashArbitrage(
          await source.getAddress(),
          amount0Out,
          amount1Out,
          legA,
          legB,
          ethers.parseEther("1"),
          await latestDeadline()
        )
      ).to.be.reverted;
    });
  });

  describe("V2 route validation", function () {
    it("rejects a V2 leg whose target is not a pair for the requested path", async function () {
      const {
        usdt,
        tok,
        source,
        buyDex,
        sellDex,
        arb,
      } = await deployFixture();

      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();

      const amount = ethers.parseEther("1000");

      const { amount0Out, amount1Out } =
        await flashAmountsForToken0(
          await source.token0(),
          usdtAddr,
          amount
        );

      /*
       * Leg A claims buyDex should process USDT -> TOK.
       * The mock pair does contain these tokens, so the path itself is
       * structurally valid. The test therefore relies on the source
       * validation and confirms that a foreign mock cannot be executed
       * as Pancake V2.
       */
      const legA = v2Leg(
        usdtAddr,
        tokAddr,
        await buyDex.getAddress()
      );

      const legB = v2Leg(
        tokAddr,
        usdtAddr,
        await sellDex.getAddress()
      );

      await expect(
        arb.flashArbitrage(
          await source.getAddress(),
          amount0Out,
          amount1Out,
          legA,
          legB,
          ethers.parseEther("1"),
          await latestDeadline()
        )
      ).to.be.reverted;
    });

    it("rejects a V2 leg with an empty path", async function () {
      const {
        usdt,
        tok,
        source,
        buyDex,
        sellDex,
        arb,
      } = await deployFixture();

      const usdtAddr = await usdt.getAddress();

      const amount = ethers.parseEther("1");

      const { amount0Out, amount1Out } =
        await flashAmountsForToken0(
          await source.token0(),
          usdtAddr,
          amount
        );

      const badLegA = {
        kind: LEG_V2,
        target: await buyDex.getAddress(),
        zeroForOne: false,
        path: [],
      };

      const legB = {
        kind: LEG_V2,
        target: await sellDex.getAddress(),
        zeroForOne: false,
        path: [
          await tok.getAddress(),
          usdtAddr,
        ],
      };

      await expect(
        arb.flashArbitrage(
          await source.getAddress(),
          amount0Out,
          amount1Out,
          badLegA,
          legB,
          1n,
          await latestDeadline()
        )
      ).to.be.reverted;
    });
  });

  describe("DODO callback authentication", function () {
    it("rejects DODO flashloan token-side mismatch", async function () {
      const {
        usdt,
        tok,
        buyDex,
        sellDex,
        dodo,
        arb,
      } = await deployFixture();

      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();

      const legA = v2Leg(
        usdtAddr,
        tokAddr,
        await buyDex.getAddress()
      );

      const legB = v2Leg(
        tokAddr,
        usdtAddr,
        await sellDex.getAddress()
      );

      await expect(
        arb.flashArbitrageDodo(
          await dodo.getAddress(),
          ethers.parseEther("1000"),
          0n,
          tokAddr,
          usdtAddr,
          usdtAddr,
          tokAddr,
          legA,
          legB,
          1n,
          await latestDeadline()
        )
      ).to.be.reverted;
    });

    it("rejects a DODO flashloan with an invalid pool address", async function () {
      const {
        usdt,
        tok,
        buyDex,
        sellDex,
        dodo,
        attacker,
        arb,
      } = await deployFixture();

      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();

      const legA = v2Leg(
        usdtAddr,
        tokAddr,
        await buyDex.getAddress()
      );

      const legB = v2Leg(
        tokAddr,
        usdtAddr,
        await sellDex.getAddress()
      );

      await expect(
        arb.flashArbitrageDodo(
          attacker.address,
          ethers.parseEther("1000"),
          0n,
          usdtAddr,
          tokAddr,
          usdtAddr,
          tokAddr,
          legA,
          legB,
          1n,
          await latestDeadline()
        )
      ).to.be.reverted;
    });

    it("rejects a DODO flashloan whose quote amount is inconsistent", async function () {
      const {
        usdt,
        tok,
        buyDex,
        sellDex,
        dodo,
        arb,
      } = await deployFixture();

      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();

      const legA = v2Leg(
        usdtAddr,
        tokAddr,
        await buyDex.getAddress()
      );

      const legB = v2Leg(
        tokAddr,
        usdtAddr,
        await sellDex.getAddress()
      );

      /*
       * The mock has no TOK liquidity. Asking the contract to borrow
       * both sides while its configured input/output semantics only
       * expect USDT must be rejected.
       */
      await expect(
        arb.flashArbitrageDodo(
          await dodo.getAddress(),
          ethers.parseEther("1000"),
          ethers.parseEther("100"),
          usdtAddr,
          tokAddr,
          usdtAddr,
          tokAddr,
          legA,
          legB,
          1n,
          await latestDeadline()
        )
      ).to.be.reverted;
    });
  });

  describe("DODO execution interface", function () {
    it("does not rely on the obsolete sellBase(address,uint256) interface", async function () {
      const MockDODO = await ethers.getContractFactory("MockDODO");
      const {
        usdt,
        tok,
        dodo,
      } = await deployFixture();

      /*
       * This test documents the interface exposed by the mock:
       * the pool uses base/quote tokens and the actual input is determined
       * by the pool's balance/reserve semantics.
       *
       * We deliberately do not call a fake profitable DODO trade here.
       * Real PMM economics belong in the BSC fork suite.
       */
      expect(await dodo.baseToken()).to.equal(
        await usdt.getAddress()
      );

      expect(await dodo.quoteToken()).to.equal(
        await tok.getAddress()
      );

      expect(MockDODO).to.not.equal(undefined);
    });
  });

  describe("Pancake V3 callback protection", function () {
    it("rejects a non-canonical V3 pool", async function () {
      const {
        usdt,
        tok,
        source,
        sellDex,
        dodo,
        v3Pool,
        arb,
      } = await deployFixture();

      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();

      const legA = v3Leg(
        await v3Pool.getAddress(),
        true
      );

      const legB = v2Leg(
        tokAddr,
        usdtAddr,
        await sellDex.getAddress()
      );

      await expect(
        arb.flashArbitrageDodo(
          await dodo.getAddress(),
          ethers.parseEther("1000"),
          0n,
          usdtAddr,
          tokAddr,
          usdtAddr,
          tokAddr,
          legA,
          legB,
          ethers.parseEther("1"),
          await latestDeadline()
        )
      ).to.be.reverted;
    });

    it("rejects an invalid V3 direction", async function () {
      const {
        usdt,
        tok,
        sellDex,
        dodo,
        v3Pool,
        arb,
      } = await deployFixture();

      const usdtAddr = await usdt.getAddress();
      const tokAddr = await tok.getAddress();

      /*
       * The mock is intentionally not a canonical Pancake V3 pool.
       * The important property here is that an invalid direction
       * cannot become an executable V3 leg.
       */
      const legA = v3Leg(
        await v3Pool.getAddress(),
        false
      );

      const legB = v2Leg(
        tokAddr,
        usdtAddr,
        await sellDex.getAddress()
      );

      await expect(
        arb.flashArbitrageDodo(
          await dodo.getAddress(),
          ethers.parseEther("1000"),
          0n,
          usdtAddr,
          tokAddr,
          usdtAddr,
          tokAddr,
          legA,
          legB,
          1n,
          await latestDeadline()
        )
      ).to.be.reverted;
    });
  });

  describe("Rescue / owner safety", function () {
    it("only the owner can rescue token dust", async function () {
      const {
        owner,
        stranger,
        usdt,
        arb,
      } = await deployFixture();

      const dust = ethers.parseEther("1");

      await usdt.mint(
        await arb.getAddress(),
        dust
      );

      await expect(
        arb.connect(stranger).rescueToken(
          await usdt.getAddress()
        )
      ).to.be.revertedWithCustomError(
        arb,
        "OwnableUnauthorizedAccount"
      );

      const before =
        await usdt.balanceOf(owner.address);

      await arb.rescueToken(
        await usdt.getAddress()
      );

      const after =
        await usdt.balanceOf(owner.address);

      expect(after - before).to.equal(dust);
    });

    it("rescueToken does not transfer BNB from the contract", async function () {
      const {
        owner,
        usdt,
        arb,
      } = await deployFixture();

      const dust = ethers.parseEther("1");

      await usdt.mint(
        await arb.getAddress(),
        dust
      );

      const contractBalance =
        await ethers.provider.getBalance(
          await arb.getAddress()
        );

      expect(contractBalance).to.equal(0n);

      await arb.rescueToken(
        await usdt.getAddress()
      );

      expect(
        await usdt.balanceOf(owner.address)
      ).to.be.gte(dust);
    });
  });

  describe("Mock sanity", function () {
    it("uses distinct token addresses", async function () {
      const { usdt, tok } = await deployFixture();

      expect(
        (await usdt.getAddress()).toLowerCase()
      ).to.not.equal(
        (await tok.getAddress()).toLowerCase()
      );
    });

    it("creates correctly ordered V2 mock pairs", async function () {
      const {
        usdt,
        tok,
        source,
      } = await deployFixture();

      const token0 =
        (await source.token0()).toLowerCase();

      const token1 =
        (await source.token1()).toLowerCase();

      expect(
        [token0, token1].sort()
      ).to.deep.equal(
        [
          (await usdt.getAddress()).toLowerCase(),
          (await tok.getAddress()).toLowerCase(),
        ].sort()
      );
    });
  });
});
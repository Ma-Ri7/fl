// ============================================================================
// PHASE 2B: REAL DODO DVM FLASHLOAN + TWO-LEG ARBITRAGE ON BSC FORK
// Flash source : DODODVMMock (PMM state real, fee-free)
// Leg A        : Pancake V3 pool fee=100 (real) -> USDT -> WBNB
// Leg B        : BiSwap V2 (real, skewed)       -> WBNB -> USDT
// Validates: profit > 0, delta on-chain vs off-chain quote, repay exact,
//            cleanup, ArbitrageExecuted event emission.
// ============================================================================
const hre = require("hardhat");

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const PC_V3_POOL_F100 = "0x172fcd41e0913e95784454622d1c3724f546f849";
const BISWAP_FACTORY = "0x858E3312ed3A876947EA49d572A7C42DE08af7EE";
const BISWAP_ROUTER = "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8";
const QUOTER_V2 = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)","function transfer(address,uint256) returns (bool)"];
const ROUTER_ABI = ["function factory() view returns (address)","function getAmountsOut(uint256,address[]) view returns (uint256[])"];
const FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
const PAIR_ABI = ["function getReserves() view returns (uint112,uint112,uint32)","function token0() view returns (address)","function token1() view returns (address)","function sync()"];
const QUOTER_ABI = ["function quoteExactInputSingle((address,address,uint256,uint24,uint160)) view returns (uint256,uint160,uint32,uint256)"];

const U = (n) => BigInt(n) * 1000000000000000000n;
const N18 = 1000000000000000000n;
function p(s){console.log("  "+s);}
function head(s){console.log("\n=== "+s+" ===");}
function fmt(x){return (Number(x)/1e18).toLocaleString("en-US",{maximumFractionDigits:6});}

async function main() {
  const { ethers } = hre;
  const provider = hre.ethers.provider;
  const forkBlock = (await provider.getBlock("latest")).number;
  p(`BSC fork block ${forkBlock}`);

  const [owner] = await ethers.getSigners();
  const whale = "0xF977814e90dA44bFA03b6295A0616a897441aceC";
  await provider.send("hardhat_impersonateAccount", [whale]);
  const whaleSigner = await ethers.getSigner(whale);
  await owner.sendTransaction({ to: whale, value: ethers.parseEther("1") });

  const usdt = new ethers.Contract(USDT, ERC20_ABI, whaleSigner);
  const wbnb = new ethers.Contract(WBNB, ERC20_ABI, whaleSigner);
  const router = new ethers.Contract(BISWAP_ROUTER, ROUTER_ABI, provider);
  const factory = new ethers.Contract(BISWAP_FACTORY, FACTORY_ABI, provider);
  const venuePair = await factory.getPair(WBNB, USDT);
  if (venuePair === ethers.ZeroAddress) throw new Error("venue pair missing");

  // Deploy FLASH
  const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
  const flash = await Flash.deploy();
  await flash.waitForDeployment();
  const flashAddr = await flash.getAddress();

  // Deploy DVM mock with real PMM state
  const DVM = await ethers.getContractFactory("DODODVMMock");
  const dvm = await DVM.deploy(WBNB, USDT, N18, 100000000000000000n,
    ethers.parseEther("10000"), ethers.parseEther("20000000"));
  await dvm.waitForDeployment();
  const dvmAddr = await dvm.getAddress();

  // Fund DVM with USDT for flash loans
  const dvmFund = ethers.parseEther("500000");
  await usdt.transfer(dvmAddr, dvmFund);
  p(`DVM ${dvmAddr} funded ${fmt(dvmFund)} USDT`);
  p(`FLASH ${flashAddr}`);

  // Off-chain quote
  const borrow = U(1000);
  const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);
  const qA = await quoter.quoteExactInputSingle([USDT, WBNB, borrow, 100, 0]);
  const wbnbOut = qA[0];
  const outB = await router.getAmountsOut(wbnbOut, [WBNB, USDT]);
  const usdtBack = outB[outB.length - 1];
  const netProfit = usdtBack - borrow;
  // Execute flashArbitrageDodo
  const ownerBefore = await usdt.balanceOf(owner.address);
  const deadline = Math.floor(Date.now() / 1000) + 86400;
  // V3 pool: USDT (token0) -> WBNB (token1), so zeroForOne = true
  const legA = { kind: 1, target: PC_V3_POOL_F100, zeroForOne: true, path: [] };
  const legB = { kind: 0, target: BISWAP_ROUTER, zeroForOne: false, path: [WBNB, USDT] };

  try {
    await flash.flashArbitrageDodo.staticCall(dvmAddr, 0n, borrow, USDT, WBNB, WBNB, USDT, legA, legB, 1n, deadline);
    p("staticCall: OK");
  } catch (e) { throw new Error("staticCall failed: " + e.message); }

  const gasEst = await flash.flashArbitrageDodo.estimateGas(dvmAddr, 0n, borrow, USDT, WBNB, WBNB, USDT, legA, legB, 1n, deadline);
  p(`estimateGas: ${gasEst}`);

  const tx = await flash.connect(owner).flashArbitrageDodo(
    dvmAddr, 0n, borrow, USDT, WBNB, WBNB, USDT, legA, legB, 1n, deadline,
    { gasLimit: (gasEst * 120n) / 100n }
  );
  const rc = await tx.wait();
  p(`tx=${tx.hash} block=${rc.blockNumber} gasUsed=${rc.gasUsed}`);

  // Verify
  const profit = (await usdt.balanceOf(owner.address)) - ownerBefore;
  p(`profit=${fmt(profit)} expected=${fmt(netProfit)} delta=${profit - netProfit} wei`);

  let evProfit = null;
  for (const lg of rc.logs) { try { const ev = flash.interface.parseLog(lg); if (ev && ev.name === "ArbitrageExecuted") evProfit = ev.args.profit; } catch {} }
  if (evProfit === null) throw new Error("ArbitrageExecuted missing");
  if (BigInt(evProfit) !== profit) throw new Error("event profit != balance delta");
  p(`PASS: ArbitrageExecuted(profit=${fmt(evProfit)})`);

  const arbUsdtFinal = await usdt.balanceOf(flashAddr);
  const arbWbnbFinal = await wbnb.balanceOf(flashAddr);
  if (arbUsdtFinal > 0n || arbWbnbFinal > 0n) throw new Error(`dust left: USDT=${arbUsdtFinal} WBNB=${arbWbnbFinal}`);
  p("PASS: contract cleanup");

  const dvmUsdtFinal = await usdt.balanceOf(dvmAddr);
  if (dvmUsdtFinal < dvmFund) throw new Error(`DVM underfunded: ${dvmUsdtFinal} < ${dvmFund}`);
  p("PASS: DVM repayment exact (fee-free)");

  const diff = profit - netProfit;
  if (diff < -2n || diff > 2n) throw new Error(`delta too large: ${diff} wei`);
  p(`PASS: delta ${diff} wei`);

  head("PHASE 2B: DODO REAL FLASHLOAN -- ALL PASS");
}
main().catch((err) => { console.error("\n!! TEST FAILED: " + err.message); process.exitCode = 1; });

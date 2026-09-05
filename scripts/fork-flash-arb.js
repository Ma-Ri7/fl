// ============================================================================
// Test A/B — Phase 2: REAL FLASHSWAP + REAL TWO-LEG ATOMIC ARBITRAGE (BSC fork)
//
// Mediu: Hardhat 2.26.5 + EDR 0.11.3. Contractul FLASH este NEMODIFICAT (copie).
//
// Scenariu:
//   Flash source : Pancake V2 pair WBNB/USDT (real)  -> pancakeCall flashswap
//   Leg A        : Pancake V3 pool fee=100 (real)    -> USDT -> WBNB (pret piata)
//   Leg B        : router UniswapV2-style (real)     -> WBNB -> USDT (venue skew)
//
// NOTE DE DESIGN:
//   - Flash pair-ul NU poate fi venue de swap: contractul nu face sync() in
//     callback, deci K-invariant al pair-ului imprumutat ar esua. Leg B este
//     mereu pe un venue diferit de flash source.
//   - Skew artificial: donatie USDT la venue pair + sync() (pe fork, doar pt test).
//   - Quote V3 REAL prin QuoterV2 on-chain (tick crossing real, nu slot0 simplu).
//   - Quote V2 REAL prin getAmountsOut al routerului real (fee real al venue-ului).
// ============================================================================

const hre = require("hardhat");

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const PC_V2_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const PC_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
const PC_V3_POOL_F100 = "0x172fcd41e0913e95784454622d1c3724f546f849";
const QUOTER_V2 = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";

const CANDIDATE_VENUES = [
  { name: "SushiSwap", factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506" },
  { name: "BiSwap",    factory: "0x858E3312ed3A876947EA49d572A7C42DE08af7EE", router: "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8" },
];

const WHALES = [
  "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3", // Binance Hot 6
  "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance 7
  "0x564286362092D8e7936f0549571a803B203aAceD", // Binance Hot 2
  "0x28C6c06298d514Db089934071355E5743bf21d60", // Binance 14
  "0xDFd5293D8e347dFe59E90eFd556295c6aCa5f542", // Binance 15
  "0x5a52E96BAcdaBb82fd05763E25335261B270Efcb", // Binance 3
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
const POOL_ABI = [
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

const U = (n) => BigInt(n) * 1000000000000000000n;

function p(s) { console.log("  " + s); }
function head(s) { console.log("\n=== " + s + " ==="); }
function fmt(x) { return (Number(x) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 6 }); }

async function main() {
  const { ethers } = hre;
  const provider = hre.ethers.provider;
  const [owner, other] = await hre.ethers.getSigners();
  const me = owner.address;

  head("BSC FORK — REAL FLASHSWAP + 2-LEG ARB (Hardhat 2.26.5 / EDR 0.11.3)");
  p(`chainId    = ${BigInt(await provider.send("eth_chainId", []))}`);
  const forkBlock = BigInt(await provider.send("eth_blockNumber", []));
  p(`fork block = ${forkBlock}`);
  p(`owner EOA  = ${me}`);

  // ------------------------------------------------------------------ deploy
  const Fac = await hre.ethers.getContractFactory("FlashLoanArbitrage", owner);
  const arb = await Fac.deploy();
  await arb.waitForDeployment();
  const arbAddr = await arb.getAddress();
  p(`FLASH deployed: ${arbAddr}`);

  const usdt = new ethers.Contract(USDT, ERC20_ABI, owner);
  const wbnb = new ethers.Contract(WBNB, ERC20_ABI, owner);

  // ------------------------------------------------- flash pair (Pancake V2)
  const pcFactory = new ethers.Contract(PC_V2_FACTORY, FACTORY_ABI, owner);
  const flashPair = await pcFactory.getPair(WBNB, USDT);
  if (flashPair === ethers.ZeroAddress) throw new Error("flash pair missing");
  const fp = new ethers.Contract(flashPair, PAIR_ABI, owner);
  const fpFactory = await fp.factory();
  if (fpFactory.toLowerCase() !== PC_V2_FACTORY.toLowerCase())
    throw new Error("flash pair factory mismatch");
  const fpT0 = await fp.token0();
  const [fr0, fr1] = await fp.getReserves();
  const usdtIsT0 = fpT0.toLowerCase() === USDT.toLowerCase();
  const fpUsdt = usdtIsT0 ? fr0 : fr1;
  const fpWbnb = usdtIsT0 ? fr1 : fr0;
  p(`flash pair : ${flashPair}  (PancakeV2 canonical, factory OK)`);
  p(`  reserves : ${fmt(fpUsdt)} USDT / ${fmt(fpWbnb)} WBNB`);

  // ------------------------------------------------ V3 pool sanity (Leg A)
  const v3Pool = new ethers.Contract(PC_V3_POOL_F100, POOL_ABI, owner);
  const v3F = await v3Pool.factory();
  const v3T0 = await v3Pool.token0();
  const v3Fee = await v3Pool.fee();
  if (v3F.toLowerCase() !== PC_V3_FACTORY.toLowerCase())
    throw new Error("V3 pool factory mismatch");
  if (v3T0.toLowerCase() !== USDT.toLowerCase()) throw new Error("V3 pool token0 != USDT");
  if (Number(v3Fee) !== 100) throw new Error("V3 pool fee != 100");
  p(`V3 pool    : ${PC_V3_POOL_F100}  (fee ${v3Fee}, canonical OK)`);

  // ------------------------------------------------ venue discovery (Leg B)
  head("VENUE DISCOVERY (Leg B — router real + pair real)");
  let venue = null;
  for (const cand of CANDIDATE_VENUES) {
    try {
      const rc = new ethers.Contract(cand.router, ROUTER_ABI, owner);
      const rf = await rc.factory();
      if (rf.toLowerCase() !== cand.factory.toLowerCase())
        throw new Error("router factory unexpected");
      const fac = new ethers.Contract(rf, FACTORY_ABI, owner);
      const pair = await fac.getPair(WBNB, USDT);
      if (pair === ethers.ZeroAddress) { p(`${cand.name}: pair inexistent, skip`); continue; }
      const pc = new ethers.Contract(pair, PAIR_ABI, owner);
      const t0 = await pc.token0();
      const [r0, r1] = await pc.getReserves();
      const usdtRes = t0.toLowerCase() === USDT.toLowerCase() ? r0 : r1;
      const wbnbRes = t0.toLowerCase() === USDT.toLowerCase() ? r1 : r0;
      p(`${cand.name}: router ${cand.router}`);
      p(`  pair ${pair}`);
      p(`  reserves ${fmt(usdtRes)} USDT / ${fmt(wbnbRes)} WBNB`);
      if (usdtRes > U(10000) && wbnbRes > U(1)) {
        if (!venue || usdtRes > venue.usdtRes)
          venue = { ...cand, routerC: rc, pair, pairC: pc, usdtRes, wbnbRes };
      }
    } catch (e) {
      p(`${cand.name}: probe failed (${String(e.message).slice(0, 70)})`);
    }
  }
  if (!venue) throw new Error("niciun venue utilizabil pentru Leg B");
  p(`VENUE SELECTAT: ${venue.name} (routerul routeaza exact pair-ul skew-uit)`);

  // ---------------------------------------------------- TEST 0: access control
  head("TEST 0 — ACCESS CONTROL pe fork real");
  const deadline0 = (await provider.getBlock("latest")).timestamp + 1200;
  const legA0 = { kind: 1, target: PC_V3_POOL_F100, zeroForOne: true, path: [] };
  const legB0 = { kind: 0, target: venue.router, zeroForOne: false, path: [WBNB, USDT] };
  let nonOwnerRejected = false;
  try {
    await arb.connect(other).flashArbitrage.staticCall(
      flashPair, U(1), 0n, legA0, legB0, 1n, deadline0
    );
  } catch (e) {
    nonOwnerRejected = true;
    p(`non-owner staticCall reverted: ${String(e.message).slice(0, 90)}`);
  }
  if (!nonOwnerRejected) throw new Error("non-owner NU a fost respins");
  p("PASS: non-owner respins");

  // ------------------------------------------------------------------ quotes
  head("REAL QUOTES — V3 QuoterV2 + venue router (inainte de skew)");
  const A = U(1000); // flash-borrowed USDT
  const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, owner);
  const [wbnbOut] = await quoter.quoteExactInputSingle.staticCall([USDT, WBNB, A, 100, 0n]);
  if (wbnbOut <= 0n) throw new Error("V3 quote zero");
  p(`V3 real quote : ${fmt(A)} USDT -> ${fmt(wbnbOut)} WBNB (fee=100, tick-crossing real)`);
  const repay = (A * 10000n + 9974n) / 9975n; // ceil exact: ceil(A*10000/9975)
  p(`flash repay   : ${fmt(repay)} USDT`);

  const venueT0 = await venue.pairC.token0();
  const venueQuote = async () =>
    BigInt((await venue.routerC.getAmountsOut(wbnbOut, [WBNB, USDT]))[1]);
  const back0 = await venueQuote();
  p(`venue quote   : ${fmt(wbnbOut)} WBNB -> ${fmt(back0)} USDT (${venue.name})`);
  p(`net asteptat (pre-skew): ${fmt(back0 - repay)} USDT`);

  const amount0Out = usdtIsT0 ? A : 0n;
  const amount1Out = usdtIsT0 ? 0n : A;
  const legA = { kind: 1, target: PC_V3_POOL_F100, zeroForOne: v3T0.toLowerCase() === USDT.toLowerCase(), path: [] };
  const legB = { kind: 0, target: venue.router, zeroForOne: false, path: [WBNB, USDT] };
  const dl = async () => (await provider.getBlock("latest")).timestamp + 600;

  async function ensureUsdt(need) {
    let bal = await usdt.balanceOf(me);
    for (const w of WHALES) {
      if (bal >= need) break;
      await provider.send("hardhat_impersonateAccount", [w]);
      await provider.send("hardhat_setBalance", [w, "0x56BC75E2D63100000"]);
      const wt = usdt.connect(await ethers.getSigner(w));
      const wb = await usdt.balanceOf(w);
      const take = wb < need - bal ? wb : need - bal;
      await (await wt.transfer(me, take)).wait();
      bal = await usdt.balanceOf(me);
      p(`funded: +${fmt(take)} USDT de la ${w}`);
    }
    if (bal < need) throw new Error("USDT insuficient de la whale-uri");
  }

  // ------------------------------------------------------- TEST 1: negatives
  head("TEST 1 — ATOMICITATE: runda NEPROFITABILA trebuie sa dea revert");
  try {
    await arb.flashArbitrage.staticCall(flashPair, amount0Out, amount1Out, legA, legB, 1n, await dl());
    throw new Error("staticCall a REUSIT pe runda neprofitabila — atomicitatea NU functioneaza");
  } catch (e) {
    if (String(e.message).includes("REUSIT")) throw e;
    p(`PASS: revert (${String(e.message).slice(0, 80)})`);
  }

  head("TEST 1b — deadline expirat");
  const oldDl = (await provider.getBlock("latest")).timestamp - 10;
  try {
    await arb.flashArbitrage.staticCall(flashPair, amount0Out, amount1Out, legA, legB, 1n, oldDl);
    throw new Error("deadline expirat a fost acceptat");
  } catch (e) {
    if (!String(e.message).includes("expired")) throw new Error("revert gresit: " + e.message);
    p("PASS: revert 'expired'");
  }

  head("TEST 1c — minProfit = 0");
  try {
    await arb.flashArbitrage.staticCall(flashPair, amount0Out, amount1Out, legA, legB, 0n, await dl());
    throw new Error("minProfit=0 a fost acceptat");
  } catch (e) {
    if (!String(e.message).includes("profit-zero")) throw new Error("revert gresit: " + e.message);
    p("PASS: revert 'profit-zero'");
  }

  // ------------------------------------------------------------- TEST 2 skew
  head("TEST 2 — SKEW venue: donatie USDT + sync (iterativ, quote real)");
  const targetNet = U(25);
  let backSkewed = back0;
  for (let i = 0; i < 10; i++) {
    const net = backSkewed - repay;
    if (net >= targetNet) { p(`iter ${i}: net=${fmt(net)} USDT — suficient`); break; }
    const res = await venue.pairC.getReserves();
    const ru = BigInt(venueT0.toLowerCase() === USDT.toLowerCase() ? res[0] : res[1]);
    const backTarget = repay + targetNet + U(50);
    const m = (Number(backTarget) + 1) / (Number(backSkewed) + 1);
    const D = BigInt(Math.floor(Number(ru) * (m - 1))) + U(25);
    await ensureUsdt(D);
    await (await usdt.transfer(venue.pair, D)).wait();
    await (await venue.pairC.sync()).wait();
    backSkewed = await venueQuote();
    p(`iter ${i}: donat ${fmt(D)} USDT -> quote=${fmt(backSkewed)} USDT (net ${fmt(backSkewed - repay)})`);
  }
  if (backSkewed - repay < targetNet) throw new Error("skew esuat: net sub target");
  p(`SKEW OK: net asteptat = ${fmt(backSkewed - repay)} USDT`);

  // -------------------------------------------------- TEST 3: real execution
  head("TEST 3 — EXECUTIE REALA: flashswap PancakeV2 + LegA V3 real + LegB venue real");
  const ownerBefore = BigInt(await usdt.balanceOf(me));
  const pairUsdtBefore = BigInt(await usdt.balanceOf(flashPair));
  const arbUsdtBefore = BigInt(await usdt.balanceOf(arbAddr));
  const arbWbnbBefore = BigInt(await wbnb.balanceOf(arbAddr));

  const tx = await arb.flashArbitrage(flashPair, amount0Out, amount1Out, legA, legB, 1n, await dl());
  const rc = await tx.wait();
  if (rc.status !== 1) throw new Error("tx esuata");
  const gasBnb = BigInt(rc.gasUsed) * BigInt(rc.gasPrice);
  p(`tx=${rc.hash}`);
  p(`block=${rc.blockNumber}  gasUsed=${rc.gasUsed}  effGasPrice=${(Number(rc.gasPrice) / 1e9).toFixed(3)} gwei`);

  const profit = BigInt(await usdt.balanceOf(me)) - ownerBefore;
  const expected = backSkewed - repay;
  const diff = profit - expected;
  p(`profit real=${fmt(profit)} USDT | asteptat (off-chain quote)=${fmt(expected)} | delta=${diff} wei`);
  if (diff < -2n || diff > 2n)
    throw new Error(`profit real != quote off-chain (delta ${diff} wei)`);
  if (diff !== 0n) p("NOTA: delta sub-wei tolerat (rotunjiri V3/router)");
  if (profit <= 0n) throw new Error("profit <= 0");

  const pairDelta = BigInt(await usdt.balanceOf(flashPair)) - pairUsdtBefore;
  if (pairDelta !== repay - A)
    throw new Error(`flash fee incorect: ${pairDelta} != ${repay - A}`);
  p(`PASS: repay EXACT pe pair (fee flashswap = ${fmt(repay - A)} USDT)`);

  const arbUsdtAfter = BigInt(await usdt.balanceOf(arbAddr));
  const arbWbnbAfter = BigInt(await wbnb.balanceOf(arbAddr));
  if (arbUsdtAfter !== 0n || arbWbnbAfter !== 0n)
    throw new Error(`dust ramas in contract: USDT=${arbUsdtAfter} WBNB=${arbWbnbAfter}`);
  p(`PASS: cleanup complet (final ${arbUsdtAfter}/${arbWbnbAfter}; initial ${arbUsdtBefore}/${arbWbnbBefore})`);

  let evProfit = null;
  for (const lg of rc.logs) {
    try {
      const ev = arb.interface.parseLog(lg);
      if (ev && ev.name === "ArbitrageExecuted") evProfit = ev.args.profit;
    } catch { /* log strain */ }
  }
  if (evProfit === null) throw new Error("eveniment ArbitrageExecuted lipsa");
  if (BigInt(evProfit) !== profit) throw new Error("event profit != delta sold owner");
  p(`PASS: event ArbitrageExecuted(token=USDT, profit=${fmt(evProfit)})`);

  // ------------------------------------------------------------- TEST 4
  head("TEST 4 — OPORTUNITATE CONSUMATA (stabilitate)");
  const backAfter = await venueQuote();
  const netAfter = backAfter - repay;
  p(`net pre-exec=${fmt(backSkewed - repay)} -> post-exec=${fmt(netAfter)} USDT`);
  if (netAfter >= backSkewed - repay) throw new Error("oportunitatea nu s-a consumat");
  p("PASS: profitul scade strict dupa executie");

  // ------------------------------------------------------------- REZUMAT
  head("REZUMAT — PHASE 2: REAL ATOMIC ARBITRAGE ON BSC FORK");
  let edrV = "unknown";
  try {
    edrV = JSON.parse(require("fs").readFileSync(__dirname + "/../node_modules/@nomicfoundation/edr/package.json", "utf8")).version;
  } catch { /* fallback unknown */ }
  const resNow = await fp.getReserves();
  const usdtResNow = BigInt(usdtIsT0 ? resNow[0] : resNow[1]);
  const wbnbResNow = BigInt(usdtIsT0 ? resNow[1] : resNow[0]);
  const usdtPerBnb = Number(usdtResNow) / Number(wbnbResNow);
  const gasBnbF = Number(gasBnb) / 1e18;
  const gasUsdt = gasBnbF * usdtPerBnb;
  p(`mediu    : hardhat ${hre.version} / EDR ${edrV} / fork block ${forkBlock}`);
  p(`borrow   : ${fmt(A)} USDT din pair PancakeV2 real ${flashPair}`);
  p(`Leg A    : PancakeV3 pool real fee=100 -> ${fmt(wbnbOut)} WBNB`);
  p(`Leg B    : ${venue.name} router real (${venue.pair}) -> ${fmt(backSkewed)} USDT`);
  p(`profit   : ${fmt(profit)} USDT (wei-exact vs quote: delta ${diff})`);
  p(`gas      : ${rc.gasUsed} @ ${(Number(rc.gasPrice) / 1e9).toFixed(3)} gwei = ${gasBnbF.toFixed(6)} BNB (~${gasUsdt.toFixed(4)} USDT)`);
  p(`net dupa gas ≈ ${(Number(profit) / 1e18 - gasUsdt).toFixed(4)} USDT`);
  p("TOATE TESTELE: PASS");
}

main().catch((err) => {
  console.error("\n!! TEST FAILED: " + err.message);
  process.exitCode = 1;
});


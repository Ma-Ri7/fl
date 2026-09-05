// FLASH - central configuration for the BSC flashloan arbitrage bot.
// All addresses are normalized through ethers.getAddress() so that any
// checksum typo is caught as soon as this file is loaded.
const { getAddress } = require("ethers");

const A = (addr) => getAddress(addr);

const WBNB = A("0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");
const USDT = A("0x55d398326f99059ff775485246999027b3197955");
const BUSD = A("0xe9e7cea3dedca5984780bafc599bd69add087d56");
const USDC = A("0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d");
const BTCB = A("0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c");
const ETH = A("0x2170ed0880ac9a755fd29b2688956bd959f933f8");
const CAKE = A("0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82");

// --- Token-uri "less tracked" (mid/low-cap), din lista oficiala PancakeSwap extended.
// Fiecare poate avea sau nu perechi pe fiecare DEX - bot-ul verifica on-chain la
// pornire si foloseste DOAR perechile care exista pe cel putin 2 DEX-uri.
const ACH = A("0xbc7d6b50616989655afd682fb42743507003056d");
const ALICE = A("0xac51066d7bec65dc4589368da368b212745d63e8");
const ALPACA = A("0x8f0528ce5ef7b51152a59745befdd91d97091d2f");
const ALPHA = A("0xa1faa113cbe53436df28ff0aee54275c13b40975");
const AITECH = A("0x2d060ef4d6bf7f9e5edde373ab735513c0e4f944");
const HIGH = A("0x5f4bde007dc06b867f86ebfe4802e34a1ffeed63");
const HOOK = A("0xa260e12d2b924cb899ae80bb58123ac3fee1e2f0");
const HFT = A("0x44ec807ce2f4a6f2737a92e985f318d035883e47");
const HOO = A("0xe1d1f66215998786110ba0102ef558b22224c016");
const HOTCROSS = A("0x4fa7163e153419e0e1064e418dd7a99314ed27b6");
const HTD = A("0x5e2689412fae5c29bd575fbe1d5c1cd1e0622a8f");

const MULTICALL3 = A("0xca11bde05977b3631167028862be2a173976ca11");

// Quote tokens: the bot scans pairs quoted in these tokens (and arbitrages
// wherever two DEXes disagree). More quotes = more pairs = more coverage.
// USDT/WBNB/BUSD/USDC is the deepest-liquidity triangle set on BSC.
const QUOTES = ["USDT", "WBNB", "BUSD", "USDC"];

// --- PancakeSwap V3 (concentrated liquidity). Pool-uri descoperite prin
// factory.getPool(token0, token1, feeTier) - fee tiers in hundredths of a bip.
// Factory verificat on-chain (probe) pe BSC mainnet.
const PANCAKE_V3_FACTORY = A("0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865");
const PANCAKE_V3_FEE_TIERS = [100, 500, 2500, 10000]; // 0.01% / 0.05% / 0.25% / 1%
// QuoterV2 - pricing EXACT pe lichiditate concentrata (ruleaza in eth_call).
const PANCAKE_V3_QUOTER = A("0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997");

// --- DODO V2 (PMM). Flashloane pe DVM/DSP/DPP. Factory-urile au fost
// verificate on-chain: fiecare intoarce pool-uri vii pentru perechile noastre.
//
// ATENȚIE (audit item 4/12): NU modelăm DODO printr-un "swap fee" constant.
// Matematica PMM exactă (i, K, B, Q, B0, Q0, R + LP fee + maintainer fee,
// citite din pool) e implementată în lib/dodo.js și folosită de bot/profit.js.
const DODO_FACTORIES = [
  { id: "dvm", name: "DODO DVM", address: A("0x790B4A80Fb1094589A3c0eFC8740aA9b0C1733fB") },
  { id: "dsp", name: "DODO DSP", address: A("0x0fb9815938Ad069Bf90E14FE6C596c514BEDe767") },
  { id: "dpp", name: "DODO DPP", address: A("0xd9CAc3D964327e47399aebd8e1e6dCC4c251DaAE") },
];

// Costul flashloan-ului DODO (PHASE 2B — se validează pe fork):
// null => 0 (contractul rambursează EXACT activele împrumutate, pool-ul nu
// primește nimic în callback). Dacă validarea pe fork arată altfel, setează
// aici bps (ex: 2) și profit.js le va include automat în calcul.
const DODO_POLICY = {
  flashFeeBps: null,
};

const DEXES = [
  {
    id: "pancakeswap",
    name: "PancakeSwap V2",
    factory: A("0xca143ce32fe78f1f7019d7d551a6402fc5350c73"),
    router: A("0x10ed43c718714eb63d5aa57b78b54704e256024e"),
    feeBps: 25, // 0.25%
    verified: true,
  },
  {
    id: "biswap",
    name: "BiSwap",
    factory: A("0x858e3312ed3a876947ea49d572a7c42de08af7ee"),
    router: A("0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8"),
    feeBps: 10, // 0.10%
    verified: true,
  },
  {
    id: "sushiswap",
    name: "SushiSwap",
    factory: A("0xc35dadb65012ec5796536bd9864ed8773abc74c4"),
    router: A("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"),
    feeBps: 30, // 0.30%
    verified: true,
  },
  {
    id: "apeswap",
    name: "ApeSwap",
    factory: A("0x0841bd0b734e4f5853f0dd8d7ea041c241fb0da6"),
    router: A("0xc0788a3ad43d79aa53b09c2eacc313a787d1d607"),
    feeBps: 20, // 0.20%
    verified: true,
  },
  {
    id: "babyswap",
    name: "BabySwap",
    factory: A("0x86407bea2078ea5f5eb5a52b2caa963bc1f889da"),
    router: A("0x8317c460c22a9958c27b4b6403b98d2ef4e2ad32"),
    feeBps: 20, // 0.20%
    verified: true,
  },
  {
    id: "fstswap",
    name: "FstSwap",
    factory: A("0x9a272d734c5a0d7d84e0a892e891a553e8066dce"),
    router: A("0x1b6c9c20693afde803b27f8782156c0f892abc2d"),
    feeBps: 30, // 0.30%
    verified: true,
  },
];

module.exports = {
  chainId: 56,
  MULTICALL3,
  DEXES,
  V2_ROUTERS: DEXES, // alias for backward compat
  QUOTES,
  PANCAKE_V3_FACTORY,
  PANCAKE_V3_FEE_TIERS,
  PANCAKE_V3_QUOTER,
  DODO_FACTORIES,
  dodo: DODO_POLICY,
  TOKENS: {
    // Majore (baza de preturi, utile pentru perechile stabile):
    WBNB: { address: WBNB, decimals: 18, symbol: "WBNB" },
    USDT: { address: USDT, decimals: 18, symbol: "USDT" },
    BUSD: { address: BUSD, decimals: 18, symbol: "BUSD" },
    USDC: { address: USDC, decimals: 18, symbol: "USDC" },
    BTCB: { address: BTCB, decimals: 18, symbol: "BTCB" },
    ETH: { address: ETH, decimals: 18, symbol: "ETH" },
    CAKE: { address: CAKE, decimals: 18, symbol: "CAKE" },
    // Mai putin urmarite (mid/low-cap) - focusul bot-ului:
    ACH: { address: ACH, decimals: 8, symbol: "ACH" },
    ALICE: { address: ALICE, decimals: 6, symbol: "ALICE" },
    ALPACA: { address: ALPACA, decimals: 18, symbol: "ALPACA" },
    ALPHA: { address: ALPHA, decimals: 18, symbol: "ALPHA" },
    AITECH: { address: AITECH, decimals: 18, symbol: "AITECH" },
    HIGH: { address: HIGH, decimals: 18, symbol: "HIGH" },
    HOOK: { address: HOOK, decimals: 18, symbol: "HOOK" },
    HFT: { address: HFT, decimals: 18, symbol: "HFT" },
    HOO: { address: HOO, decimals: 8, symbol: "HOO" },
    HOTCROSS: { address: HOTCROSS, decimals: 18, symbol: "HOTCROSS" },
    HTD: { address: HTD, decimals: 18, symbol: "HTD" },
  },
  bot: {
    pollIntervalMs: 2000,
    scanTimeoutMs: 8000,
    defaultFlashAmount: 1000000n * 10n ** 18n, // 1M quote token cap per trade
    minProfitBnb: 0.01, // broadcast only if estimated NET profit > 0.01 BNB
    slippageBps: 100n, // marja de risc aplicată pe quote-ul EXACT la minProfit (PHASE 10)
    maxPerPairBorrowBps: 200, // never borrow more than 200 bps (2%) of a pair's quote reserve
    gasMultiplier: 1.15,
    maxNonceGap: 5,
    sweepMinBnb: 0.005,
    maxTxWaitMs: 60000,
    // PHASE 10/11 — execuție:
    requoteMaxAgeBlocks: 2, // final requote mai vechi de N block-uri => skip
    gasReserveBps: 500, // profit net (în BNB) trebuie să depășească gas estimat cu 5%
    deadlinePadSec: 75, // deadline scurt (~3 blocuri BSC), nu 5 minute
  },
};
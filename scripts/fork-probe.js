// Probe minimal BSC fork — rulează cu configurația PROPRIE a proiectului FLASH.
// Fără ethers: doar JSON-RPC raw (selectori UniswapV2 canonici, stabili).
// Scop: re-test HH604 pe hardhat 2.29.1 / EDR 0.12.0-next.23 în FLASH.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";

const pad = (a) => a.slice(2).toLowerCase().padStart(64, "0");

async function main() {
  const p = hre.network.provider;
  const hk = hre.config.networks.hardhat;
  const fk = hk.forking || {};
  let host = "?";
  try { host = new URL(fk.url || "").hostname; } catch { /* fara url */ }
  console.log("hardhat       :", hre.version);
  try {
    const edrPkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "node_modules", "@nomicfoundation", "edr", "package.json"), "utf8")
    );
    console.log("edr           :", edrPkg.version);
  } catch { console.log("edr           : unknown"); }
  console.log("forking cfg   :", fk.enabled === false ? "DISABLED!" : `enabled, host=${host}, block=${fk.blockNumber ?? "latest"}`);
  console.log("chainId cfg   :", hk.chainId);

  const chainId = BigInt(await p.send("eth_chainId"));
  const block = BigInt(await p.send("eth_blockNumber"));
  console.log("chainId live  :", chainId.toString());
  console.log("fork block    :", block.toString());

  const call = (to, data) => p.send("eth_call", [{ to, data }, "latest"]);

  const lenRaw = await call(FACTORY, "0x574f2ba3"); // allPairsLength()
  const len = BigInt(lenRaw);
  console.log("allPairsLength:", len.toString());

  const pairRaw = await call(FACTORY, "0xe6a43905" + pad(WBNB) + pad(USDT)); // getPair(WBNB,USDT)
  const pair = "0x" + pairRaw.slice(-40);
  console.log("getPair       :", pair);

  const resRaw = await call(pair, "0x0902f1ac"); // getReserves()
  const r0 = BigInt("0x" + resRaw.slice(2, 66));
  const r1 = BigInt("0x" + resRaw.slice(66, 130));
  const ts = BigInt("0x" + resRaw.slice(130, 138));
  console.log("getReserves   : r0=" + r0.toString() + " r1=" + r1.toString() + " ts=" + ts.toString());

  if (len <= 0n) throw new Error("allPairsLength invalid");
  if (BigInt(pair) === 0n) throw new Error("getPair -> zero");
  if (r0 === 0n || r1 === 0n) throw new Error("reserves zero");
  console.log("\nPROBE PASS — fork + eth_call funcțional pe configurația FLASH");
}

main().catch((e) => {
  console.error("\nPROBE FAIL:", e.message);
  process.exitCode = 1;
});

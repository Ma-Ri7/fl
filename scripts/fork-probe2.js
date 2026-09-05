// Probe 2: raw eth_call CU `from` — testează dacă lipsa `from` declanșează HH604.
const hre = require("hardhat");
const FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const pad = (a) => a.slice(2).toLowerCase().padStart(64, "0");

async function main() {
  const p = hre.network.provider;
  const [signer] = await hre.ethers.getSigners();
  console.log(
    "fork block:",
    BigInt(await p.send("eth_blockNumber", [])).toString()
  );

  const pairRaw = await p.send("eth_call", [
    {
      from: signer.address,
      to: FACTORY,
      data: "0xe6a43905" + pad(WBNB) + pad(USDT),
    },
    "latest",
  ]);
  const pair = "0x" + pairRaw.slice(-40);
  console.log("getPair (cu from):", pair);
  if (BigInt(pair) === 0n) throw new Error("pair zero");

  const resRaw = await p.send("eth_call", [
    { from: signer.address, to: pair, data: "0x0902f1ac" },
    "latest",
  ]);
  console.log(
    "getReserves (cu from): OK, r0=" +
      BigInt("0x" + resRaw.slice(2, 66)).toString()
  );
  console.log("\nPROBE2 PASS — eth_call CU `from` funcționează");
}

main().catch((e) => {
  console.error("PROBE2 FAIL:", e.message);
  process.exitCode = 1;
});

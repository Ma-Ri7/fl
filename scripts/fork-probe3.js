// Probe 3 — test decisiv H1:
//  (a) eth_call la latest (== forkBlock)           -> se asteapta HH604
//  (b) evm_mine, apoi eth_call la latest (F+1)     -> se asteptat PASS
//  (c) eth_call cu blockTag explicit = forkBlock   -> se asteapta HH604
const hre = require("hardhat");
const FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const pad = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const CALL = "0x574f2ba3"; // allPairsLength()

async function main() {
  const p = hre.network.provider;
  const F = BigInt(await p.send("eth_blockNumber", []));
  console.log("forkBlock (head):", F.toString());

  // (a) eth_call la latest == forkBlock
  try {
    const r = await p.send("eth_call", [{ to: FACTORY, data: CALL }, "latest"]);
    console.log("(a) latest==F   : PASS len=" + (BigInt(r) > 0n));
  } catch (e) {
    console.log("(a) latest==F   : FAIL → " + e.message.slice(0, 60));
  }

  // (b) mineaza un block gol, apoi eth_call la latest == F+1
  await p.send("evm_mine", []);
  const H = BigInt(await p.send("eth_blockNumber", []));
  try {
    const r = await p.send("eth_call", [{ to: FACTORY, data: CALL }, "latest"]);
    console.log(`(b) latest==F+1 (${H}) : PASS len=` + BigInt(r).toString());
  } catch (e) {
    console.log("(b) latest==F+1 : FAIL → " + e.message.slice(0, 60));
  }

  // (c) eth_call cu blockTag explicit = forkBlock (istoric)
  try {
    const r = await p.send("eth_call", [
      { to: FACTORY, data: CALL },
      "0x" + F.toString(16),
    ]);
    console.log("(c) explicit F  : PASS len=" + BigInt(r).toString());
  } catch (e) {
    console.log("(c) explicit F  : FAIL → " + e.message.slice(0, 60));
  }

  // (d) eth_call la block istoric vechi (F-100) — sanctuar istoric complet
  try {
    const r = await p.send("eth_call", [
      { to: FACTORY, data: CALL },
      "0x" + (F - 100n).toString(16),
    ]);
    console.log("(d) istoric F-100 : PASS len=" + BigInt(r).toString());
  } catch (e) {
    console.log("(d) istoric F-100 : FAIL → " + e.message.slice(0, 60));
  }
}

main().catch((e) => {
  console.error("PROBE3 ERROR:", e.message);
  process.exitCode = 1;
});

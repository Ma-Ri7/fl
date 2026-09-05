#! /usr/bin/env node
// discover-dex.js <routerAddress>
// Given a UniswapV2-style DEX router on BSC, this probe discovers its factory
// and lists live pairs for the token universe in bot/config.js.
//
// Usage:  node scripts/discover-dex.js 0x<routerAddress>
require("dotenv").config();
const { ethers } = require("ethers");
const { pickProvider } = require("../bot/rpc");
const config = require("../bot/config");

const FACTORY_SELS = ["0xc45a5555", "0xfb1da9f4", "0x9c941266"]; // factory(), getFactory(), FACTORY()

async function discoverFactory(provider, routerAddr) {
  for (const sel of FACTORY_SELS) {
    try {
      const res = await provider.call({ to: routerAddr, data: sel });
      if (res && res.length >= 66) {
        const addr = "0x" + res.slice(26, 66).toLowerCase();
        if (addr !== ethers.ZeroAddress) return addr;
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

async function main() {
  const router = process.argv[2];
  if (!router || !router.startsWith("0x")) {
    console.error("Usage: node scripts/discover-dex.js 0x<routerAddress>");
    process.exit(1);
  }
  const routerAddr = ethers.getAddress(router.toLowerCase());

  console.log("=== FLASH — DEX discovery ===\n");
  const { provider } = await pickProvider();
  console.log(`Block: ${await provider.getBlockNumber()}`);

  // 1. Factory
  let factory = null;
  try {
    const code = await provider.getCode(routerAddr);
    if (code === "0x") {
      console.log(`ERROR: no code at ${routerAddr} (not a contract)`);
      process.exit(1);
    }
    console.log(`Router : ${routerAddr}`);
    factory = await discoverFactory(provider, routerAddr);
    if (factory) {
      console.log(`Factory: ${factory}`);
    } else {
      console.log(`Factory: (nu-poate-fi determinată automat — verifică pe BscScan sau\n`);
      console.log(`         în documentația DEX-ului; adresa routerului îți e de-ajuns\n`);
      console.log(`         doar dacă DEX-ul e un fork PancakeV2 standard)`);
    }
  } catch (e) {
    console.error(`ERROR reading router code: ${e.message.slice(0, 120)}`);
    process.exit(1);
  }

  if (!factory) {
    console.log("\nRouter-ul e valid, dar factory nu poate fi auto-detectat.");
    console.log("Caută factory-ul manual (BscScan securit-uri → contract) și rulează iar");
    console.log(`sau adaugă DEX-ul cu factory cunoscut în bot/config.js DEXES.`);
    process.exit(0);
  }

  // Verify the factory responds to getPair
  const factoryContract = new ethers.Contract(factory, [
    "function getPair(address,address) view returns (address)",
  ], provider);

  // 2. Live pairs across our token universe
  const tokens = Object.values(config.TOKENS);
  console.log(`\nProbing ${tokens.length} tokens for live pairs on the factory...`);
  let found = 0;
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      try {
        const pair = await factoryContract.getPair(tokens[i].address, tokens[j].address);
        if (pair && pair !== ethers.ZeroAddress) {
          console.log(`  ${tokens[i].symbol}-${tokens[j].symbol}  pair=${pair}`);
          found++;
        }
      } catch (_) { /* no pair on this factory */ }
    }
  }
  console.log(`\n${found} live pairs found on ${factory}`);
  console.log("\nTo add this DEX to the bot, add an entry in bot/config.js DEXES:");
  console.log(`  { id: "xxxx", name: "...", factory: "${factory}", router: "${routerAddr}", feeBps: 25, verified: true }`);
  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
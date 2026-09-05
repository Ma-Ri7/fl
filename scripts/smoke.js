// Smoke test: read-only live scan on BSC. Validates RPC, venue discovery,
// state reads, and opportunity detection WITHOUT broadcasting anything.
require("dotenv").config();
const { ethers } = require("ethers");
const { pickProvider } = require("../bot/rpc");
const { discoverVenues, readState } = require("../bot/scanner");
const { findOpportunities } = require("../bot/profit");
const config = require("../bot/config");

(async () => {
  try {
    console.log("=== FLASH smoke test (read-only, no broadcast) ===\n");
    const { provider } = await pickProvider();
    console.log(`Provider : HTTP`);
    console.log(`Block    : ${await provider.getBlockNumber()}`);
    const net = await provider.getNetwork();
    console.log(`Network  : ${Number(net.chainId) === 56 ? "BSC mainnet" : "chain " + Number(net.chainId)}\n`);

    console.log("Discovering venues (V2/V3/DODO)...");
    const { venues, byPair } = await discoverVenues(provider, config);
    console.log(`Venues   : ${venues.length}  (V2=${venues.filter(v => v.kind === "v2").length}, ` +
      `V3=${venues.filter(v => v.kind === "v3").length}, ` +
      `DODO=${venues.filter(v => v.kind === "dodo").length})`);
    console.log(`Pairs    : ${byPair.size}`);

    console.log("\nReading on-chain state...");
    await readState(provider, venues);
    const live = venues.filter(v => !v.dead);
    console.log(`Live     : ${live.length} venues with liquidity\n`);

    const tokens = Object.values(config.TOKENS);
    const opps = findOpportunities(venues, tokens);
    console.log(`Opportunities: ${opps.length}`);
    opps.slice(0, 10).forEach((o) => {
      const p = o.profitInBnb ? ethers.formatUnits(o.profitInBnb, 18) : "n/a";
      console.log(
        `  ${o.borrowToken.symbol}/${o.baseToken.symbol}` +
        ` | borrow=${ethers.formatUnits(o.borrowAmount, o.borrowToken.decimals || 18)} ${o.borrowToken.symbol}` +
        ` | profit≈${p} BNB` +
        ` | ${o.buyVen.name} -> ${o.sellVen.name}` +
        ` | src=${o.sourceKind}`
      );
    });

    console.log("\n✓ Smoke test completed successfully. No transactions were sent.");
    process.exit(0);
  } catch (e) {
    console.error("\n✗ Smoke test FAILED:", e.message);
    process.exit(1);
  }
})();
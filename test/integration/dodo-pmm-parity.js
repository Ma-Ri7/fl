// ============================================================================
// test/integration/dodo-pmm-parity.js — DODO PMM JS <-> EVM parity test.
//
// Validates PHASE 2B (audit): the off-chain quote engine (lib/dodo.js) produces
// bit-exact results against the on-chain DODO V2 PMM implementation
// (contracts/mocks/DODOPMMParity.sol — faithful port of DODO contractV2).
//
// Run: npx hardhat test test/integration/dodo-pmm-parity.js
// ============================================================================
const { expect } = require("chai");
const { ethers } = require("hardhat");
const dodo = require("../../lib/dodo");

describe("Test A: DODO PMM parity (JS vs EVM)", function () {
  let harness;

  before(async function () {
    const Harness = await ethers.getContractFactory("DODOPMMHarness");
    harness = await Harness.deploy();
    await harness.waitForDeployment();
  });

  // PMM states covering R_ONE, R_ABOVE, R_BELOW regimes + edge cases
  const CASES = [
    { i: 10n ** 18n, K: 0n, B: 1000000n, Q: 1000000n, pay: 100n },
    { i: 10n ** 18n, K: 10n ** 17n, B: 1000000n, Q: 1000000n, pay: 100n },
    { i: 10n ** 18n, K: 5n * 10n ** 17n, B: 1000000n, Q: 1000000n, pay: 100n },
    { i: 2n * 10n ** 18n, K: 10n ** 17n, B: 500000n, Q: 1000000n, pay: 500n },
    { i: 10n ** 18n, K: 10n ** 18n, B: 1000000n, Q: 2000000n, pay: 1000n },
    { i: 10n ** 18n, K: 10n ** 17n, B: 999000n, Q: 1000000n, pay: 100n },
    { i: 10n ** 18n, K: 10n ** 17n, B: 500000n, Q: 1000000n, pay: 50000n },
    { i: 3n * 10n ** 18n, K: 8n * 10n ** 17n, B: 200000n, Q: 600000n, pay: 100n },
  ];

  for (const c of CASES) {
    it(`sellBase parity: i=${c.i} K=${c.K} B=${c.B} Q=${c.Q} pay=${c.pay}`, async function () {
      const state = dodo.pmmStateFromReserves({ i: c.i, K: c.K, B: c.B, Q: c.Q });
      const jsResult = dodo.sellBaseToken(state, c.pay);
      const evmResult = await harness.sellBaseRaw(
        c.i, c.K, c.B, c.Q, state.B0, state.Q0, Number(state.R), c.pay
      );
      expect(jsResult.receive).to.equal(evmResult);
    });

    it(`sellQuote parity: i=${c.i} K=${c.K} B=${c.B} Q=${c.Q} pay=${c.pay}`, async function () {
      const state = dodo.pmmStateFromReserves({ i: c.i, K: c.K, B: c.B, Q: c.Q });
      const jsResult = dodo.sellQuoteToken(state, c.pay);
      const evmResult = await harness.sellQuoteRaw(
        c.i, c.K, c.B, c.Q, state.B0, state.Q0, Number(state.R), c.pay
      );
      expect(jsResult.receive).to.equal(evmResult);
    });
  }
});

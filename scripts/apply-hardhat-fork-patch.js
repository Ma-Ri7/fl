// ============================================================================
// apply-hardhat-fork-patch.js
//
// FIX pentru HH604: "No known hardfork for execution on historical block ..."
//
// ROOT CAUSE (confirmat experimental + la nivel de cod):
//   hardhat 2.29.1 construieste chainOverrides cu campul `hardforks`:
//     { chainId, name: "Unknown", hardforks: [...] }
//   dar EDR 0.12.0-next.23 citeste DOAR:
//     { chainId, name, hardforkActivationOverrides?: [...] }
//   Campul gresit este ignorat silențios (interfață opțională) => istoricul de
//   hardfork nu ajunge niciodata in VM => orice executie la block <= forkBlock
//   pică cu HH604. Execuția pe block-uri NOI (> forkBlock) funcționează, fiindcă
//   folosește config.hardfork (default OSAKA) — de aceea testele care minează
//   un block înainte de citiri pareau OK, iar citirile raw la block==fork picau.
//
// PATCH:
//   1. redenumire camp -> `hardforkActivationOverrides`
//   2. valori >= 1e12 din hardforkHistory sunt interpretate ca UNIX TIMESTAMP
//      (BSC activează fork-urile moderne pe timestamp; vezi bnb-chain/bsc
//      params/config.go BSCChainConfig), valori mici = block number.
//
// Idempotent. Rulează automat la `npm install` (postinstall).
// ============================================================================

const fs = require("fs");
const path = require("path");

const PROVIDER = path.join(
  __dirname,
  "..",
  "node_modules",
  "hardhat",
  "internal",
  "hardhat-network",
  "provider",
  "provider.js"
);

const BROKEN = `        const chainOverrides = Array.from(config.chains, ([chainId, hardforkConfig]) => {
            return {
                chainId: BigInt(chainId),
                name: "Unknown",
                hardforks: Array.from(hardforkConfig.hardforkHistory, ([hardfork, blockNumber]) => {
                    return {
                        condition: { blockNumber: BigInt(blockNumber) },
                        hardfork: (0, convertToEdr_1.ethereumsjsHardforkToEdrSpecId)((0, hardforks_1.getHardforkName)(hardfork)),
                    };
                }),
            };
        });`;

const FIXED = `        // FLASH PATCH (scripts/apply-hardhat-fork-patch.js):
        // hardhat 2.29.1 trimite campul 'hardforks', dar EDR >= 0.12.0-next.23
        // citeste 'hardforkActivationOverrides' -> istoricul era aruncat silent
        // (HH604 la orice executie pe block <= fork block). Valori >= 1e12 sunt
        // tratate ca unix timestamps (BSC activeaza fork-urile moderne pe timp).
        const chainOverrides = Array.from(config.chains, ([chainId, hardforkConfig]) => {
            return {
                chainId: BigInt(chainId),
                name: "Unknown",
                hardforkActivationOverrides: Array.from(hardforkConfig.hardforkHistory, ([hardfork, activation]) => {
                    const condition = BigInt(activation) >= 1000000000000n
                        ? { timestamp: BigInt(activation) }
                        : { blockNumber: BigInt(activation) };
                    return {
                        condition,
                        hardfork: (0, convertToEdr_1.ethereumsjsHardforkToEdrSpecId)((0, hardforks_1.getHardforkName)(hardfork)),
                    };
                }),
            };
        });`;

function main() {
  if (!fs.existsSync(PROVIDER)) {
    console.error(
      "[fork-patch] hardhat/internal provider.js nu exista — hardhat instalat?"
    );
    process.exit(1);
  }
  const src = fs.readFileSync(PROVIDER, "utf8");

  if (src.includes("hardforkActivationOverrides")) {
    console.log("[fork-patch] deja aplicat — OK");
    return;
  }
  if (!src.includes(BROKEN)) {
    console.error(
      "[fork-patch] NU am gasit pattern-ul asteptat — hardhat s-ar fi putut actualiza. Verifica manual provider.js!"
    );
    process.exit(1);
  }
  fs.writeFileSync(PROVIDER, src.replace(BROKEN, FIXED));
  console.log("[fork-patch] PATCH APLICAT: hardforks -> hardforkActivationOverrides");
}

main();

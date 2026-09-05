require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      metadata: {
        bytecodeHash: "none",
      },
      viaIR: true,
    },
  },

  networks: {
    hardhat: {
      chainId: 56,

      chains: {
        56: {
          // Istoric REAL BSC mainnet (sursa: bnb-chain/bsc params/config.go,
          // BSCChainConfig). Conventie patch FLASH: valoare >= 1e12 = unix
          // timestamp; valoare mica = block number. Fork-urile BSC moderne sunt
          // timestamp-based.
          hardforkHistory: {
            byzantium: 0,
            constantinople: 0,
            petersburg: 0,
            istanbul: 0,
            muirGlacier: 0,
            berlin: 31302048,
            london: 31302048,
            shanghai: 1705996800, // 2024-01-23 08:00 UTC
            cancun: 1718863500, // 2024-06-20 06:05 UTC
            prague: 1742436600, // 2025-03-20 02:10 UTC
            osaka: 1777343400, // 2026-04-28 02:30 UTC
          },
        },
      },

      forking: process.env.BSC_RPC_URL
        ? {
            url: process.env.BSC_RPC_URL,
            blockNumber: process.env.BSC_FORK_BLOCK
              ? Number(process.env.BSC_FORK_BLOCK)
              : undefined,
          }
        : undefined,
    },

    bscTestnet: {
      url:
        process.env.BSC_TESTNET_RPC_URL ||
        "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY]
        : [],
    },

    bsc: {
      url:
        process.env.BSC_RPC_URL ||
        "https://bsc-dataseed1.binance.org",
      chainId: 56,
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY]
        : [],
    },
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },

  etherscan: {
    apiKey: process.env.BSCSCAN_API_KEY,
  },
};
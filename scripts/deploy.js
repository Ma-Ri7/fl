// FLASH - deploy script for BSC mainnet (or BSC testnet with --network bscTestnet).
// Usage:
//   npm run deploy                        # deploys to BSC mainnet using .env
//   npx hardhat run scripts/deploy.js --network bscTestnet   # testnet dry run
//
// After deployment the address is printed and (optionally) written into .env.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

async function main() {
  const rpc = process.env.BSC_RPC_URL;
  const pk = process.env.PRIVATE_KEY;
  if (!rpc || !pk) {
    console.error("Missing BSC_RPC_URL / PRIVATE_KEY in .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpc, 56);
  const wallet = new ethers.Wallet(pk, provider);

  const artifact = require("../artifacts/contracts/FlashLoanArbitrage.sol/FlashLoanArbitrage.json");
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  console.log(`Deploying from ${wallet.address}...`);
  const balance = await provider.getBalance(wallet.address);
  console.log(`Balance: ${ethers.formatEther(balance)} BNB`);
  if (balance < ethers.parseEther("0.01")) {
    console.warn("WARNING: low balance - deployment may fail.");
  }

  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log(`Deployed FlashLoanArbitrage at: ${addr}`);
  console.log(`Deploy tx: https://bscscan.com/tx/${contract.deploymentTransaction().hash}`);

  // Write CONTRACT_ADDRESS into .env if present (keeps secrets intact).
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    let env = fs.readFileSync(envPath, "utf8");
    if (/^CONTRACT_ADDRESS=/m.test(env)) {
      env = env.replace(/^CONTRACT_ADDRESS=.*$/m, `CONTRACT_ADDRESS=${addr}`);
    } else {
      env += `\nCONTRACT_ADDRESS=${addr}\n`;
    }
    fs.writeFileSync(envPath, env);
    console.log(`Updated CONTRACT_ADDRESS in .env`);
  } else {
    console.log(`Set CONTRACT_ADDRESS=${addr} in your .env`);
  }
  return addr;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
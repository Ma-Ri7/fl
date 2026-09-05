// FLASH - sweeper: shows the wallet's BNB balance. The arbitrage contract already
// forwards every profit to the owner automatically, so this is mostly a status
// check / gas monitor. If you ever deposit tokens into the contract for reasons
// other than flashes, use rescueToken() from the contract.
//
// Run with:  node bot/sweeper.js   (or: npm run sweep)

require("dotenv").config();
const { ethers } = require("ethers");
const config = require("./config");
const logger = require("./logger");

(async () => {
  const rpc = process.env.BSC_RPC_URL;
  const pk = process.env.PRIVATE_KEY;

  const provider = new ethers.JsonRpcProvider(rpc, new ethers.Network("bsc", 56));
  const wallet = new ethers.Wallet(pk, provider);

  const bal = await provider.getBalance(wallet.address);
  const contract = process.env.CONTRACT_ADDRESS;
  logger.info(`Wallet  : ${wallet.address}`);
  logger.info(`Balance : ${Number(ethers.formatEther(bal)).toFixed(4)} BNB`);

  if (contract && /^0x[0-9a-fA-F]{40}$/.test(contract)) {
    const cBal = await provider.getBalance(contract);
    if (cBal > 0n) {
      logger.info(`Contract: ${Number(ethers.formatEther(cBal)).toFixed(6)} BNB (native, probably dust)`);
    } else {
      logger.info(`Contract: 0 BNB (normal - the contract never holds funds)`);
    }
  }
})();
// FLASH — builds calldata, simulates (eth_call), and broadcasts arbitrage txs.
// Supports both public mempool and BloXroute private mempool (anti-frontrunning).
const { ethers } = require("ethers");
const abi = require("../artifacts/contracts/FlashLoanArbitrage.sol/FlashLoanArbitrage.json").abi;
const config = require("./config");
const bloxroute = require("./bloxroute");

const iface = new ethers.Interface(abi);
const DEADLINE_PAD = 300; // 5 minutes

function buildLeg(venue, tokenIn) {
  const inIsA = tokenIn.toLowerCase() === venue.tokenA?.address?.toLowerCase();
  if (venue.kind === "v2") {
    const tA = venue.tokenA.address, tB = venue.tokenB.address;
    const path = inIsA ? [tA, tB] : [tB, tA];
    return { kind: 0, target: venue.router, zeroForOne: false, path };
  }
  if (venue.kind === "v3") {
    const zeroForOne = tokenIn.toLowerCase() === venue.tokenA.address.toLowerCase();
    return { kind: 1, target: venue.pool, zeroForOne, path: [] };
  }
  const zeroForOne = tokenIn.toLowerCase() === venue.baseToken.toLowerCase();
  return { kind: 2, target: venue.pool, zeroForOne, path: [] };
}

function buildCalldata(opp) {
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_PAD;
  const minReturn = (opp.quoteRecv * 99n) / 100n; // 1% slippage

  if (opp.sourceKind === "dodo") {
    const legA = buildLeg(opp.buyVen, opp.borrowToken.address);
    const legB = buildLeg(opp.sellVen, opp.baseToken.address);
    const baseAmt = opp.borrowToken.address.toLowerCase() === opp.sourceVen.baseToken.toLowerCase() ? opp.borrowAmount : 0n;
    const quoteAmt = opp.borrowToken.address.toLowerCase() === opp.sourceVen.quoteToken.toLowerCase() ? opp.borrowAmount : 0n;
    return {
      sig: "dodo",
      data: iface.encodeFunctionData("flashArbitrageDodo", [
        opp.sourceVen.pool, baseAmt, quoteAmt,
        opp.borrowToken.address, opp.baseToken.address,
        opp.sourceVen.baseToken, opp.sourceVen.quoteToken,
        legA, legB, minReturn, deadline,
      ]),
    };
  }

  // V2 flashswap: legs must use ROUTERS (not pair addresses)
  const bIsT0 = opp.borrowToken.address.toLowerCase() === opp.sourceVen.tokenA?.address?.toLowerCase();
  const amount0Out = bIsT0 ? opp.borrowAmount : 0n;
  const amount1Out = bIsT0 ? 0n : opp.borrowAmount;
  const pathA = [opp.borrowToken.address, opp.baseToken.address];
  const pathB = [opp.baseToken.address, opp.borrowToken.address];
  return {
    sig: "v2",
    data: iface.encodeFunctionData("flashArbitrage", [
      opp.sourceVen.pair, amount0Out, amount1Out,
      opp.buyVen.router, pathA, opp.sellVen.router, pathB,
      minReturn, deadline,
    ]),
  };
}

async function simulate(contractAddr, calldata, sig, provider) {
  const res = await provider.call({ to: contractAddr, data: calldata });
  const fn = sig === "dodo" ? "flashArbitrageDodo" : "flashArbitrage";
  return iface.decodeFunctionResult(fn, res);
}

async function executeOpp(opp, contractAddr, wallet, provider, opts = {}) {
  const { data, sig } = buildCalldata(opp);
  const contract = new ethers.Contract(contractAddr, abi, wallet);
  const fn = sig === "dodo" ? "flashArbitrageDodo" : "flashArbitrage";

  // Simulate first
  let estProfit;
  try {
    const decoded = parseCalldata(fn, data);
    await contract[fn].staticCall(...decoded);
    estProfit = opp.netProfit;
  } catch (e) {
    return { ok: false, reason: "sim-fail", err: e.message.slice(0, 120) };
  }

  // Estimate gas
  let gasLimit;
  try {
    const decoded = parseCalldata(fn, data);
    gasLimit = await contract[fn].estimateGas(...decoded);
    gasLimit = (gasLimit * 120n) / 100n; // 20% buffer
  } catch (e) {
    return { ok: false, reason: "gas-est-fail", err: e.message.slice(0, 120) };
  }

  const feeData = await provider.getFeeData();

  // --- Choose broadcast method: BloXroute (private) vs public mempool ---
  const useBloxroute = await bloxroute.isAvailable();

  if (useBloxroute) {
    // Private mempool: tx goes directly to validators, invisible to frontrunners
    const result = await bloxroute.sendPrivateTx({
      wallet,
      to: contractAddr,
      data,
      gasLimit,
      maxFeePerGas: feeData.maxFeePerGas || 5000000000n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || 2000000000n,
      targetBlock: opts.targetBlock,
    });
    if (!result.ok) {
      // Fallback to public mempool if BloXroute fails
      console.warn("[bloxroute] failed, falling back to public:", result.error);
    } else {
      return { ok: true, txHash: result.txHash, blockNumber: result.block, profit: estProfit, private: true };
    }
  }

  // Public mempool (default)
  const tx = await wallet.sendTransaction({
    to: contractAddr,
    data,
    gasLimit,
    gasPrice: feeData.gasPrice || 5000000000n,
  });

  const receipt = await tx.wait(opts.maxTxWaitMs || 60000);
  return { ok: true, txHash: tx.hash, blockNumber: receipt.blockNumber, profit: estProfit, private: false };
}

function parseCalldata(fn, data) {
  const decoded = iface.decodeFunctionData(fn, data);
  // Convert ethers Result (with named struct fields) to a plain array
  return decoded.toArray ? decoded.toArray() : Array.from(decoded);
}

module.exports = { buildCalldata, buildLeg, simulate, executeOpp };

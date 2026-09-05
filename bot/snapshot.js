// FLASH — formal BLOCK SNAPSHOT (audit item 6, PHASE 8).
// Toate citirile de stare ale unui ciclu de scanare sunt fixate pe același
// block (blockTag), astfel încât toate quote-urile unei oportunități provin
// din aceeași stare logică a lanțului.
const { ethers } = require("ethers");

let stateVersionCounter = 0n;

/**
 * Creează un snapshot formal la block-ul cel mai recent cunoscut de provider.
 * @param {ethers.Provider} provider
 * @returns {Promise<{blockNumber:number, blockHash:string, timestamp:number, stateVersion:bigint, createdAt:number}>}
 */
async function createSnapshot(provider) {
  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  const snap = {
    blockNumber,
    blockHash: block.hash,
    timestamp: block.timestamp,
    stateVersion: ++stateVersionCounter,
    createdAt: Date.now(),
  };
  return snap;
}

/** Verificare de consistență: toate venue-urile au fost citite în același block? */
function isConsistent(snapshot, venues) {
  return venues.every(
    (v) => v.dead || v.snapshot === undefined || v.snapshot === snapshot.blockNumber
  );
}

module.exports = { createSnapshot, isConsistent };

// FLASH — FRESH ON-CHAIN STATE VALIDATION (TASK 4.3-A).
//
// TASK 4.3 a adus fingerprint-ul de state la momentul SCANĂRII. Dar
// validateSnapshot() recalculează amprenta din obiectele opp.buyVen /
// opp.sellVen — adică din view-ul off-chain. Dacă pool-ul REAL se schimbă
// după scan și nicio re-scanare nu a reîmprospătat obiectele, view-ul vechi
// produce ACEEAȘI amprentă => FALSE ACCEPT.
//
// Acest modul elimină golul: citește starea REALĂ de pe lanț la un block
// coerent (blockTag = freshBlockNumber), prin infrastructura existentă din
// scanner.js (readState + enrichV3Venues — fără o a doua implementare de
// ABI/RPC), construiește CLONE de venue (opportunity-ul NU este atins) și
// compară amprentele proaspete cu cele transportate de oportunitate.
//
// Reguli:
//   fresh fingerprint == opp fingerprint  => ACCEPT (block nou fără schimbare
//                                            de state este OK — Caz A)
//   fresh fingerprint != opp fingerprint  => REJECT "stale-state" (Caz B)
//   blockHash indisponibil                => REJECT (nu implicit valid)
//   venue neidentificabil / amprentă lipsă=> REJECT (nu ghicim)
//   NICIO mutare pe opp / snapshot (§2/§12)
//
// NU face requote economic (faza 10) — doar detectează inconsistența.
const scanner = require("./scanner");
const snapshotMod = require("./snapshot");

/**
 * Schelet de venue pentru citirea fresh: păstrează IDENTITATEA (prefixul
 * canonic al cheii de fingerprint) și lasă state-ul să fie re-citit.
 * Pentru V3 se setează isV3:true ca scanner.isV3Venue() să recunoască clona.
 */
function cloneVenueSkeleton(v) {
  const base = { kind: v.kind };
  if (v.kind === "v2") {
    return {
      ...base,
      pair: v.pair,
      router: v.router,
      tokenA: v.tokenA,
      tokenB: v.tokenB,
      feeBps: v.feeBps,
      feeN: v.feeN,
      feeD: v.feeD,
    };
  }
  if (v.kind === "v3") {
    return {
      ...base,
      pool: v.pool,
      feeTier: v.feeTier,
      tokenA: v.tokenA,
      tokenB: v.tokenB,
      name: v.name,
      isV3: true,
    };
  }
  if (v.kind === "dodo") {
    return {
      ...base,
      pool: v.pool,
      baseToken: v.baseToken,
      quoteToken: v.quoteToken,
      factoryId: v.factoryId,
    };
  }
  return { ...base };
}

/**
 * Citește starea FRESH pe lanț pentru un venue (clone de skeleton + re-citire
 * la blockTag). Folosește scanner.readState / enrichV3Venues — fără a duplica
 * ABI/RPC logic. Returnează un obiect CLONE (opportunity-ul NU este atins).
 */
async function readFreshVenueState(provider, v, blockTag) {
  const clone = cloneVenueSkeleton(v);

  if (v.kind === "v2") {
    // Rezervele se citesc prin scanner.readState (Multicall3 getReserves).
    const stats = await scanner.readState(provider, [clone], { blockTag });
    if (stats.ok < 1) return null; // pair dead / read failed
    return clone;
  }

  if (v.kind === "v3") {
    // V3 superficial (slot0 + liquidity) + deep state (tickBitmap, ticks).
    await scanner.readState(provider, [clone], { blockTag });
    await scanner.enrichV3Venues(provider, [clone], { blockTag, words: 3 });
    return clone;
  }

  if (v.kind === "dodo") {
    // DODO PMM state: baseToken, quoteToken, reserves, pmm, fees.
    await scanner.readState(provider, [clone], { blockTag });
    return clone;
  }

  return null; // tip necunoscut
}

/**
 * Validează starea FRESH pe lanț pentru toate venue-urile din oportunitate.
 *
 * Flux:
 *   1. Obține freshBlockNumber + freshBlock (hash obligatoriu).
 *   2. Pentru fiecare venue (buyVen + sellVen): citește starea REALĂ la
 *      blockTag = freshBlockNumber, construiește fingerprint-ul și compară
 *      cu opp.stateFingerprint[venueKey].
 *   3. Orice diferență => REJECT (stale-state).
 *
 * @param {object} opp          Oportunitatea (cu opp.snapshot + opp.stateFingerprint)
 * @param {object} provider     ethers.Provider
 * @returns {Promise<{ok:boolean, reason?:string, details?:object}>}
 */
async function freshOnChainStateValidation(opp, provider) {
  if (!opp || typeof opp !== "object") {
    return { ok: false, reason: "invalid-opp" };
  }

  // Snapshot identity obligatorie.
  const snap = opp.snapshot;
  if (!snap || snap.blockNumber == null) {
    return { ok: false, reason: "missing-snapshot" };
  }

  // Fresh block.
  let freshBlockNumber;
  let freshBlock;
  try {
    freshBlockNumber = await provider.getBlockNumber();
    freshBlock = await provider.getBlock(freshBlockNumber);
  } catch (e) {
    return { ok: false, reason: "block-read-failed", details: e.message };
  }

  // blockHash obligatoriu (§9).
  if (!freshBlock || !freshBlock.hash) {
    return { ok: false, reason: "block-hash-unavailable" };
  }

  // Venue-uri de validat.
  const venues = [];
  if (opp.buyVen) venues.push(opp.buyVen);
  if (opp.sellVen) venues.push(opp.sellVen);

  if (venues.length === 0) {
    return { ok: false, reason: "no-venues" };
  }

  // Fingerprint-ul oportunității trebuie să existe.
  const oppFp = opp.stateFingerprint;
  if (!oppFp || typeof oppFp !== "object") {
    return { ok: false, reason: "missing-fingerprint" };
  }

  for (const v of venues) {
    const key = snapshotMod.venueKey(v);

    // Venue identity: cheia trebuie să existe în fingerprint.
    if (!(key in oppFp)) {
      return { ok: false, reason: "venue-not-fingerprinted", details: { key } };
    }

    // Citește starea FRESH pe lanț.
    let freshVenue;
    try {
      freshVenue = await readFreshVenueState(provider, v, freshBlockNumber);
    } catch (e) {
      return { ok: false, reason: "fresh-read-failed", details: { key, error: e.message } };
    }

    if (!freshVenue) {
      return { ok: false, reason: "fresh-venue-unreadable", details: { key } };
    }

    // Calculează fingerprint-ul fresh.
    const freshFp = snapshotMod.venueFingerprint(freshVenue);
    if (!freshFp) {
      return { ok: false, reason: "fresh-fingerprint-failed", details: { key } };
    }

    // Compară cu fingerprint-ul oportunității.
    if (freshFp !== oppFp[key]) {
      return { ok: false, reason: "stale-state", details: { key, expected: oppFp[key], actual: freshFp } };
    }
  }

  // Toate venue-urile au fingerprint-ul identic.
  return {
    ok: true,
    freshBlockNumber,
    freshBlockHash: freshBlock.hash,
    venuesChecked: venues.length,
  };
}

module.exports = {
  freshOnChainStateValidation,
  readFreshVenueState,
  cloneVenueSkeleton,
};

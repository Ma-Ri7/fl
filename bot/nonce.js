// FLASH — NonceManager (audit item 7, PHASE 11).
// Rezervă nonce-uri tranzacțiilor în zbor, împiedică double-submit cu același
// nonce și reapr nonce-urile blocate (tx never mind / dropped).
class NonceManager {
  /**
   * @param {ethers.Wallet} wallet
   * @param {number} maxPending — plafon de tx-uri simultane (audit: maxNonceGap)
   */
  constructor(wallet, maxPending = 5) {
    this.wallet = wallet;
    this.maxPending = maxPending;
    this.next = null;          // următorul nonce liber (local)
    this.pending = new Map();  // nonce -> txHash
    this.lastSync = 0;
  }

  /** Resincronizează contorul local cu nonce-ul 'pending' on-chain. */
  async init(force = false) {
    if (this.next === null || force) {
      this.next = await this.wallet.getNonce("pending");
      this.lastSync = Date.now();
    }
    return this.next;
  }

  /**
   * Rezervă un nonce. Returnează null dacă sunt prea multe tx-uri în zbor
   * (evită blocajul nonce-gap).
   */
  async reserve() {
    if (this.next === null) await this.init();
    if (this.pending.size >= this.maxPending) return null;
    const nonce = this.next;
    this.next += 1;
    return nonce;
  }

  /** Tranzacția a fost transmisă cu acest nonce — îl marcăm pending.
   *  hash poate fi null (submisie privată UNKNOWN — tombstone până la reap). */
  commit(nonce, hash) {
    this.pending.set(nonce, { hash: hash || null, ts: Date.now() });
  }

  /**
   * Eliberează un nonce nefolosit. Reutilizează doar dacă nu există
   * tranzacții mai noi în zbor (altfel lăsăm un gap, rezolvat la resync).
   */
  rollback(nonce) {
    if (this.pending.size === 0 && this.next === nonce + 1) {
      this.next = nonce;
    }
  }

  /**
   * Reap: verifică pending-urile; cele confirmate sau dispărute se șterg.
   * Se apelează la fiecare ciclu de scan.
   * @returns {Promise<number>} numărul de tx-uri în continuare pending
   */
  async reap(provider) {
    for (const [nonce, entry] of [...this.pending.entries()]) {
      const hash = entry && typeof entry === "object" ? entry.hash : entry;
      const ts = entry && typeof entry === "object" ? entry.ts : 0;
      if (hash === null || hash === undefined) {
        // tombstone: submisie privată UNKNOWN — slot rămâne blocat 90s ca să
        // nu reutilizăm nonce-ul în timp ce tx-ul poate încă fi inclus.
        if (Date.now() - ts > 90000) this.pending.delete(nonce);
        continue;
      }
      try {
        const receipt = await provider.getTransactionReceipt(hash);
        if (receipt) {
          this.pending.delete(nonce);
          continue;
        }
        const tx = await provider.getTransaction(hash);
        if (!tx) {
          // nu mai există în mempool → dispărută; eliberăm
          this.pending.delete(nonce);
        }
      } catch (_) {
        /* RPC error — reîncercăm la următorul reap */
      }
    }
    // resync periodic ca să ne protejăm de gaps persistente
    if (this.pending.size === 0 || Date.now() - this.lastSync > 60000) {
      try {
        const onchain = await this.wallet.getNonce("pending");
        if (this.pending.size === 0 || onchain !== this.next) {
          if (onchain >= this.next || this.pending.size === 0) this.next = onchain;
          this.lastSync = Date.now();
        }
      } catch (_) { /* ignore */ }
    }
    return this.pending.size;
  }
}

module.exports = { NonceManager };

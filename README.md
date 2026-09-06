# FLASH — Bot de Flashloan Arbitraj pe BSC (BNB Chain)

Bot automat care monitorizează token-uri (cu focus pe cele **mai puțin urmărite**)
pe mai multe DEX-uri de pe BNB Chain și, când detectează o oportunitate de arbitraj,
execută **flashloan-uri** (PancakeSwap V2 FlashSwap sau DODO) într-o singură tranzacție atomică.


> ⚠️ **Avertisment sincer**: arbitrajul pe BSC este extrem de competitiv. Acest proiect
> este o infrastructură educațională și funcțională, dar **nu garantează profit**.
> Nu investi fonduri pe care nu ești dispus să le pierzi. Citește `TUTORIAL.md`.


## Maturity levels

| Component | Level |
|---|---|
| Contract security (auth, reentrancy, validation) | FORK VERIFIED |
| Pancake V2 flashswap + V3 swap | FORK VERIFIED |
| DODO PMM math engine (JS) | PASS (Test A — parity JS vs EVM) |
| DODO protocol mock flow | PASS (Test B — DODODVMMock) |
| REAL DODO V2 fork flow | ✅ PASS (Test C — real pool, 70 USDT profit, 0.5% LP fee) |
| V3 multi-tick quote engine (words + ticks + liquidityNet) | FORK VERIFIED (20/20 paritate vs QuoterV2, dev. 0 bps) |
| Block snapshot consistency | FORK VERIFIED (validateSnapshot — reject la bloc inconsistent) |
| Nonce manager (unul per proces/wallet, DI) | IMPLEMENTED |
| TX tracker + realized P&L (submit → tracker → receipt → P&L) | IMPLEMENTED |
| Large-profit verification (fără gate isPlausible >2%) | IMPLEMENTED (needsVerification → staticCall) |
| Final requote + eth_call | IMPLEMENTED |
| Size optimizer | PENDING |
| Cost/economics engine (exact gas) | IMPLEMENTED |
| Opportunity ranking | PENDING |
| Shadow mode | IMPLEMENTED |
| Paper execution | PENDING |
| Micro-live | PENDING |
| 24/7 production | PENDING |


## Status TASK 4.3–4.6 (2026-05)

- **4.3 Snapshot integration** — `takeSnapshot()` înainte de fiecare scanare; toate citirile
  (`readState`) folosesc același `blockTag`; fiecare venue primește stampila `blockNumber`,
  iar `validateSnapshot()` **reject-ează** orice oportunitate al cărei venue nu are exact
  `snapshot.blockNumber` (nu se execută niciodată pe date inconsistente).
- **4.4 V3 integration** — scannerul citește acum starea V3 profundă prin Multicall3:
  `slot0` (sqrtPriceX96/tick/liquidity), `tickSpacing`, `tickBitmap` words în jurul
  tick-ului curent și tick-urile inițializate cu `liquidityNet`; rezultatul alimentează
  `lib/v3.getAmountOutV3Exact()`. Paritate verificată pe fork BSC vs `QuoterV2`
  (`test/integration/v3-quoter-parity.js`): **20/20 cazuri, ambele direcții, deviație 0 bps**.
- **4.5 Nonce + Tracker** — exact **un** `NonceManager` și **un** Tracker per proces/wallet
  (injectați în `index.js`/`executor.js` — dependency injection). Flux: `submit` →
  `tracker` → `receipt` → **realized P&L** (profit real din evenimente, nu estimare).
- **4.6 isPlausible eliminat** — profiturile mari (>2%) **nu mai sunt eliminate** înainte de
  Size Optimizer. Sunt marcate `needsVerification=true` și **verificate** prin
  `eth_call` (staticCall) înainte de execuție; doar verificarea reală decide.

## Arhitectură

```
┌────────────────────────── Mac Mini (24/7) ──────────────────────────┐
│  bot/                                                               │
│   • scanner.js  – descoperă venue-uri (V2/V3/DODO) + citește stări  │
│   • profit.js   – calculează profit net (fee + gas + slippage)      │
│   • executor.js – simulează (eth_call) + transmite tranzacția       │
│   • index.js    – bucla principală de monitorizare                  │
│   • sweeper.js  – verifică soldul BNB                               │
└───────────────┬─────────────────────────────────────────────────────┘
                │  semnare tranzacție (doar BNB pt gas)
                ▼
┌────────────── On-chain: FlashLoanArbitrage.sol ─────────────────────┐
│  1. ia flashloan de pe PancakeSwap V2 (0.25%) SAU DODO (fee 0*)   │
│  2. swap pe DEX A (V2 router sau V3 pool sau DODO pool)             │
│  3. swap pe DEX B (V2 router sau V3 pool sau DODO pool)             │
│  4. rambursează flashloan-ul + fee                                   │
│  5. trimite profitul automat la wallet-ul owner                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Componente

| Fișier | Rol |
|---|---|
| `contracts/FlashLoanArbitrage.sol` | Contractul on-chain (flashloan + 2 swap-uri + repay) |
| `bot/config.js` | DEX-uri, token-uri, parametri bot |
| `bot/scanner.js` | Descoperă perechi live + citește rezerve (Multicall3) |
| `bot/profit.js` | Estimare profit net (constant-product, slippage real) |
| `bot/executor.js` | Simulare `eth_call` + broadcast + nonce management |
| `bot/sweeper.js` | Verifică soldul de BNB |
| `lib/amm.js` | Matematică AMM partajată |
| `launchd/` | Serviciu macOS 24/7 (`start/stop/status`) |
| `scripts/deploy.js` | Deploy pe BSC |
| `scripts/smoke.js` | Test read-only pe rețeaua reală |
| `scripts/fork-dodo-flash.js` | Test DODO real flashloan + arbitraj pe fork BSC |
| `test/` | Teste unitare (MockDEX) + test fork BSC |

## DEX-uri & token-uri default

### Venue-uri (3 tipuri, verificate on-chain)

| Tip | Protocoale | Fee swap | Flashloan fee |
|---|---|---|---|
| **V2 AMM** (6) | PancakeSwap V2, BiSwap, SushiSwap, ApeSwap, BabySwap, FstSwap | 0.1–0.3% | 0.25% (PancakeSwap V2) |
| **V3 CLM** (1) | PancakeSwap V3 (4 fee tiers: 0.01%, 0.05%, 0.25%, 1%) | dinamic | — (picior de swap) |
| **DODO PMM** (3) | DVMFactory, DSPFactory, DPPFactory | ~0.2% | **fee 0\*** |

- **Venue-uri**: 6 DEX-uri V2 + 1 V3 + 3 DODO factory-uri (descoperite on-chain, la pornire).
- **Token-uri**: WBNB, USDT, BUSD, USDC, BTCB, ETH, CAKE + **less-tracked**:
  ACH, ALICE, ALPACA, ALPHA, AITECH, HIGH, HOOK, HFT, HOO, HOTCROSS, HTD
  (adrese din lista oficială PancakeSwap extended; bot-ul le verifică on-chain)
- **Coverage**: ~60+ perechi arbitraj-gata (cu ≥2 venue-uri vii), scanate pe fiecare block.
  Bot-ul arbitrează orice pereche (bază × quote) pe care cel puțin 2 DEX-uri o au — indiferent de tip (V2↔V2, V2↔V3, V2↔DODO, etc.).

> \* DODO flashloan are fee zero doar dacă pool-ul revine la starea inițială. DODO
> PMM este modelat complet (i, K, B, Q, R state, LP fee, maintainer fee) — nu printr-un
> `DODO_SWAP_FEE_BPS` constant.

## Pornire rapidă

```bash
# 1. instalare
npm install

# 2. configurare
cp .env.example .env
#   - completeaza BSC_RPC_URL, PRIVATE_KEY (wallet dedicat cu BNB), CONTRACT_ADDRESS dupa deploy

# 3. test (fara costuri)
npm run compile
npm test
node scripts/smoke.js          # test read-only pe BSC real

# 4. deploy contract pe BSC
npm run deploy

# 5. pornire bot (manual)
npm run bot

# 6. pornire ca serviciu 24/7 (launchd)
npm run start
npm run status
```

Vezi ghidul detaliat pas-cu-pas: **`TUTORIAL.md`**.

## Comenzi utile

| Comandă | Descriere |
|---|---|
| `npm run compile` | Compilează contractele |
| `npm test` | Teste unitare (MockDEX, MockV3Pool, access control, validation) |
| `npm run test:fork` | Test A — DODO PMM parity (JS vs EVM, necessită RPC cu arhivă) |
| `npm run test:dodo-mock` | Test B — DODO protocol mock flow (DODODVMMock) |
| `npm run test:dodo-fork` | Test C — REAL DODO V2 fork flow (✅ PASS — real pool, ~70 USDT profit) |
| `npm run test:v3-parity` | TASK 4.4 — V3 quote local (words+ticks) vs QuoterV2 pe fork BSC (20/20, 0 bps) |
| `npm run deploy` | Deploy pe BSC + scrie `CONTRACT_ADDRESS` în `.env` |
| `npm run smoke` | Smoke test read-only pe rețeaua reală |
| `npm run discover -- <router>` | Descoperă factory-ul + perechile unui DEX nou pe lanț |
| `npm run bot` | Rulează bot-ul în foreground |
| `npm run sweep` | Arată soldul BNB |
| `npm run start` | Instalează și pornește serviciul launchd |
| `npm run stop` | Oprește serviciul launchd |
| `npm run status` | Status + ultimele log-uri |

## Optimizări avansate (recomandat)

### RPC privat — Ankr ($49/lună)

Fără RPC privat bot-ul scannează cu întârziere (rate-limit pe cel public).

1. [https://www.ankr.com/rpc/](https://www.ankr.com/rpc/) → cont gratuit → Create API Key → BNB Chain
2. În `.env`:
   ```env
   BSC_RPC_URL=https://rpc.ankr.com/bsc/<API_KEY>
   ```
   WebSocket-ul se derivează automat pentru notificări în timp real.

### Private mempool — BloXroute ($99/lună)

Tranzacțiile publice sunt vizibile în mempool — bot-urile MEV le pot frontrun. BloXroute trimite direct la validatori.

1. [https://portal.bloxroute.com](https://portal.bloxroute.com) → cont → Subscriptions → BNB Chain Bundle Submit
2. În `.env`:
   ```env
   BLOXROUTE_API_TOKEN=<token>
   BLOXROUTE_PRIVATE_RPC=wss://api.bloxroute.com/ws
   ```
   Bot-ul trimite prin BloXroute automat când este configurat; fallback la mempool public dacă eșuează.

## Configurare cheie (bot/config.js)

| Parametru | Default | Ce face |
|---|---|---|
| `pollIntervalMs` | 2000 | Frecvența scanării (BSC ~3s/block) |
| `defaultFlashAmount` | 1M USDT | Plafon împrumut flashloan |
| `maxPerPairBorrowBps` | 200 (2%) | Niciodată peste 2% din rezerva perechii |
| `minProfitBnb` | 0.01 | Prag minim profit net înainte de broadcast |
| `slippageBps` | 100 (1%) | Buffer de slippage la `minReturn` |
| `gasMultiplier` | 1.15 | Multiplicator gas pret |

## Log-uri

- `logs/bot.out.log` — evenimente normale
- `logs/bot.err.log` — warnings / erori
- `npm run status` afișează ultimele 20 linii din fiecare

## Securitate

- **Pastrează `.env` privat** (conține cheia privată). Nu-l comite niciodată.
- Folosește un **wallet dedicat** actualizat doar cu BNB pentru gas.
- Contractul nu reține fonduri: profitul e trimis automat la owner după fiecare execuție.
- Doar owner-ul poate apela `flashArbitrage` și `rescueToken`.

Vezi `TUTORIAL.md` pentru ghidul complet de utilizare pas cu pas.
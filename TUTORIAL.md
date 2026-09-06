# TUTORIAL — Ghid pas cu pas: Bot Flashloan Arbitraj pe BSC

Acest ghid îți arată cum să instalezi, configurezi, testezi și rulezi **24/7** bot-ul
FLASH de flashloan arbitraj pe BNB Chain (BSC), pe un Mac Mini M4.

---

## Cuprins

1. [Ce face bot-ul și riscurile](#1-ce-face-bot-ul-și-riscurile)
2. [Cerințe de sistem](#2-cerințe-de-sistem)
3. [Pasul 0 — Wallet dedicat și BNB](#pasul-0--wallet-dedicat-și-bnb)
4. [Pasul 1 — RPC BSC (recomandat privat)](#pasul-1--rpc-bsc)
5. [Pasul 2 — Instalare proiect](#pasul-2--instalare-proiect)
6. [Pasul 3 — Configurare .env](#pasul-3--configurare-env)
7. [Pasul 4 — Compilare și teste](#pasul-4--compilare-și-teste)
8. [Pasul 5 — Deploy contract pe BSC](#pasul-5--deploy-contract-pe-bsc)
9. [Pasul 6 — Smoke test pe rețeaua reală](#pasul-6--smoke-test-pe-rețeaua-reală)
10. [Pasul 7 — Pornire bot (manual)](#pasul-7--pornire-bot-manual)
11. [Pasul 8 — Rulare 24/7 cu launchd](#pasul-8--rulare-247-cu-launchd)
12. [Pasul 9 — Monitorizare log-uri](#pasul-9--monitorizare-log-uri)
13. [Pasul 10 — Întreținere, extindere, FAQ](#pasul-10--întreținere-extindere-faq)

---

## 1. Ce face bot-ul și riscurile

Bot-ul citește rezervele (lichiditatea) fiecărei perechi de token pe **mai multe DEX-uri**
de pe BSC, folosind un singur apel `aggregate3` la **Multicall3** (rapid, ieftin). Când
prețul unui token diferă între DEX-uri suficient cât să acopere toate costurile, bot-ul:

1. Declanșează **flashloan** de pe o pereche PancakeSwap V2 (împrumut fără garanție,
   de returnat în aceeași tranzacție, cu fee ~0.25%) **SAU DODO (fee 0* — vezi nota)**;
2. Swap pe DEX A (V2 router, V3 pool, sau DODO pool) — token ieftin;
3. Swap pe DEX B (V2 router, V3 pool, sau DODO pool) — token scump;
4. Rambursează împrumutul și **trimite profitul automat** în wallet-ul tău.

> \* **DODO flashloan fee**: DODO nu percepe un fee explicit. Costul real vine din
> mecanismul de equalizare al pool-ului PMM. Dacă contractul returnează exact activele
> împrumutate și pool-ul revine la starea inițială, costul net este zero. Această
> proprietate trebuie validată pe fork pentru fiecare pool DODO în parte — nu e un
> adevăr universal. Matematica PMM completă (i, K, B, Q, R state, LP fee, maintainer
> fee) este implementată în `lib/dodo.js` și testată prin paritate JS↔EVM.

**Riscuri reale:**
- **Competiția**: pe BSC există bot-uri profesionale cu servere în colocation și
  abonamente private mempool (bloXroute / 48Club). Multe oportunități sunt prinse
  în milisecunde.
- **Token-urile mici** (mid/low-cap) au lichiditate mică: o tranzacție prea mare mută
  prețul împotriva ta. De aceea bot-ul **limitează împrumutul la 2% din rezervă**.
- **Token-uri toxice** (fee la transfer, honeypot, blacklist): bot-ul **simulează
  fiecare tranzacție cu `eth_call`** înainte de broadcast — dacă simularea eșuează
  sau profitul nu e real, tranzacția nu pleacă.
- **Atenție la scheme**: nu există "bot MEV gata de cumpărat" care să meargă. Codul
  din acest proiect este al tău, verificabil și extensibil.

**Cât costă să rulezi:** doar **BNB pentru gas** (începe cu 0.05–0.5 BNB) și, opțional,
un abonament RPC privat. Flashloan-ul nu necesită capital propriu în pereche.

---

## 2. Cerințe de sistem

- **macOS** pe Mac Mini M4 (sau orice Mac cu Node.js).
- **Node.js ≥ 18** (recomandat LTS). Verifică: `node -v` și `npm -v`.
  Dacă nu e instalat: descarcă de pe [nodejs.org](https://nodejs.org) (LTS) sau:
  ```bash
  brew install node
  ```
- **Git** (opțional, pentru versionare): `git --version`
- **~200 MB** spațiu pe disc (node_modules + artifacts).

> 💡 Dacă folosești un **Mac Mini ca server**, recomand să îl lași mereu conectat
> la rețea și setat să nu doarmă: `System Settings → Battery/Power → Prevent sleeping`.

---

## Pasul 0 — Wallet dedicat și BNB

1. Instalează o extensie de wallet (ex. MetaMask) sau folosește un portofel hardware.
2. **Creează un wallet NOU, dedicat DOAR pentru acest bot.**
   Nu folosi niciodată wallet-ul tău principal.
3. Scrie seed phrase-ul pe hârtie și păstrează-l în siguranță.
4. Trimite **BNB** pe adresa acestui wallet (de pe un exchange). Începe cu
   **0.1–0.5 BNB**. Din acești bani se plătesc:
   - deploy-ul contractului (o singură dată)
   - gas-ul tranzacțiilor arbitraj (per execuție ~sub 0.01 BNB)
5. Copiază **private key**-ul (hex, `0x` + 64 caractere). Îl vei pune în `.env`
   la Pasul 3. **Nu-l arăta nimănui și nu-l commit-tui în Git.**

> Sfat: poți genera o cheie nouă și din terminal:
> ```bash
> node -e "const {Wallet}=require('ethers');const w=Wallet.createRandom();console.log('address:',w.address);console.log('key:',w.privateKey);"
> ```
---

## Pasul 1 — RPC BSC

**Ce e un RPC?** Este adresa (URL) prin care bot-ul vorbește cu lanțul BSC.

**Recomandare: RPC privat** (mai rapid, fără limite stricte):
- [Ankr](https://www.ankr.com/rpc/bsc/) — gratuit pentru volum mic (necesită cont)
- [QuickNode](https://www.quicknode.com/endpoints/bsc) — trial gratuit
- [Chainstack](https://www.chainstack.com/) — trial
- **Pentru fork/teste cu arhivă**: un RPC cu *archive data* (ex. QuickNode cu arhivă
  sau Ankr Advanced). RPC-urile publice **nu** au arhivă → testele de fork dau
  `missing trie node`.

**RPC-uri publice (pentru început / smoke test):**
- `https://bsc-dataseed1.binance.org`
- `https://bsc-dataseed2.binance.org`
- `https://1rpc.io/bnb`
- `https://bsc-rpc.publicnode.com`

Pune URL-ul ales în `.env` (Pasul 3) ca `BSC_RPC_URL`.

> 💡 **Pentru a prinde oportunități în concurență, trei lucruri sunt critice:**
> 1. **RPC privat** pentru latență sub 100ms și WebSocket (blocuri în timp real) — vezi Ankr mai sus.
> 2. **RPC-ul trebuie să aibă `eth_getProof` dacă rulezi teste pe fork** (pentru archive); pentru botul live HTTP e de ajuns.
> 3. **Tranzacții private (private mempool)** ca să nu te frontruneze.

### Tranzacții private prin bloXroute (elimină frontrunning-ul)

**De ce e util:** când trimiți o tranzacție normală, ajunge în *mempool*-ul public. Alți bot-uri o văd și trimit o tx mai agresivă — tu o pierzi. Trimitând prin **bloXroute bundles**, tranzacția merge direct către validatori și NU apare în mempool.

#### Pas cu pas:

**Pas 1 — Cont + abonament**
1. Mergi la [https://portal.bloxroute.com](https://portal.bloxroute.com) și creezi un cont.
2. În dashboard → **Subscriptions** → caută **BNB Chain Bundle Submit** și pornește o
   proveedură (cel mai mic plan care include bundle submit; există și plan gratuit
   cu limită redusă).
3. În **API Keys** → copiază `Authorization` token (îl folosești ca `BLOXROUTE_API_TOKEN`).

**Pas 2 — WebSocket**
Bot-ul are nevoie de un WebSocket pentru bloXroute. Dacă ai cont dezvoltat:
```
BLOXROUTE_PRIVATE_RPC=wss://api.bloxroute.com/ws
```

**Pas 3 — Configurare `.env`**
```env
BSC_RPC_URL=https://rpc.ankr.com/bsc/<cheia_ta_Ankr>
BLOXROUTE_API_TOKEN=<cheia_bloXroute_din_dashboard>
BLOXROUTE_PRIVATE_RPC=wss://api.bloxroute.com/ws
```

**Pas 4 — Cum funcționează**
Când pornesti bot-ul cu `BLOXROUTE_API_TOKEN` setat, `executor.js`:
1. Încearcă să trimită tranzacția prin **BloXroute bundle** (privat, direct la validatori).
2. Dacă BloXroute eșuează (timeout, limită depășită), **face fallback automat** la
   trimitere normală în mempool public — nicio oportunitate nu se pierde din cauza unui
   serviciu extern.

În log-uri vei vedea:
```
TX OK 2025-01-15T10:30:00Z pool=BUSD-USDT buy=BTCB sell=ALPHA borrow=49500 BUSD
 profit=0.023 BNB private=true hash=0x...
```
(`private=true` înseamnă că a fost trimisă prin BloXroute și **nu a fost frontrunată**.)

---

## Pasul 2 — Instalare proiect

```bash
cd ~/Desktop/FLASH      # sau folderul ales
npm install
npm run compile         # compilează contractele Solidity
```

Dacă `npm run compile` dă eroare de **compiler download** (necesită internet),
rulează din nou — se descarcă o singură dată compilatorul 0.8.24.

> Dacă e prima dată când rulezi npm în acest folder și primești un warning
> `allow-scripts`, e normal; apasă pe opțiunea de aprobare a scripturilor
> pentru `keccak` / `secp256k1` (sunt necesare pachetelor criptografice).

---

## Pasul 3 — Configurare .env

```bash
cd ~/Desktop/FLASH
cp .env.example .env
```

Apoi deschide `.env` și completează:

```ini
BSC_RPC_URL=https://bsc-dataseed1.binance.org      # sau RPC-ul tău privat
PRIVATE_KEY=0x...                                   # cheia privată a wallet-ului dedicat
# CONTRACT_ADDRESS se completează automat după deploy (Pasul 5)
BSCSCAN_API_KEY=                                     # opțional, pt verificare contract
```

**Verificări obligatorii:**
- `PRIVATE_KEY` trebuie să înceapă cu `0x` și să aibă 64 caractere hex după.
- `.env` este deja în `.gitignore` → nu va fi urcat pe Git.

> ⚠️ Dacă ai pus vreodată cheia privată într-un fișier care ajunge public,
> **migrează fondurile** pe un alt wallet. O cheie scursă = fonduri pierdute.

---

## Pasul 4 — Compilare și teste

```bash
npm run compile      # compilează contractele
npm test             # teste unitare (MockDEX) - nu costă nimic
```

Testele unitare verifică:
- arbitraj profitabil cu flashloan → owner-ul primește profitul;
- arbitraj neprofitabil → tranzacția e respinsă (protecție on-chain);
- doar owner-ul poate apela contractul / rescue.

> **Teste de integrare (opționale, pe fork BSC — necesită `BSC_RPC_URL` în `.env`):**
> ```bash
> npm run test:v3-parity    # motorul V3 local (words+ticks) vs QuoterV2 — paritate 20/20, 0 bps
> npm run test:dodo-fork    # flow REAL DODO V2 pe fork — flashloan + profit real
> ```
> Prima oară pot dura 1–2 minute (fork + Multicall3). Sunt dovada că matematica
> off-chain a bot-ului (quote V3, DODO PMM) corespunde cu contractele reale on-chain.

Exemplu ieșire așteptată:
```
FlashLoanArbitrage (mock DEX)
  ✔ executes a profitable flashloan arbitrage and pays the owner
  ✔ reverts when the arbitrage is not profitable
  ✔ rejects callers that are not the owner
  ✔ only the owner can rescue token dust
```
---

## Pasul 5 — Deploy contract pe BSC

Bot-ul are nevoie de contractul `FlashLoanArbitrage` deployat pe BSC. Deploy-ul
costă o singură dată (BNB gas).

```bash
# verifică mai întâi că .env are BSC_RPC_URL și PRIVATE_KEY setate corect
node -e "require('dotenv').config(); const {ethers}=require('ethers'); console.log('wallet:', new ethers.Wallet(process.env.PRIVATE_KEY).address)"

npm run deploy
```

Exemplu ieșire:
```
Deploying from 0x... 
Balance: 0.23 BNB
Deployed FlashLoanArbitrage at: 0x...
Deploy tx: https://bscscan.com/tx/...
Updated CONTRACT_ADDRESS in .env
```

După deploy:
- `CONTRACT_ADDRESS` a fost scris automat în `.env`;
- poți **verifica sursa contractului** pe BscScan (opțional), cu:
  ```bash
  npx hardhat verify --network bsc <CONTRACT_ADDRESS>
  ```
- Verifică adresa contractului pe [bscscan.com](https://bscscan.com) → trebuie să
  apară numele `FlashLoanArbitrage`.

> ⚠️ Păstrează cheia privată a wallet-ului cu care ai făcut deploy: acel wallet este
> **owner-ul** contractului. Doar el poate trigger-ui arbitrajul (bot-ul folosește
> aceeași cheie din `.env`) și doar el poate face rescue.

---

## Pasul 6 — Smoke test pe rețeaua reală

Acest test este **read-only** (nu trimite tranzacții, nu costă nimic). Verifică că
bot-ul se conectează la BSC, găsește perechi live și calculează spread-uri.

```bash
node scripts/smoke.js
```

Exemplu ieșire (real, cu date live):
```
Connecting to https://bsc-dataseed1.binance.org ...
Connected. Latest block: 119550422
Live pairs found: 56
  PancakeSwap V2  0x16b9...
  BiSwap          0x8840...
  SushiSwap       0x2905...
  ApeSwap         0x83C5...
  BabySwap        0x0458...
  FstSwap         0x7796...
Reserves read: 56
Spread CAKE: buy=BiSwap sell=PancakeSwap V2 netProfit=0.0000 USDT
Spread ALPACA: buy=BiSwap sell=PancakeSwap V2 netProfit=0.0000 USDT
Spread HOTCROSS: buy=BabySwap sell=PancakeSwap V2 netProfit=0.0000 USDT
...
Detected 5 exploitable spread(s).
```

Dacă vezi `No exploitable spread right now (normal).` — e **perfect normal**: spread-urile
profitabile apar și dispar în secunde în piața reală. Bot-ul rulează continuu tocmai
pentru a le prinde.

---

## Pasul 7 — Pornire bot (manual)

Odată configurat și deployat, pornește bot-ul în **foreground** (vrei să vezi log-urile
întâi):

```bash
npm run bot
```

Log-uri utile la pornire:
```
Starting FLASH bot on BSC
Wallet    : 0x...
Contract  : 0x...
BNB balance: 0.2300 BNB
Live pairs: 56
```

Bot-ul scanează la fiecare ~2s. Când găsește o oportunitate peste pragul `minProfitBnb`:
1. **Simulează** tranzacția (`SIM ...` — `eth_call`, fără cost);
2. Dacă simularea confirmă profitul → **broadcast** și așteaptă confirmare.

Pentru a opri: `Ctrl+C`.

> 💡 Rulează prima dată în foreground câteva minute, urmărește log-urile, apoi treci
> la serviciul 24/7 (Pasul 8).
---

## Pasul 8 — Rulare 24/7 cu launchd

Pachetul `launchd/` transformă bot-ul într-un serviciu macOS care:
- pornește automat la logare (și după reboot);
- repornește automat dacă bot-ul crapă (KeepAlive);
- scrie log-uri în `logs/`.

**Pornește serviciul:**
```bash
npm run start
# sau, direct: launchd/start.sh
```

**Verifică statusul:**
```bash
npm run status
# → arată PID-ul procesului activ + ultimele 20 linii din log
```

**Oprește serviciul:**
```bash
npm run stop
```

**Cum funcționează intern (pentru curioși):**
- `launchd/start.sh` copiază `com.flash.bot.plist` în `~/Library/LaunchAgents` și
  îl încarcă cu `launchctl`.
- `com.flash.bot.plist` conține `RunAtLoad=true` și `KeepAlive` (restart la crash,
  cu pauză de 10s).
- Dacă vrei să pornească și mai repede după boot, poți ajusta `ThrottleInterval`.

**Dezinstalare serviciu (fără a șterge codul):**
```bash
npm run stop
```

> 💡 Dacă Mac-ul e folosit drept server, activează *auto-login* pentru un utilizator
> (System Settings → Users & Groups → Auto Login) ca serviciul să pornească direct
> după reboot fără să introduci parola.

---

## Pasul 9 — Monitorizare log-uri

**În timp real** (în alt terminal):
```bash
tail -f logs/bot.out.log
tail -f logs/bot.err.log      # warnings/erori
```

**Căutare rapidă** de execuții reușite:
```bash
grep "TRADE OK" logs/bot.out.log
```

**Căutare erori frecvente:**
```bash
grep -E "ERROR|broadcast failed" logs/bot.err.log
```

**Ce înseamnă mesajele cheie:**
| Mesaj | Ce înseamnă |
|---|---|
| `Live pairs: 56` | Bot-ul monitorizează 56 de perechi (tokenurile din config care există pe ≥2 DEX) |
| `OPPORTUNITY CAKE: buy=... sell=...` | Spread detectat peste prag — bot-ul încearcă simularea |
| `SIM OK ...` | Simularea (eth_call) a confirmat profitul real |
| `TX CAKE buy=... sell=...` | Tranzacție transmisă pe lanț |
| `TRADE OK CAKE tx=0x...` | Tranzacție confirmată — profit trimis la wallet |
| `No exploitable spread` | Piața e eficientă momentan (normal) |

---

## Pasul 10 — Întreținere, extindere, FAQ

### Cum adaug token-uri noi?
Editează `bot/config.js` → lista `TOKENS`. Adaugă:
```js
const NOUL_TOKEN = A("0x...adresa_lowercase");
// ...
NOUL_TOKEN: { address: NOUL_TOKEN, decimals: 18 },
```
Pornește bot-ul din nou. Token-ul va fi scanat dacă are perechi pe DEX-urile
configurate.

### Cum adaug un DEX nou?
Folosește `scripts/discover-dex.js` — primește adresa routerului și descoperă automat
factory-ul + perechile live:
```bash
node scripts/discover-dex.js 0x<routerAddress>
# exemplu de ieșire:
# Router : 0x3a6d8ca...
# Factory: 0x858e3312...
#   USDT-WBNB      pair=0x8840...
#   USDT-CAKE      pair=0x5032...
```
Dacă perechile arată bine, adaugă DEX-ul în `config.js` → `DEXES`:
```js
{
  id: "nouldex",
  name: "Noul DEX",
  factory: A("0x..."),
  router: A("0x..."),
  feeBps: 25,      // comisionul de swap în bază de puncte (0.25% => 25)
  verified: true,
}
```
Apoi `node scripts/smoke.js` ca să confirmi noile perechi. Dacă factory/router e greșit,
perechile lipsesc pur și simplu (nu blochează bot-ul).

### Cum ajustez dimensiunea flashloan-ului?
`bot/config.js` → `defaultFlashAmount` (plafon absolut) și
`maxPerPairBorrowBps` (câte puncte de bază din rezerva perechii poți împrumuta).
Pentru token-uri mici ține `maxPerPairBorrowBps` mic (100–300 = 1–3%).

### Cum reduc riscul de front-running?
- Folosește un **RPC privat rapid** și, dacă ai acces, setează `BLOXROUTE_API_TOKEN`
  în `.env` pentru tranzacții private (via bloXroute bundles). Vezi detaliile în Pasul 1.
- Ridică pragul `minProfitBnb` ca să executi doar oportunități mai solide.

### De ce o oportunitate "detectată" nu a fost executată?
1. **Prag de profit**: netProfit estimat < `minProfitBnb`;
2. **Simulare eșuată**: token cu taxă ascunsă / honeypot / slippage prea mare;
   bot-ul a sărit-o (intenționat);
3. **Competiție**: alt bot a executat înaintea ta (în milisecunde).

### Există garanție de profit?
**Nu.** Acest bot este o infrastructură solidă, dar profitul net depinde de piață,
rapiditate, RPC și competiție. Tratează-l ca un experiment cu buget limitat.

### Referințe utile
- Adrese PancakeSwap v2: https://docs.pancakeswap.finance/contracts/v2/addresses
- Multicall3 (pe toate lanțurile): `0xcA11bde05977b3631167028862bE2a173976CA11`
- BSCScan (verificare adrese/tx): https://bscscan.com
- Flashbots (concepte MEV, tutoriale): https://docs.flashbots.net
- bloXroute BSC (private tx/bundles): https://docs.bloxroute.com

---

*Sfârșitul ghidului.* Mult noroc și testați întotdeauna cu sume mici înainte de a crește
expunerea!
> (rulează din directorul proiectului, după `npm install`)
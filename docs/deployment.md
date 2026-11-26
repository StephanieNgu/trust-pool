# Deploying TrustPool to Sepolia

This is the runbook for the public testnet deployment. The contracts go on Ethereum Sepolia with real Chainlink VRF v2.5. One hosted service serves the web app, the API and the claim keeper.

## Environments

| Environment | Chain | Contracts | App | Used for |
|---|---|---|---|---|
| Local dev | Hardhat node (31337) | `npm run deploy:local`, VRF mock | `npm run dev` + `npm run dev:backend` | Day-to-day work, demo roles |
| CI | In-process Hardhat | Fresh every run | Built and run by Playwright | Every push and PR (`.github/workflows`) |
| **Testnet** | **Sepolia (11155111)** | `scripts/deploy.js --network sepolia`, real Chainlink VRF | Docker service on Render | Milestone demo, outside testers |
| Mainnet | — | Out of scope | — | MockStablecoin and the shortened windows make this testnet-only |

## What runs where

```
Browser (MetaMask on Sepolia)
   │  signs its own transactions ─────────────────────────────┐
   ▼                                                           ▼
Render web service (Docker, 1 instance, free plan)                 Sepolia contracts
   ├─ /            built web app (dist/frontend)          MockStablecoin (faucet), Pool,
   ├─ /api/*       Express API: config, claims,           PolicyRegistry, VRFRandomness,
   │               evidence (AES-256-GCM), sign-in         JuryModule, ClaimManager
   ├─ keeper       finalize / acceptOffer / payout /            ▲
   │               expire / lapse, every 60 s ── RPC ─────────┤
   └─ /var/data    evidence, accounts (ephemeral on free plan) │
                                                    Chainlink VRF coordinator answers
                                                    jury randomness by itself
```

The web app reads the chain id and contract addresses from `GET /api/config`, so the same build works locally and on Sepolia. If MetaMask is on the wrong network it shows a **Switch network** button.

## Testnet parameters

Sepolia can't fast-forward time, so `scripts/deploy.js` applies `TESTNET_PARAMS` from `scripts/lib/deployContracts.js`:

| Parameter | Default | Sepolia |
|---|---|---|
| Waiting period | 7 days | 0 |
| Jury size / quorum | 5 / 3 | 3 / 2 |
| Commit window, reveal window | 2 days, 1 day | 15 min, 15 min |
| Claimant response window | 2 days | 15 min |
| Randomness timeout | 1 day | 1 hour |
| Receipt window | 30 days | 1 day |

All other parameters (premiums, stakes, bonds, the 20% payout cap) are the defaults. The deploy seeds the pool with 5,000 mUSDC. Members get their own test mUSDC from the token's public faucet: the dashboard button gives 1,000 mUSDC, once per wallet per day.

## Accounts and secrets

| What | Who holds it | Where it goes |
|---|---|---|
| Deployer wallet (throwaway, about 0.15 Sepolia ETH) | Max, MetaMask | Local `.env` only (`DEPLOYER_PRIVATE_KEY`) |
| Keeper wallet (throwaway, about 0.05 Sepolia ETH) | Max, MetaMask | Render secret `KEEPER_PRIVATE_KEY` |
| Alchemy (or Infura) Sepolia RPC URL | Max | `.env` `SEPOLIA_RPC_URL` and Render secret `RPC_URL` |
| VRF subscription (at least 30 LINK, added with **Add funds**; each pending request holds back about 24) | Deployer wallet at vrf.chain.link | `.env` `VRF_SUBSCRIPTION_ID` |
| Evidence encryption key (`openssl rand -hex 32`) | Render secret, plus a copy in a password manager (with a disk, losing it makes stored evidence unreadable) | Render secret `EVIDENCE_ENCRYPTION_KEY` |
| Render account | Max | — |

Keep the deployer and keeper as separate wallets. The keeper key sits on the server, and none of its calls need privileges because every one of them is permissionless on-chain. If the key leaks, all an attacker gets is its gas money. Never commit a key. `.env` is git-ignored.

## Deploy steps

### 1. Prepare (once)

Do steps 1 to 4 of [docs/vrf.md](vrf.md): the deployer wallet, Sepolia ETH, the RPC URL, and a funded VRF subscription created **from the deployer wallet**. Then make the second wallet (the keeper) and send it about 0.05 Sepolia ETH.

### 2. Deploy the contracts (from a laptop)

```bash
git checkout main && git pull && npm ci
npx hardhat test                       # all green before deploying
cp .env.example .env                   # fill SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, VRF_SUBSCRIPTION_ID
npx hardhat run scripts/deploy.js --network sepolia
```

Expect `Added 0x… as a consumer of VRF subscription …`, `Seeded the pool with 5000.0 mUSDC.`, the address table, and `Addresses written to deployments/sepolia.json`.

```bash
git checkout -b deploy/sepolia-$(date +%Y%m%d)
git add deployments/sepolia.json
git commit -m "Deploy contracts to Sepolia"
git push -u origin HEAD                # open a PR and merge it to main
```

The service builds from `main` and reads `deployments/sepolia.json`, so this file is how the app finds the contracts.

### 3. Create the service on Render (once)

1. In the Render dashboard, click **New**, then **Blueprint**, and pick this repository. Render reads `render.yaml`, which sets up one free Docker web service with a health check on `/api/health`.
2. Fill in the three secrets it asks for: `RPC_URL`, `KEEPER_PRIVATE_KEY` and `EVIDENCE_ENCRYPTION_KEY`.
3. Click **Apply**. The first build takes about 5 minutes, because it compiles the contracts and builds and type-checks the web app.

After that, every merge to `main` redeploys automatically.

### 4. Smoke test

```bash
curl https://<app>.onrender.com/api/health   # ok: true, chainId "11155111", keeper.running: true
curl https://<app>.onrender.com/api/config   # addresses match deployments/sepolia.json
```

Then in a browser with MetaMask:

1. Open the app, connect, and click **Switch network**.
2. Click **Get 1,000 test mUSDC**.
3. Buy coverage.
4. With three other wallets, buy coverage and stake for jury duty.
5. File a claim. Within 1 to 3 minutes the claim shows a seated jury: Chainlink answered the VRF request.
6. The jurors commit and then reveal. The keeper finalizes within a minute of the reveal window closing.
7. Accept the offer, upload the receipt, and the keeper pays out.

To run a jury draw from the command line, use `npx hardhat run scripts/sepolia-vrf-demo.js --network sepolia`.

## Configuration reference (service)

| Variable | Value on Render | Notes |
|---|---|---|
| `DEPLOYMENT_FILE` | `/app/deployments/sepolia.json` | Set in the image and in `render.yaml` |
| `RPC_URL` | secret | HTTPS Sepolia endpoint |
| `KEEPER_PRIVATE_KEY` | secret | Without it the keeper is off on Sepolia, and claims then have to be advanced by hand from the UI |
| `EVIDENCE_ENCRYPTION_KEY` | secret | 32 bytes, hex or base64. Required on any non-local chain |
| `KEEPER_INTERVAL_MS` | `60000` | 60 s keeps the RPC use inside Alchemy's free tier. Windows are 15 min, so this is plenty |
| `LOG_BLOCK_RANGE` | `10` | Alchemy's free tier allows 10 blocks per `eth_getLogs`; the backend reads history in chunks from the deploy block (needs PR #38) |
| `STATIC_DIR` | `/app/dist/frontend` | Set in the image; serves the web app at `/` |
| `EVIDENCE_DIR`, `ACCOUNTS_DIR` | `/var/data/evidence`, `/var/data/accounts` | Ephemeral on the free plan; on a paid plan mount a disk here |
| `PORT` | set by Render | |
| `CORS_ORIGIN` | unset (`*`) | The app and API share one origin; API auth is a bearer token, not a cookie |
| `KEEPER_FULFILL_RANDOMNESS` | default | Ignored on Sepolia, where there is no mock coordinator to drive |

## Final demo: run the service on a laptop

This is how we present the final demo. The same app runs on a laptop against the same Sepolia contracts. Claims, policies, stakes and wallets are all on-chain, so nothing has to be migrated. Evidence uploaded to the hosted service stays there, though, so file demo claims on the one you will present from.

1. Suspend the hosted service (Render: **Settings → Suspend Service**) so two keepers don't send transactions from the same wallet.
2. Terminal 1, in the repo (PowerShell; use `export NAME=value` in bash):
   ```powershell
   $env:RPC_URL="<Sepolia HTTPS URL>"; $env:DEPLOYMENT_FILE="deployments/sepolia.json"
   $env:KEEPER_PRIVATE_KEY="<keeper key>"; $env:EVIDENCE_ENCRYPTION_KEY="<64 hex characters>"
   $env:LOG_BLOCK_RANGE="10"; npm run dev:backend
   ```
3. Terminal 2: `npm run dev`, then open http://localhost:5173 with MetaMask on Sepolia. Connect each demo account to `localhost:5173` in MetaMask and sign in once.
4. Afterwards, stop both terminals and resume the hosted service.

If the app can't be used at all, two scripts finish a claim from the command line. `scripts/sepolia-jury-vote.js` votes from the demo juror wallets (`CLAIM_ID`, optional `AMOUNT`). `scripts/sepolia-receipt.js` submits the receipt and pays out (`CLAIM_ID`, `CLAIMANT_PRIVATE_KEY`, `RECEIPT_TOTAL`). Both run with `npx hardhat run <script> --network sepolia`.

## Rollback

**App (web, API, keeper).** In Render, open the service's **Events**, choose the last good deploy, and click **Rollback**. You can also revert the bad commit on `main`, which redeploys it. On the free plan any redeploy or rollback wipes stored evidence and sign-ins; on-chain state is untouched. Contract addresses only change when `deployments/sepolia.json` changes.

**Contracts.** Deployed contracts are immutable and have no upgrade path or admin switch. That's deliberate, so nobody can change a claim's outcome. To "roll back", you redeploy instead:

1. Fix the bug and run `npx hardhat test`.
2. Run `scripts/deploy.js --network sepolia` again. It deploys a fresh set and adds the new `VRFRandomness` as a consumer of the same subscription.
3. Commit the new `deployments/sepolia.json` and merge it. The service redeploys against it.
4. On vrf.chain.link, remove the old `VRFRandomness` consumer so it can't spend LINK. Chainlink refuses while that consumer has a request pending; it drops such a request after 24 hours, so remove it then.

To go back to a previous contract set, revert the commit that changed `deployments/sepolia.json`. Policies, stakes and claims live in the contract set they were made in. Members of the old set don't carry over, and with a disk, their evidence stays readable by its uploaders.

**Evidence key.** If `EVIDENCE_ENCRYPTION_KEY` is lost, stored evidence can't be decrypted. Keep a copy in a password manager. If it leaks, rotate it: set a new key, then redeploy contracts and clear `/var/data/evidence`. The store has no re-encryption tool yet.

## Monitoring

| Signal | Where | Act when |
|---|---|---|
| Service up | Render health check on `/api/health` (it restarts the service after repeated failures), plus an uptime pinger on the same URL | Any alert |
| Keeper healthy | `/api/health` → `keeper.running`, `keeper.lastTickAt`, `keeper.lastError`. Logs lines start `[keeper]` | `lastTickAt` older than 5 min, or a repeated `lastError` |
| Keeper gas | Etherscan page of the keeper address | Below 0.01 ETH: top up from a faucet |
| VRF subscription balance | vrf.chain.link subscription page | Below 30 LINK (a request needs about 24 held back), or requests stuck pending |
| Claims stuck | Claims page (`JuryPending` over 10 min), Etherscan `ClaimManager` events | Check the VRF subscription and the consumer list |
| RPC quota | Alchemy dashboard, compute units | Above 70% of the monthly limit: raise `KEEPER_INTERVAL_MS` |
| Errors | Render logs (the API logs unexpected errors with `console.error`) | Any 502 burst |

On demo day, open `/api/health`, the keeper address on Etherscan and the VRF subscription page in tabs. Check all three are green 30 minutes before presenting.

## Known limits

- **Run one instance.** The keeper and the stores assume a single process. Don't scale the service horizontally.
- **The free plan can't carry a live demo.** On 26 Nov it answered most requests with 429 or 503 (from Render's front end; the backend never sends either), it sleeps after 15 idle minutes, and every restart or redeploy wipes `/var/data`. A restart wiped an open claim's evidence, which locked its jurors out of voting in the app. Keep the hosted service as a public link people can try, and present from a laptop (see [Final demo](#final-demo-run-the-service-on-a-laptop)). Starter with a 1 GB disk at `/var/data` (about $7.25 a month) would fix the sleeping and the wipes. The container runs as `node`, though, and a mounted disk is owned by root, so check that the backend can write to it before relying on it. On-chain state (policies, claims, payouts) is never affected by any of this.
- **Keep it awake.** A free uptime monitor (for example UptimeRobot) that requests `/api/health` every 5 minutes stops the free service sleeping, so the keeper keeps running. One always-on service fits inside Render's 750 free hours a month.
- **History catch-up after a restart.** With Alchemy's free tier (10 blocks per `eth_getLogs`), the backend has to read the event history from the deploy block again after every restart, in about 7,200 blocks a day. It starts in the background at boot and logs `[history] indexed N events in S s` when it's done. Until then, only the Account history panel waits; everything else works straight away.
- **Sepolia itself.** Faucets rate-limit, and Chainlink VRF can occasionally be slow. Claims can be cancelled after the 1-hour randomness timeout.
- **MockStablecoin.** Anyone can mint 1,000 a day from the faucet, so pool numbers on the testnet mean nothing economically.

## Cost

The Render free plan costs nothing (Starter with a 1 GB disk is about $7.25 a month). Alchemy, Chainlink and the Sepolia faucets are free.

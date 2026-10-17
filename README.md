# trust-pool

## Prerequisites

Before setting up the project, make sure you have:

* Node.js installed
* npm installed

Check your versions with:

```powershell
node --version
npm --version
```

## Setup

Clone the repository:

```powershell
git clone https://github.com/StephanieNgu/trust-pool.git
```

Move into the project directory:

```powershell
cd trust-pool
```

Install the project dependencies:

```powershell
npm install
```
## Running the Application

The frontend, the Express backend, and the smart contracts run separately.

Frontend

Start the Vite development server:

```powershell
npm run dev
```

The frontend includes a personal dashboard and a device coverage purchase form. It supports MetaMask and expects the Hardhat local network:

* RPC URL: `http://127.0.0.1:8545`
* Chain ID: `31337`
* Currency symbol: `ETH`

Contract instances are created centrally in `frontend/src/contracts/contracts.ts`. The frontend
loads local addresses from `deployments/localhost.json`, which `npm run deploy:local` writes (see
[Smart Contracts](#smart-contracts)). The deploy script also gives every Hardhat dev account
10,000 mUSDC; import one of the private keys printed by `npm run chain` into MetaMask to use it.

### Dashboard and device coverage

Without a connected wallet, the dashboard displays a connection prompt and empty balance cards.
With a wallet on the local network, it reads the mUSDC balance, shared pool balance, current payout
cap, policy status, backend block and keeper status through the backend API. Missing backend,
contract and network errors are shown with a retry action. Values are not simulated. Start the
backend before the frontend dashboard (`npm run dev:backend`); Vite proxies `/api` to port 3000.

The frontend API client lives in `frontend/src/api`. Select **Sign in** to fetch the backend's
timestamped authentication message, sign it in MetaMask, and cache the resulting evidence-access
headers in the browser session until shortly before the 10-minute signature expiry. Read-only
dashboard routes do not require this signature.

### Claims and evidence

The **Claims** workspace lets an eligible policyholder request a payout, describe the incident and
attach up to 10 supported images or PDFs (5 MB each). The frontend validates the amount and files,
signs in to the protected evidence API when needed, uploads the encrypted evidence bundle, then asks
MetaMask to submit its returned hash to `ClaimManager`. The same page loads the connected wallet's
claims from the backend and shows their current state, evidence hash, jury progress and payout.
Select **View details** for policy, evidence, payout, deadlines, outcome and every juror's
commit/reveal status.

The **Jury Queue** workspace queries assignments for the connected wallet, separates required commit
or reveal actions from completed reviews, and opens the same claim detail view. Commit and reveal
transactions are not part of this frontend milestone yet; the queue currently provides status and
deadlines so those actions can be added without changing the read-side flow.

An active policy past its waiting period is required, and a policy may have only one open claim.
Evidence may remain stored if the user rejects or the chain rejects the transaction after upload;
retrying the same bundle is safe because evidence is content-addressed and produces the same hash.

Select **Get Device Coverage**, enter a device identifier and coverage amount, then select
**Review premium**. The app reads the premium from PolicyRegistry. **Approve & confirm coverage**
requests the necessary mUSDC approval for the Pool, waits for confirmation, then requests the
coverage transaction. The device identifier is hashed locally. After confirmation, the dashboard
refreshes and the purchase appears in the current session's activity list. Activity is not persisted
across reloads. The avatar and member name are placeholders; there is no email/password login.

To verify the purchase flow, start the local chain (`npm run chain`), deploy the contracts
(`npm run deploy:local`), start the frontend (`npm run dev`), and connect a funded local development wallet. Verify both MetaMask confirmations,
the active policy on the dashboard, and the updated mUSDC and pool balances. Test a rejected
wallet request and a wrong network as well. Use local test accounts and test tokens only.

Backend

The backend (`backend/src`, Express + TypeScript) is the off-chain half of the design doc. It never
holds user keys: members still sign their own transactions in MetaMask. It does three things:

* **Private evidence storage.** A policyholder uploads photos and gets back the `evidenceHash` to pass
  to `ClaimManager.submitClaim`. Evidence is served only to its uploader and to the selected jurors
  of a claim the uploader filed with it, never publicly. Jurors download the exact stored bytes and
  recompute `keccak256` to confirm they match the hash on-chain (that proves the files are unchanged,
  not that the claim is true). Jurors lose access once voting ends. Files live in `data/evidence/`,
  encrypted with AES-256-GCM. See
  [design doc §6b](docs/design-doc.md#6b-off-chain-backend-and-evidence-privacy) for the full policy.
* **Keeper.** Polls open claims and moves them along: fulfils jury randomness (as the
  `MockRandomness` owner, using a CSPRNG seed), cancels a claim whose randomness is more than a day
  late, finalizes once voting closes or every juror has voted, and pays approved claims. Everything
  except randomness is callable by anyone on-chain, so the keeper cannot change an outcome.
* **Read API** for the dashboard: pool stats, a member's policy, claims filtered by claimant, juror or
  state, and each claim's jury and votes.

Start a chain and deploy first, then start the backend in a third terminal:

```powershell
npm run chain          # terminal 1
npm run deploy:local   # terminal 2
npm run dev:backend    # terminal 3: http://localhost:3000/api/health
```

On the local chain the keeper signs with the deployer's unlocked Hardhat account, so no key is
needed. The Vite dev server proxies `/api` to the backend, so the frontend can call `/api/...` directly.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Chain id, block number, keeper status |
| `GET /api/config` | Contract addresses, protocol parameters, token symbol and decimals |
| `GET /api/pool` | Balance, per-claim cap, totals, policy and claim counts |
| `GET /api/members/:address` | Wallet balance, contributions, policy, claim-eligible date, open claim |
| `GET /api/claims?claimant=&juror=&state=` | Claims, newest first; `juror=` gives a juror their queue |
| `GET /api/claims/:id` | Claim, jury (jurors, who has committed and revealed, revealed tally, deadlines) and evidence link |
| `GET /api/auth/message?address=` | The message to sign with the wallet for the evidence routes |
| `POST /api/evidence` 🔒 | Upload `{ description, files: [{ name, contentType, data (base64) }] }`; returns `evidenceHash`. Active policyholders only |
| `GET /api/evidence/:hash` 🔒 | Evidence description and file list |
| `GET /api/evidence/:hash/raw` 🔒 | Exact stored bytes; `keccak256` of these equals the on-chain hash |
| `GET /api/evidence/:hash/files/:index` 🔒 | One file, for display (fetch it, then show it from a blob URL) |

🔒 routes need three headers: `x-trustpool-address`, `x-trustpool-issued-at` (unix seconds) and
`x-trustpool-signature`, the wallet's `personal_sign` of the message from `/api/auth/message`. A
signature is valid for 10 minutes, so the frontend signs once, not per request.

Claims can end `Paid`, `Rejected` (majority against, a tie, or fewer than 3 votes; the API's
`jury.outcomeReason` says which) or `Cancelled` (randomness never arrived). An approved claim's payout
is fixed when the jury approves.

Up to 10 files of 5 MB each (JPEG, PNG, WebP, GIF, HEIC or PDF) per claim.

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `RPC_URL` | `http://127.0.0.1:8545` | |
| `DEPLOYMENT_FILE` | `deployments/localhost.json` | Written by `npm run deploy:local` |
| `EVIDENCE_DIR` | `data/evidence` | |
| `EVIDENCE_ENCRYPTION_KEY` | unset | 32 bytes as hex or base64. Required off the local chain |
| `EVIDENCE_KEY_FILE` | `data/evidence.key` | Local chain only: generated on first start when no key is set |
| `CORS_ORIGIN` | `*` | |
| `KEEPER_ENABLED` | `true` | |
| `KEEPER_PRIVATE_KEY` | unset | Required off the local chain; must own `MockRandomness` to select juries |
| `KEEPER_INTERVAL_MS` | `5000` | |
| `KEEPER_FULFILL_RANDOMNESS` | `true` | |
| `KEEPER_AUTO_RESOLVE` | `true` | Finalize and pay automatically |

## Smart Contracts

The on-chain protocol from [`docs/design-doc.md`](docs/design-doc.md) lives in `contracts/` and uses Hardhat.

| Contract | Role | Holds funds? |
|---|---|---|
| `MockStablecoin` | Demo ERC-20 standing in for USDC (6 decimals) | n/a |
| `PolicyRegistry` | Sells policies, one per wallet and per device; tracks Active/Lapsed; lists eligible jurors | No |
| `Pool` | Holds all funds; takes premiums and contributions; pays approved claims up to `maxPayoutBps` of its balance | **Yes** |
| `ClaimManager` | Claim state machine: Submitted → JuryPending → Voting → Approved/Rejected → Paid | No |
| `JuryModule` | Requests randomness, picks 5 jurors (claimant excluded), runs commit-reveal voting, tallies | No |
| `MockRandomness` | **Demo-only** randomness provider behind `IRandomnessProvider` (swap for Chainlink VRF later) | No |

Prototype parameters (in `scripts/lib/deployContracts.js`): 7-day waiting period, 5% premium, 2,000 mUSDC max coverage, 20% per-claim pool cap, jury of 5, quorum of 3, 2-day commit window then 1-day reveal window, 1-day randomness timeout.

**Voting is commit-reveal.** A juror first calls `commitVote(claimId, commitment)` with
`commitment = JuryModule.computeCommitment(claimId, juror, approve, salt)` for a secret 32-byte
`salt`, then, once every juror has committed or the commit window ends, calls
`revealVote(claimId, approve, salt)`. Only revealed votes count. The juror must keep the salt until
revealing; a frontend can derive it from a wallet signature over the claim id so it can always be
recomputed.

Run the whole claim flow in one command (no node needed):

```powershell
npm run demo
```

Run a local chain and deploy to it (for the frontend):

```powershell
npm run chain         # terminal 1: local node on http://127.0.0.1:8545
npm run deploy:local  # terminal 2: deploys, funds dev accounts, writes deployments/localhost.json
```

Compile only:

```powershell
npm run compile
```

## Running Tests

Run every test: the contract suite (unit tests in `test/unit`, the end-to-end happy path in
`test/integration`) and the backend suite (`backend/test`, which runs the API and keeper against an
in-process Hardhat chain):

```powershell
npm test
npm run test:contracts   # contracts only
npm run test:backend     # backend only
```

For a coverage report:

```powershell
npm run coverage
```

## Linting

Run ESLint (JavaScript/TypeScript) and Solhint (Solidity):

```powershell
npm run lint
```

## Building

Build the contracts, frontend, and backend with:

```powershell
npm run build
```

The frontend is built using Vite, and the backend is compiled using TypeScript.

Build files are generated in the `dist/` directory and are not committed to the repository.

## Continuous Integration

GitHub Actions is configured in:

```text
.github/workflows/ci.yml
```

The CI pipeline runs automatically when:

* Code is pushed to the repository
* A pull request targets the `main` branch

The pipeline:

1. Installs dependencies
2. Compiles the contracts
3. Runs the contract and backend test suites
4. Runs ESLint and Solhint
5. Builds the frontend and backend

## Development Workflow

Create a separate branch for a feature or change:

```powershell
git checkout -b feature/your-feature-name
```

After making changes:

```powershell
git add .
git commit -m "Describe your changes"
git push -u origin feature/your-feature-name
```

Then open a pull request from your feature branch into `main`.

## Project Structure

```text
trust-pool/
├── .github/
│   └── workflows/
│       └── ci.yml
├── contracts/
│   ├── MockStablecoin.sol
│   ├── PolicyRegistry.sol
│   ├── Pool.sol
│   ├── ClaimManager.sol
│   ├── JuryModule.sol
│   ├── interfaces/
│   └── mocks/
│       └── MockRandomness.sol
├── test/
│   ├── helpers.js
│   ├── unit/
│   └── integration/
│       └── happyPath.test.js
├── scripts/
│   ├── deploy.js
│   ├── demo.js
│   └── lib/
│       └── deployContracts.js
├── deployments/        # written by deploy.js
├── docs/
│   └── design-doc.md
├── frontend/
│   ├── index.html
│   ├── tsconfig.json
│   └── src/
│       ├── App.tsx
│       ├── contracts/  # ABIs, addresses, contract calls
│       └── wallet/     # MetaMask connection
├── backend/
│   ├── src/
│   │   ├── server.ts   # entry point
│   │   ├── app.ts      # HTTP routes
│   │   ├── evidence.ts # content-addressed evidence store
│   │   ├── keeper.ts   # jury randomness, finalize, payout
│   │   └── protocol.ts # on-chain reads for the API
│   └── test/
├── hardhat.config.js
├── .solhint.json
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.mts
├── eslint.config.mjs
├── .gitignore
└── README.md
```

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
10,000 mUSDC and seeds the community pool with 5,000 mUSDC from the last dev account, so a demo claim is not
capped to a few mUSDC; import one of the private keys printed by `npm run chain` into MetaMask to use it.

### Dashboard, community pool and device coverage

Without a connected wallet, the dashboard displays a connection prompt and empty balance cards.
With a wallet on the local network, it reads the mUSDC balance, shared pool balance, current payout
cap, policy status, backend block and keeper status through the backend API. Missing backend,
contract and network errors are shown with a retry action. Values are not simulated. Start the
backend before the frontend dashboard (`npm run dev:backend`); Vite proxies `/api` to port 3000.

The frontend API client lives in `frontend/src/api`. Select **Sign in** to sign the backend's
timestamped message once in the wallet; the backend returns a session token valid for 7 days, kept
in this browser until it expires or you select **Sign out**. Signed in, your display name, device
nickname and read notifications are saved to your profile on the backend, so they follow you to
other browsers. Read-only dashboard routes do not need a sign-in.

For a MetaMask-free local walkthrough, open `http://127.0.0.1:5173/?demo=1`. In development only,
the frontend offers Hardhat's first well-known test account and forwards its transactions to the
local RPC node. Use the **Demo role** selector to switch between the claimant and five juror accounts;
wallet-specific dashboard, authentication, claims and jury assignments refresh automatically. Never
send real funds to these test accounts or use their public development mnemonic outside the local
prototype.

To skip the setup clicks before a demo, run `npm run seed:demo` once the chain, the deployment and
the backend are up. It signs demo accounts 1 to 5 up for coverage (device details and placeholder
signup photos, uploaded through the backend like the app does) and stakes each for jury duty, so a
claim can be filed straight away. Account 0 is left for a live signup; set `SEED_CLAIMANT=1` to sign
it up too. Running it again skips members already covered or staked. `TRUSTPOOL_API` overrides the
backend URL (default `http://localhost:3000`).

```powershell
npm run chain         # terminal 1
npm run deploy:local  # terminal 2: deploys, funds dev accounts and seeds the pool
npm run dev:backend   # terminal 3
npm run seed:demo     # terminal 2 again: five covered, staked members
npm run dev           # terminal 4: open http://127.0.0.1:5173/?demo=1 as Account 0
```

### Notifications

The bell in the top bar and the **Needs your attention** list on the dashboard show what each wallet
needs to know, refreshed every 15 seconds:

* **Jury duty**: picked for a jury and the commit deadline, reveals opening and the reveal deadline,
  a missed commit or reveal, and the outcome with the fee earned or penalty taken.
* **Your claims**: each status change (filed, jury reviewing, offer to accept or withdraw before it
  auto-accepts, approved, paid, rejected, withdrawn, cancelled), with how much of the bond came back.
* **Monthly premiums**: a premium due within 7 days, a missed premium during the grace period (with the
  grace deadline), coverage stopped once grace ends, and the policy closing.
* **Your policy**: the waiting period and when claims open, and a juror stake below the minimum.

`GET /api/members/:address/notifications` builds the list from chain state on each request
(`backend/src/notifications.ts`), so nothing is stored server side. Each notification has an `id` that
names the state it describes (for example `jury:3:reveal` or `claim:3:Offered`), so a new step shows
up as new. Which ids a wallet has seen is kept in the browser's localStorage. Action items stay on the
dashboard until they are done, and deadlines are counted against chain time.

### Claims and evidence

The **Claims** workspace lets an eligible policyholder request a payout, describe the incident and
attach up to 10 supported images or PDFs (5 MB each). The frontend validates the amount and files,
signs in to the protected evidence API when needed, uploads the encrypted evidence bundle, then asks
MetaMask to submit its returned hash to `ClaimManager`. The same page loads the connected wallet's
claims from the backend and shows their current state, evidence hash, jury progress and payout.
Use the status selector to ask the backend for only Submitted, Voting, Paid or another claim state.
Select **View details** for policy, evidence, payout, deadlines, outcome and every juror's
commit/reveal status.

The **Jury Queue** workspace queries assignments for the connected wallet, separates required commit
or reveal actions from completed reviews, and opens the same claim detail view. A selected juror can
open the private evidence, verify its exact raw bundle against the on-chain hash, and only then seal
the amount they would pay (from 0, which rejects, up to the amount asked) with a short note. The note
is required when paying less than asked. Evidence previews are created from those verified bytes rather than a
second unverified file response. The vote salt is derived from a private, claim-specific wallet
signature and is never displayed or sent to the backend. An exact recovery copy is encrypted with a
non-exportable browser key so a wallet that produces a different signature later does not strand the
vote; if that copy is unavailable, the wallet can still try to reproduce the salt. Recovery data is
deleted after reveal; without it, the juror re-enters the amount they sealed and the app finds their note among the ones they saved. The frontend
checks the commitment against the blockchain before submitting the reveal. Claim, jury, dashboard and
pool state refresh automatically.

The claim form asks how the claimant arrived at the amount, and they can attach a repair quote. When
voting ends the claim gets the jury's offer: the middle (median) of the revealed amounts. The claimant
sees each juror's amount and note, then accepts the offer or withdraws the claim. There is no
counteroffer. If they do neither within 2 days, the offer is accepted for them.

**Payouts are reimbursements against a receipt.** Once the offer is accepted, the claim page asks the
claimant for the receipt for the repair or replacement: the shop, the total, the date and a photo or
PDF of the invoice. It is stored encrypted like the photos, its hash and total go on-chain, and the
keeper pays the smaller of the offer and the receipt's total. If no receipt arrives within 30 days, the
claim expires unpaid. A receipt file can back only one claim, and the claim page flags a receipt whose
total differs from the one submitted or that is dated before the claim. The claim's jurors can open
the receipt; they have nothing to do with it.

**Filing a claim posts a bond** of 5% of the amount asked (at least 5 mUSDC), which the form shows
before you submit. The pool holds it outside the reserve until the jury decides, then returns it minus
the share of the ask the jury cut: a claim paid in full gets all of it back, one cut to half gets half,
and a rejected claim loses it. What is kept joins the reserve. If the jury misses quorum or the claim is
cancelled, the whole bond comes back.

**Jury duty is opt-in and staked.** On the Jury Queue page a member locks 20 mUSDC in the pool to be
picked for juries; the stake is locked while they sit on a jury and can be withdrawn otherwise. When a
jury closes, jurors whose amount agrees with the outcome share a fee of 2% of the claim (at least
2 mUSDC) from the pool. Agreeing means within 10% of the requested amount from the median, or voting 0
on a rejected claim; no fee is paid without quorum. A juror who never reveals loses 5 mUSDC of their
stake, which goes to the agreeing jurors. Voting against the majority costs nothing.

An active policy past its waiting period is required, and a policy may have only one open claim.
Evidence may remain stored if the user rejects or the chain rejects the transaction after upload;
retrying the same bundle is safe because evidence is content-addressed and produces the same hash.

Select **Get Device Coverage**, enter a device identifier and coverage amount, then select
**Review premium**. The app reads the premium from PolicyRegistry. **Approve & confirm coverage**
requests the necessary mUSDC approval for the Pool, waits for confirmation, then requests the
coverage transaction.

**Showing the device is yours** is optional and adds to the photos. Signing up on the insured device
itself (a checkbox at signup) makes this browser create a key that cannot be copied off the device;
a claim later filed from the same browser is signed with it, and jurors see "Filed from the insured
device". Devices without a browser, such as cameras, are signed up from another device and simply have
no key on record, which jurors are told is normal. Signup can also include a proof of purchase (an
invoice or carrier bill naming the device), which jurors see marked as such. Separately, the backend
refuses any signup or claim photo that was uploaded before, so the same pictures cannot insure one
device twice or back a second claim. The device identifier is hashed locally. After confirmation, the dashboard
refreshes and the purchase appears in the current session's activity list. Activity is not persisted
across reloads. The avatar and member name are placeholders; there is no email/password login.

The **Community Pool** workspace shows the live reserve, the connected wallet's contributions,
protocol contribution and payout totals, and the current payout cap. A member can approve mUSDC and
call `Pool.contribute`; voluntary contributions become shared, non-refundable pool funds. An active
policy can also be cancelled from its dashboard card through an explicit confirmation step. The UI
and PolicyRegistry both block cancellation while that policy has an open claim, then refresh policy
and pool data after a confirmed transaction. Claim details expose permissionless keeper fallbacks to
finalize a closed vote, execute an approved payout or cancel a timed-out randomness request.

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
| `GET /api/pool` | Reserve balance (excluding jurors' stakes and claim bonds), per-claim cap, totals including stakes, juror fees, penalties and bonds, the claim bond rate and minimum, policy and claim counts |
| `GET /api/members/:address` | Wallet balance, contributions, juror stake (`juror: { stake, minStake, activeJuries, staked }`), how many other members could sit on a jury for this wallet's claim (`jury: { available, required }`; a claim cannot be filed below `required`), policy, claim-eligible date, open claim, whether the policy is `covered` now, and its `premium` schedule (below) |
| `GET /api/members/:address/history` | The member's account history from contract events, newest first: `{ history: [{ id, kind, title, amount, direction, claimId, txHash, blockNumber, logIndex, at }] }`. `kind` is `coverage`, `premium`, `lapse`, `contribution`, `stake`, `unstake`, `fee`, `penalty`, `bond`, `bondReturn`, `claim` or `payout`; `direction` is `in` (to the wallet), `out` or null. Premiums are listed once, not again as contributions |
| `GET /api/members/:address/premium` | Just the premium schedule, light enough to poll for reminders: `{ premium: { status, amount, period, paidThrough, dueAt, graceEndsAt, secondsUntilDue, dueSoon, canPay, asOf } }`, or `{ premium: null }` without a policy. `status` is `Paid`, `Grace` (missed, still covered until `graceEndsAt`), `Overdue` (not covered; the keeper will close it) or `Lapsed`. `dueSoon` is true within 7 days of `dueAt` or once missed |
| `GET /api/claims?claimant=&juror=&state=` | Claims, newest first; `juror=` gives a juror their queue |
| `GET /api/claims/:id` | Claim, jury (jurors, who has committed and revealed, each revealed amount, the median `award`, deadlines), `offerDeadline` while an offer is open, the `bond` (amount, and once decided what was returned and forfeited), evidence and signup-photo links, and `deviceCheck` (do the IMEIs or serials match?), the `receipt` (deadline, hash, total) with `receiptFile` and `receiptCheck` (does the total match, is it dated after the claim?) |
| `POST /api/claims/:id/notes` 🔒 | A juror's note `{ note }` (up to 500 characters), sent before sealing the vote; returns the `noteHash` to seal. Jurors of the claim only, while voting and before they commit |
| `GET /api/claims/:id/notes/mine` 🔒 | The notes this juror saved for the claim, each with its `noteHash`, so a juror without the browser copy of their sealed vote only has to re-enter the amount to reveal. The juror only |
| `GET /api/claims/:id/votes` 🔒 | Each revealed juror's `amount` and `note`. Only the claimant and the claim's jurors |
| `GET /api/auth/message?address=` | The message to sign with the wallet to sign in |
| `POST /api/auth/session` 🔒 | Signed headers only: opens a session, returns `{ token, address, expiresAt }` (7 days) |
| `POST /api/auth/session/end` | Signs out: the bearer token stops working |
| `GET /api/profile` 🔒 | `{ displayName, deviceNickname, readNotifications, updatedAt }` for the signed-in wallet |
| `POST /api/profile` 🔒 | Save any of `displayName` (≤40), `deviceNickname` (≤60) and `readNotifications` (ids); others are kept |
| `POST /api/capture/code` 🔒 | A one-time code (e.g. `TP-7K4Q2M`) to show in the photos about to be taken; valid 15 minutes, for one upload |
| `POST /api/evidence` 🔒 | Upload `{ kind, captureCode, description, amountReason, device, files: [{ name, contentType, data (base64) }] }`; returns `evidenceHash`. `amountReason` (claims only) explains the amount asked for. `kind: "enrollment"` (signup photos plus `device: { type, imei, serial, make, model, color }`, with `imei` required for a phone and absent or optional for other types) is open to any wallet and its hash goes to `buyPolicy`; `kind: "claim"` (default, optional `device: { imei }` or `{ serial }`) needs an active policy and its hash goes to `submitClaim` |
| `GET /api/evidence/:hash` 🔒 | Kind, description, device details, capture code and times, and file list |
| `GET /api/evidence/:hash/raw` 🔒 | Exact stored bytes; `keccak256` of these equals the on-chain hash |
| `GET /api/evidence/:hash/files/:index` 🔒 | One file, for display (fetch it, then show it from a blob URL) |

🔒 routes need a sign-in: either `Authorization: Bearer <token>` from `POST /api/auth/session`, or
three headers: `x-trustpool-address`, `x-trustpool-issued-at` (unix seconds) and
`x-trustpool-signature`, the wallet's `personal_sign` of the message from `/api/auth/message`, valid
for 10 minutes. The frontend signs once to open a session; scripts can keep using the headers.

Claims can end `Paid`, `Rejected` (most jurors voted 0, a tie, or fewer than 3 votes; the API's
`jury.outcomeReason` says which), `Withdrawn` (the claimant turned the offer down) or `Cancelled`
(randomness never arrived). The offer is fixed when voting ends: the median juror amount, capped by
the coverage limit and the pool's per-claim cap. The keeper accepts an offer the claimant has not
answered once its deadline passes, then pays it.

Premiums are monthly. Buying a policy pays the first 30 days; `PolicyRegistry.payPremium()` pays the
next 30, counted from the end of the paid period, at most one period ahead. A missed premium starts a
7-day grace period in which coverage continues and the member can still pay. After it the policy no
longer counts as active (no new claims, no jury duty), and the keeper calls the permissionless
`lapseOverdue` to close it and free the device. A claim already open keeps its policy open until it
is decided.

Up to 10 files of 5 MB each (JPEG, PNG, WebP, GIF, HEIC or PDF) per claim.

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `RPC_URL` | `http://127.0.0.1:8545` | |
| `DEPLOYMENT_FILE` | `deployments/localhost.json` | Written by `npm run deploy:local` |
| `EVIDENCE_DIR` | `data/evidence` | |
| `EVIDENCE_ENCRYPTION_KEY` | unset | 32 bytes as hex or base64. Required off the local chain |
| `EVIDENCE_KEY_FILE` | `data/evidence.key` | Local chain only: generated on first start when no key is set |
| `ACCOUNTS_DIR` | `data/accounts` | Sign-in sessions and member profiles |
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
| `PolicyRegistry` | Sells policies, one per wallet and per device; collects monthly premiums with a grace period; tracks Active/Lapsed; lists eligible jurors | No |
| `Pool` | Holds all funds; takes premiums and contributions; holds jurors' stakes and claimants' bonds apart from the reserve; pays approved claims up to `maxPayoutBps` of the reserve, and jurors' fees | **Yes** |
| `ClaimManager` | Claim state machine: Submitted → JuryPending → Voting → Offered/Rejected → Approved (or Withdrawn) → Paid (or Expired without a receipt); takes the claimant's bond on submit and settles it at the verdict; pays the smaller of the offer and the receipt | No |
| `JuryModule` | Requests randomness, picks 5 staked jurors (claimant excluded), runs commit-reveal amount voting, takes the median, pays agreeing jurors and penalizes no-shows | No |
| `MockRandomness` | **Demo-only** randomness provider behind `IRandomnessProvider` (swap for Chainlink VRF later) | No |

Prototype defaults (in `scripts/lib/deployContracts.js`): 7-day waiting period, 1.5% premium per 30-day period (the first paid on purchase), 7-day grace period after a missed premium, 2,000 mUSDC max coverage, 20% per-claim pool cap, jury of 5, quorum of 3, 2-day commit window then 1-day reveal window, 1-day randomness timeout, 2 days for the claimant to answer the offer, 20 mUSDC juror stake, juror fee 2% of the claim (minimum 2 mUSDC), agreement band 10% of the claim, 5 mUSDC no-show penalty, claim bond 5% of the claim (minimum 5 mUSDC), 30 days to submit the receipt. `scripts/deploy.js` overrides only the local Hardhat waiting period to zero so UI claim flows can be tested immediately; tests and non-local deployments retain the 7-day default. The test suites pin a 5% premium to keep their amounts round.

**Voting is commit-reveal, on amounts.** Each juror votes the amount they think the claim should pay,
from 0 (reject) up to the amount asked. A juror first calls `commitVote(claimId, commitment)` with
`commitment = JuryModule.computeCommitment(claimId, juror, amount, noteHash, salt)`, where `noteHash`
is `keccak256` of their note (or zero for none) and `salt` is a secret 32 bytes. Once every juror has
committed or the commit window ends, they call `revealVote(claimId, amount, noteHash, salt)`. Only
revealed votes count. The claim is approved when at least 3 votes are revealed and the median amount
is above 0 (so strictly more jurors would pay than reject); the median, rounded down to the lower
middle vote for an even count, is the offer. `ClaimManager.acceptOffer` or `withdrawClaim` is the
claimant's answer; after `responsePeriod` anyone can call `acceptOffer`. The juror must keep the salt
until revealing; a frontend can derive it from a wallet signature over the claim id so it can always
be recomputed.

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
npm run test:frontend    #frontend only
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

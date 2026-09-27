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
With a wallet on the local network and deployed contracts, it reads the mUSDC balance, shared pool
balance, current payout cap, and policy status. Missing contracts and network errors are shown with
a retry action. Values are not simulated.

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

The backend uses Express and TypeScript.

Start the backend server with:

```powershell
npm run dev:backend
```

## Smart Contracts

The on-chain protocol from [`docs/design-doc.md`](docs/design-doc.md) lives in `contracts/` and uses Hardhat.

| Contract | Role | Holds funds? |
|---|---|---|
| `MockStablecoin` | Demo ERC-20 standing in for USDC (6 decimals) | n/a |
| `PolicyRegistry` | Sells policies, one per wallet and per device; tracks Active/Lapsed; lists eligible jurors | No |
| `Pool` | Holds all funds; takes premiums and contributions; pays approved claims up to `maxPayoutBps` of its balance | **Yes** |
| `ClaimManager` | Claim state machine: Submitted → JuryPending → Voting → Approved/Rejected → Paid | No |
| `JuryModule` | Requests randomness, picks 5 jurors (claimant excluded), records votes, tallies | No |
| `MockRandomness` | **Demo-only** randomness provider behind `IRandomnessProvider` (swap for Chainlink VRF later) | No |

Prototype parameters (in `scripts/lib/deployContracts.js`): 7-day waiting period, 5% premium, 2,000 mUSDC max coverage, 20% per-claim pool cap, jury of 5, quorum of 3, 3-day voting window.

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

Run the contract test suite (unit tests in `test/unit`, the end-to-end happy path in `test/integration`):

```powershell
npm test
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
3. Runs the contract test suite
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
│   └── src/
│       └── server.ts
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

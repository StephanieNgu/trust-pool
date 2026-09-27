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

The frontend and backend run separately.

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
loads local addresses from `deployments/localhost.json`; this file is created by the Hardhat local
deployment script once the smart-contract work is available.

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

To verify the purchase flow after the contract branch is available, start the local chain, deploy
contracts, and connect a funded local development wallet. Verify both MetaMask confirmations,
the active policy on the dashboard, and the updated mUSDC and pool balances. Test a rejected
wallet request and a wrong network as well. Use local test accounts and test tokens only.

Backend

The backend uses Express and TypeScript.

Start the backend server with:

```powershell
npm run dev:backend
```

## Running Tests

Run the test suite with:

```powershell
npm test
```

At the current stage of development, there may not be any tests yet. While tests are being added, use:

```powershell
npm test -- --passWithNoTests
```

Once project tests have been added, use `npm test` normally.

## Linting

Run ESLint to check the project code:

```powershell
npm run lint
```

## Building

Build the frontend and backend with:

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
2. Runs the test suite
3. Runs ESLint
4. Builds the frontend and backend

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
├── frontend/
│   ├── index.html
│   └── src/
├── backend/
│   └── src/
│       └── server.ts
├── tests/
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.mts
├── eslint.config.mjs
├── .gitignore
└── README.md
```

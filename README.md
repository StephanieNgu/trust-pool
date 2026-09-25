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

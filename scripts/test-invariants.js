// Runs the randomised token-accounting invariant suite with many more sequences than `npm test` does.
// Usage: npm run test:invariants  (override with INVARIANT_RUNS, INVARIANT_STEPS or INVARIANT_SEED)
const { spawnSync } = require("node:child_process");

const env = { INVARIANT_RUNS: "20", INVARIANT_STEPS: "200", ...process.env };
const extra = process.argv.slice(2);
const result = spawnSync("npx", ["hardhat", "test", "test/invariant/accounting.test.js", ...extra], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);

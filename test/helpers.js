const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployContracts, DAY, USDC } = require("../scripts/lib/deployContracts");

const COVERAGE = USDC(1_000);
const SEED_LIQUIDITY = USDC(10_000);
const EVIDENCE = ethers.keccak256(ethers.toUtf8Bytes("ipfs://demo-evidence-bundle"));

const deviceHash = (label) => ethers.keccak256(ethers.toUtf8Bytes(`device:${label}`));

/** Fresh deployment with no policies. */
async function deployFixture() {
  const ctx = await deployContracts();
  const signers = await ethers.getSigners();
  return { ...ctx, signers };
}

/**
 * Deployment with `HOLDER_COUNT` policyholders (signers[1..]) who are past the waiting period,
 * plus seed liquidity from the deployer so the per-claim cap is comfortably above one claim.
 */
const HOLDER_COUNT = 7;
async function activePoolFixture() {
  const ctx = await deployFixture();
  const { token, pool, registry, deployer, signers } = ctx;
  const holders = signers.slice(1, 1 + HOLDER_COUNT);

  await token.mint(deployer.address, SEED_LIQUIDITY);
  await token.connect(deployer).approve(await pool.getAddress(), SEED_LIQUIDITY);
  await pool.connect(deployer).contribute(SEED_LIQUIDITY);

  for (const [i, h] of holders.entries()) {
    await token.mint(h.address, USDC(1_000));
    await token.connect(h).approve(await pool.getAddress(), ethers.MaxUint256);
    await registry.connect(h).buyPolicy(deviceHash(i), COVERAGE);
  }
  await time.increase(ctx.params.waitingPeriod);

  return { ...ctx, holders, claimant: holders[0] };
}

/** Fulfils randomness for `claimId` and returns the selected jurors as signers. */
async function selectJury(ctx, claimId, seed = 42n) {
  await ctx.randomness.fulfill(claimId, seed);
  const addresses = await ctx.jury.getJurors(claimId);
  return addresses.map((a) => ctx.signers.find((s) => s.address === a));
}

/** Submits a claim from `claimant` and returns its id. */
async function submitClaim(ctx, claimant, amount = USDC(400)) {
  await ctx.claimManager.connect(claimant).submitClaim(amount, EVIDENCE);
  return ctx.claimManager.claimCount();
}

// Mirrors of the Solidity enums, for readable assertions.
const ClaimState = { None: 0n, Submitted: 1n, JuryPending: 2n, Voting: 3n, Approved: 4n, Rejected: 5n, Paid: 6n };
const JuryPhase = { None: 0n, AwaitingRandomness: 1n, Voting: 2n, Tallied: 3n };
const Outcome = { None: 0n, Approved: 1n, Rejected: 2n };
const PolicyStatus = { None: 0n, Active: 1n, Lapsed: 2n };

module.exports = {
  DAY,
  USDC,
  COVERAGE,
  SEED_LIQUIDITY,
  EVIDENCE,
  HOLDER_COUNT,
  deviceHash,
  deployFixture,
  activePoolFixture,
  selectJury,
  submitClaim,
  ClaimState,
  JuryPhase,
  Outcome,
  PolicyStatus,
};

const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployContracts, DAY, USDC } = require("../scripts/lib/deployContracts");

const COVERAGE = USDC(1_000);
const SEED_LIQUIDITY = USDC(10_000);
const EVIDENCE = ethers.keccak256(ethers.toUtf8Bytes("ipfs://demo-evidence-bundle"));

const deviceHash = (label) => ethers.keccak256(ethers.toUtf8Bytes(`device:${label}`));
const enrollmentHash = (label) => ethers.keccak256(ethers.toUtf8Bytes(`enrollment:${label}`));

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
  return populate(await deployFixture());
}

/** Adds seed liquidity and `HOLDER_COUNT` policyholders past the waiting period to a deployment. */
async function populate(ctx) {
  const { token, pool, registry, deployer, signers } = ctx;
  const holders = signers.slice(1, 1 + HOLDER_COUNT);

  await token.mint(deployer.address, SEED_LIQUIDITY);
  await token.connect(deployer).approve(await pool.getAddress(), SEED_LIQUIDITY);
  await pool.connect(deployer).contribute(SEED_LIQUIDITY);

  for (const [i, h] of holders.entries()) {
    await token.mint(h.address, USDC(1_000));
    await token.connect(h).approve(await pool.getAddress(), ethers.MaxUint256);
    await registry.connect(h).buyPolicy(deviceHash(i), COVERAGE, enrollmentHash(i));
  }
  await time.increase(ctx.params.waitingPeriod);

  return { ...ctx, holders, claimant: holders[0] };
}

/**
 * Like activePoolFixture, but juries are drawn by VRFRandomness through a mock Chainlink VRF v2.5
 * coordinator, with VRFRandomness registered on a subscription the deployer owns.
 */
async function vrfPoolFixture() {
  const coordinator = await ethers.deployContract("MockVRFCoordinator");
  await coordinator.createSubscription();
  const vrf = { coordinator: await coordinator.getAddress(), subscriptionId: 1n, keyHash: ethers.id("lane"), addConsumer: true };
  const ctx = await deployContracts({}, { vrf });
  const signers = await ethers.getSigners();
  return { ...(await populate({ ...ctx, signers })), coordinator, vrf };
}

/** Fulfils randomness for `claimId` and returns the selected jurors as signers. */
async function selectJury(ctx, claimId, seed = 42n) {
  await ctx.randomness.fulfill(claimId, seed);
  const addresses = await ctx.jury.getJurors(claimId);
  return addresses.map((a) => ctx.signers.find((s) => s.address === a));
}

/** Deterministic per-juror salt so tests can reveal without bookkeeping. */
const saltFor = (claimId, juror) => ethers.keccak256(ethers.toUtf8Bytes(`salt:${claimId}:${juror.address}`));

async function commitVote(ctx, claimId, juror, approve) {
  const commitment = await ctx.jury.computeCommitment(claimId, juror.address, approve, saltFor(claimId, juror));
  return ctx.jury.connect(juror).commitVote(claimId, commitment);
}

async function revealVote(ctx, claimId, juror, approve) {
  return ctx.jury.connect(juror).revealVote(claimId, approve, saltFor(claimId, juror));
}

/**
 * Commit-reveal votes for `jurors` (votes[i] is jurors[i]'s choice). If not every juror commits, waits
 * out the commit window so the reveal window opens.
 */
async function castVotes(ctx, claimId, jurors, votes) {
  for (const [i, j] of jurors.entries()) await commitVote(ctx, claimId, j, votes[i]);
  if (!(await ctx.jury.revealOpen(claimId))) await time.increase(ctx.params.commitPeriod + 1);
  for (const [i, j] of jurors.entries()) await revealVote(ctx, claimId, j, votes[i]);
}

/** Commit plus reveal window: after this long, voting is closed. */
const votingPeriod = (params) => params.commitPeriod + params.revealPeriod;

/** Submits a claim from `claimant` and returns its id. */
async function submitClaim(ctx, claimant, amount = USDC(400)) {
  await ctx.claimManager.connect(claimant).submitClaim(amount, EVIDENCE);
  return ctx.claimManager.claimCount();
}

// Mirrors of the Solidity enums, for readable assertions.
const ClaimState = { None: 0n, Submitted: 1n, JuryPending: 2n, Voting: 3n, Approved: 4n, Rejected: 5n, Paid: 6n, Cancelled: 7n };
const JuryPhase = { None: 0n, AwaitingRandomness: 1n, Voting: 2n, Tallied: 3n, Cancelled: 4n };
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
  enrollmentHash,
  deployFixture,
  activePoolFixture,
  vrfPoolFixture,
  selectJury,
  submitClaim,
  saltFor,
  commitVote,
  revealVote,
  castVotes,
  votingPeriod,
  ClaimState,
  JuryPhase,
  Outcome,
  PolicyStatus,
};

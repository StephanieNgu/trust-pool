const { ethers } = require("hardhat");

const DAY = 24 * 60 * 60;
const USDC = (amount) => ethers.parseUnits(String(amount), 6);

/** Prototype parameters. Override any of them by passing a partial object to deployContracts(). */
const DEFAULT_PARAMS = {
  waitingPeriod: 7 * DAY,
  premiumBps: 500, // 5% of coverage limit, paid upfront
  maxCoverageLimit: USDC(2_000),
  maxPayoutBps: 2_000, // a single claim may take at most 20% of the pool
  jurySize: 5,
  quorum: 3,
  commitPeriod: 2 * DAY, // jurors submit sealed votes
  revealPeriod: 1 * DAY, // then open them; 3 days of voting in total
  randomnessTimeout: 1 * DAY, // a claim whose jury randomness is this late can be cancelled
  // Juror incentives: members lock a stake to be picked; agreeing jurors share a fee; no-shows pay.
  minJurorStake: USDC(20),
  jurorFeeBps: 200, // 2% of the amount requested...
  minJurorFee: USDC(2), // ...but at least 2 mUSDC per claim
  agreementBandBps: 1_000, // within 10% of the request from the median counts as agreeing
  noShowPenalty: USDC(5), // taken from the stake of a juror who never reveals
  responsePeriod: 2 * DAY, // the claimant accepts or withdraws the jury's offer; silence accepts
  // Claimant bond: posted when filing, returned minus the share of the ask the jury cut.
  claimBondBps: 500, // 5% of the amount asked...
  minClaimBond: USDC(5), // ...but at least 5 mUSDC
  receiptPeriod: 30 * DAY, // after accepting, the claimant uploads the repair or replacement receipt
};

/**
 * Deploys and wires every contract from the design doc. Deployment order avoids circular
 * constructor arguments; the remaining links are one-time owner setters.
 *
 *   MockStablecoin -> Pool -> PolicyRegistry -> MockRandomness -> JuryModule -> ClaimManager
 */
async function deployContracts(overrides = {}) {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const [deployer] = await ethers.getSigners();

  const token = await ethers.deployContract("MockStablecoin");
  const pool = await ethers.deployContract("Pool", [await token.getAddress(), params.maxPayoutBps]);
  const registry = await ethers.deployContract("PolicyRegistry", [
    await pool.getAddress(),
    params.waitingPeriod,
    params.premiumBps,
    params.maxCoverageLimit,
  ]);
  const randomness = await ethers.deployContract("MockRandomness");
  const jury = await ethers.deployContract("JuryModule", [
    await registry.getAddress(),
    await randomness.getAddress(),
    await pool.getAddress(),
    params.jurySize,
    params.quorum,
    params.commitPeriod,
    params.revealPeriod,
    params.randomnessTimeout,
    {
      minStake: params.minJurorStake,
      feeBps: params.jurorFeeBps,
      minFee: params.minJurorFee,
      agreementBandBps: params.agreementBandBps,
      noShowPenalty: params.noShowPenalty,
    },
  ]);
  const claimManager = await ethers.deployContract("ClaimManager", [
    await registry.getAddress(),
    await pool.getAddress(),
    await jury.getAddress(),
    params.responsePeriod,
    params.claimBondBps,
    params.minClaimBond,
    params.receiptPeriod,
  ]);

  await (await pool.setRegistry(await registry.getAddress())).wait();
  await (await pool.setClaimManager(await claimManager.getAddress())).wait();
  await (await jury.setClaimManager(await claimManager.getAddress())).wait();
  await (await pool.setJury(await jury.getAddress())).wait();

  return { deployer, params, token, pool, registry, randomness, jury, claimManager };
}

module.exports = { deployContracts, DEFAULT_PARAMS, DAY, USDC };

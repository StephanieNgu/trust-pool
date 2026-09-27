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
  votingPeriod: 3 * DAY,
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
    params.jurySize,
    params.quorum,
    params.votingPeriod,
  ]);
  const claimManager = await ethers.deployContract("ClaimManager", [
    await registry.getAddress(),
    await pool.getAddress(),
    await jury.getAddress(),
  ]);

  await (await pool.setRegistry(await registry.getAddress())).wait();
  await (await pool.setClaimManager(await claimManager.getAddress())).wait();
  await (await jury.setClaimManager(await claimManager.getAddress())).wait();

  return { deployer, params, token, pool, registry, randomness, jury, claimManager };
}

module.exports = { deployContracts, DEFAULT_PARAMS, DAY, USDC };

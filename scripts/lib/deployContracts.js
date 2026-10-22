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
};

/** Chainlink VRF defaults; everything but the coordinator and subscription can be overridden. */
const VRF_DEFAULTS = {
  callbackGasLimit: 1_000_000, // jury selection scans every holder; generous for a demo-sized pool
  requestConfirmations: 3,
  nativePayment: false, // pay VRF fees in LINK from the subscription
};

/** Deploys a contract and waits for it to be mined, so public-network nonces stay in order. */
async function deploy(name, args = []) {
  const contract = await ethers.deployContract(name, args);
  await contract.waitForDeployment();
  return contract;
}

/**
 * Deploys and wires every contract from the design doc. Deployment order avoids circular
 * constructor arguments; the remaining links are one-time owner setters.
 *
 *   MockStablecoin -> Pool -> PolicyRegistry -> randomness -> JuryModule -> ClaimManager
 *
 * Randomness is MockRandomness unless `options.vrf` is given:
 *   { coordinator, subscriptionId, keyHash, callbackGasLimit?, requestConfirmations?, nativePayment?,
 *     addConsumer? }
 * which deploys VRFRandomness against that Chainlink VRF v2.5 coordinator. With `addConsumer: true`
 * the deployer (who must own the subscription) registers VRFRandomness as a consumer.
 */
async function deployContracts(overrides = {}, options = {}) {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const [deployer] = await ethers.getSigners();

  const token = await deploy("MockStablecoin");
  const pool = await deploy("Pool", [await token.getAddress(), params.maxPayoutBps]);
  const registry = await deploy("PolicyRegistry", [
    await pool.getAddress(),
    params.waitingPeriod,
    params.premiumBps,
    params.maxCoverageLimit,
  ]);
  let randomness;
  let randomnessProvider = "mock";
  if (options.vrf) {
    const vrf = { ...VRF_DEFAULTS, ...options.vrf };
    randomness = await deploy("VRFRandomness", [
      vrf.coordinator,
      vrf.subscriptionId,
      vrf.keyHash,
      vrf.callbackGasLimit,
      vrf.requestConfirmations,
      vrf.nativePayment,
    ]);
    randomnessProvider = "vrf";
    if (vrf.addConsumer) {
      const coordinator = await ethers.getContractAt(
        ["function addConsumer(uint256 subId, address consumer)"],
        vrf.coordinator,
      );
      await (await coordinator.addConsumer(vrf.subscriptionId, await randomness.getAddress())).wait();
    }
  } else {
    randomness = await deploy("MockRandomness");
  }
  const jury = await deploy("JuryModule", [
    await registry.getAddress(),
    await randomness.getAddress(),
    params.jurySize,
    params.quorum,
    params.commitPeriod,
    params.revealPeriod,
    params.randomnessTimeout,
  ]);
  const claimManager = await deploy("ClaimManager", [
    await registry.getAddress(),
    await pool.getAddress(),
    await jury.getAddress(),
  ]);

  await (await pool.setRegistry(await registry.getAddress())).wait();
  await (await pool.setClaimManager(await claimManager.getAddress())).wait();
  await (await jury.setClaimManager(await claimManager.getAddress())).wait();
  if (randomnessProvider === "vrf") await (await randomness.setConsumer(await jury.getAddress())).wait();

  return { deployer, params, token, pool, registry, randomness, randomnessProvider, jury, claimManager };
}

module.exports = { deployContracts, DEFAULT_PARAMS, VRF_DEFAULTS, DAY, USDC };

const { ethers } = require("hardhat");

const DAY = 24 * 60 * 60;
const USDC = (amount) => ethers.parseUnits(String(amount), 6);

/** Prototype parameters. Override any of them by passing a partial object to deployContracts(). */
const DEFAULT_PARAMS = {
  waitingPeriod: 7 * DAY,
  premiumBps: 150, // 1.5% of coverage limit per premium period (18% a year)
  premiumPeriod: 30 * DAY, // premiums are paid monthly; buying a policy pays the first month
  gracePeriod: 7 * DAY, // a missed premium keeps coverage this long before the policy lapses
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

/** Chainlink VRF v2.5 request settings shared by every network. */
const VRF_DEFAULTS = {
  // Seating a jury from 7 policyholders uses about 585k gas, and each extra policyholder adds a
  // little. Raise this (Sepolia allows up to 2,500,000) for much larger pools; a higher limit makes
  // Chainlink reserve more of the subscription balance per request.
  callbackGasLimit: 1_000_000,
  requestConfirmations: 3,
  nativePayment: false,
};

/** Any non-zero key hash works with the mock coordinator; it only matters on real networks. */
const LOCAL_KEY_HASH = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";

/**
 * Deploys Chainlink's VRFCoordinatorV2_5Mock and a funded subscription for local chains and tests.
 * LOCAL ONLY: the mock lets anyone answer a request. Public networks pass `vrf.coordinator`.
 */
async function deployLocalVrf() {
  // Base fee and gas price are kept small, and the subscription well funded, so demos never run dry.
  const coordinator = await ethers.deployContract("VRFCoordinatorV2_5Mock", [
    ethers.parseEther("0.001"),
    1_000_000_000n,
    ethers.parseEther("0.004"),
  ]);
  const receipt = await (await coordinator.createSubscription()).wait();
  const created = receipt.logs
    .map((log) => {
      try {
        return coordinator.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "SubscriptionCreated");
  const subscriptionId = created.args.subId;
  await (await coordinator.fundSubscription(subscriptionId, ethers.parseEther("1000000"))).wait();
  return { coordinator, subscriptionId, keyHash: LOCAL_KEY_HASH };
}

/**
 * Deploys and wires every contract from the design doc. Deployment order avoids circular
 * constructor arguments; the remaining links are one-time setters.
 *
 *   MockStablecoin -> Pool -> PolicyRegistry -> VRFRandomness -> JuryModule -> ClaimManager
 *
 * Jury randomness comes from Chainlink VRF v2.5. Without `vrf.coordinator` a local
 * VRFCoordinatorV2_5Mock is deployed and returned as `vrfCoordinator`. With it (e.g. Sepolia), the
 * caller supplies `vrf.subscriptionId` and `vrf.keyHash` and must add the returned `randomness`
 * contract as a consumer of that subscription.
 */
async function deployContracts(overrides = {}, vrf = {}) {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const [deployer] = await ethers.getSigners();

  const token = await ethers.deployContract("MockStablecoin");
  const pool = await ethers.deployContract("Pool", [await token.getAddress(), params.maxPayoutBps]);
  const registry = await ethers.deployContract("PolicyRegistry", [
    await pool.getAddress(),
    params.waitingPeriod,
    params.premiumBps,
    params.maxCoverageLimit,
    params.premiumPeriod,
    params.gracePeriod,
  ]);
  const vrfSettings = { ...VRF_DEFAULTS, ...vrf };
  let vrfCoordinator = null;
  if (!vrfSettings.coordinator) {
    const local = await deployLocalVrf();
    vrfCoordinator = local.coordinator;
    vrfSettings.coordinator = await local.coordinator.getAddress();
    vrfSettings.subscriptionId = local.subscriptionId;
    vrfSettings.keyHash = local.keyHash;
  }
  const randomness = await ethers.deployContract("VRFRandomness", [
    vrfSettings.coordinator,
    vrfSettings.subscriptionId,
    vrfSettings.keyHash,
    vrfSettings.callbackGasLimit,
    vrfSettings.requestConfirmations,
    vrfSettings.nativePayment,
  ]);
  if (vrfCoordinator) {
    await (await vrfCoordinator.addConsumer(vrfSettings.subscriptionId, await randomness.getAddress())).wait();
  }
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

  await (await randomness.setConsumer(await jury.getAddress())).wait();
  await (await pool.setRegistry(await registry.getAddress())).wait();
  await (await pool.setClaimManager(await claimManager.getAddress())).wait();
  await (await jury.setClaimManager(await claimManager.getAddress())).wait();
  await (await pool.setJury(await jury.getAddress())).wait();

  return { deployer, params, token, pool, registry, randomness, vrfCoordinator, vrf: vrfSettings, jury, claimManager };
}

module.exports = { deployContracts, DEFAULT_PARAMS, VRF_DEFAULTS, DAY, USDC };

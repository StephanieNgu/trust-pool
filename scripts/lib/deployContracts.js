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

/**
 * Public-testnet parameters. Sepolia can't fast-forward time like the local chain, so the multi-day
 * windows become minutes, and the jury is 3 (quorum 2) so a small team can seat one with real wallets.
 */
const TESTNET_PARAMS = {
  waitingPeriod: 0,
  commitPeriod: 15 * 60,
  revealPeriod: 15 * 60,
  responsePeriod: 15 * 60,
  // Chainlink normally answers in 1 to 3 minutes; after an hour a stalled claim can be cancelled.
  randomnessTimeout: 60 * 60,
  receiptPeriod: 24 * 60 * 60,
  jurySize: 3,
  quorum: 2,
};

/** Chainlink VRF v2.5 request settings shared by every network. */
const VRF_DEFAULTS = {
  // The callback only stores the seed (JuryModule.seatJury seats the jury in its own transaction)
  // and creates no new storage, so it takes about 35k gas at any pool size. Creating storage would
  // not fit: since EIP-8037 (live on Sepolia) each new slot costs about 98k gas, which is why the
  // first 100k-gas deployment's callback ran out of gas. 150k leaves room for further repricing.
  // Chainlink holds back LINK in proportion to this limit for each pending request: about 133 LINK
  // at 1M gas on Sepolia, about 24 LINK at 150k.
  callbackGasLimit: 150_000,
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
async function deployContracts(overrides = {}, vrf = {}, { log, existing = {}, signer } = {}) {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const deployer = signer ?? (await ethers.getSigners())[0];
  // With `log` (public networks), report each step and wait for it to be mined, so a slow or stuck
  // transaction is visible instead of the script sitting silent. With `existing` (contract name ->
  // address, from findPartialDeployment), contracts an earlier, interrupted run already deployed are
  // reused instead of deployed again.
  const KEYS = {
    MockStablecoin: "token",
    Pool: "pool",
    PolicyRegistry: "registry",
    VRFRandomness: "randomness",
    JuryModule: "jury",
    ClaimManager: "claimManager",
  };
  const deploy = async (name, args = []) => {
    const reuse = existing[KEYS[name]];
    if (reuse) {
      if (log) log(`  reusing ${name} at ${reuse}`);
      return ethers.getContractAt(name, reuse, deployer);
    }
    if (!log) return ethers.deployContract(name, args, deployer);
    log(`  deploying ${name}...`);
    const contract = await ethers.deployContract(name, args, deployer);
    log(`    tx ${contract.deploymentTransaction().hash}`);
    await contract.waitForDeployment();
    log(`    ${name} at ${await contract.getAddress()}`);
    return contract;
  };
  const step = async (label, txPromise) => {
    if (log) log(`  ${label}...`);
    const tx = await txPromise;
    if (log) log(`    tx ${tx.hash}`);
    return tx.wait();
  };

  const token = await deploy("MockStablecoin");
  const pool = await deploy("Pool", [await token.getAddress(), params.maxPayoutBps]);
  const registry = await deploy("PolicyRegistry", [
    await pool.getAddress(),
    params.waitingPeriod,
    params.premiumBps,
    params.maxCoverageLimit,
    params.premiumPeriod,
    params.gracePeriod,
  ]);
  const vrfSettings = { ...VRF_DEFAULTS, ...vrf };
  let vrfCoordinator = null;
  if (!vrfSettings.coordinator && existing.randomness) {
    throw new Error("Reusing a VRFRandomness needs the VRF coordinator it was deployed with.");
  }
  if (!vrfSettings.coordinator) {
    const local = await deployLocalVrf();
    vrfCoordinator = local.coordinator;
    vrfSettings.coordinator = await local.coordinator.getAddress();
    vrfSettings.subscriptionId = local.subscriptionId;
    vrfSettings.keyHash = local.keyHash;
  }
  const randomness = await deploy("VRFRandomness", [
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
  const jury = await deploy("JuryModule", [
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
  const claimManager = await deploy("ClaimManager", [
    await registry.getAddress(),
    await pool.getAddress(),
    await jury.getAddress(),
    params.responsePeriod,
    params.claimBondBps,
    params.minClaimBond,
    params.receiptPeriod,
  ]);

  // Each link is a one-time setter, so skip any an earlier, interrupted run already made.
  const links = [
    ["linking VRFRandomness to JuryModule", () => randomness.consumer(), () => randomness.setConsumer(jury)],
    ["linking Pool to PolicyRegistry", () => pool.registry(), () => pool.setRegistry(registry)],
    ["linking Pool to ClaimManager", () => pool.claimManager(), () => pool.setClaimManager(claimManager)],
    ["linking JuryModule to ClaimManager", () => jury.claimManager(), () => jury.setClaimManager(claimManager)],
    ["linking Pool to JuryModule", () => pool.jury(), () => pool.setJury(jury)],
  ];
  for (const [label, current, set] of links) {
    if (Object.keys(existing).length > 0 && (await current()) !== ethers.ZeroAddress) {
      if (log) log(`  already done: ${label}`);
      continue;
    }
    await step(label, set());
  }

  return { deployer, params, token, pool, registry, randomness, vrfCoordinator, vrf: vrfSettings, jury, claimManager };
}

module.exports = { deployContracts, DEFAULT_PARAMS, TESTNET_PARAMS, VRF_DEFAULTS, DAY, USDC };

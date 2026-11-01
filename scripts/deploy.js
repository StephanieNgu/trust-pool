// Deploys and wires all contracts, then writes their addresses to deployments/<network>.json
// so the frontend (or anything else) can find them.
//
//   npx hardhat node                                   # terminal 1
//   npx hardhat run scripts/deploy.js --network localhost  # terminal 2
//
// Jury randomness comes from Chainlink VRF v2.5. Locally that is Chainlink's coordinator mock,
// deployed alongside. On Sepolia it is Chainlink's real coordinator and your VRF subscription:
//
//   npx hardhat run scripts/deploy.js --network sepolia    # needs .env, see docs/vrf.md
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { deployContracts, USDC } = require("./lib/deployContracts");

const LOCAL_NETWORKS = ["hardhat", "localhost"];

/** Chainlink VRF v2.5 on public networks. Override with VRF_COORDINATOR / VRF_KEY_HASH in .env. */
const PUBLIC_VRF = {
  sepolia: {
    coordinator: "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B",
    keyHash: "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae",
  },
};

const COORDINATOR_ABI = [
  "function s_provingKeys(bytes32 keyHash) view returns (bool exists, uint64 maxGas)",
  "function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)",
  "function addConsumer(uint256 subId, address consumer)",
];

/** Reads and checks the VRF settings for a public network before anything is deployed. */
async function publicVrfSettings(deployer) {
  const env = process.env;
  const known = PUBLIC_VRF[network.name] ?? {};
  const coordinator = env.VRF_COORDINATOR || known.coordinator;
  const keyHash = env.VRF_KEY_HASH || known.keyHash;
  if (!coordinator || !keyHash) {
    throw new Error(`No Chainlink VRF settings for ${network.name}: set VRF_COORDINATOR and VRF_KEY_HASH.`);
  }
  if (!env.VRF_SUBSCRIPTION_ID) {
    throw new Error("Set VRF_SUBSCRIPTION_ID to your subscription from https://vrf.chain.link (see docs/vrf.md).");
  }
  const subscriptionId = BigInt(env.VRF_SUBSCRIPTION_ID);

  const c = new ethers.Contract(coordinator, COORDINATOR_ABI, deployer);
  const key = await c.s_provingKeys(keyHash);
  if (!key.exists) throw new Error(`Key hash ${keyHash} is not registered on the coordinator ${coordinator}.`);
  const sub = await c.getSubscription(subscriptionId).catch(() => {
    throw new Error(`Subscription ${subscriptionId} does not exist on ${coordinator}.`);
  });
  const nativePayment = env.VRF_NATIVE_PAYMENT === "true";
  if ((nativePayment ? sub.nativeBalance : sub.balance) === 0n) {
    console.warn(`Warning: subscription ${subscriptionId} has no ${nativePayment ? "native" : "LINK"} balance; fund it before filing a claim.`);
  }

  const settings = { coordinator, keyHash, subscriptionId, nativePayment };
  if (env.VRF_CALLBACK_GAS_LIMIT) settings.callbackGasLimit = Number(env.VRF_CALLBACK_GAS_LIMIT);
  return { settings, coordinatorContract: c, subOwner: sub.subOwner };
}
const FAUCET_AMOUNT = USDC(10_000);
const POOL_SEED = USDC(5_000);

async function main() {
  const local = LOCAL_NETWORKS.includes(network.name);
  const [deployer] = await ethers.getSigners();
  const vrf = local ? null : await publicVrfSettings(deployer);

  // Keep the production/default rule at seven days, but remove the wait from local UI testing and
  // from testnet demos, so a claim can be filed straight after joining.
  const overrides = local || network.name === "sepolia" ? { waitingPeriod: 0 } : {};
  const ctx = await deployContracts(overrides, vrf ? vrf.settings : {});
  const { chainId } = await ethers.provider.getNetwork();

  if (vrf) {
    const consumer = await ctx.randomness.getAddress();
    if (vrf.subOwner.toLowerCase() === deployer.address.toLowerCase()) {
      await (await vrf.coordinatorContract.addConsumer(vrf.settings.subscriptionId, consumer)).wait();
      console.log(`Added ${consumer} as a consumer of VRF subscription ${vrf.settings.subscriptionId}.`);
    } else {
      console.warn(
        `The deployer does not own VRF subscription ${vrf.settings.subscriptionId}. Its owner (${vrf.subOwner}) must ` +
          `add ${consumer} as a consumer at https://vrf.chain.link before claims can get a jury.`,
      );
    }
  }

  const addresses = {};
  for (const name of ["token", "pool", "registry", "randomness", "jury", "claimManager"]) {
    addresses[name] = await ctx[name].getAddress();
  }
  // Local chains get Chainlink's VRF coordinator mock, which the backend keeper drives.
  if (ctx.vrfCoordinator) addresses.vrfCoordinatorMock = await ctx.vrfCoordinator.getAddress();

  // On local networks, give every dev account some mock USDC to play with, and seed the pool so a
  // demo claim can be paid: a claim takes at most 20% of the pool, and premiums alone start it small.
  if (LOCAL_NETWORKS.includes(network.name)) {
    for (const s of await ethers.getSigners()) {
      await (await ctx.token.mint(s.address, FAUCET_AMOUNT)).wait();
    }
    // The seed comes from the last dev account, which the demo roles (accounts 0 to 5) never use.
    const signers = await ethers.getSigners();
    const treasury = signers[signers.length - 1];
    await (await ctx.token.mint(treasury.address, POOL_SEED)).wait();
    await (await ctx.token.connect(treasury).approve(await ctx.pool.getAddress(), POOL_SEED)).wait();
    await (await ctx.pool.connect(treasury).contribute(POOL_SEED)).wait();
  }

  const params = Object.fromEntries(Object.entries(ctx.params).map(([k, v]) => [k, v.toString()]));
  const vrfInfo = {
    coordinator: ctx.vrf.coordinator,
    subscriptionId: ctx.vrf.subscriptionId.toString(),
    keyHash: ctx.vrf.keyHash,
    mock: !vrf,
  };
  const out = { network: network.name, chainId: chainId.toString(), deployer: ctx.deployer.address, addresses, vrf: vrfInfo, params };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");

  console.log(`Deployed to ${network.name} (chainId ${chainId}):`);
  console.table(addresses);
  console.log(`Addresses written to ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

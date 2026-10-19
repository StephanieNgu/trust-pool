// Deploys and wires all contracts, then writes their addresses to deployments/<network>.json
// so the frontend (or anything else) can find them.
//
//   npx hardhat node                                   # terminal 1
//   npx hardhat run scripts/deploy.js --network localhost  # terminal 2
//
// Local networks use MockRandomness. Any other network uses Chainlink VRF v2.5 (see the README):
//   VRF_SUBSCRIPTION_ID   required: a funded VRF subscription owned by the deployer
//   VRF_COORDINATOR       defaults to the Sepolia coordinator on Sepolia
//   VRF_KEY_HASH          defaults to the Sepolia 100 gwei gas lane on Sepolia
//   VRF_CALLBACK_GAS_LIMIT, VRF_REQUEST_CONFIRMATIONS, VRF_NATIVE_PAYMENT=true   optional
//   RANDOMNESS=mock       forces MockRandomness (demo only: the deployer then picks every jury)
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { deployContracts, USDC } = require("./lib/deployContracts");

const LOCAL_NETWORKS = ["hardhat", "localhost"];
const FAUCET_AMOUNT = USDC(10_000);

// Chainlink VRF v2.5 on Ethereum Sepolia (https://docs.chain.link/vrf/v2-5/supported-networks).
const SEPOLIA_CHAIN_ID = 11155111n;
const SEPOLIA_VRF = {
  coordinator: "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B",
  keyHash: "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae",
};

/** Reads the VRF settings from the environment, or returns null for MockRandomness. */
function vrfConfig(chainId) {
  const local = LOCAL_NETWORKS.includes(network.name);
  const choice = process.env.RANDOMNESS ?? (local ? "mock" : "vrf");
  if (choice === "mock") return null;
  if (choice !== "vrf") throw new Error(`RANDOMNESS must be "mock" or "vrf", not "${choice}".`);

  const defaults = chainId === SEPOLIA_CHAIN_ID ? SEPOLIA_VRF : {};
  const vrf = {
    coordinator: process.env.VRF_COORDINATOR ?? defaults.coordinator,
    keyHash: process.env.VRF_KEY_HASH ?? defaults.keyHash,
    subscriptionId: process.env.VRF_SUBSCRIPTION_ID,
    addConsumer: true,
  };
  const missing = Object.entries({ VRF_COORDINATOR: vrf.coordinator, VRF_KEY_HASH: vrf.keyHash, VRF_SUBSCRIPTION_ID: vrf.subscriptionId })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Chainlink VRF needs ${missing.join(", ")}. Set RANDOMNESS=mock to deploy the demo randomness instead.`);
  }
  vrf.subscriptionId = BigInt(vrf.subscriptionId);
  if (process.env.VRF_CALLBACK_GAS_LIMIT) vrf.callbackGasLimit = Number(process.env.VRF_CALLBACK_GAS_LIMIT);
  if (process.env.VRF_REQUEST_CONFIRMATIONS) vrf.requestConfirmations = Number(process.env.VRF_REQUEST_CONFIRMATIONS);
  if (process.env.VRF_NATIVE_PAYMENT) vrf.nativePayment = process.env.VRF_NATIVE_PAYMENT === "true";
  return vrf;
}

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  const vrf = vrfConfig(chainId);
  // Keep the production/default rule at seven days, but remove the wait from local UI testing.
  const ctx = await deployContracts(LOCAL_NETWORKS.includes(network.name) ? { waitingPeriod: 0 } : {}, { vrf });

  const addresses = {};
  for (const name of ["token", "pool", "registry", "randomness", "jury", "claimManager"]) {
    addresses[name] = await ctx[name].getAddress();
  }

  // On local networks, give every dev account some mock USDC to play with.
  if (LOCAL_NETWORKS.includes(network.name)) {
    for (const s of await ethers.getSigners()) {
      await (await ctx.token.mint(s.address, FAUCET_AMOUNT)).wait();
    }
  }

  const params = Object.fromEntries(Object.entries(ctx.params).map(([k, v]) => [k, v.toString()]));
  const out = {
    network: network.name,
    chainId: chainId.toString(),
    deployer: ctx.deployer.address,
    randomnessProvider: ctx.randomnessProvider,
    addresses,
    params,
  };
  if (vrf) out.vrf = { coordinator: vrf.coordinator, subscriptionId: vrf.subscriptionId.toString(), keyHash: vrf.keyHash };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");

  console.log(`Deployed to ${network.name} (chainId ${chainId}) with ${ctx.randomnessProvider} randomness:`);
  console.table(addresses);
  console.log(`Addresses written to ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

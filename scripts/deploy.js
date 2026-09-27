// Deploys and wires all contracts, then writes their addresses to deployments/<network>.json
// so the frontend (or anything else) can find them.
//
//   npx hardhat node                                   # terminal 1
//   npx hardhat run scripts/deploy.js --network localhost  # terminal 2
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { deployContracts, USDC } = require("./lib/deployContracts");

const LOCAL_NETWORKS = ["hardhat", "localhost"];
const FAUCET_AMOUNT = USDC(10_000);

async function main() {
  const ctx = await deployContracts();
  const { chainId } = await ethers.provider.getNetwork();

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
  const out = { network: network.name, chainId: chainId.toString(), deployer: ctx.deployer.address, addresses, params };
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

// Files a claim on Sepolia and shows Chainlink VRF picking its jury, with Etherscan links to check.
//
//   npx hardhat run scripts/deploy.js --network sepolia          # once (see docs/vrf.md)
//   npx hardhat run scripts/sepolia-vrf-demo.js --network sepolia
//
// The demo uses six members (a claimant plus five possible jurors; Sepolia seats a jury of three). It makes throwaway wallets for
// them, saves their keys to deployments/sepolia-demo-wallets.json (git-ignored) so later runs reuse
// them, and funds each with a little Sepolia ETH from the deployer for gas. Members join, stake, and
// one files a claim; the script then waits for Chainlink's oracle to answer, and seats the jury from
// the seed it delivered (JuryModule.seatJury, which anyone may call). Nothing here can choose the
// seed: it arrives in the coordinator's own transaction, and seating only reads it.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const MEMBERS = 6;
const COVERAGE = ethers.parseUnits("1000", 6);
const CLAIM = ethers.parseUnits("100", 6);
const LIQUIDITY = ethers.parseUnits("5000", 6);
// Enough for approve, buyPolicy, stake and one claim at testnet gas prices.
const GAS_FUNDING = ethers.parseEther(process.env.DEMO_MEMBER_ETH || "0.003");
const WAIT_MINUTES = 10;

const root = path.join(__dirname, "..");
const deploymentFile = path.join(root, "deployments", `${network.name}.json`);
const walletsFile = path.join(root, "deployments", `${network.name}-demo-wallets.json`);
const explorer = network.name === "sepolia" ? "https://sepolia.etherscan.io" : null;
const txLink = (hash) => (explorer ? `${explorer}/tx/${hash}` : hash);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(label, txPromise) {
  const tx = await txPromise;
  await tx.wait();
  console.log(`    ${label}: ${txLink(tx.hash)}`);
  return tx;
}

function loadWallets() {
  let keys = [];
  if (fs.existsSync(walletsFile)) keys = JSON.parse(fs.readFileSync(walletsFile, "utf8"));
  while (keys.length < MEMBERS) keys.push(ethers.Wallet.createRandom().privateKey);
  fs.writeFileSync(walletsFile, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  return keys.map((k) => new ethers.Wallet(k, ethers.provider));
}

async function main() {
  if (["hardhat", "localhost"].includes(network.name)) {
    throw new Error("This demo is for a public network with real Chainlink VRF. Locally, use scripts/demo.js.");
  }
  if (!fs.existsSync(deploymentFile)) {
    throw new Error(`${deploymentFile} not found. Run scripts/deploy.js --network ${network.name} first.`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  const a = deployment.addresses;
  const [deployer] = await ethers.getSigners();
  const at = (name, address) => ethers.getContractAt(name, address, deployer);
  const token = await at("MockStablecoin", a.token);
  const pool = await at("Pool", a.pool);
  const registry = await at("PolicyRegistry", a.registry);
  const randomness = await at("VRFRandomness", a.randomness);
  const jury = await at("JuryModule", a.jury);
  const claimManager = await at("ClaimManager", a.claimManager);

  console.log(`Network ${network.name}; VRF coordinator ${await randomness.coordinator()}`);
  console.log(`Subscription ${await randomness.subscriptionId()}; deployer ${deployer.address}`);

  // Pick up a claim filed by an earlier run (for example one whose answer took longer than the wait).
  if (process.env.CLAIM_ID) {
    const claimId = BigInt(process.env.CLAIM_ID);
    // Look back about five hours of Sepolia blocks for Chainlink's delivery transaction.
    const fromBlock = Math.max(0, (await ethers.provider.getBlockNumber()) - 1500);
    console.log(`\nChecking claim #${claimId} from an earlier run`);
    await seatAndReport({ jury, randomness, claimId, fromBlock, address: a.randomness });
    return;
  }

  console.log("\n[1] Preparing six member wallets");
  const members = loadWallets();
  for (const m of members) {
    const balance = await ethers.provider.getBalance(m.address);
    if (balance < GAS_FUNDING / 2n) {
      await send(`fund ${m.address}`, deployer.sendTransaction({ to: m.address, value: GAS_FUNDING - balance }));
    }
  }

  console.log("\n[2] Members join and stake for jury duty");
  const minStake = await jury.minStake();
  for (const [i, m] of members.entries()) {
    if (!(await registry.isActive(m.address))) {
      await send(`mint mUSDC for member ${i}`, token.mint(m.address, ethers.parseUnits("500", 6)));
      await send(`member ${i} approves pool`, token.connect(m).approve(a.pool, ethers.MaxUint256));
      const device = ethers.keccak256(ethers.toUtf8Bytes(`sepolia-demo-device:${m.address}`));
      const enrollment = ethers.keccak256(ethers.toUtf8Bytes(`sepolia-demo-enrollment:${m.address}`));
      await send(`member ${i} buys a policy`, registry.connect(m).buyPolicy(device, COVERAGE, enrollment));
    }
    if ((await pool.stakeOf(m.address)) < minStake) {
      await send(`member ${i} stakes`, pool.connect(m).stake(minStake));
    }
  }

  if ((await pool.balance()) < LIQUIDITY / 2n) {
    console.log("\n[3] Seeding the pool so a claim can be paid");
    await send("mint liquidity", token.mint(deployer.address, LIQUIDITY));
    await send("approve", token.approve(a.pool, LIQUIDITY));
    await send("contribute", pool.contribute(LIQUIDITY));
  }

  console.log("\n[4] A member files a claim, which requests Chainlink VRF randomness");
  let claimant = null;
  for (const m of members) {
    const policy = await registry.getPolicy(m.address);
    if ((await claimManager.openClaimOfPolicy(policy.id)) === 0n) {
      claimant = m;
      break;
    }
  }
  if (!claimant) throw new Error("Every demo member already has an open claim; delete the wallets file to start over.");
  const evidence = ethers.keccak256(ethers.toUtf8Bytes(`sepolia-demo-evidence:${Date.now()}`));
  const submitTx = await send(`${claimant.address} files a claim`, claimManager.connect(claimant).submitClaim(CLAIM, evidence));
  // Read the claim and request ids from the receipt rather than from follow-up calls: a load-balanced
  // RPC can answer those from a node a block behind, which made an earlier run give up straight away.
  const receipt = await submitTx.wait();
  const fromBlock = receipt.blockNumber;
  const events = receipt.logs.map((l) => {
    for (const c of [claimManager, randomness]) {
      try {
        const e = c.interface.parseLog(l);
        if (e) return e;
      } catch {
        // another contract's event
      }
    }
    return null;
  });
  const claimId = events.find((e) => e?.name === "ClaimSubmitted").args.claimId;
  const requestId = events.find((e) => e?.name === "RandomnessRequested").args.requestId;
  console.log(`    Claim #${claimId}; VRF request ${requestId}`);
  console.log(`    (If this run stops early, CLAIM_ID=${claimId} picks the claim up later.)`);

  console.log(`\n[5] Waiting for Chainlink's oracle (usually 1 to 3 minutes, up to ${WAIT_MINUTES})`);
  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  while (Date.now() < deadline) {
    if ((await jury.seedOf(claimId)) !== 0n) break;
    process.stdout.write(".");
    await sleep(10_000);
  }
  console.log();
  await seatAndReport({ jury, randomness, claimId, fromBlock, address: a.randomness });
}

/** Events matching `filter` from `fromBlock` on, searched in 10-block steps (free RPC tiers cap the range). */
async function findEvents(contract, filter, fromBlock) {
  const found = [];
  const latest = await ethers.provider.getBlockNumber();
  for (let from = fromBlock; from <= latest && found.length === 0; from += 10) {
    found.push(...(await contract.queryFilter(filter, from, Math.min(from + 9, latest))));
  }
  return found;
}

/** Finds Chainlink's delivery, seats the jury from that seed and prints both, with Etherscan links. */
async function seatAndReport({ jury, randomness, claimId, fromBlock, address }) {
  const seed = await jury.seedOf(claimId);
  if (seed === 0n) {
    const failed = await findEvents(randomness, randomness.filters.RandomnessDeliveryFailed(claimId), fromBlock);
    if (failed.length > 0) {
      console.log(`Chainlink answered in ${txLink(failed[0].transactionHash)}, but the JuryModule rejected the seed`);
      console.log(`(revert data ${failed[0].args.reason}). The claim can be cancelled once its timeout passes.`);
      return;
    }
    console.log("No answer yet. Check the subscription's balance and consumers at https://vrf.chain.link,");
    console.log(`then run this again with CLAIM_ID=${claimId} to pick up this claim, or watch`);
    console.log(`${explorer ? `${explorer}/address/${address}` : address}.`);
    return;
  }

  const fulfilled = await findEvents(randomness, randomness.filters.RandomnessFulfilled(claimId), fromBlock);
  console.log(`    Chainlink delivered seed ${seed}`);
  if (fulfilled.length > 0) {
    console.log(`    In transaction ${txLink(fulfilled[fulfilled.length - 1].transactionHash)} (sent by the VRF coordinator)`);
  }

  if (await jury.canSeat(claimId)) {
    console.log("\n[6] Seating the jury from that seed (anyone may do this; the seed decides who sits)");
    await send("seatJury", jury.seatJury(claimId));
  }
  const jurors = await jury.getJurors(claimId);
  if (jurors.length === 0) {
    console.log(`    No jury seated (starved: ${await jury.starved(claimId)}); the claim can be cancelled.`);
    return;
  }
  console.log(`    Jurors for claim #${claimId}:`);
  for (const j of jurors) console.log(`      ${j}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

// Walks through the full happy-path claim flow and narrates each step.
//
//   npx hardhat run scripts/demo.js                        # in-process network, nothing to start
//   npx hardhat run scripts/demo.js --network localhost    # against a running `npx hardhat node`
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployContracts, USDC } = require("./lib/deployContracts");

const fmt = (amount) => `${ethers.formatUnits(amount, 6)} mUSDC`;
const short = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
const STATES = ["None", "Submitted", "JuryPending", "Voting", "Approved", "Rejected", "Paid"];
let step = 0;
const log = (msg) => console.log(`\n[${++step}] ${msg}`);

async function main() {
  const signers = await ethers.getSigners();
  const [, claimant, ...members] = signers;
  const policyholders = [claimant, ...members.slice(0, 6)];

  log("Deploying contracts");
  const { token, pool, registry, randomness, jury, claimManager, params } = await deployContracts();
  const poolAddr = await pool.getAddress();
  console.log(`    Pool at ${poolAddr}; jury of ${params.jurySize}, quorum ${params.quorum}`);

  log(`${policyholders.length} members join, each insuring one phone for ${fmt(USDC(1_000))}`);
  for (const [i, member] of policyholders.entries()) {
    await (await token.mint(member.address, USDC(500))).wait();
    await (await token.connect(member).approve(poolAddr, ethers.MaxUint256)).wait();
    const deviceIdHash = ethers.keccak256(ethers.toUtf8Bytes(`IMEI-35-000000-${i}`));
    await (await registry.connect(member).buyPolicy(deviceIdHash, USDC(1_000))).wait();
  }
  console.log(`    Premium each: ${fmt(await registry.premiumFor(USDC(1_000)))}`);

  log("A backer contributes extra liquidity");
  await (await token.mint(signers[0].address, USDC(5_000))).wait();
  await (await token.approve(poolAddr, USDC(5_000))).wait();
  await (await pool.contribute(USDC(5_000))).wait();
  console.log(`    Pool balance: ${fmt(await pool.balance())}; per-claim cap: ${fmt(await pool.maxPayout())}`);

  log(`Fast-forwarding past the ${Number(params.waitingPeriod) / 86400}-day waiting period`);
  await time.increase(params.waitingPeriod);

  log(`${short(claimant.address)} cracks their screen and files a claim for ${fmt(USDC(250))}`);
  // In the real app the UI uploads encrypted photos to IPFS and submits the content hash.
  const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("photos-of-cracked-screen.zip"));
  await (await claimManager.connect(claimant).submitClaim(USDC(250), evidenceHash)).wait();
  const claimId = await claimManager.claimCount();
  console.log(`    Claim #${claimId}, evidence ${evidenceHash.slice(0, 18)}…`);
  console.log(`    State: ${STATES[(await claimManager.getClaim(claimId)).state]}`);

  log("Randomness provider responds (MOCK: not secure randomness)");
  await (await randomness.fulfillWithBlockhash(claimId)).wait();
  const jurorAddrs = await jury.getJurors(claimId);
  console.log(`    Jurors: ${jurorAddrs.map(short).join(", ")}`);
  console.log(`    State: ${STATES[(await claimManager.getClaim(claimId)).state]}`);

  log("Jurors review the evidence and vote");
  for (const [i, addr] of jurorAddrs.entries()) {
    const juror = signers.find((s) => s.address === addr);
    const approve = i !== jurorAddrs.length - 1; // last juror dissents, to show it's a real tally
    await (await jury.connect(juror).castVote(claimId, approve)).wait();
    console.log(`    ${short(addr)} votes ${approve ? "APPROVE" : "REJECT"}`);
  }

  log("Finalizing (all jurors voted, so no need to wait for the deadline)");
  await (await claimManager.finalize(claimId)).wait();
  console.log(`    State: ${STATES[(await claimManager.getClaim(claimId)).state]}`);

  log("Executing payout");
  const before = await token.balanceOf(claimant.address);
  await (await claimManager.executePayout(claimId)).wait();
  const after = await token.balanceOf(claimant.address);
  console.log(`    Claimant received ${fmt(after - before)}`);
  console.log(`    State: ${STATES[(await claimManager.getClaim(claimId)).state]}`);
  console.log(`    Pool balance now: ${fmt(await pool.balance())}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

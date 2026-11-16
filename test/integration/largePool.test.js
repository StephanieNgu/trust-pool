// Integration: seating a jury in a pool bigger than the classroom demo. Chainlink delivers the VRF
// word inside a fixed callback gas limit (1,000,000 by default), and the local coordinator mock
// enforces the same limit. Before the fix, the draw copied and filtered every policyholder inside
// that callback, so from about 35 members on the callback ran out of gas, the jury was never
// seated, and every claim ended up cancelled after the randomness timeout.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, deviceHash, enrollmentHash, deliverRandomness, callbackSucceeded, COVERAGE, EVIDENCE, USDC, JuryPhase, ClaimState } = require("../helpers");

/** Deploys the protocol with `n` fresh wallets that bought policies, staked, and passed the waiting period. */
async function poolOf(n) {
  const ctx = await deployFixture();
  const { token, pool, registry, deployer, params } = ctx;
  const poolAddr = await pool.getAddress();
  await token.mint(deployer.address, USDC(50_000));
  await token.approve(poolAddr, USDC(50_000));
  await pool.contribute(USDC(50_000));
  const members = [];
  for (let i = 0; i < n; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
    await token.mint(w.address, USDC(1_000));
    await token.connect(w).approve(poolAddr, ethers.MaxUint256);
    await registry.connect(w).buyPolicy(deviceHash(`big-${i}`), COVERAGE, enrollmentHash(`big-${i}`));
    await pool.connect(w).stake(params.minJurorStake);
    members.push(w);
  }
  await time.increase(params.waitingPeriod);
  return { ...ctx, members };
}

const pool40 = () => poolOf(40);
const pool60 = () => poolOf(60);

async function fileAndFulfill(ctx, claimant, word) {
  await ctx.claimManager.connect(claimant).submitClaim(USDC(100), EVIDENCE);
  const claimId = await ctx.claimManager.claimCount();
  // Step 1: Chainlink's callback, which only stores the seed. Step 2: anyone seats the jury.
  const callback = await (await deliverRandomness(ctx, claimId, word)).wait();
  const receipt = await (await ctx.jury.seatJury(claimId)).wait();
  return { claimId, callback, receipt };
}

describe("Integration: jury draw in a large pool", function () {
  this.timeout(300_000);

  it("seats a jury of 5 from 40 members, with a callback well inside Chainlink's gas limit", async function () {
    const ctx = await loadFixture(pool40);
    const { claimId, callback, receipt } = await fileAndFulfill(ctx, ctx.members[0]);
    await expect(callback).to.not.emit(ctx.randomness, "RandomnessDeliveryFailed");
    expect((await ctx.jury.getJury(claimId)).phase).to.equal(JuryPhase.Voting);
    expect((await ctx.claimManager.getClaim(claimId)).state).to.equal(ClaimState.Voting);
    const jurors = await ctx.jury.getJurors(claimId);
    expect(new Set(jurors).size).to.equal(5);
    expect(jurors).to.not.include(ctx.members[0].address);
    // The callback only stores the seed, so it fits in the small gas limit the VRF request asks for
    // (which keeps down the LINK the subscription has to hold in reserve).
    expect(callbackSucceeded(ctx, callback)).to.equal(true);
    // Seating is an ordinary transaction with no Chainlink limit, but it is still bounded.
    expect(receipt.gasUsed).to.be.lessThan(750_000n);
  });

  it("keeps the seating gas flat as the pool grows", async function () {
    const ctx = await loadFixture(pool60);
    const { callback, receipt } = await fileAndFulfill(ctx, ctx.members[0]);
    await expect(callback).to.not.emit(ctx.randomness, "RandomnessDeliveryFailed");
    expect(receipt.gasUsed).to.be.lessThan(750_000n);
  });

  it("never seats an ineligible member, and stays in budget when most members are ineligible", async function () {
    const ctx = await loadFixture(pool60);
    // 45 of the 60 withdraw their stake, so only 14 (besides the claimant) can be picked.
    for (const m of ctx.members.slice(15)) await ctx.pool.connect(m).unstake(ctx.params.minJurorStake);
    let seated = 0;
    let starved = 0;
    for (let i = 0; i < 6; i++) {
      // Each claim gets its own claimant, since a policy holds one open claim at a time.
      const word = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`sparse-${i}`)));
      const claimant = ctx.members[i];
      const { claimId, callback, receipt } = await fileAndFulfill(ctx, claimant, word);
      await expect(callback).to.not.emit(ctx.randomness, "RandomnessDeliveryFailed");
      expect(receipt.gasUsed).to.be.lessThan(900_000n);
      const jurors = await ctx.jury.getJurors(claimId);
      if (jurors.length === 0) {
        starved++;
        expect(await ctx.jury.canCancel(claimId)).to.equal(true);
        continue;
      }
      seated++;
      for (const j of jurors) {
        expect(j).to.not.equal(claimant.address);
        expect(await ctx.pool.stakeOf(j)).to.be.at.least(ctx.params.minJurorStake);
      }
    }
    // With a quarter of the pool eligible, 30 draws fill 5 seats nearly every time.
    expect(seated).to.be.at.least(5);
    expect(seated + starved).to.equal(6);
  });

  it("spreads seats across every eligible member", async function () {
    const ctx = await loadFixture(pool40);
    const picks = new Map();
    // Different claimants and words; each claim locks its jurors' stakes but leaves them eligible.
    for (let i = 0; i < 12; i++) {
      const word = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`spread-${i}`)));
      const { claimId } = await fileAndFulfill(ctx, ctx.members[i], word);
      for (const a of await ctx.jury.getJurors(claimId)) picks.set(a, (picks.get(a) ?? 0) + 1);
    }
    // 60 seats over 40 members: a biased draw (say, always the first holders) would reach few of them.
    expect(picks.size).to.be.greaterThan(25);
    expect(Math.max(...picks.values())).to.be.lessThan(8);
  });
});

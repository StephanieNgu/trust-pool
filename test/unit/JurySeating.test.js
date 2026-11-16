// Jury selection takes two steps: the VRF callback only stores the seed, then anyone calls
// JuryModule.seatJury. These tests pin down what the gap between the two steps allows: members can
// see the seed before seating, so the only thing they must be able to do with it is drop out, which
// removes themselves and nobody else. Nobody can join a draw, re-roll it, or reorder it.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  activePoolFixture,
  submitClaim,
  deliverRandomness,
  callbackSucceeded,
  deviceHash,
  enrollmentHash,
  COVERAGE,
  JuryPhase,
  ClaimState,
} = require("../helpers");

const coder = ethers.AbiCoder.defaultAbiCoder();
const score = (seed, member) => BigInt(ethers.keccak256(coder.encode(["uint256", "address"], [seed, member])));
/** The jury seatJury should seat in a small pool: the `size` candidates with the lowest scores. */
const expectedJury = (seed, candidates, size) =>
  [...candidates].sort((a, b) => (score(seed, a) < score(seed, b) ? -1 : 1)).slice(0, size);
/** The first seed (from a fixed sequence) for which `want(seed)` holds, so tests do not depend on luck. */
function seedWhere(want) {
  for (let i = 0; i < 10_000; i++) {
    const seed = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`seating-seed-${i}`)));
    if (want(seed)) return seed;
  }
  throw new Error("no seed found");
}

async function pendingFixture() {
  const ctx = await activePoolFixture();
  const claimId = await submitClaim(ctx, ctx.claimant);
  const others = ctx.holders.filter((h) => h.address !== ctx.claimant.address).map((h) => h.address);
  return { ...ctx, claimId, others };
}

/** A member who bought a policy and served the waiting period before the claim, but had not staked. */
async function lateStakerFixture() {
  const ctx = await activePoolFixture();
  const late = ctx.signers[12];
  await ctx.token.mint(late.address, ethers.parseUnits("1000", 6));
  await ctx.token.connect(late).approve(await ctx.pool.getAddress(), ethers.MaxUint256);
  await ctx.registry.connect(late).buyPolicy(deviceHash("late"), COVERAGE, enrollmentHash("late"));
  await time.increase(ctx.params.waitingPeriod);
  const claimId = await submitClaim(ctx, ctx.claimant);
  const others = ctx.holders.filter((h) => h.address !== ctx.claimant.address).map((h) => h.address);
  return { ...ctx, claimId, others, late };
}

describe("Seating a jury after the VRF answer", function () {
  describe("the two steps", function () {
    it("stores the seed in the callback and seats the jury only when seatJury is called", async function () {
      const ctx = await loadFixture(pendingFixture);
      const { jury, claimManager, claimId } = ctx;
      expect(await jury.canSeat(claimId)).to.equal(false);
      await expect(jury.seatJury(claimId)).to.be.revertedWithCustomError(jury, "NotSeeded");

      await expect(deliverRandomness(ctx, claimId, 42n)).to.emit(jury, "SeedReceived").withArgs(claimId, 42n).and.not.to.emit(jury, "JurySelected");
      expect((await jury.getJury(claimId)).phase).to.equal(JuryPhase.AwaitingRandomness);
      expect(await jury.getJurors(claimId)).to.have.lengthOf(0);
      expect(await jury.canSeat(claimId)).to.equal(true);

      // Anyone may seat it: here a member who is not involved in the claim.
      await expect(jury.connect(ctx.signers[15]).seatJury(claimId)).to.emit(jury, "JurySelected");
      expect((await jury.getJury(claimId)).phase).to.equal(JuryPhase.Voting);
      expect((await claimManager.getClaim(claimId)).state).to.equal(ClaimState.Voting);
      expect(await jury.canSeat(claimId)).to.equal(false);
      await expect(jury.seatJury(claimId)).to.be.revertedWithCustomError(jury, "WrongPhase");
    });

    it("seats exactly the jury anyone can work out from the public seed", async function () {
      const ctx = await loadFixture(pendingFixture);
      const seed = 123456789n;
      await deliverRandomness(ctx, ctx.claimId, seed);
      await ctx.jury.seatJury(ctx.claimId);
      const size = Number(await ctx.jury.jurySize());
      expect(await ctx.jury.getJurors(ctx.claimId)).to.deep.equal(expectedJury(seed, ctx.others, size));
    });

    it("keeps the callback small enough for a 100k gas limit, which needs far less LINK", async function () {
      const ctx = await loadFixture(pendingFixture);
      expect(await ctx.randomness.callbackGasLimit()).to.equal(100_000n);
      const receipt = await (await deliverRandomness(ctx, ctx.claimId, ethers.MaxUint256 - 1n)).wait();
      // The mock forwards exactly the requested gas to the callback, as Chainlink does.
      expect(callbackSucceeded(ctx, receipt)).to.equal(true);
      expect(await ctx.jury.seedOf(ctx.claimId)).to.equal(ethers.MaxUint256 - 1n);
    });
  });

  describe("what seeing the seed early allows", function () {
    it("a member who drops out only removes themselves; the next in line takes the seat", async function () {
      const ctx = await loadFixture(pendingFixture);
      const { jury, pool, claimId, others } = ctx;
      const size = Number(await jury.jurySize());
      const seed = 2024n;
      const before = expectedJury(seed, others, size);
      await deliverRandomness(ctx, claimId, seed);

      // The top-ranked member sees the seed and unstakes before the jury is seated.
      const leaver = ctx.signers.find((s) => s.address === before[0]);
      await pool.connect(leaver).unstake(await pool.stakeOf(leaver.address));
      await jury.seatJury(claimId);

      const seated = await jury.getJurors(claimId);
      expect(seated).to.not.include(leaver.address);
      // Everyone else who would have sat still sits, in the same order, plus the next member.
      expect(seated.slice(0, size - 1)).to.deep.equal(before.slice(1));
      expect(seated).to.deep.equal(expectedJury(seed, others.filter((a) => a !== leaver.address), size));
    });

    it("a member who staked after the claim was filed cannot join, even if the seed favours them", async function () {
      const ctx = await loadFixture(lateStakerFixture);
      const { jury, pool, claimId, others, late } = ctx;
      const size = Number(await jury.jurySize());
      // A seed under which the late member would be first in line if they counted.
      const seed = seedWhere((s) => expectedJury(s, [...others, late.address], size)[0] === late.address);
      await deliverRandomness(ctx, claimId, seed);

      await pool.connect(late).stake(ctx.params.minJurorStake);
      await jury.seatJury(claimId);
      const seated = await jury.getJurors(claimId);
      expect(seated).to.not.include(late.address);
      expect(seated).to.deep.equal(expectedJury(seed, others, size));
    });

    it("a member whose policy started after filing cannot join either", async function () {
      const ctx = await loadFixture(pendingFixture);
      const { jury, pool, registry, claimId, others } = ctx;
      const size = Number(await jury.jurySize());
      // Re-buying cover after filing (here: cancel and buy again) resets the policy's start, so the
      // member is no longer a candidate for this claim.
      const rebuyer = ctx.signers.find((s) => s.address === others[0]);
      const seed = seedWhere((s) => expectedJury(s, others, size)[0] === rebuyer.address);
      await deliverRandomness(ctx, claimId, seed);
      await registry.connect(rebuyer).cancelPolicy();
      await registry.connect(rebuyer).buyPolicy(deviceHash("rebuy"), COVERAGE, enrollmentHash("rebuy"));
      await time.increase(ctx.params.waitingPeriod);
      expect(await registry.isPastWaitingPeriod(rebuyer.address)).to.equal(true);
      expect(await pool.stakeOf(rebuyer.address)).to.be.greaterThan(0n);

      await jury.seatJury(claimId);
      expect(await jury.getJurors(claimId)).to.not.include(rebuyer.address);
    });

    it("a brand-new member who joins after filing is never a candidate", async function () {
      const ctx = await loadFixture(pendingFixture);
      const { jury, pool, registry, token, claimId, others } = ctx;
      const size = Number(await jury.jurySize());
      const newcomer = ctx.signers[13];
      const seed = seedWhere((s) => expectedJury(s, [...others, newcomer.address], size)[0] === newcomer.address);
      await deliverRandomness(ctx, claimId, seed);

      await token.mint(newcomer.address, ethers.parseUnits("1000", 6));
      await token.connect(newcomer).approve(await pool.getAddress(), ethers.MaxUint256);
      await registry.connect(newcomer).buyPolicy(deviceHash("newcomer"), COVERAGE, enrollmentHash("newcomer"));
      await pool.connect(newcomer).stake(ctx.params.minJurorStake);
      await time.increase(ctx.params.waitingPeriod);

      await jury.seatJury(claimId);
      expect(await jury.getJurors(claimId)).to.deep.equal(expectedJury(seed, others, size));
    });

    it("once the seed is in, nobody can cancel the claim to throw the draw away", async function () {
      const ctx = await loadFixture(pendingFixture);
      const { jury, claimManager, claimId } = ctx;
      await time.increase(ctx.params.randomnessTimeout + 1);
      expect(await jury.canCancel(claimId)).to.equal(true); // no answer yet: cancellable
      await deliverRandomness(ctx, claimId, 5n);
      expect(await jury.canCancel(claimId)).to.equal(false);
      expect(await jury.cancelAvailableAt(claimId)).to.equal(0n);
      await expect(claimManager.connect(ctx.claimant).cancelStalledClaim(claimId)).to.be.reverted;
      await expect(jury.seatJury(claimId)).to.emit(jury, "JurySelected");
    });
  });

  describe("too few candidates at seating", function () {
    it("starves the claim instead of seating a short jury, and it can be cancelled at once", async function () {
      const ctx = await loadFixture(pendingFixture);
      const { jury, pool, claimManager, claimId, others } = ctx;
      const size = Number(await jury.jurySize());
      await deliverRandomness(ctx, claimId, 9n);
      // Enough members drop out that only size - 1 candidates remain.
      for (const address of others.slice(0, others.length - (size - 1))) {
        const m = ctx.signers.find((s) => s.address === address);
        await pool.connect(m).unstake(await pool.stakeOf(address));
      }
      await expect(jury.seatJury(claimId)).to.emit(jury, "JuryStarved").withArgs(claimId, size - 1, size);
      expect(await jury.getJurors(claimId)).to.have.lengthOf(0);
      expect(await jury.canSeat(claimId)).to.equal(false);
      expect(await jury.canCancel(claimId)).to.equal(true);
      await expect(claimManager.connect(ctx.claimant).cancelStalledClaim(claimId)).to.emit(jury, "JuryCancelled");
    });
  });
});

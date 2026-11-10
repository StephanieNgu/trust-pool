const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployContracts } = require("../../scripts/lib/deployContracts");
const {
  activePoolFixture,
  selectJury,
  submitClaim,
  castVotes,
  stakeAsJuror,
  deviceHash,
  enrollmentHash,
  USDC,
  RECEIPT,
  ClaimState,
} = require("../helpers");

// Money promised to a claim is reserved in the Pool when the jury makes its offer, so two claims can
// never be offered the same funds and an accepted claim can always be paid.

/**
 * A small pool with a high per-claim cap (60%), where two large claims are open at the same time.
 * Free reserve before any claim: 1,000 seed + 7 premiums of 50 = 1,350.
 */
async function concurrentFixture() {
  const ctx = await deployContracts({ premiumBps: 500, maxPayoutBps: 6_000 });
  const signers = await ethers.getSigners();
  const { token, pool, registry, deployer } = ctx;
  await token.mint(deployer.address, USDC(1_000));
  await token.connect(deployer).approve(await pool.getAddress(), USDC(1_000));
  await pool.connect(deployer).contribute(USDC(1_000));
  const holders = signers.slice(1, 8);
  for (const [i, h] of holders.entries()) {
    await token.mint(h.address, USDC(1_000));
    await token.connect(h).approve(await pool.getAddress(), ethers.MaxUint256);
    await registry.connect(h).buyPolicy(deviceHash(i), USDC(1_000), enrollmentHash(i));
    await stakeAsJuror({ ...ctx, signers }, h);
  }
  await time.increase(ctx.params.waitingPeriod);
  return { ...ctx, signers, holders };
}

/** Files a claim for `amount` from `claimant` and has its whole jury vote for the full ask. */
async function votedClaim(ctx, claimant, amount) {
  const claimId = await submitClaim(ctx, claimant, amount);
  const jurors = await selectJury(ctx, claimId, BigInt(claimId) * 7919n);
  await castVotes(ctx, claimId, jurors, jurors.map(() => amount));
  return claimId;
}

describe("Fund reservation for concurrent payouts", function () {
  it("never offers two claims the same money, and pays both", async function () {
    const ctx = await loadFixture(concurrentFixture);
    const { pool, claimManager, token, holders } = ctx;
    const [alice, bob] = holders;

    // Both claims are filed and voted on before either is decided.
    const first = await votedClaim(ctx, alice, USDC(800));
    const second = await votedClaim(ctx, bob, USDC(800));

    // First decision: 2% fee (16) leaves 1,334 free, so the 60% cap (800.4) lets the full 800 through.
    await claimManager.finalize(first);
    const a = await claimManager.getClaim(first);
    expect(a.approvedAmount).to.equal(USDC(800));
    expect(await pool.totalReserved()).to.equal(USDC(800));
    expect(await claimManager.reservedFor(first)).to.equal(USDC(800));
    expect(await pool.balance()).to.equal(USDC(534));

    // Second decision: another 16 in fees leaves 518 free. Without the reservation the cap would
    // still see the first claim's 800 and offer 800 again, 1,600 against a 1,318 reserve.
    await claimManager.finalize(second);
    const b = await claimManager.getClaim(second);
    expect(b.approvedAmount).to.equal(USDC(310.8));
    expect(await pool.totalReserved()).to.equal(USDC(800) + USDC(310.8));
    expect(await pool.balance()).to.equal(USDC(518) - USDC(310.8));

    for (const [id, who] of [[first, alice], [second, bob]]) {
      await claimManager.connect(who).acceptOffer(id);
      const { approvedAmount } = await claimManager.getClaim(id);
      await claimManager.connect(who).submitReceipt(id, RECEIPT, approvedAmount);
    }

    // Pay the second (smaller, later) claim first, then the first: both succeed.
    const bobBefore = await token.balanceOf(bob.address);
    await expect(claimManager.executePayout(second)).to.emit(pool, "PaidOut").withArgs(bob.address, USDC(310.8));
    expect((await token.balanceOf(bob.address)) - bobBefore).to.equal(USDC(310.8));
    await expect(claimManager.executePayout(first)).to.emit(pool, "PaidOut").withArgs(alice.address, USDC(800));

    expect((await claimManager.getClaim(first)).state).to.equal(ClaimState.Paid);
    expect((await claimManager.getClaim(second)).state).to.equal(ClaimState.Paid);
    expect(await pool.totalReserved()).to.equal(0n);
    expect(await claimManager.reservedFor(first)).to.equal(0n);
    expect(await claimManager.reservedFor(second)).to.equal(0n);
    expect(await pool.balance()).to.equal(USDC(518) - USDC(310.8));
  });

  it("keeps reserved funds away from juror fees", async function () {
    const ctx = await loadFixture(concurrentFixture);
    const { pool, claimManager, holders } = ctx;
    const first = await votedClaim(ctx, holders[0], USDC(800));
    await claimManager.finalize(first);
    const reserved = await pool.totalReserved();
    // Whatever later juries are paid, the reservation stays covered by tokens the Pool holds.
    const second = await votedClaim(ctx, holders[1], USDC(800));
    await claimManager.finalize(second);
    const held = await ctx.token.balanceOf(await pool.getAddress());
    expect(held).to.be.gte((await pool.totalStaked()) + (await pool.totalBonded()) + (await pool.totalReserved()));
    expect(await claimManager.reservedFor(first)).to.equal(reserved);
  });

  it("closes an approved claim when everything is already reserved, instead of offering 0", async function () {
    // With a 100% cap the first offer can take the whole free reserve, leaving nothing for the next.
    const ctx = await deployContracts({ premiumBps: 500, maxPayoutBps: 10_000 });
    const signers = await ethers.getSigners();
    const holders = signers.slice(1, 8);
    for (const [i, h] of holders.entries()) {
      await ctx.token.mint(h.address, USDC(1_000));
      await ctx.token.connect(h).approve(await ctx.pool.getAddress(), ethers.MaxUint256);
      await ctx.registry.connect(h).buyPolicy(deviceHash(i), USDC(1_000), enrollmentHash(i));
      await stakeAsJuror({ ...ctx, signers }, h);
    }
    await time.increase(ctx.params.waitingPeriod);
    const run = { ...ctx, signers, holders };
    const [alice, bob] = holders;

    const first = await votedClaim(run, alice, USDC(1_000));
    const second = await votedClaim(run, bob, USDC(100));
    await ctx.claimManager.finalize(first);
    expect(await ctx.pool.balance()).to.equal(0n);

    const bobBefore = await ctx.token.balanceOf(bob.address);
    await ctx.claimManager.finalize(second);
    const b = await ctx.claimManager.getClaim(second);
    expect(b.state).to.equal(ClaimState.Rejected);
    expect(b.approvedAmount).to.equal(0n);
    expect(b.bondForfeited, "the jury paid in full, so no bond is kept").to.equal(0n);
    expect((await ctx.token.balanceOf(bob.address)) - bobBefore).to.equal(b.bond);
    expect(await ctx.claimManager.openClaimOfPolicy((await ctx.registry.getPolicy(bob.address)).id)).to.equal(0n);
    expect(await ctx.claimManager.reservedFor(second)).to.equal(0n);
  });

  describe("releases", function () {
    async function offered() {
      const ctx = await activePoolFixture();
      const claimId = await submitClaim(ctx, ctx.claimant, USDC(400));
      const jurors = await selectJury(ctx, claimId);
      await castVotes(ctx, claimId, jurors, jurors.map(() => USDC(400)));
      await ctx.claimManager.finalize(claimId);
      return { ...ctx, claimId };
    }

    it("reserves the offer when the jury decides", async function () {
      const { pool, claimManager, claimId } = await loadFixture(offered);
      expect((await claimManager.getClaim(claimId)).state).to.equal(ClaimState.Offered);
      expect(await claimManager.reservedFor(claimId)).to.equal(USDC(400));
      expect(await pool.totalReserved()).to.equal(USDC(400));
    });

    it("releases everything when the claimant withdraws", async function () {
      const { pool, claimManager, claimant, claimId } = await loadFixture(offered);
      const before = await pool.balance();
      await expect(claimManager.connect(claimant).withdrawClaim(claimId))
        .to.emit(pool, "Released")
        .withArgs(USDC(400), 0n);
      expect(await claimManager.reservedFor(claimId)).to.equal(0n);
      expect(await pool.balance()).to.equal(before + USDC(400));
    });

    it("releases the difference when the receipt is below the offer", async function () {
      const { pool, claimManager, claimant, claimId } = await loadFixture(offered);
      await claimManager.connect(claimant).acceptOffer(claimId);
      await claimManager.connect(claimant).submitReceipt(claimId, RECEIPT, USDC(250));
      expect(await claimManager.reservedFor(claimId)).to.equal(USDC(250));
      expect(await pool.totalReserved()).to.equal(USDC(250));
      await claimManager.executePayout(claimId);
      expect(await pool.totalReserved()).to.equal(0n);
      expect((await claimManager.getClaim(claimId)).paidAmount).to.equal(USDC(250));
    });

    it("keeps the full reservation when the receipt is above the offer", async function () {
      const { pool, claimManager, claimant, claimId } = await loadFixture(offered);
      await claimManager.connect(claimant).acceptOffer(claimId);
      await claimManager.connect(claimant).submitReceipt(claimId, RECEIPT, USDC(900));
      expect(await pool.totalReserved()).to.equal(USDC(400));
    });

    it("releases everything when no receipt arrives in time", async function () {
      const { pool, claimManager, claimant, claimId, params } = await loadFixture(offered);
      await claimManager.connect(claimant).acceptOffer(claimId);
      await time.increase(params.receiptPeriod + 1);
      await claimManager.expireClaim(claimId);
      expect(await claimManager.reservedFor(claimId)).to.equal(0n);
      expect(await pool.totalReserved()).to.equal(0n);
    });

    it("reserves nothing for a rejected claim", async function () {
      const ctx = await loadFixture(activePoolFixture);
      const claimId = await submitClaim(ctx, ctx.claimant, USDC(400));
      const jurors = await selectJury(ctx, claimId);
      await castVotes(ctx, claimId, jurors, jurors.map(() => 0n));
      await ctx.claimManager.finalize(claimId);
      expect((await ctx.claimManager.getClaim(claimId)).state).to.equal(ClaimState.Rejected);
      expect(await ctx.pool.totalReserved()).to.equal(0n);
    });
  });
});

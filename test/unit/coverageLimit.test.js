const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  activePoolFixture,
  selectJury,
  submitClaim,
  castVotes,
  finalizeAndAccept,
  deviceHash,
  enrollmentHash,
  USDC,
  COVERAGE,
  RECEIPT,
  EVIDENCE,
  ClaimState,
} = require("../helpers");

// Coverage is a lifetime limit per device: each payout counts against it, so a holder cannot claim
// the full limit again and again, and cancelling and re-buying cover for the same device does not
// reset it.

/** Files a claim for `amount`, has the jury agree to all of it, and pays it against a full receipt. */
async function paidClaim(ctx, claimant, amount) {
  const claimId = await submitClaim(ctx, claimant, amount);
  const jurors = await selectJury(ctx, claimId, BigInt(claimId) * 31n);
  await castVotes(ctx, claimId, jurors, jurors.map(() => amount));
  await finalizeAndAccept(ctx, claimId, claimant);
  await ctx.claimManager.executePayout(claimId);
  return claimId;
}

describe("Lifetime coverage limit", function () {
  it("counts each payout against the device's coverage", async function () {
    const ctx = await loadFixture(activePoolFixture);
    const { claimManager, claimant } = ctx;
    const device = (await ctx.registry.getPolicy(claimant.address)).deviceIdHash;
    expect(await claimManager.remainingCoverage(claimant.address)).to.equal(COVERAGE);

    const first = await paidClaim(ctx, claimant, USDC(600));
    expect(await claimManager.deviceOfClaim(first)).to.equal(device);
    expect(await claimManager.paidOnDevice(device)).to.equal(USDC(600));
    expect(await claimManager.remainingCoverage(claimant.address)).to.equal(USDC(400));

    // Asking for more than is left is refused, with how much is left.
    await expect(claimManager.connect(claimant).submitClaim(USDC(400) + 1n, EVIDENCE))
      .to.be.revertedWithCustomError(claimManager, "CoverageUsedUp")
      .withArgs(USDC(400) + 1n, USDC(400));

    // What is left can still be claimed, and then the cover is used up.
    await paidClaim(ctx, claimant, USDC(400));
    expect(await claimManager.remainingCoverage(claimant.address)).to.equal(0n);
    await expect(claimManager.connect(claimant).submitClaim(1n, EVIDENCE))
      .to.be.revertedWithCustomError(claimManager, "CoverageUsedUp")
      .withArgs(1n, 0n);
  });

  it("counts only what was paid: a lower receipt uses less, and a closed claim uses none", async function () {
    const ctx = await loadFixture(activePoolFixture);
    const { claimManager, claimant } = ctx;

    // Offered 500, but the repair cost 300: only 300 is used.
    const id = await submitClaim(ctx, claimant, USDC(500));
    const jurors = await selectJury(ctx, id);
    await castVotes(ctx, id, jurors, jurors.map(() => USDC(500)));
    await finalizeAndAccept(ctx, id, claimant, { receipt: false });
    await claimManager.connect(claimant).submitReceipt(id, RECEIPT, USDC(300));
    await claimManager.executePayout(id);
    expect(await claimManager.remainingCoverage(claimant.address)).to.equal(USDC(700));

    // A rejected claim pays nothing, so nothing is used.
    const rejected = await submitClaim(ctx, claimant, USDC(700));
    const jury2 = await selectJury(ctx, rejected, 7n);
    await castVotes(ctx, rejected, jury2, jury2.map(() => 0n));
    await claimManager.finalize(rejected);
    expect((await claimManager.getClaim(rejected)).state).to.equal(ClaimState.Rejected);
    expect(await claimManager.remainingCoverage(claimant.address)).to.equal(USDC(700));

    // Nor does a withdrawn one.
    const withdrawn = await submitClaim(ctx, claimant, USDC(700));
    const jury3 = await selectJury(ctx, withdrawn, 11n);
    await castVotes(ctx, withdrawn, jury3, jury3.map(() => USDC(700)));
    await claimManager.finalize(withdrawn);
    await claimManager.connect(claimant).withdrawClaim(withdrawn);
    expect(await claimManager.remainingCoverage(claimant.address)).to.equal(USDC(700));
  });

  it("does not reset when the holder cancels and buys new cover for the same device", async function () {
    const ctx = await loadFixture(activePoolFixture);
    const { claimManager, registry, claimant, params } = ctx;
    await paidClaim(ctx, claimant, USDC(800));

    await registry.connect(claimant).cancelPolicy();
    expect(await claimManager.remainingCoverage(claimant.address)).to.equal(0n, "no active policy");
    // Same device (signup index 0 in the fixture), new photos, new policy.
    await registry.connect(claimant).buyPolicy(deviceHash(0), COVERAGE, enrollmentHash("again"));
    expect(await claimManager.remainingCoverage(claimant.address)).to.equal(USDC(200));
    await time.increase(params.waitingPeriod);
    await expect(claimManager.connect(claimant).submitClaim(USDC(201), EVIDENCE))
      .to.be.revertedWithCustomError(claimManager, "CoverageUsedUp")
      .withArgs(USDC(201), USDC(200));

    // A different device starts with its full cover.
    await registry.connect(claimant).cancelPolicy();
    await registry.connect(claimant).buyPolicy(deviceHash("new phone"), COVERAGE, enrollmentHash("new phone"));
    expect(await claimManager.remainingCoverage(claimant.address)).to.equal(COVERAGE);
  });

  it("measures what is left against the current policy's limit", async function () {
    // Raising the limit on a new policy adds only the difference; lowering it can leave nothing.
    const ctx = await loadFixture(activePoolFixture);
    const { claimManager, registry, claimant } = ctx;
    await paidClaim(ctx, claimant, USDC(600));
    await registry.connect(claimant).cancelPolicy();
    await registry.connect(claimant).buyPolicy(deviceHash(0), USDC(1_500), enrollmentHash("higher"));
    expect(await claimManager.remainingCoverage(claimant.address)).to.equal(USDC(900));
    await registry.connect(claimant).cancelPolicy();
    await registry.connect(claimant).buyPolicy(deviceHash(0), USDC(500), enrollmentHash("lower"));
    expect(await claimManager.remainingCoverage(claimant.address)).to.equal(0n);
  });
});

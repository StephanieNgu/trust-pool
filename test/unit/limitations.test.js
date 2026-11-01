const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  activePoolFixture,
  selectJury,
  submitClaim,
  castVotes,
  votingPeriod,
  USDC,
  EVIDENCE,
  ClaimState,
  Outcome,
} = require("../helpers");

/**
 * Known limitations, written as tests so they stay true and visible. These do not test a defence:
 * they pin down what the contracts cannot tell apart. See docs/oracle-and-anti-fraud.md.
 */
describe("Known limitations (docs/oracle-and-anti-fraud.md)", function () {
  it("a colluding majority of three jurors gets a fabricated claim paid in full, and is paid the fee for it", async function () {
    const ctx = await loadFixture(activePoolFixture);
    const { claimManager, jury, token, claimant } = ctx;

    // Nothing on-chain says whether the damage is real: the evidence is just a hash.
    const fabricated = ethers.keccak256(ethers.toUtf8Bytes("photos of a phone that is not broken"));
    await claimManager.connect(claimant).submitClaim(USDC(400), fabricated);
    const claimId = await claimManager.claimCount();
    const jurors = await selectJury(ctx, claimId);

    // Three jurors (friends of the claimant, or the claimant's own extra wallets) pay in full.
    // The two honest jurors reject. The median is the colluders' amount.
    const votes = [USDC(400), USDC(400), USDC(400), 0n, 0n];
    await castVotes(ctx, claimId, jurors, votes);
    await expect(claimManager.finalize(claimId))
      .to.emit(jury, "Tallied")
      .withArgs(claimId, Outcome.Approved, 3n, 2n, USDC(400));

    // The colluders "agree with the outcome", so they share the fee; the honest jurors get nothing.
    const share = (await jury.feeFor(claimId)) / 3n;
    for (const [i, j] of jurors.entries()) {
      expect(await jury.rewardOf(claimId, j.address)).to.equal(i < 3 ? share : 0n);
    }
    // The claimant keeps the whole bond, because the jury cut nothing.
    expect((await claimManager.getClaim(claimId)).bondForfeited).to.equal(0n);

    // Any receipt hash is accepted on-chain; only the backend looks at the file.
    await claimManager.connect(claimant).acceptOffer(claimId);
    await claimManager.connect(claimant).submitReceipt(claimId, ethers.keccak256(ethers.toUtf8Bytes("invented receipt")), USDC(400));
    const before = await token.balanceOf(claimant.address);
    await claimManager.executePayout(claimId);
    expect((await claimManager.getClaim(claimId)).state).to.equal(ClaimState.Paid);
    expect((await token.balanceOf(claimant.address)) - before).to.equal(USDC(400));
  });

  it("an honest majority still decides against two colluders, but only because it is a majority", async function () {
    const ctx = await loadFixture(activePoolFixture);
    const claimId = await submitClaim(ctx, ctx.claimant);
    const jurors = await selectJury(ctx, claimId);
    await castVotes(ctx, claimId, jurors, [USDC(400), USDC(400), 0n, 0n, 0n]);
    await ctx.claimManager.finalize(claimId);
    expect((await ctx.claimManager.getClaim(claimId)).state).to.equal(ClaimState.Rejected);
  });

  it("two colluders are enough when two honest jurors do not reveal", async function () {
    // Only revealed votes count and quorum is 3, so honest no-shows hand the median to the colluders.
    const ctx = await loadFixture(activePoolFixture);
    const claimId = await submitClaim(ctx, ctx.claimant);
    const jurors = await selectJury(ctx, claimId);
    await castVotes(ctx, claimId, jurors.slice(0, 3), [USDC(400), USDC(400), 0n]);
    await time.increase(votingPeriod(ctx.params) + 1);
    await expect(ctx.claimManager.finalize(claimId))
      .to.emit(ctx.jury, "Tallied")
      .withArgs(claimId, Outcome.Approved, 2n, 1n, USDC(400));
  });

  it("accepts any non-zero evidence hash, including one another claim already used", async function () {
    // Refusing reused photos is a backend check (it sees the files); the contract only sees hashes.
    const ctx = await loadFixture(activePoolFixture);
    const [first, second] = ctx.holders;
    await ctx.claimManager.connect(first).submitClaim(USDC(100), EVIDENCE);
    await ctx.claimManager.connect(second).submitClaim(USDC(100), EVIDENCE);
    const a = await ctx.claimManager.getClaim(1n);
    const b = await ctx.claimManager.getClaim(2n);
    expect(a.evidenceHash).to.equal(b.evidenceHash);
    expect(b.state).to.equal(ClaimState.JuryPending);
  });
});

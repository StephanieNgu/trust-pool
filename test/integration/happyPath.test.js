const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployFixture,
  deviceHash,
  enrollmentHash,
  commitVote,
  revealVote,
  USDC,
  COVERAGE,
  EVIDENCE,
  RECEIPT,
  ClaimState,
  noteHashFor,
  fulfillRandomness,
} = require("../helpers");

describe("Integration: happy path", function () {
  it("join -> contribute -> submit -> jury -> vote amounts -> offer -> accept -> receipt -> payout", async function () {
    const ctx = await loadFixture(deployFixture);
    const { token, pool, registry, randomness, jury, claimManager, deployer, signers, params } = ctx;
    const [claimant, ...others] = signers.slice(1, 8);
    const poolAddr = await pool.getAddress();

    // 1. Join: seven wallets each buy a policy (premium is 5% of coverage).
    for (const [i, s] of [claimant, ...others].entries()) {
      await token.mint(s.address, USDC(100));
      await token.connect(s).approve(poolAddr, ethers.MaxUint256);
      await expect(registry.connect(s).buyPolicy(deviceHash(i), COVERAGE, enrollmentHash(i))).to.emit(registry, "PolicyPurchased");
      // Each also opts in to jury duty by locking the minimum stake.
      await expect(pool.connect(s).stake(params.minJurorStake)).to.emit(pool, "Staked");
    }

    // 2. Contribute: a backer seeds the pool with extra liquidity.
    await token.mint(deployer.address, USDC(5_000));
    await token.approve(poolAddr, USDC(5_000));
    await pool.contribute(USDC(5_000));
    expect(await pool.balance()).to.equal(USDC(5_000) + 7n * USDC(50));

    // Waiting period must pass before claims are allowed.
    await expect(claimManager.connect(claimant).submitClaim(USDC(300), EVIDENCE)).to.be.revertedWithCustomError(
      claimManager,
      "WaitingPeriodNotElapsed",
    );
    await time.increase(params.waitingPeriod);

    // 3. Submit: claim moves straight to JuryPending and requests randomness.
    await expect(claimManager.connect(claimant).submitClaim(USDC(300), EVIDENCE))
      .to.emit(claimManager, "ClaimSubmitted")
      .and.to.emit(randomness, "RandomnessRequested");
    const claimId = await claimManager.claimCount();
    expect((await claimManager.getClaim(claimId)).state).to.equal(ClaimState.JuryPending);

    // 4. Randomness fulfilled: 5 jurors picked, claimant excluded, claim now in Voting.
    //    Chainlink VRF answers through the coordinator; locally that is the official mock.
    await expect(fulfillRandomness(ctx, claimId)).to.emit(jury, "JurySelected");
    const jurorAddrs = await jury.getJurors(claimId);
    expect(jurorAddrs).to.have.lengthOf(5);
    expect(jurorAddrs).to.not.include(claimant.address);
    expect((await claimManager.getClaim(claimId)).state).to.equal(ClaimState.Voting);

    // 5. Vote with commit-reveal: each juror seals the amount they would pay. One rejects, one thinks
    //    150 covers the repair, one says 200, two give the full 300. Commits reveal nothing.
    const amounts = [0n, USDC(150), USDC(200), USDC(300), USDC(300)];
    const jurors = jurorAddrs.map((a) => signers.find((s) => s.address === a));
    for (const [i, j] of jurors.entries()) {
      await expect(commitVote(ctx, claimId, j, amounts[i])).to.emit(jury, "VoteCommitted").withArgs(claimId, j.address);
    }
    expect((await jury.getJury(claimId)).approvals).to.equal(0n);
    // Everyone committed, so reveals open without waiting for the commit deadline.
    for (const [i, j] of jurors.entries()) {
      await expect(revealVote(ctx, claimId, j, amounts[i]))
        .to.emit(jury, "VoteRevealed")
        .withArgs(claimId, j.address, amounts[i], noteHashFor(claimId, j, amounts[i]));
    }

    // 6. Finalize: all jurors revealed, so no need to wait for the deadline. The offer is the median, 200.
    await expect(claimManager.finalize(claimId))
      .to.emit(jury, "Tallied")
      .and.to.emit(claimManager, "OfferMade");
    expect((await claimManager.getClaim(claimId)).state).to.equal(ClaimState.Offered);
    expect(await claimManager.payoutAmount(claimId)).to.equal(USDC(200));

    // 7. The claimant reads the jurors' reasoning and accepts.
    await claimManager.connect(claimant).acceptOffer(claimId);
    expect((await claimManager.getClaim(claimId)).state).to.equal(ClaimState.Approved);

    // 8. The repair costs 180, a little under the offer. The claimant pays the shop and submits the receipt.
    await expect(claimManager.executePayout(claimId)).to.be.revertedWithCustomError(claimManager, "ReceiptRequired");
    await expect(claimManager.connect(claimant).submitReceipt(claimId, RECEIPT, USDC(180)))
      .to.emit(claimManager, "ReceiptSubmitted")
      .withArgs(claimId, RECEIPT, USDC(180), USDC(180));

    // 9. Payout: the receipt, since it is less than the offer.
    const before = await token.balanceOf(claimant.address);
    await expect(claimManager.executePayout(claimId))
      .to.emit(claimManager, "ClaimPaid")
      .withArgs(claimId, claimant.address, USDC(180))
      .and.to.emit(pool, "PaidOut");
    expect(await token.balanceOf(claimant.address)).to.equal(before + USDC(180));

    const claim = await claimManager.getClaim(claimId);
    expect(claim.state).to.equal(ClaimState.Paid);
    expect(claim.paidAmount).to.equal(USDC(180));
    expect(await claimManager.openClaimOfPolicy(claim.policyId)).to.equal(0n);

    // Only the Pool ever holds tokens.
    for (const c of [registry, claimManager, jury, randomness]) {
      expect(await token.balanceOf(await c.getAddress())).to.equal(0n);
    }
  });
});

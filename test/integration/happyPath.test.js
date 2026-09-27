const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, deviceHash, USDC, COVERAGE, EVIDENCE, ClaimState } = require("../helpers");

describe("Integration: happy path", function () {
  it("join -> contribute -> submit -> jury -> vote -> finalize -> payout", async function () {
    const ctx = await loadFixture(deployFixture);
    const { token, pool, registry, randomness, jury, claimManager, deployer, signers, params } = ctx;
    const [claimant, ...others] = signers.slice(1, 8);
    const poolAddr = await pool.getAddress();

    // 1. Join: seven wallets each buy a policy (premium is 5% of coverage).
    for (const [i, s] of [claimant, ...others].entries()) {
      await token.mint(s.address, USDC(100));
      await token.connect(s).approve(poolAddr, ethers.MaxUint256);
      await expect(registry.connect(s).buyPolicy(deviceHash(i), COVERAGE)).to.emit(registry, "PolicyPurchased");
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
    await expect(randomness.fulfill(claimId, 1234n)).to.emit(jury, "JurySelected");
    const jurorAddrs = await jury.getJurors(claimId);
    expect(jurorAddrs).to.have.lengthOf(5);
    expect(jurorAddrs).to.not.include(claimant.address);
    expect((await claimManager.getClaim(claimId)).state).to.equal(ClaimState.Voting);

    // 5. Vote: 4 approve, 1 rejects.
    const jurors = jurorAddrs.map((a) => signers.find((s) => s.address === a));
    for (const [i, j] of jurors.entries()) {
      await expect(jury.connect(j).castVote(claimId, i !== 0))
        .to.emit(jury, "VoteCast")
        .withArgs(claimId, j.address, i !== 0);
    }

    // 6. Finalize: all jurors voted, so no need to wait for the deadline.
    await expect(claimManager.finalize(claimId)).to.emit(jury, "Tallied");
    expect((await claimManager.getClaim(claimId)).state).to.equal(ClaimState.Approved);

    // 7. Payout.
    const before = await token.balanceOf(claimant.address);
    await expect(claimManager.executePayout(claimId))
      .to.emit(claimManager, "ClaimPaid")
      .withArgs(claimId, claimant.address, USDC(300))
      .and.to.emit(pool, "PaidOut");
    expect(await token.balanceOf(claimant.address)).to.equal(before + USDC(300));

    const claim = await claimManager.getClaim(claimId);
    expect(claim.state).to.equal(ClaimState.Paid);
    expect(claim.paidAmount).to.equal(USDC(300));
    expect(await claimManager.openClaimOfPolicy(claim.policyId)).to.equal(0n);

    // Only the Pool ever holds tokens.
    for (const c of [registry, claimManager, jury, randomness]) {
      expect(await token.balanceOf(await c.getAddress())).to.equal(0n);
    }
  });
});

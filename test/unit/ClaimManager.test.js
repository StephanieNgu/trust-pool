const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  activePoolFixture,
  deployFixture,
  selectJury,
  submitClaim,
  deviceHash,
  enrollmentHash,
  USDC,
  COVERAGE,
  EVIDENCE,
  ClaimState,
  castVotes,
  votingPeriod,
  finalizeAndAccept,
} = require("../helpers");

async function castAll(ctx, claimId, jurors, approve) {
  await castVotes(ctx, claimId, jurors, jurors.map(() => approve));
}

async function approvedClaimFixture() {
  const ctx = await activePoolFixture();
  const claimId = await submitClaim(ctx, ctx.claimant, USDC(400));
  const jurors = await selectJury(ctx, claimId);
  await castAll(ctx, claimId, jurors, true);
  await finalizeAndAccept(ctx, claimId, ctx.claimant);
  return { ...ctx, claimId, jurors };
}

async function offeredClaimFixture() {
  const ctx = await activePoolFixture();
  const claimId = await submitClaim(ctx, ctx.claimant, USDC(400));
  const jurors = await selectJury(ctx, claimId);
  await castVotes(ctx, claimId, jurors, [USDC(150), USDC(150), USDC(200), USDC(400), 0n]);
  await ctx.claimManager.finalize(claimId);
  return { ...ctx, claimId, jurors };
}

describe("ClaimManager", function () {
  describe("submitClaim", function () {
    it("records the claim and requests a jury", async function () {
      const ctx = await loadFixture(activePoolFixture);
      const { claimManager, jury, claimant } = ctx;
      const policyId = (await ctx.registry.getPolicy(claimant.address)).id;

      await expect(claimManager.connect(claimant).submitClaim(USDC(400), EVIDENCE))
        .to.emit(claimManager, "ClaimSubmitted")
        .withArgs(1n, claimant.address, policyId, USDC(400), EVIDENCE)
        .and.to.emit(claimManager, "ClaimStateChanged")
        .withArgs(1n, ClaimState.Submitted, ClaimState.JuryPending)
        .and.to.emit(jury, "JuryRequested")
        .withArgs(1n, claimant.address);

      const c = await claimManager.getClaim(1n);
      expect(c.claimant).to.equal(claimant.address);
      expect(c.amount).to.equal(USDC(400));
      expect(c.coverageLimit).to.equal(COVERAGE);
      expect(c.evidenceHash).to.equal(EVIDENCE);
      expect(c.state).to.equal(ClaimState.JuryPending);
      expect(await claimManager.openClaimOfPolicy(policyId)).to.equal(1n);
    });

    it("rejects claimants without an active policy", async function () {
      const { claimManager, signers, registry, claimant } = await loadFixture(activePoolFixture);
      await expect(claimManager.connect(signers[15]).submitClaim(USDC(1), EVIDENCE)).to.be.revertedWithCustomError(
        claimManager,
        "NoActivePolicy",
      );
      await registry.connect(claimant).cancelPolicy();
      await expect(claimManager.connect(claimant).submitClaim(USDC(1), EVIDENCE)).to.be.revertedWithCustomError(
        claimManager,
        "NoActivePolicy",
      );
    });

    it("rejects claims inside the waiting period", async function () {
      const ctx = await loadFixture(deployFixture);
      const [, alice] = ctx.signers;
      await ctx.token.mint(alice.address, USDC(100));
      await ctx.token.connect(alice).approve(await ctx.pool.getAddress(), ethers.MaxUint256);
      await ctx.registry.connect(alice).buyPolicy(deviceHash("a"), COVERAGE, enrollmentHash("a"));
      await expect(ctx.claimManager.connect(alice).submitClaim(USDC(1), EVIDENCE)).to.be.revertedWithCustomError(
        ctx.claimManager,
        "WaitingPeriodNotElapsed",
      );
    });

    it("rejects zero amounts, amounts over the coverage limit and empty evidence", async function () {
      const { claimManager, claimant } = await loadFixture(activePoolFixture);
      const cm = claimManager.connect(claimant);
      await expect(cm.submitClaim(0, EVIDENCE)).to.be.revertedWithCustomError(claimManager, "InvalidAmount");
      await expect(cm.submitClaim(COVERAGE + 1n, EVIDENCE))
        .to.be.revertedWithCustomError(claimManager, "ExceedsCoverageLimit")
        .withArgs(COVERAGE + 1n, COVERAGE);
      await expect(cm.submitClaim(USDC(1), ethers.ZeroHash)).to.be.revertedWithCustomError(
        claimManager,
        "InvalidEvidence",
      );
    });

    it("allows only one open claim per policy", async function () {
      const ctx = await loadFixture(activePoolFixture);
      await submitClaim(ctx, ctx.claimant);
      await expect(ctx.claimManager.connect(ctx.claimant).submitClaim(USDC(1), EVIDENCE))
        .to.be.revertedWithCustomError(ctx.claimManager, "OpenClaimExists")
        .withArgs(1n);
    });

    it("reverts when there are not enough eligible jurors", async function () {
      const ctx = await loadFixture(activePoolFixture);
      // 7 holders -> 6 eligible jurors for the claimant; lapse 2 to drop below jurySize (5).
      await ctx.registry.connect(ctx.holders[5]).cancelPolicy();
      await ctx.registry.connect(ctx.holders[6]).cancelPolicy();
      await expect(ctx.claimManager.connect(ctx.claimant).submitClaim(USDC(1), EVIDENCE))
        .to.be.revertedWithCustomError(ctx.jury, "NotEnoughEligibleJurors")
        .withArgs(4n, 5n);
    });
  });

  describe("state machine guards", function () {
    it("only the jury module can start voting", async function () {
      const ctx = await loadFixture(activePoolFixture);
      const claimId = await submitClaim(ctx, ctx.claimant);
      await expect(ctx.claimManager.startVoting(claimId)).to.be.revertedWithCustomError(
        ctx.claimManager,
        "NotJuryModule",
      );
    });

    it("cannot finalize before voting starts or pay before approval", async function () {
      const ctx = await loadFixture(activePoolFixture);
      const claimId = await submitClaim(ctx, ctx.claimant);
      await expect(ctx.claimManager.finalize(claimId))
        .to.be.revertedWithCustomError(ctx.claimManager, "WrongState")
        .withArgs(ClaimState.Voting, ClaimState.JuryPending);
      await expect(ctx.claimManager.executePayout(claimId))
        .to.be.revertedWithCustomError(ctx.claimManager, "WrongState")
        .withArgs(ClaimState.Approved, ClaimState.JuryPending);
    });

    it("closes a rejected claim and frees the policy for a new claim", async function () {
      const ctx = await loadFixture(activePoolFixture);
      const claimId = await submitClaim(ctx, ctx.claimant);
      const jurors = await selectJury(ctx, claimId);
      await castAll(ctx, claimId, jurors, false);
      await ctx.claimManager.finalize(claimId);

      expect((await ctx.claimManager.getClaim(claimId)).state).to.equal(ClaimState.Rejected);
      await expect(ctx.claimManager.executePayout(claimId)).to.be.revertedWithCustomError(
        ctx.claimManager,
        "WrongState",
      );
      await expect(ctx.claimManager.connect(ctx.claimant).submitClaim(USDC(1), EVIDENCE)).to.emit(
        ctx.claimManager,
        "ClaimSubmitted",
      );
    });

    it("rejects a claim when non-voting jurors leave it short of quorum", async function () {
      const ctx = await loadFixture(activePoolFixture);
      const claimId = await submitClaim(ctx, ctx.claimant);
      const jurors = await selectJury(ctx, claimId);
      await castAll(ctx, claimId, jurors.slice(0, 2), true);
      await time.increase(votingPeriod(ctx.params) + 1);
      await ctx.claimManager.finalize(claimId);
      expect((await ctx.claimManager.getClaim(claimId)).state).to.equal(ClaimState.Rejected);
    });
  });

  describe("offers", function () {
    it("offers the median juror amount with a response deadline", async function () {
      const ctx = await loadFixture(activePoolFixture);
      const claimId = await submitClaim(ctx, ctx.claimant, USDC(400));
      await castVotes(ctx, claimId, await selectJury(ctx, claimId), [USDC(150), USDC(150), USDC(200), USDC(400), 0n]);
      await expect(ctx.claimManager.finalize(claimId))
        .to.emit(ctx.claimManager, "OfferMade")
        .and.to.emit(ctx.claimManager, "ClaimStateChanged")
        .withArgs(claimId, ClaimState.Voting, ClaimState.Offered);
      const claim = await ctx.claimManager.getClaim(claimId);
      expect(claim.approvedAmount).to.equal(USDC(150));
      expect(claim.offerDeadline).to.equal(BigInt(await time.latest()) + BigInt(ctx.params.responsePeriod));
      expect(await ctx.claimManager.payoutAmount(claimId)).to.equal(USDC(150));
    });

    it("cannot pay before the offer is accepted", async function () {
      const ctx = await loadFixture(offeredClaimFixture);
      await expect(ctx.claimManager.executePayout(ctx.claimId))
        .to.be.revertedWithCustomError(ctx.claimManager, "WrongState")
        .withArgs(ClaimState.Approved, ClaimState.Offered);
    });

    it("lets the claimant accept, and only the claimant before the deadline", async function () {
      const ctx = await loadFixture(offeredClaimFixture);
      const { claimManager, claimId, claimant, holders } = ctx;
      await expect(claimManager.connect(holders[3]).acceptOffer(claimId)).to.be.revertedWithCustomError(
        claimManager,
        "ResponseWindowOpen",
      );
      await expect(claimManager.connect(claimant).acceptOffer(claimId))
        .to.emit(claimManager, "ClaimStateChanged")
        .withArgs(claimId, ClaimState.Offered, ClaimState.Approved);
      await expect(claimManager.executePayout(claimId))
        .to.emit(claimManager, "ClaimPaid")
        .withArgs(claimId, claimant.address, USDC(150));
    });

    it("counts silence as accepting once the deadline passes", async function () {
      const ctx = await loadFixture(offeredClaimFixture);
      const { claimManager, claimId, claimant, holders, params } = ctx;
      await time.increase(params.responsePeriod + 1);
      await expect(claimManager.connect(claimant).withdrawClaim(claimId)).to.be.revertedWithCustomError(
        claimManager,
        "ResponseWindowClosed",
      );
      await claimManager.connect(holders[3]).acceptOffer(claimId);
      expect((await claimManager.getClaim(claimId)).state).to.equal(ClaimState.Approved);
    });

    it("lets the claimant withdraw, paying nothing and freeing the policy", async function () {
      const ctx = await loadFixture(offeredClaimFixture);
      const { claimManager, claimId, claimant, holders } = ctx;
      await expect(claimManager.connect(holders[3]).withdrawClaim(claimId)).to.be.revertedWithCustomError(
        claimManager,
        "NotClaimant",
      );
      await expect(claimManager.connect(claimant).withdrawClaim(claimId))
        .to.emit(claimManager, "ClaimStateChanged")
        .withArgs(claimId, ClaimState.Offered, ClaimState.Withdrawn);
      expect(await claimManager.payoutAmount(claimId)).to.equal(0n);
      await expect(claimManager.executePayout(claimId)).to.be.revertedWithCustomError(claimManager, "WrongState");
      await expect(claimManager.acceptOffer(claimId)).to.be.revertedWithCustomError(claimManager, "WrongState");
      await expect(claimManager.connect(claimant).submitClaim(USDC(1), EVIDENCE)).to.emit(
        claimManager,
        "ClaimSubmitted",
      );
    });

    it("rejects a zero response period", async function () {
      const { registry, pool, jury } = await loadFixture(deployFixture);
      const CM = await ethers.getContractFactory("ClaimManager");
      await expect(
        CM.deploy(registry.getAddress(), pool.getAddress(), jury.getAddress(), 0),
      ).to.be.revertedWithCustomError(CM, "InvalidConfig");
    });
  });

  describe("executePayout", function () {
    it("pays the claim amount and cannot pay twice", async function () {
      const ctx = await loadFixture(approvedClaimFixture);
      const { claimManager, token, claimant, claimId } = ctx;
      expect(await claimManager.payoutAmount(claimId)).to.equal(USDC(400));
      await expect(claimManager.executePayout(claimId)).to.changeTokenBalances(
        token,
        [claimant, ctx.pool],
        [USDC(400), -USDC(400)],
      );
      await expect(claimManager.executePayout(claimId))
        .to.be.revertedWithCustomError(claimManager, "WrongState")
        .withArgs(ClaimState.Approved, ClaimState.Paid);
    });

    it("clamps the payout to the pool's per-claim cap", async function () {
      // Small pool with no seed liquidity: 7 premiums of 50 = 350 USDC, so the 20% cap is 70 USDC.
      const ctx = await loadFixture(deployFixture);
      const holders = ctx.signers.slice(1, 8);
      for (const [i, h] of holders.entries()) {
        await ctx.token.mint(h.address, USDC(100));
        await ctx.token.connect(h).approve(await ctx.pool.getAddress(), ethers.MaxUint256);
        await ctx.registry.connect(h).buyPolicy(deviceHash(i), COVERAGE, enrollmentHash(i));
      }
      await time.increase(ctx.params.waitingPeriod);

      const claimId = await submitClaim(ctx, holders[0], USDC(900));
      await castAll(ctx, claimId, await selectJury(ctx, claimId), true);
      await finalizeAndAccept(ctx, claimId, holders[0]);

      expect(await ctx.pool.maxPayout()).to.equal(USDC(70));
      await expect(ctx.claimManager.executePayout(claimId))
        .to.emit(ctx.claimManager, "ClaimPaid")
        .withArgs(claimId, holders[0].address, USDC(70));
      expect((await ctx.claimManager.getClaim(claimId)).paidAmount).to.equal(USDC(70));
    });

    it("fixes the payout at approval, so later pool changes cannot alter it", async function () {
      const ctx = await loadFixture(approvedClaimFixture);
      const { claimManager, pool, token, deployer, claimant, claimId } = ctx;
      expect((await claimManager.getClaim(claimId)).approvedAmount).to.equal(USDC(400));

      // A large new contribution raises the cap; the approved amount stays as the jury decided.
      await token.mint(deployer.address, USDC(50_000));
      await token.approve(await pool.getAddress(), USDC(50_000));
      await pool.contribute(USDC(50_000));
      expect(await claimManager.payoutAmount(claimId)).to.equal(USDC(400));
      await expect(claimManager.executePayout(claimId))
        .to.emit(claimManager, "ClaimPaid")
        .withArgs(claimId, claimant.address, USDC(400));
    });

    it("keeps an approved claim payable later when the pool is short", async function () {
      // Two claims approved against a 400 USDC pool (8 premiums): each is capped at 80 when approved.
      // The first payout leaves 320, so the live cap drops to 64, yet the second still pays its 80.
      const ctx = await loadFixture(deployFixture);
      const holders = ctx.signers.slice(1, 9);
      for (const [i, h] of holders.entries()) {
        await ctx.token.mint(h.address, USDC(100));
        await ctx.token.connect(h).approve(await ctx.pool.getAddress(), ethers.MaxUint256);
        await ctx.registry.connect(h).buyPolicy(deviceHash(i), COVERAGE, enrollmentHash(i));
      }
      await time.increase(ctx.params.waitingPeriod);

      const first = await submitClaim(ctx, holders[0], USDC(900));
      await castAll(ctx, first, await selectJury(ctx, first), true);
      const second = await submitClaim(ctx, holders[1], USDC(900));
      await castAll(ctx, second, await selectJury(ctx, second, 7n), true);
      await finalizeAndAccept(ctx, first, holders[0]);
      await finalizeAndAccept(ctx, second, holders[1]);

      await ctx.claimManager.executePayout(first);
      const approved = (await ctx.claimManager.getClaim(second)).approvedAmount;
      expect(await ctx.pool.maxPayout()).to.be.lessThan(approved);
      await expect(ctx.claimManager.executePayout(second))
        .to.emit(ctx.claimManager, "ClaimPaid")
        .withArgs(second, holders[1].address, approved);
    });
  });

  describe("cancelStalledClaim", function () {
    async function pendingFixture() {
      const ctx = await activePoolFixture();
      const claimId = await submitClaim(ctx, ctx.claimant);
      return { ...ctx, claimId };
    }

    it("cancels a claim whose randomness never arrived and frees the policy", async function () {
      const ctx = await loadFixture(pendingFixture);
      const { claimManager, jury, randomness, claimant, claimId, params } = ctx;
      await expect(claimManager.cancelStalledClaim(claimId)).to.be.revertedWithCustomError(
        jury,
        "RandomnessNotTimedOut",
      );

      await time.increase(params.randomnessTimeout + 1);
      await expect(claimManager.connect(ctx.holders[3]).cancelStalledClaim(claimId))
        .to.emit(claimManager, "ClaimStateChanged")
        .withArgs(claimId, ClaimState.JuryPending, ClaimState.Cancelled)
        .and.to.emit(jury, "JuryCancelled");
      expect(await claimManager.openClaimOfPolicy((await claimManager.getClaim(claimId)).policyId)).to.equal(0n);

      // A late randomness callback cannot seat a jury for the cancelled claim.
      await expect(randomness.fulfill(claimId, 1n)).to.be.revertedWithCustomError(jury, "WrongPhase");
      await expect(claimManager.connect(claimant).submitClaim(USDC(1), EVIDENCE)).to.emit(
        claimManager,
        "ClaimSubmitted",
      );
    });

    it("cannot cancel a claim that already has a jury", async function () {
      const ctx = await loadFixture(pendingFixture);
      await selectJury(ctx, ctx.claimId);
      await time.increase(ctx.params.randomnessTimeout + 1);
      await expect(ctx.claimManager.cancelStalledClaim(ctx.claimId))
        .to.be.revertedWithCustomError(ctx.claimManager, "WrongState")
        .withArgs(ClaimState.JuryPending, ClaimState.Voting);
    });
  });
});

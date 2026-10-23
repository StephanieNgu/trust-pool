const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  activePoolFixture,
  selectJury,
  submitClaim,
  saltFor,
  commitVote,
  revealVote,
  castVotes,
  votingPeriod,
  JuryPhase,
  Outcome,
  ClaimState,
  USDC,
  EVIDENCE,
  stakeAsJuror,
} = require("../helpers");

async function awaitingRandomnessFixture() {
  const ctx = await activePoolFixture();
  const claimId = await submitClaim(ctx, ctx.claimant);
  return { ...ctx, claimId };
}

async function votingFixture() {
  const ctx = await awaitingRandomnessFixture();
  const jurors = await selectJury(ctx, ctx.claimId);
  const nonJuror = ctx.holders.find((h) => h !== ctx.claimant && !jurors.includes(h));
  return { ...ctx, jurors, nonJuror };
}

describe("JuryModule", function () {
  describe("configuration", function () {
    it("rejects an invalid quorum or jury size", async function () {
      const { registry, randomness, pool } = await loadFixture(activePoolFixture);
      const JM = await ethers.getContractFactory("JuryModule");
      const incentives = { minStake: USDC(20), feeBps: 200, minFee: USDC(2), agreementBandBps: 1_000, noShowPenalty: USDC(5) };
      const args = (size, quorum, period, timeout = 60, overrides = {}) => [
        registry.getAddress(),
        randomness.getAddress(),
        pool.getAddress(),
        size,
        quorum,
        period,
        60,
        timeout,
        { ...incentives, ...overrides },
      ];
      await expect(JM.deploy(...args(5, 6, 60))).to.be.revertedWithCustomError(JM, "InvalidConfig");
      await expect(JM.deploy(...args(0, 0, 60))).to.be.revertedWithCustomError(JM, "InvalidConfig");
      await expect(JM.deploy(...args(5, 3, 0))).to.be.revertedWithCustomError(JM, "InvalidConfig");
      await expect(JM.deploy(...args(5, 3, 60, 0))).to.be.revertedWithCustomError(JM, "InvalidConfig");
      const noReveal = [registry.getAddress(), randomness.getAddress(), pool.getAddress(), 5, 3, 60, 0, 60, incentives];
      await expect(JM.deploy(...noReveal)).to.be.revertedWithCustomError(JM, "InvalidConfig");
      await expect(JM.deploy(...args(5, 3, 60, 60, { minStake: 0 }))).to.be.revertedWithCustomError(JM, "InvalidConfig");
      await expect(JM.deploy(...args(5, 3, 60, 60, { noShowPenalty: USDC(21) }))).to.be.revertedWithCustomError(JM, "InvalidConfig");
    });
  });

  describe("selection", function () {
    it("only accepts jury requests from the claim manager", async function () {
      const { jury, claimant } = await loadFixture(activePoolFixture);
      await expect(jury.requestJury(99, claimant.address, USDC(1))).to.be.revertedWithCustomError(jury, "NotClaimManager");
    });

    it("only accepts the randomness callback from the provider", async function () {
      const { jury, claimId } = await loadFixture(awaitingRandomnessFixture);
      expect((await jury.getJury(claimId)).phase).to.equal(JuryPhase.AwaitingRandomness);
      await expect(jury.fulfillRandomness(claimId, 1n)).to.be.revertedWithCustomError(jury, "NotRandomnessProvider");
    });

    it("only lets the mock's owner fulfil randomness", async function () {
      const { randomness, claimant, claimId } = await loadFixture(awaitingRandomnessFixture);
      await expect(randomness.connect(claimant).fulfill(claimId, 1n)).to.be.revertedWithCustomError(
        randomness,
        "OwnableUnauthorizedAccount",
      );
    });

    it("selects jurySize distinct jurors, never the claimant", async function () {
      const ctx = await loadFixture(awaitingRandomnessFixture);
      const jurors = await selectJury(ctx, ctx.claimId, 7n);
      const addrs = jurors.map((j) => j.address);
      expect(addrs).to.have.lengthOf(5);
      expect(new Set(addrs).size).to.equal(5);
      expect(addrs).to.not.include(ctx.claimant.address);
      for (const a of addrs) expect(await ctx.jury.isJuror(ctx.claimId, a)).to.equal(true);
      expect((await ctx.jury.getJury(ctx.claimId)).phase).to.equal(JuryPhase.Voting);
    });

    it("is deterministic in the seed and varies across seeds", async function () {
      const pick = async (seed) => {
        const ctx = await loadFixture(awaitingRandomnessFixture);
        return (await selectJury(ctx, ctx.claimId, seed)).map((j) => j.address);
      };
      expect(await pick(1n)).to.deep.equal(await pick(1n));
      const outcomes = new Set();
      for (let s = 0n; s < 8n; s++) outcomes.add((await pick(s)).join());
      expect(outcomes.size).to.be.greaterThan(1);
    });

    it("cannot be fulfilled twice", async function () {
      const ctx = await loadFixture(awaitingRandomnessFixture);
      await selectJury(ctx, ctx.claimId);
      await expect(ctx.randomness.fulfill(ctx.claimId, 1n)).to.be.revertedWithCustomError(
        ctx.randomness,
        "NoPendingRequest",
      );
    });

    it("re-checks eligibility at fulfilment and seats fewer jurors if some lapsed", async function () {
      const ctx = await loadFixture(awaitingRandomnessFixture);
      // 6 eligible at request time; two lapse before the callback.
      await ctx.registry.connect(ctx.holders[1]).cancelPolicy();
      await ctx.registry.connect(ctx.holders[2]).cancelPolicy();
      const jurors = await selectJury(ctx, ctx.claimId);
      expect(jurors).to.have.lengthOf(4);
      expect(jurors).to.not.include(ctx.holders[1]);
      expect(jurors).to.not.include(ctx.holders[2]);
    });
  });

  describe("randomness timeout", function () {
    it("is cancellable only after the timeout, and only by the claim manager", async function () {
      const { jury, params, claimId } = await loadFixture(awaitingRandomnessFixture);
      const requestedAt = BigInt(await time.latest());
      expect(await jury.cancelAvailableAt(claimId)).to.equal(requestedAt + BigInt(params.randomnessTimeout));
      expect(await jury.canCancel(claimId)).to.equal(false);
      await time.increase(params.randomnessTimeout + 1);
      expect(await jury.canCancel(claimId)).to.equal(true);
      await expect(jury.cancel(claimId)).to.be.revertedWithCustomError(jury, "NotClaimManager");
    });

    it("is not cancellable once a jury is selected", async function () {
      const ctx = await loadFixture(awaitingRandomnessFixture);
      await selectJury(ctx, ctx.claimId);
      await time.increase(ctx.params.randomnessTimeout + 1);
      expect(await ctx.jury.canCancel(ctx.claimId)).to.equal(false);
      expect(await ctx.jury.cancelAvailableAt(ctx.claimId)).to.equal(0n);
    });
  });

  describe("commit-reveal voting", function () {
    it("seals a vote until it is revealed", async function () {
      const ctx = await loadFixture(votingFixture);
      const { jury, jurors, claimId } = ctx;
      await expect(commitVote(ctx, claimId, jurors[0], true))
        .to.emit(jury, "VoteCommitted")
        .withArgs(claimId, jurors[0].address);
      const j = await jury.getJury(claimId);
      expect(j.commits).to.equal(1n);
      expect(j.approvals + j.rejections).to.equal(0n, "nothing readable before reveal");
    });

    it("opens reveals only after the commit window, or once everyone has committed", async function () {
      const ctx = await loadFixture(votingFixture);
      const { jury, jurors, claimId } = ctx;
      for (const j of jurors.slice(0, 4)) await commitVote(ctx, claimId, j, true);
      expect(await jury.revealOpen(claimId)).to.equal(false);
      await expect(revealVote(ctx, claimId, jurors[0], true)).to.be.revertedWithCustomError(jury, "RevealNotOpen");

      await commitVote(ctx, claimId, jurors[4], false);
      expect(await jury.revealOpen(claimId)).to.equal(true);
      await expect(revealVote(ctx, claimId, jurors[0], true))
        .to.emit(jury, "VoteRevealed")
        .withArgs(claimId, jurors[0].address, USDC(400), ethers.ZeroHash);
      expect(await jury.amountOf(claimId, jurors[0].address)).to.equal(USDC(400));
      expect(await jury.hasRevealed(claimId, jurors[0].address)).to.equal(true);
      expect((await jury.getJury(claimId)).approvals).to.equal(1n);
    });

    it("rejects a reveal that does not match the commitment", async function () {
      const ctx = await loadFixture(votingFixture);
      const { jury, jurors, claimId } = ctx;
      await commitVote(ctx, claimId, jurors[0], true);
      await time.increase(ctx.params.commitPeriod + 1);
      // Changing the amount, the note or the salt does not match.
      const salt = saltFor(claimId, jurors[0]);
      const note = ethers.keccak256(ethers.toUtf8Bytes("a different note"));
      await expect(revealVote(ctx, claimId, jurors[0], USDC(399))).to.be.revertedWithCustomError(
        jury,
        "CommitmentMismatch",
      );
      await expect(
        jury.connect(jurors[0]).revealVote(claimId, USDC(400), note, salt),
      ).to.be.revertedWithCustomError(jury, "CommitmentMismatch");
      await expect(
        jury.connect(jurors[0]).revealVote(claimId, USDC(400), ethers.ZeroHash, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(jury, "CommitmentMismatch");
    });

    it("binds a commitment to its juror, so copying another juror's commitment fails on reveal", async function () {
      const ctx = await loadFixture(votingFixture);
      const { jury, jurors, claimId } = ctx;
      await commitVote(ctx, claimId, jurors[0], true);
      const copied = await jury.commitmentOf(claimId, jurors[0].address);
      await jury.connect(jurors[1]).commitVote(claimId, copied);
      await time.increase(ctx.params.commitPeriod + 1);
      await expect(
        jury.connect(jurors[1]).revealVote(claimId, USDC(400), ethers.ZeroHash, saltFor(claimId, jurors[0])),
      ).to.be.revertedWithCustomError(jury, "CommitmentMismatch");
    });

    it("rejects a revealed amount above the claim", async function () {
      const ctx = await loadFixture(votingFixture);
      const { jury, jurors, claimId } = ctx;
      await commitVote(ctx, claimId, jurors[0], USDC(401));
      await time.increase(ctx.params.commitPeriod + 1);
      await expect(revealVote(ctx, claimId, jurors[0], USDC(401)))
        .to.be.revertedWithCustomError(jury, "AmountTooHigh")
        .withArgs(USDC(401), USDC(400));
    });

    it("rejects double commits and double reveals", async function () {
      const ctx = await loadFixture(votingFixture);
      const { jury, jurors, claimId } = ctx;
      await commitVote(ctx, claimId, jurors[0], true);
      await expect(commitVote(ctx, claimId, jurors[0], false)).to.be.revertedWithCustomError(jury, "AlreadyCommitted");
      await time.increase(ctx.params.commitPeriod + 1);
      await revealVote(ctx, claimId, jurors[0], true);
      await expect(revealVote(ctx, claimId, jurors[0], true)).to.be.revertedWithCustomError(jury, "AlreadyRevealed");
    });

    it("rejects votes from non-jurors, including the claimant", async function () {
      const ctx = await loadFixture(votingFixture);
      const { jury, nonJuror, claimant, claimId } = ctx;
      await expect(commitVote(ctx, claimId, nonJuror, true)).to.be.revertedWithCustomError(jury, "NotAJuror");
      await expect(commitVote(ctx, claimId, claimant, true)).to.be.revertedWithCustomError(jury, "NotAJuror");
      await expect(revealVote(ctx, claimId, nonJuror, true)).to.be.revertedWithCustomError(jury, "NotCommitted");
    });

    it("rejects an empty commitment", async function () {
      const { jury, jurors, claimId } = await loadFixture(votingFixture);
      await expect(jury.connect(jurors[0]).commitVote(claimId, ethers.ZeroHash)).to.be.revertedWithCustomError(
        jury,
        "EmptyCommitment",
      );
    });

    it("rejects commits after the commit window and reveals after the reveal window", async function () {
      const ctx = await loadFixture(votingFixture);
      const { jury, jurors, claimId, params } = ctx;
      await commitVote(ctx, claimId, jurors[0], true);
      await time.increase(params.commitPeriod + 1);
      await expect(commitVote(ctx, claimId, jurors[1], true)).to.be.revertedWithCustomError(jury, "CommitClosed");
      await time.increase(params.revealPeriod);
      await expect(revealVote(ctx, claimId, jurors[0], true)).to.be.revertedWithCustomError(jury, "RevealClosed");
    });

    it("rejects votes before jurors are selected", async function () {
      const ctx = await loadFixture(awaitingRandomnessFixture);
      await expect(commitVote(ctx, ctx.claimId, ctx.holders[1], true)).to.be.revertedWithCustomError(
        ctx.jury,
        "WrongPhase",
      );
    });
  });

  describe("tally", function () {
    const vote = (ctx, pattern) => castVotes(ctx, ctx.claimId, ctx.jurors.slice(0, pattern.length), pattern);

    it("only the claim manager can tally", async function () {
      const { jury, claimId } = await loadFixture(votingFixture);
      await expect(jury.tally(claimId)).to.be.revertedWithCustomError(jury, "NotClaimManager");
    });

    it("cannot close voting early unless everyone has revealed", async function () {
      const ctx = await loadFixture(votingFixture);
      for (const [i, j] of ctx.jurors.entries()) await commitVote(ctx, ctx.claimId, j, i !== 4);
      for (const j of ctx.jurors.slice(0, 4)) await revealVote(ctx, ctx.claimId, j, true);
      expect(await ctx.jury.canTally(ctx.claimId)).to.equal(false);
      await expect(ctx.claimManager.finalize(ctx.claimId)).to.be.revertedWithCustomError(ctx.jury, "VotingStillOpen");
      await revealVote(ctx, ctx.claimId, ctx.jurors[4], false);
      expect(await ctx.jury.canTally(ctx.claimId)).to.equal(true);
    });

    it("approves on a majority once the reveal window ends", async function () {
      const ctx = await loadFixture(votingFixture);
      await vote(ctx, [true, true, false]);
      await time.increase(votingPeriod(ctx.params) + 1);
      await expect(ctx.claimManager.finalize(ctx.claimId))
        .to.emit(ctx.jury, "Tallied")
        .withArgs(ctx.claimId, Outcome.Approved, 2n, 1n, USDC(400));
    });

    it("rejects on a majority against", async function () {
      const ctx = await loadFixture(votingFixture);
      await vote(ctx, [true, true, false, false, false]);
      await ctx.claimManager.finalize(ctx.claimId);
      expect((await ctx.jury.getJury(ctx.claimId)).outcome).to.equal(Outcome.Rejected);
      expect((await ctx.claimManager.getClaim(ctx.claimId)).state).to.equal(ClaimState.Rejected);
    });

    it("rejects a tie", async function () {
      const ctx = await loadFixture(votingFixture);
      await vote(ctx, [true, true, false, false]);
      await time.increase(votingPeriod(ctx.params) + 1);
      await ctx.claimManager.finalize(ctx.claimId);
      expect((await ctx.jury.getJury(ctx.claimId)).outcome).to.equal(Outcome.Rejected);
    });

    it("rejects when quorum is not met, even if every vote approves", async function () {
      const ctx = await loadFixture(votingFixture);
      await vote(ctx, [true, true]);
      await time.increase(votingPeriod(ctx.params) + 1);
      await expect(ctx.claimManager.finalize(ctx.claimId))
        .to.emit(ctx.jury, "Tallied")
        .withArgs(ctx.claimId, Outcome.Rejected, 2n, 0n, 0n);
    });

    it("ignores commits that are never revealed", async function () {
      // Four approvals are committed but only two revealed: below quorum, so the claim is rejected.
      const ctx = await loadFixture(votingFixture);
      for (const j of ctx.jurors.slice(0, 4)) await commitVote(ctx, ctx.claimId, j, true);
      await time.increase(ctx.params.commitPeriod + 1);
      for (const j of ctx.jurors.slice(0, 2)) await revealVote(ctx, ctx.claimId, j, true);
      await time.increase(ctx.params.revealPeriod);
      await expect(ctx.claimManager.finalize(ctx.claimId))
        .to.emit(ctx.jury, "Tallied")
        .withArgs(ctx.claimId, Outcome.Rejected, 2n, 0n, 0n);
    });

    it("offers the median amount, so one extreme juror cannot move it far", async function () {
      const ctx = await loadFixture(votingFixture);
      await vote(ctx, [USDC(400), USDC(1), USDC(150), USDC(250), USDC(300)]);
      await expect(ctx.claimManager.finalize(ctx.claimId))
        .to.emit(ctx.jury, "Tallied")
        .withArgs(ctx.claimId, Outcome.Approved, 5n, 0n, USDC(250));
      expect((await ctx.jury.getAward(ctx.claimId)).award).to.equal(USDC(250));
      expect((await ctx.claimManager.getClaim(ctx.claimId)).approvedAmount).to.equal(USDC(250));
    });

    it("takes the lower middle amount when an even number of jurors reveal", async function () {
      const ctx = await loadFixture(votingFixture);
      await vote(ctx, [USDC(400), USDC(100), USDC(200), USDC(300)]);
      await time.increase(votingPeriod(ctx.params) + 1);
      await ctx.claimManager.finalize(ctx.claimId);
      expect((await ctx.jury.getAward(ctx.claimId)).award).to.equal(USDC(200));
    });

    it("rejects when the median is zero, even if some jurors would pay", async function () {
      const ctx = await loadFixture(votingFixture);
      await vote(ctx, [USDC(400), USDC(400), 0n, 0n, 0n]);
      await ctx.claimManager.finalize(ctx.claimId);
      expect((await ctx.jury.getJury(ctx.claimId)).outcome).to.equal(Outcome.Rejected);
      expect((await ctx.jury.getAward(ctx.claimId)).award).to.equal(0n);
    });
  });

  describe("incentives", function () {
    // The default claim asks for 400: the fee is 2% of it (8), and agreeing means within 40 of the median.
    const FEE = USDC(8);

    it("only picks members who have staked, and locks their stakes while they serve", async function () {
      const ctx = await loadFixture(activePoolFixture);
      const { jury, pool, holders, claimant } = ctx;
      expect(await jury.eligibleJurors(claimant.address)).to.have.lengthOf(6);
      await pool.connect(holders[1]).unstake(USDC(20));
      await pool.connect(holders[2]).unstake(USDC(20));
      expect(await jury.eligibleJurors(claimant.address)).to.not.include(holders[1].address);
      await expect(ctx.claimManager.connect(claimant).submitClaim(USDC(400), EVIDENCE))
        .to.be.revertedWithCustomError(jury, "NotEnoughEligibleJurors")
        .withArgs(4n, 5n);

      await stakeAsJuror(ctx, holders[1]);
      const claimId = await submitClaim(ctx, claimant);
      const jurors = await selectJury(ctx, claimId);
      for (const j of jurors) {
        expect(await pool.activeJuriesOf(j.address)).to.equal(1n);
        await expect(pool.connect(j).unstake(USDC(20))).to.be.revertedWithCustomError(pool, "StakeLocked");
      }
      await castVotes(ctx, claimId, jurors, jurors.map(() => true));
      await ctx.claimManager.finalize(claimId);
      for (const j of jurors) expect(await pool.activeJuriesOf(j.address)).to.equal(0n);
      await expect(pool.connect(jurors[0]).unstake(USDC(20))).to.emit(pool, "Unstaked");
    });

    it("splits the fee among jurors within 10% of the request from the median", async function () {
      const ctx = await loadFixture(votingFixture);
      const { jury, pool, token, jurors, claimId } = ctx;
      // Median 380; 400, 400 and 380 are within 40 of it; 200 is not, and 0 rejects.
      const amounts = [USDC(400), USDC(400), USDC(380), USDC(200), 0n];
      await castVotes(ctx, claimId, jurors, amounts);
      expect(await jury.feeFor(claimId)).to.equal(FEE);
      const reserve = await pool.balance();
      const before = await Promise.all(jurors.map((j) => token.balanceOf(j.address)));

      const share = FEE / 3n;
      await expect(ctx.claimManager.finalize(claimId)).to.emit(jury, "JurySettled").withArgs(claimId, 3n, share, 0n);
      for (const [i, j] of jurors.entries()) {
        const expected = i < 3 ? share : 0n;
        expect(await jury.rewardOf(claimId, j.address)).to.equal(expected);
        expect((await token.balanceOf(j.address)) - before[i]).to.equal(expected);
        expect(await jury.penaltyOf(claimId, j.address)).to.equal(0n);
        expect(await pool.stakeOf(j.address)).to.equal(USDC(20), "disagreeing is not penalized");
      }
      expect(reserve - (await pool.balance())).to.equal(share * 3n);
    });

    it("pays the jurors who rejected when the claim is rejected", async function () {
      const ctx = await loadFixture(votingFixture);
      const { jury, jurors, claimId } = ctx;
      await castVotes(ctx, claimId, jurors, [0n, 0n, 0n, USDC(400), USDC(390)]);
      await ctx.claimManager.finalize(claimId);
      const rewards = await Promise.all(jurors.map((j) => jury.rewardOf(claimId, j.address)));
      expect(rewards).to.deep.equal([FEE / 3n, FEE / 3n, FEE / 3n, 0n, 0n]);
    });

    it("takes part of a no-show's stake and adds it to the agreeing jurors' fee", async function () {
      const ctx = await loadFixture(votingFixture);
      const { jury, pool, jurors, claimId, params } = ctx;
      // Four vote the full amount; the fifth never commits.
      await castVotes(ctx, claimId, jurors.slice(0, 4), [true, true, true, true]);
      await time.increase(votingPeriod(params) + 1);
      const share = (FEE + USDC(5)) / 4n;
      await expect(ctx.claimManager.finalize(claimId)).to.emit(jury, "JurySettled").withArgs(claimId, 4n, share, USDC(5));
      expect(await jury.penaltyOf(claimId, jurors[4].address)).to.equal(USDC(5));
      expect(await pool.stakeOf(jurors[4].address)).to.equal(USDC(15));
      expect(await jury.rewardOf(claimId, jurors[0].address)).to.equal(share);
      // Below the minimum stake, the no-show is not picked again until they top up.
      expect(await jury.eligibleJurors(ctx.claimant.address)).to.not.include(jurors[4].address);
    });

    it("pays no fee without quorum, but still penalizes no-shows", async function () {
      const ctx = await loadFixture(votingFixture);
      const { jury, pool, jurors, claimId, params } = ctx;
      await castVotes(ctx, claimId, jurors.slice(0, 2), [true, true]);
      await time.increase(votingPeriod(params) + 1);
      const reserve = await pool.balance();
      await expect(ctx.claimManager.finalize(claimId)).to.emit(jury, "JurySettled").withArgs(claimId, 0n, 0n, USDC(15));
      expect(await jury.rewardOf(claimId, jurors[0].address)).to.equal(0n);
      expect((await pool.balance()) - reserve).to.equal(USDC(15), "penalties stay in the reserve");
    });

    it("judges agreement against the request, not the median", async function () {
      const ctx = await loadFixture(votingFixture);
      const { jury, jurors, claimId } = ctx;
      await castVotes(ctx, claimId, jurors, [USDC(10), USDC(30), USDC(50), USDC(90), USDC(91)]);
      await ctx.claimManager.finalize(claimId);
      // Median 50; the band is 40 either side (10% of 400), so 10 and 90 agree but 91 does not.
      expect(await jury.agrees(claimId, USDC(10))).to.equal(true);
      expect(await jury.agrees(claimId, USDC(90))).to.equal(true);
      expect(await jury.agrees(claimId, USDC(91))).to.equal(false);
      expect(await jury.agrees(claimId, 0n)).to.equal(false);
    });
  });
});

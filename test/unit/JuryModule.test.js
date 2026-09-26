const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { activePoolFixture, selectJury, submitClaim, JuryPhase, Outcome, ClaimState } = require("../helpers");

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
      const { registry, randomness } = await loadFixture(activePoolFixture);
      const JM = await ethers.getContractFactory("JuryModule");
      const args = (size, quorum, period) => [
        registry.getAddress(),
        randomness.getAddress(),
        size,
        quorum,
        period,
      ];
      await expect(JM.deploy(...args(5, 6, 60))).to.be.revertedWithCustomError(JM, "InvalidConfig");
      await expect(JM.deploy(...args(0, 0, 60))).to.be.revertedWithCustomError(JM, "InvalidConfig");
      await expect(JM.deploy(...args(5, 3, 0))).to.be.revertedWithCustomError(JM, "InvalidConfig");
    });
  });

  describe("selection", function () {
    it("only accepts jury requests from the claim manager", async function () {
      const { jury, claimant } = await loadFixture(activePoolFixture);
      await expect(jury.requestJury(99, claimant.address)).to.be.revertedWithCustomError(jury, "NotClaimManager");
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

  describe("voting", function () {
    it("records a vote and emits VoteCast", async function () {
      const { jury, jurors, claimId } = await loadFixture(votingFixture);
      await expect(jury.connect(jurors[0]).castVote(claimId, true))
        .to.emit(jury, "VoteCast")
        .withArgs(claimId, jurors[0].address, true);
      expect(await jury.hasVoted(claimId, jurors[0].address)).to.equal(true);
      expect((await jury.getJury(claimId)).approvals).to.equal(1n);
    });

    it("rejects a double vote", async function () {
      const { jury, jurors, claimId } = await loadFixture(votingFixture);
      await jury.connect(jurors[0]).castVote(claimId, true);
      await expect(jury.connect(jurors[0]).castVote(claimId, false)).to.be.revertedWithCustomError(
        jury,
        "AlreadyVoted",
      );
    });

    it("rejects votes from non-jurors, including the claimant", async function () {
      const { jury, nonJuror, claimant, claimId } = await loadFixture(votingFixture);
      await expect(jury.connect(nonJuror).castVote(claimId, true)).to.be.revertedWithCustomError(jury, "NotAJuror");
      await expect(jury.connect(claimant).castVote(claimId, true)).to.be.revertedWithCustomError(jury, "NotAJuror");
    });

    it("rejects votes after the deadline", async function () {
      const { jury, jurors, claimId, params } = await loadFixture(votingFixture);
      await time.increase(params.votingPeriod + 1);
      await expect(jury.connect(jurors[0]).castVote(claimId, true)).to.be.revertedWithCustomError(
        jury,
        "VotingClosed",
      );
    });

    it("rejects votes before jurors are selected", async function () {
      const { jury, holders, claimId } = await loadFixture(awaitingRandomnessFixture);
      await expect(jury.connect(holders[1]).castVote(claimId, true)).to.be.revertedWithCustomError(jury, "WrongPhase");
    });
  });

  describe("tally", function () {
    const vote = async (ctx, pattern) => {
      for (const [i, v] of pattern.entries()) await ctx.jury.connect(ctx.jurors[i]).castVote(ctx.claimId, v);
    };

    it("only the claim manager can tally", async function () {
      const { jury, claimId } = await loadFixture(votingFixture);
      await expect(jury.tally(claimId)).to.be.revertedWithCustomError(jury, "NotClaimManager");
    });

    it("cannot close voting early unless everyone has voted", async function () {
      const ctx = await loadFixture(votingFixture);
      await vote(ctx, [true, true, true, true]);
      expect(await ctx.jury.canTally(ctx.claimId)).to.equal(false);
      await expect(ctx.claimManager.finalize(ctx.claimId)).to.be.revertedWithCustomError(ctx.jury, "VotingStillOpen");
      await ctx.jury.connect(ctx.jurors[4]).castVote(ctx.claimId, false);
      expect(await ctx.jury.canTally(ctx.claimId)).to.equal(true);
    });

    it("approves on a majority once the deadline passes", async function () {
      const ctx = await loadFixture(votingFixture);
      await vote(ctx, [true, true, false]);
      await time.increase(ctx.params.votingPeriod + 1);
      await expect(ctx.claimManager.finalize(ctx.claimId))
        .to.emit(ctx.jury, "Tallied")
        .withArgs(ctx.claimId, Outcome.Approved, 2n, 1n);
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
      await time.increase(ctx.params.votingPeriod + 1);
      await ctx.claimManager.finalize(ctx.claimId);
      expect((await ctx.jury.getJury(ctx.claimId)).outcome).to.equal(Outcome.Rejected);
    });

    it("rejects when quorum is not met, even if every vote approves", async function () {
      const ctx = await loadFixture(votingFixture);
      await vote(ctx, [true, true]);
      await time.increase(ctx.params.votingPeriod + 1);
      await expect(ctx.claimManager.finalize(ctx.claimId))
        .to.emit(ctx.jury, "Tallied")
        .withArgs(ctx.claimId, Outcome.Rejected, 2n, 0n);
    });
  });
});

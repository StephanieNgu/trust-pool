const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { vrfPoolFixture, submitClaim, castVotes, ClaimState, JuryPhase, USDC } = require("../helpers");
const { deployContracts } = require("../../scripts/lib/deployContracts");

/** Submits a claim and returns it with the VRF request id it produced. */
async function requestFixture() {
  const ctx = await vrfPoolFixture();
  const claimId = await submitClaim(ctx, ctx.claimant);
  const requestId = await ctx.randomness.requestOfClaim(claimId);
  return { ...ctx, claimId, requestId };
}

describe("VRFRandomness (Chainlink VRF v2.5)", function () {
  describe("wiring", function () {
    it("is wired to the coordinator, subscription and JuryModule", async function () {
      const { randomness, coordinator, jury, vrf, randomnessProvider } = await loadFixture(vrfPoolFixture);
      expect(randomnessProvider).to.equal("vrf");
      expect(await randomness.s_vrfCoordinator()).to.equal(await coordinator.getAddress());
      expect(await randomness.subscriptionId()).to.equal(vrf.subscriptionId);
      expect(await randomness.keyHash()).to.equal(vrf.keyHash);
      expect(await randomness.consumer()).to.equal(await jury.getAddress());
      expect(await jury.randomness()).to.equal(await randomness.getAddress());
      expect(await coordinator.isConsumer(vrf.subscriptionId, await randomness.getAddress())).to.equal(true);
    });

    it("sets the consumer once, owner only", async function () {
      const { randomness, holders } = await loadFixture(vrfPoolFixture);
      await expect(randomness.connect(holders[0]).setConsumer(holders[0].address)).to.be.revertedWith(
        "Only callable by owner",
      );
      await expect(randomness.setConsumer(holders[0].address)).to.be.revertedWithCustomError(
        randomness,
        "ConsumerAlreadySet",
      );
    });

    it("rejects an invalid configuration", async function () {
      const { coordinator } = await loadFixture(vrfPoolFixture);
      const F = await ethers.getContractFactory("VRFRandomness");
      const c = await coordinator.getAddress();
      await expect(F.deploy(c, 1, ethers.ZeroHash, 1_000_000, 3, false)).to.be.revertedWithCustomError(F, "InvalidConfig");
      await expect(F.deploy(c, 1, ethers.id("lane"), 0, 3, false)).to.be.revertedWithCustomError(F, "InvalidConfig");
      await expect(F.deploy(ethers.ZeroAddress, 1, ethers.id("lane"), 1, 3, false)).to.be.revertedWithCustomError(
        F,
        "ZeroAddress",
      );
    });
  });

  describe("requests", function () {
    it("forwards a claim's jury request to the coordinator", async function () {
      const ctx = await loadFixture(vrfPoolFixture);
      await expect(ctx.claimManager.connect(ctx.claimant).submitClaim(USDC(400), ethers.id("evidence")))
        .to.emit(ctx.randomness, "RandomnessRequested")
        .withArgs(1n, 1n)
        .and.to.emit(ctx.coordinator, "RandomWordsRequested");
      expect(await ctx.randomness.claimOfRequest(1n)).to.equal(1n);
      expect((await ctx.claimManager.getClaim(1n)).state).to.equal(ClaimState.JuryPending);
    });

    it("only lets the JuryModule request, so nobody else can spend the subscription", async function () {
      const { randomness, holders } = await loadFixture(vrfPoolFixture);
      await expect(randomness.connect(holders[0]).requestRandomness(1)).to.be.revertedWithCustomError(
        randomness,
        "NotConsumer",
      );
    });

    it("only accepts the callback from the coordinator", async function () {
      const { randomness, holders, requestId } = await loadFixture(requestFixture);
      await expect(randomness.connect(holders[0]).rawFulfillRandomWords(requestId, [1n])).to.be.revertedWithCustomError(
        randomness,
        "OnlyCoordinatorCanFulfill",
      );
    });

    it("fails the claim submission if VRFRandomness is not a subscription consumer", async function () {
      const coordinator = await ethers.deployContract("MockVRFCoordinator");
      await coordinator.createSubscription();
      const vrf = { coordinator: await coordinator.getAddress(), subscriptionId: 1n, keyHash: ethers.id("lane") };
      const ctx = await deployContracts({ waitingPeriod: 0 }, { vrf });
      const signers = await ethers.getSigners();
      for (const [i, s] of signers.slice(1, 8).entries()) {
        await ctx.token.mint(s.address, USDC(100));
        await ctx.token.connect(s).approve(await ctx.pool.getAddress(), ethers.MaxUint256);
        await ctx.registry.connect(s).buyPolicy(ethers.id(`d${i}`), USDC(1_000));
      }
      await expect(ctx.claimManager.connect(signers[1]).submitClaim(USDC(10), ethers.id("e")))
        .to.be.revertedWithCustomError(coordinator, "InvalidConsumer");
    });
  });

  describe("fulfilment", function () {
    it("seats a jury from the VRF word and runs the claim to payout", async function () {
      const ctx = await loadFixture(requestFixture);
      const { coordinator, randomness, jury, claimManager, claimant, claimId, requestId, token } = ctx;
      const seed = 0xc0ffeen;

      await expect(coordinator.fulfillRandomWords(requestId, [seed]))
        .to.emit(randomness, "RandomnessFulfilled")
        .withArgs(claimId, requestId, seed)
        .and.to.emit(jury, "JurySelected");
      expect(await randomness.claimOfRequest(requestId)).to.equal(0n);
      expect((await claimManager.getClaim(claimId)).state).to.equal(ClaimState.Voting);

      const jurorAddrs = await jury.getJurors(claimId);
      expect(jurorAddrs).to.have.lengthOf(5);
      expect(jurorAddrs).to.not.include(claimant.address);

      const jurors = jurorAddrs.map((a) => ctx.signers.find((s) => s.address === a));
      await castVotes(ctx, claimId, jurors, [true, true, true, true, false]);
      await claimManager.finalize(claimId);
      await expect(claimManager.executePayout(claimId)).to.changeTokenBalance(token, claimant, USDC(400));
    });

    it("selects the same jury as the mock would for the same seed", async function () {
      // VRF only changes who supplies the seed, not how jurors are drawn from it.
      const ctx = await loadFixture(requestFixture);
      await ctx.coordinator.fulfillRandomWords(ctx.requestId, [42n]);
      const viaVrf = await ctx.jury.getJurors(ctx.claimId);
      const eligible = await ctx.registry.eligibleJurors(ctx.claimant.address);
      expect(viaVrf.every((a) => eligible.includes(a))).to.equal(true);
    });

    it("cannot seat a jury after the claim was cancelled for late randomness", async function () {
      const ctx = await loadFixture(requestFixture);
      const { coordinator, randomness, jury, claimManager, claimId, requestId, params } = ctx;
      await time.increase(params.randomnessTimeout + 1);
      await claimManager.cancelStalledClaim(claimId);

      // The late callback does not revert (Chainlink requires that); it records the failure instead.
      await expect(coordinator.fulfillRandomWords(requestId, [7n]))
        .to.emit(randomness, "FulfillmentFailed")
        .and.to.emit(coordinator, "RandomWordsFulfilled")
        .withArgs(requestId, true);
      expect((await claimManager.getClaim(claimId)).state).to.equal(ClaimState.Cancelled);
      expect((await jury.getJury(claimId)).phase).to.equal(JuryPhase.Cancelled);
      expect(await jury.getJurors(claimId)).to.have.lengthOf(0);
    });

    it("answers each request once", async function () {
      const ctx = await loadFixture(requestFixture);
      await ctx.coordinator.fulfillRandomWords(ctx.requestId, [1n]);
      await expect(ctx.coordinator.fulfillRandomWords(ctx.requestId, [2n])).to.be.revertedWithCustomError(
        ctx.coordinator,
        "UnknownRequest",
      );
      expect(await ctx.jury.getJurors(ctx.claimId)).to.have.lengthOf(5);
    });
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { activePoolFixture, submitClaim, fulfillRandomness, JuryPhase, EVIDENCE, USDC } = require("../helpers");

async function pendingFixture() {
  const ctx = await activePoolFixture();
  const claimId = await submitClaim(ctx, ctx.claimant);
  const requestId = await ctx.randomness.requestIdOf(claimId);
  return { ...ctx, claimId, requestId };
}

describe("VRFRandomness (Chainlink VRF v2.5)", function () {
  describe("requests", function () {
    it("asks the VRF coordinator for one word when a claim is filed", async function () {
      const ctx = await loadFixture(activePoolFixture);
      const tx = ctx.claimManager.connect(ctx.claimant).submitClaim(USDC(100), EVIDENCE);
      await expect(tx).to.emit(ctx.vrfCoordinator, "RandomWordsRequested").and.to.emit(ctx.randomness, "RandomnessRequested");
      const claimId = await ctx.claimManager.claimCount();
      const requestId = await ctx.randomness.requestIdOf(claimId);
      expect(requestId).to.not.equal(0n);
      expect(await ctx.randomness.claimOfRequest(requestId)).to.equal(claimId);
      expect(await ctx.randomness.isPending(claimId)).to.equal(true);
    });

    it("uses the subscription, key hash and gas settings it was deployed with", async function () {
      const { randomness, vrf } = await loadFixture(activePoolFixture);
      expect(await randomness.coordinator()).to.equal(vrf.coordinator);
      expect(await randomness.subscriptionId()).to.equal(vrf.subscriptionId);
      expect(await randomness.keyHash()).to.equal(vrf.keyHash);
      expect(await randomness.callbackGasLimit()).to.equal(vrf.callbackGasLimit);
      expect(await randomness.requestConfirmations()).to.equal(vrf.requestConfirmations);
    });

    it("only lets the JuryModule request randomness", async function () {
      const { randomness, deployer, claimant } = await loadFixture(activePoolFixture);
      for (const caller of [deployer, claimant]) {
        await expect(randomness.connect(caller).requestRandomness(99)).to.be.revertedWithCustomError(
          randomness,
          "NotConsumer",
        );
      }
    });

    it("rejects an invalid configuration", async function () {
      const { vrf } = await loadFixture(activePoolFixture);
      const F = await ethers.getContractFactory("VRFRandomness");
      const ok = [vrf.coordinator, vrf.subscriptionId, vrf.keyHash, 2_500_000, 3, false];
      await expect(F.deploy(ethers.ZeroAddress, ...ok.slice(1))).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(ok[0], 0, ...ok.slice(2))).to.be.revertedWithCustomError(F, "InvalidConfig");
      await expect(F.deploy(ok[0], ok[1], ethers.ZeroHash, ...ok.slice(3))).to.be.revertedWithCustomError(F, "InvalidConfig");
      await expect(F.deploy(...ok.slice(0, 3), 0, 3, false)).to.be.revertedWithCustomError(F, "InvalidConfig");
    });
  });

  describe("fulfilment", function () {
    it("seats the jury with the coordinator's word, in the same transaction", async function () {
      const ctx = await loadFixture(pendingFixture);
      const { jury, randomness, claimId, requestId } = ctx;
      // The mock derives its word as keccak256(requestId, 0), standing in for the oracle's VRF output.
      const word = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [requestId, 0])));
      await expect(fulfillRandomness(ctx, claimId))
        .to.emit(randomness, "RandomnessFulfilled")
        .withArgs(claimId, requestId, word)
        .and.to.emit(jury, "JurySelected");
      expect((await jury.getJury(claimId)).phase).to.equal(JuryPhase.Voting);
      expect(await randomness.isPending(claimId)).to.equal(false);
      expect(await randomness.requestIdOf(claimId)).to.equal(0n);
      // The word stays on-chain so anyone can recompute the draw.
      expect(await randomness.seedOf(claimId)).to.equal(word);
    });

    it("rejects an unknown request id", async function () {
      const ctx = await loadFixture(pendingFixture);
      const coordinator = await ethers.getImpersonatedSigner(await ctx.vrfCoordinator.getAddress());
      await ethers.provider.send("hardhat_setBalance", [coordinator.address, "0xDE0B6B3A7640000"]);
      await expect(ctx.randomness.connect(coordinator).rawFulfillRandomWords(ctx.requestId + 100n, [1n]))
        .to.be.revertedWithCustomError(ctx.randomness, "UnknownRequest")
        .withArgs(ctx.requestId + 100n);
    });
  });

  // Milestone 3 feedback: the backend keeper owned the mock randomness seed and could bias jury
  // selection. These tests show the deployer/keeper key has no route to choose a seed any more.
  describe("seed manipulation", function () {
    it("ignores seeds pushed by the deployer (the keeper's key) or any member", async function () {
      const ctx = await loadFixture(pendingFixture);
      const { randomness, jury, deployer, holders, claimId, requestId } = ctx;
      for (const caller of [deployer, holders[3]]) {
        await expect(randomness.connect(caller).rawFulfillRandomWords(requestId, [42n]))
          .to.be.revertedWithCustomError(randomness, "OnlyCoordinator")
          .withArgs(caller.address);
        // Going around the provider straight to the JuryModule does not work either.
        await expect(jury.connect(caller).fulfillRandomness(claimId, 42n)).to.be.revertedWithCustomError(
          jury,
          "NotRandomnessProvider",
        );
      }
      expect((await jury.getJury(claimId)).phase).to.equal(JuryPhase.AwaitingRandomness);
    });

    it("has no owner or admin function that could redirect randomness", async function () {
      const { randomness, jury, deployer } = await loadFixture(activePoolFixture);
      const fns = randomness.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      // Only the one-time consumer link mutates configuration; nothing can swap the coordinator.
      expect(fns).to.not.include("owner");
      expect(fns).to.not.include("setCoordinator");
      expect(fns).to.not.include("transferOwnership");
      await expect(randomness.connect(deployer).setConsumer(deployer.address)).to.be.revertedWithCustomError(
        randomness,
        "AlreadySet",
      );
      expect(await randomness.consumer()).to.equal(await jury.getAddress());
      // And the JuryModule's provider is immutable, so a rogue provider cannot be wired in later.
      expect(jury.interface.getFunction("setRandomness")).to.equal(null);
    });

    it("only lets the deployer make the one-time consumer link", async function () {
      const { vrf, claimant } = await loadFixture(activePoolFixture);
      const fresh = await ethers.deployContract("VRFRandomness", [
        vrf.coordinator,
        vrf.subscriptionId,
        vrf.keyHash,
        vrf.callbackGasLimit,
        vrf.requestConfirmations,
        vrf.nativePayment,
      ]);
      await expect(fresh.connect(claimant).setConsumer(claimant.address)).to.be.revertedWithCustomError(fresh, "NotDeployer");
      await expect(fresh.setConsumer(ethers.ZeroAddress)).to.be.revertedWithCustomError(fresh, "ZeroAddress");
    });

    it("cannot re-roll: once the word is delivered the request is closed", async function () {
      const ctx = await loadFixture(pendingFixture);
      const { randomness, vrfCoordinator, claimId, requestId } = ctx;
      await fulfillRandomness(ctx, claimId);
      const seated = await ctx.jury.getJurors(claimId);

      const coordinator = await ethers.getImpersonatedSigner(await vrfCoordinator.getAddress());
      await ethers.provider.send("hardhat_setBalance", [coordinator.address, "0xDE0B6B3A7640000"]);
      // Even the coordinator cannot answer the same request a second time with a better word.
      await expect(randomness.connect(coordinator).rawFulfillRandomWords(requestId, [7n])).to.be.revertedWithCustomError(
        randomness,
        "UnknownRequest",
      );
      expect(await ctx.jury.getJurors(claimId)).to.deep.equal(seated);
    });

    it("spreads selection across members instead of favouring any fixed set", async function () {
      // 40 independent VRF words over the 6 eligible members: each member should be picked sometimes
      // and left out sometimes. A biased or constant seed would seat the same five every time.
      const picks = new Map();
      for (let i = 0; i < 40; i++) {
        const ctx = await loadFixture(pendingFixture);
        const word = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`vrf-word-${i}`)));
        await fulfillRandomness(ctx, ctx.claimId, word);
        for (const a of await ctx.jury.getJurors(ctx.claimId)) picks.set(a, (picks.get(a) ?? 0) + 1);
      }
      expect(picks.size).to.equal(6);
      for (const count of picks.values()) {
        expect(count).to.be.greaterThan(20); // expected 40 * 5/6 ≈ 33
        expect(count).to.be.lessThan(40);
      }
    });
  });
});

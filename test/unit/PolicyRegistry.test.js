const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, deviceHash, USDC, COVERAGE, PolicyStatus } = require("../helpers");

async function fundedFixture() {
  const ctx = await deployFixture();
  const users = ctx.signers.slice(1, 5);
  for (const u of users) {
    await ctx.token.mint(u.address, USDC(1_000));
    await ctx.token.connect(u).approve(await ctx.pool.getAddress(), ethers.MaxUint256);
  }
  return { ...ctx, users };
}

describe("PolicyRegistry", function () {
  describe("buyPolicy", function () {
    it("creates an active policy and pulls the premium into the pool", async function () {
      const { registry, pool, token, users } = await loadFixture(fundedFixture);
      const [alice] = users;
      const premium = await registry.premiumFor(COVERAGE);
      expect(premium).to.equal(USDC(50));

      await expect(registry.connect(alice).buyPolicy(deviceHash("a"), COVERAGE))
        .to.emit(registry, "PolicyPurchased")
        .withArgs(1n, alice.address, deviceHash("a"), COVERAGE, premium);

      const p = await registry.getPolicy(alice.address);
      expect(p.id).to.equal(1n);
      expect(p.holder).to.equal(alice.address);
      expect(p.coverageLimit).to.equal(COVERAGE);
      expect(p.status).to.equal(PolicyStatus.Active);
      expect(await registry.isActive(alice.address)).to.equal(true);
      expect(await pool.balance()).to.equal(premium);
      expect(await token.balanceOf(await registry.getAddress())).to.equal(0n);
    });

    it("enforces one active policy per wallet", async function () {
      const { registry, users } = await loadFixture(fundedFixture);
      await registry.connect(users[0]).buyPolicy(deviceHash("a"), COVERAGE);
      await expect(registry.connect(users[0]).buyPolicy(deviceHash("b"), COVERAGE)).to.be.revertedWithCustomError(
        registry,
        "AlreadyHasActivePolicy",
      );
    });

    it("enforces one active policy per device", async function () {
      const { registry, users } = await loadFixture(fundedFixture);
      await registry.connect(users[0]).buyPolicy(deviceHash("a"), COVERAGE);
      await expect(registry.connect(users[1]).buyPolicy(deviceHash("a"), COVERAGE)).to.be.revertedWithCustomError(
        registry,
        "DeviceAlreadyCovered",
      );
    });

    it("validates coverage and device inputs", async function () {
      const { registry, users, params } = await loadFixture(fundedFixture);
      const r = registry.connect(users[0]);
      await expect(r.buyPolicy(ethers.ZeroHash, COVERAGE)).to.be.revertedWithCustomError(registry, "InvalidDevice");
      await expect(r.buyPolicy(deviceHash("a"), 0)).to.be.revertedWithCustomError(registry, "InvalidCoverage");
      await expect(r.buyPolicy(deviceHash("a"), params.maxCoverageLimit + 1n)).to.be.revertedWithCustomError(
        registry,
        "InvalidCoverage",
      );
      // Coverage so small the premium rounds to zero.
      await expect(r.buyPolicy(deviceHash("a"), 1n)).to.be.revertedWithCustomError(registry, "InvalidCoverage");
    });

    it("reverts if the holder has not approved the pool", async function () {
      const { registry, token, pool, signers } = await loadFixture(fundedFixture);
      const stranger = signers[10];
      await token.mint(stranger.address, USDC(1_000));
      await expect(registry.connect(stranger).buyPolicy(deviceHash("s"), COVERAGE)).to.be.revertedWithCustomError(
        token,
        "ERC20InsufficientAllowance",
      );
      expect(await pool.balance()).to.equal(0n);
    });
  });

  describe("lapsing", function () {
    it("lets a holder cancel and later buy a new policy", async function () {
      const { registry, users } = await loadFixture(fundedFixture);
      const [alice] = users;
      await registry.connect(alice).buyPolicy(deviceHash("a"), COVERAGE);
      await expect(registry.connect(alice).cancelPolicy()).to.emit(registry, "PolicyLapsed").withArgs(1n, alice.address);
      expect(await registry.isActive(alice.address)).to.equal(false);
      expect(await registry.deviceCovered(deviceHash("a"))).to.equal(false);

      await registry.connect(alice).buyPolicy(deviceHash("a"), COVERAGE);
      expect((await registry.getPolicy(alice.address)).id).to.equal(2n);
      expect(await registry.holderCount()).to.equal(1n);
    });

    it("lets only the owner lapse someone else's policy", async function () {
      const { registry, users } = await loadFixture(fundedFixture);
      const [alice, bob] = users;
      await registry.connect(alice).buyPolicy(deviceHash("a"), COVERAGE);
      await expect(registry.connect(bob).lapsePolicy(alice.address)).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount",
      );
      await registry.lapsePolicy(alice.address);
      expect((await registry.getPolicy(alice.address)).status).to.equal(PolicyStatus.Lapsed);
      await expect(registry.lapsePolicy(alice.address)).to.be.revertedWithCustomError(registry, "NoActivePolicy");
    });
  });

  describe("eligibility", function () {
    it("tracks the waiting period", async function () {
      const { registry, users, params } = await loadFixture(fundedFixture);
      await registry.connect(users[0]).buyPolicy(deviceHash("a"), COVERAGE);
      expect(await registry.isPastWaitingPeriod(users[0].address)).to.equal(false);
      await time.increase(params.waitingPeriod);
      expect(await registry.isPastWaitingPeriod(users[0].address)).to.equal(true);
    });

    it("lists eligible jurors, excluding the given address, new and lapsed holders", async function () {
      const { registry, users, params } = await loadFixture(fundedFixture);
      const [a, b, c, d] = users;
      await registry.connect(a).buyPolicy(deviceHash("a"), COVERAGE);
      await registry.connect(b).buyPolicy(deviceHash("b"), COVERAGE);
      await registry.connect(c).buyPolicy(deviceHash("c"), COVERAGE);
      await time.increase(params.waitingPeriod);
      await registry.connect(d).buyPolicy(deviceHash("d"), COVERAGE); // still in waiting period
      await registry.connect(c).cancelPolicy(); // lapsed

      expect(await registry.eligibleJurors(ethers.ZeroAddress)).to.deep.equal([a.address, b.address]);
      expect(await registry.eligibleJurors(a.address)).to.deep.equal([b.address]);
    });
  });
});

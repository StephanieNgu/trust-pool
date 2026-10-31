const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployFixture,
  activePoolFixture,
  deviceHash,
  enrollmentHash,
  USDC,
  COVERAGE,
  EVIDENCE,
  PolicyStatus,
  PremiumState,
} = require("../helpers");

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

      await expect(registry.connect(alice).buyPolicy(deviceHash("a"), COVERAGE, enrollmentHash("a")))
        .to.emit(registry, "PolicyPurchased")
        .withArgs(1n, alice.address, deviceHash("a"), COVERAGE, premium, enrollmentHash("a"));

      const p = await registry.getPolicy(alice.address);
      expect(p.id).to.equal(1n);
      expect(p.holder).to.equal(alice.address);
      expect(p.coverageLimit).to.equal(COVERAGE);
      expect(p.status).to.equal(PolicyStatus.Active);
      expect(p.enrollmentHash).to.equal(enrollmentHash("a"));
      expect(await registry.isActive(alice.address)).to.equal(true);
      expect(await pool.balance()).to.equal(premium);
      expect(await token.balanceOf(await registry.getAddress())).to.equal(0n);
    });

    it("enforces one active policy per wallet", async function () {
      const { registry, users } = await loadFixture(fundedFixture);
      await registry.connect(users[0]).buyPolicy(deviceHash("a"), COVERAGE, enrollmentHash("a"));
      await expect(registry.connect(users[0]).buyPolicy(deviceHash("b"), COVERAGE, enrollmentHash("b"))).to.be.revertedWithCustomError(
        registry,
        "AlreadyHasActivePolicy",
      );
    });

    it("enforces one active policy per device", async function () {
      const { registry, users } = await loadFixture(fundedFixture);
      await registry.connect(users[0]).buyPolicy(deviceHash("a"), COVERAGE, enrollmentHash("a"));
      await expect(registry.connect(users[1]).buyPolicy(deviceHash("a"), COVERAGE, enrollmentHash("a"))).to.be.revertedWithCustomError(
        registry,
        "DeviceAlreadyCovered",
      );
    });

    it("validates coverage, device and enrollment inputs", async function () {
      const { registry, users, params } = await loadFixture(fundedFixture);
      const r = registry.connect(users[0]);
      await expect(r.buyPolicy(ethers.ZeroHash, COVERAGE, enrollmentHash("x"))).to.be.revertedWithCustomError(registry, "InvalidDevice");
      await expect(r.buyPolicy(deviceHash("a"), COVERAGE, ethers.ZeroHash)).to.be.revertedWithCustomError(
        registry,
        "InvalidEnrollment",
      );
      await expect(r.buyPolicy(deviceHash("a"), 0, enrollmentHash("a"))).to.be.revertedWithCustomError(registry, "InvalidCoverage");
      await expect(r.buyPolicy(deviceHash("a"), params.maxCoverageLimit + 1n, enrollmentHash("a"))).to.be.revertedWithCustomError(
        registry,
        "InvalidCoverage",
      );
      // Coverage so small the premium rounds to zero.
      await expect(r.buyPolicy(deviceHash("a"), 1n, enrollmentHash("a"))).to.be.revertedWithCustomError(registry, "InvalidCoverage");
    });

    it("reverts if the holder has not approved the pool", async function () {
      const { registry, token, pool, signers } = await loadFixture(fundedFixture);
      const stranger = signers[10];
      await token.mint(stranger.address, USDC(1_000));
      await expect(registry.connect(stranger).buyPolicy(deviceHash("s"), COVERAGE, enrollmentHash("s"))).to.be.revertedWithCustomError(
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
      await registry.connect(alice).buyPolicy(deviceHash("a"), COVERAGE, enrollmentHash("a"));
      await expect(registry.connect(alice).cancelPolicy()).to.emit(registry, "PolicyLapsed").withArgs(1n, alice.address);
      expect(await registry.isActive(alice.address)).to.equal(false);
      expect(await registry.deviceCovered(deviceHash("a"))).to.equal(false);

      await registry.connect(alice).buyPolicy(deviceHash("a"), COVERAGE, enrollmentHash("a"));
      expect((await registry.getPolicy(alice.address)).id).to.equal(2n);
      expect(await registry.holderCount()).to.equal(1n);
    });

    it("lets only the owner lapse someone else's policy", async function () {
      const { registry, users } = await loadFixture(fundedFixture);
      const [alice, bob] = users;
      await registry.connect(alice).buyPolicy(deviceHash("a"), COVERAGE, enrollmentHash("a"));
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
      await registry.connect(users[0]).buyPolicy(deviceHash("a"), COVERAGE, enrollmentHash("a"));
      expect(await registry.isPastWaitingPeriod(users[0].address)).to.equal(false);
      await time.increase(params.waitingPeriod);
      expect(await registry.isPastWaitingPeriod(users[0].address)).to.equal(true);
    });

    it("lists eligible jurors, excluding the given address, new and lapsed holders", async function () {
      const { registry, users, params } = await loadFixture(fundedFixture);
      const [a, b, c, d] = users;
      await registry.connect(a).buyPolicy(deviceHash("a"), COVERAGE, enrollmentHash("a"));
      await registry.connect(b).buyPolicy(deviceHash("b"), COVERAGE, enrollmentHash("b"));
      await registry.connect(c).buyPolicy(deviceHash("c"), COVERAGE, enrollmentHash("c"));
      await time.increase(params.waitingPeriod);
      await registry.connect(d).buyPolicy(deviceHash("d"), COVERAGE, enrollmentHash("d")); // still in waiting period
      await registry.connect(c).cancelPolicy(); // lapsed

      expect(await registry.eligibleJurors(ethers.ZeroAddress)).to.deep.equal([a.address, b.address]);
      expect(await registry.eligibleJurors(a.address)).to.deep.equal([b.address]);
    });
  });

  describe("monthly premiums", function () {
    async function insuredFixture() {
      const ctx = await fundedFixture();
      const [alice] = ctx.users;
      await ctx.registry.connect(alice).buyPolicy(deviceHash("a"), COVERAGE, enrollmentHash("a"));
      const bought = await time.latest();
      return { ...ctx, alice, bought: BigInt(bought) };
    }

    it("pays the first period on purchase", async function () {
      const { registry, alice, bought, params } = await loadFixture(insuredFixture);
      const period = BigInt(params.premiumPeriod);
      expect(await registry.paidThrough(alice.address)).to.equal(bought + period);
      const [state, paidUntil, graceEndsAt, amount] = await registry.premiumStatus(alice.address);
      expect(state).to.equal(PremiumState.Paid);
      expect(paidUntil).to.equal(bought + period);
      expect(graceEndsAt).to.equal(bought + period + BigInt(params.gracePeriod));
      expect(amount).to.equal(USDC(50));
    });

    it("reports no premium for a wallet without a policy", async function () {
      const { registry, users } = await loadFixture(insuredFixture);
      expect(await registry.premiumStatus(users[1].address)).to.deep.equal([PremiumState.None, 0n, 0n, 0n]);
    });

    it("extends coverage by one period from the end of the paid one, and collects the premium", async function () {
      const { registry, pool, alice, bought, params } = await loadFixture(insuredFixture);
      const period = BigInt(params.premiumPeriod);
      await time.increase(10 * 24 * 3600);
      await expect(registry.connect(alice).payPremium())
        .to.emit(registry, "PremiumPaid")
        .withArgs(1n, alice.address, USDC(50), bought + 2n * period);
      expect(await registry.paidThrough(alice.address)).to.equal(bought + 2n * period);
      expect(await pool.balance()).to.equal(USDC(100));
      expect(await pool.contributionsOf(alice.address)).to.equal(USDC(100));
    });

    it("allows paying at most one period ahead", async function () {
      const { registry, alice } = await loadFixture(insuredFixture);
      await registry.connect(alice).payPremium();
      await expect(registry.connect(alice).payPremium()).to.be.revertedWithCustomError(registry, "PaidTooFarAhead");
    });

    it("keeps coverage through the grace period after a missed premium", async function () {
      const { registry, alice, bought, params } = await loadFixture(insuredFixture);
      await time.increaseTo(bought + BigInt(params.premiumPeriod) + 1n);
      expect((await registry.premiumStatus(alice.address))[0]).to.equal(PremiumState.Grace);
      expect(await registry.isActive(alice.address)).to.equal(true);
      expect(await registry.isPastWaitingPeriod(alice.address)).to.equal(true);
      expect(await registry.isOverdue(alice.address)).to.equal(false);

      // Paying in grace counts from the missed due date, not from today.
      await registry.connect(alice).payPremium();
      expect(await registry.paidThrough(alice.address)).to.equal(bought + 2n * BigInt(params.premiumPeriod));
      expect((await registry.premiumStatus(alice.address))[0]).to.equal(PremiumState.Paid);
    });

    it("stops counting the policy as active once the grace period ends", async function () {
      const { registry, users, alice, bought, params } = await loadFixture(insuredFixture);
      const graceEnd = bought + BigInt(params.premiumPeriod) + BigInt(params.gracePeriod);
      await registry.connect(users[1]).buyPolicy(deviceHash("b"), COVERAGE, enrollmentHash("b"));
      await registry.connect(users[1]).payPremium(); // bob pays a month ahead and stays covered
      await time.increaseTo(graceEnd + 1n);

      expect(await registry.isActive(alice.address)).to.equal(false);
      expect(await registry.isOverdue(alice.address)).to.equal(true);
      expect(await registry.isPastWaitingPeriod(alice.address)).to.equal(false);
      expect((await registry.premiumStatus(alice.address))[0]).to.equal(PremiumState.Overdue);
      expect(await registry.overdueHolders()).to.deep.equal([alice.address]);
      expect(await registry.eligibleJurors(ethers.ZeroAddress)).to.deep.equal([users[1].address]);
      await expect(registry.connect(alice).payPremium()).to.be.revertedWithCustomError(registry, "PolicyOverdue");
    });

    it("lets anyone close an overdue policy, freeing its device", async function () {
      const { registry, users, alice, bought, params } = await loadFixture(insuredFixture);
      await expect(registry.connect(users[1]).lapseOverdue(alice.address)).to.be.revertedWithCustomError(registry, "NotOverdue");
      await time.increaseTo(bought + BigInt(params.premiumPeriod) + BigInt(params.gracePeriod) + 1n);
      await expect(registry.connect(users[1]).lapseOverdue(alice.address))
        .to.emit(registry, "PolicyLapsed")
        .withArgs(1n, alice.address);
      expect((await registry.getPolicy(alice.address)).status).to.equal(PolicyStatus.Lapsed);
      expect(await registry.deviceCovered(deviceHash("a"))).to.equal(false);
      expect((await registry.premiumStatus(alice.address))[0]).to.equal(PremiumState.Lapsed);
      expect(await registry.overdueHolders()).to.deep.equal([]);
      await expect(registry.connect(alice).payPremium()).to.be.revertedWithCustomError(registry, "NoActivePolicy");
    });

    it("lets the holder, or a new owner of the device, buy again once the old policy is overdue", async function () {
      const { registry, users, alice, bought, params } = await loadFixture(insuredFixture);
      await time.increaseTo(bought + BigInt(params.premiumPeriod) + BigInt(params.gracePeriod) + 1n);

      // Someone else enrolling the same device closes the overdue policy on it first.
      await expect(registry.connect(users[1]).buyPolicy(deviceHash("a"), COVERAGE, enrollmentHash("b")))
        .to.emit(registry, "PolicyLapsed")
        .withArgs(1n, alice.address);
      expect(await registry.isActive(users[1].address)).to.equal(true);

      // Alice can start over with another device without calling lapseOverdue herself.
      await registry.connect(alice).buyPolicy(deviceHash("a2"), COVERAGE, enrollmentHash("a2"));
      expect((await registry.getPolicy(alice.address)).id).to.equal(3n);
      expect((await registry.premiumStatus(alice.address))[0]).to.equal(PremiumState.Paid);
    });

    it("blocks new claims once overdue, but keeps an open claim's policy open", async function () {
      const ctx = await loadFixture(activePoolFixture);
      const { registry, claimManager, holders, claimant, params } = ctx;
      await claimManager.connect(claimant).submitClaim(USDC(100), EVIDENCE);

      await time.increase(BigInt(params.premiumPeriod) + BigInt(params.gracePeriod));
      expect(await registry.isOverdue(claimant.address)).to.equal(true);
      await expect(registry.lapseOverdue(claimant.address)).to.be.revertedWithCustomError(registry, "OpenClaimExists").withArgs(1n);

      const other = holders[1];
      await expect(claimManager.connect(other).submitClaim(USDC(100), EVIDENCE)).to.be.revertedWithCustomError(
        claimManager,
        "NoActivePolicy",
      );
      await registry.lapseOverdue(other.address);
    });

    it("rejects a zero premium period", async function () {
      const { pool } = await loadFixture(insuredFixture);
      const factory = await ethers.getContractFactory("PolicyRegistry");
      await expect(
        factory.deploy(await pool.getAddress(), 0, 500, USDC(2_000), 0, 0),
      ).to.be.revertedWithCustomError(factory, "InvalidPeriod");
    });
  });
});

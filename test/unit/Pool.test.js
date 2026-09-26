const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { USDC } = require("../helpers");

// The Pool is tested in isolation: plain signers stand in for the registry and claim manager.
async function poolFixture() {
  const [owner, registry, claimManager, alice, bob] = await ethers.getSigners();
  const token = await ethers.deployContract("MockStablecoin");
  const pool = await ethers.deployContract("Pool", [await token.getAddress(), 2_000]);
  await pool.setRegistry(registry.address);
  await pool.setClaimManager(claimManager.address);
  for (const s of [alice, bob]) {
    await token.mint(s.address, USDC(10_000));
    await token.connect(s).approve(await pool.getAddress(), ethers.MaxUint256);
  }
  return { token, pool, owner, registry, claimManager, alice, bob };
}

describe("Pool", function () {
  describe("deployment and wiring", function () {
    it("rejects invalid maxPayoutBps", async function () {
      const token = await ethers.deployContract("MockStablecoin");
      const Pool = await ethers.getContractFactory("Pool");
      await expect(Pool.deploy(await token.getAddress(), 0)).to.be.revertedWithCustomError(Pool, "InvalidBps");
      await expect(Pool.deploy(await token.getAddress(), 10_001)).to.be.revertedWithCustomError(Pool, "InvalidBps");
    });

    it("allows wiring only once and only by the owner", async function () {
      const { pool, alice } = await loadFixture(poolFixture);
      await expect(pool.setRegistry(alice.address)).to.be.revertedWithCustomError(pool, "AlreadySet");
      await expect(pool.setClaimManager(alice.address)).to.be.revertedWithCustomError(pool, "AlreadySet");

      const token = await ethers.deployContract("MockStablecoin");
      const fresh = await ethers.deployContract("Pool", [await token.getAddress(), 2_000]);
      await expect(fresh.connect(alice).setRegistry(alice.address)).to.be.revertedWithCustomError(
        fresh,
        "OwnableUnauthorizedAccount",
      );
      await expect(fresh.setClaimManager(ethers.ZeroAddress)).to.be.revertedWithCustomError(fresh, "ZeroAddress");
    });
  });

  describe("contributions", function () {
    it("accepts contributions and tracks them", async function () {
      const { pool, alice } = await loadFixture(poolFixture);
      await expect(pool.connect(alice).contribute(USDC(100)))
        .to.emit(pool, "Contributed")
        .withArgs(alice.address, USDC(100));
      expect(await pool.balance()).to.equal(USDC(100));
      expect(await pool.contributionsOf(alice.address)).to.equal(USDC(100));
      expect(await pool.totalContributed()).to.equal(USDC(100));
    });

    it("rejects zero contributions", async function () {
      const { pool, alice } = await loadFixture(poolFixture);
      await expect(pool.connect(alice).contribute(0)).to.be.revertedWithCustomError(pool, "ZeroAmount");
    });

    it("only lets the registry collect premiums", async function () {
      const { pool, registry, alice } = await loadFixture(poolFixture);
      await expect(pool.connect(alice).collectPremium(alice.address, 1n)).to.be.revertedWithCustomError(
        pool,
        "NotRegistry",
      );
      await pool.connect(registry).collectPremium(alice.address, USDC(50));
      expect(await pool.contributionsOf(alice.address)).to.equal(USDC(50));
    });
  });

  describe("payouts", function () {
    it("caps a single payout at maxPayoutBps of the balance", async function () {
      const { pool, alice } = await loadFixture(poolFixture);
      await pool.connect(alice).contribute(USDC(1_000));
      expect(await pool.maxPayout()).to.equal(USDC(200));
    });

    it("pays out up to the cap when called by the claim manager", async function () {
      const { token, pool, claimManager, alice, bob } = await loadFixture(poolFixture);
      await pool.connect(alice).contribute(USDC(1_000));
      const before = await token.balanceOf(bob.address);
      await expect(pool.connect(claimManager).payout(bob.address, USDC(200)))
        .to.emit(pool, "PaidOut")
        .withArgs(bob.address, USDC(200));
      expect(await token.balanceOf(bob.address)).to.equal(before + USDC(200));
      expect(await pool.totalPaidOut()).to.equal(USDC(200));
    });

    it("reverts a payout above the cap", async function () {
      const { pool, claimManager, alice, bob } = await loadFixture(poolFixture);
      await pool.connect(alice).contribute(USDC(1_000));
      await expect(pool.connect(claimManager).payout(bob.address, USDC(200) + 1n))
        .to.be.revertedWithCustomError(pool, "ExceedsPayoutCap")
        .withArgs(USDC(200) + 1n, USDC(200));
    });

    it("rejects payouts from anyone but the claim manager", async function () {
      const { pool, owner, alice } = await loadFixture(poolFixture);
      await pool.connect(alice).contribute(USDC(1_000));
      await expect(pool.connect(owner).payout(alice.address, 1n)).to.be.revertedWithCustomError(
        pool,
        "NotClaimManager",
      );
    });

    it("rejects zero amounts and the zero address", async function () {
      const { pool, claimManager, alice } = await loadFixture(poolFixture);
      await pool.connect(alice).contribute(USDC(1_000));
      await expect(pool.connect(claimManager).payout(alice.address, 0)).to.be.revertedWithCustomError(
        pool,
        "ZeroAmount",
      );
      await expect(pool.connect(claimManager).payout(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(
        pool,
        "ZeroAddress",
      );
    });
  });
});

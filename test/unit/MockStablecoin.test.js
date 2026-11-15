const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("MockStablecoin", function () {
  it("uses 6 decimals like USDC", async function () {
    const token = await ethers.deployContract("MockStablecoin");
    expect(await token.decimals()).to.equal(6);
  });

  it("lets only the owner mint", async function () {
    const [owner, other] = await ethers.getSigners();
    const token = await ethers.deployContract("MockStablecoin");
    await token.connect(owner).mint(other.address, 100n);
    expect(await token.balanceOf(other.address)).to.equal(100n);
    await expect(token.connect(other).mint(other.address, 1n)).to.be.revertedWithCustomError(
      token,
      "OwnableUnauthorizedAccount",
    );
  });

  it("lets anyone draw 1,000 mUSDC from the faucet once a day", async function () {
    const [, member] = await ethers.getSigners();
    const token = await ethers.deployContract("MockStablecoin");
    const amount = await token.FAUCET_AMOUNT();
    expect(amount).to.equal(1_000_000_000n);

    await expect(token.connect(member).faucet()).to.emit(token, "FaucetUsed").withArgs(member.address, amount);
    expect(await token.balanceOf(member.address)).to.equal(amount);

    const availableAt = (await token.lastFaucetAt(member.address)) + (await token.FAUCET_COOLDOWN());
    await expect(token.connect(member).faucet())
      .to.be.revertedWithCustomError(token, "FaucetCooldown")
      .withArgs(availableAt);

    await time.increaseTo(availableAt);
    await token.connect(member).faucet();
    expect(await token.balanceOf(member.address)).to.equal(amount * 2n);
  });
});

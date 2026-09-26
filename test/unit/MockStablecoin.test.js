const { expect } = require("chai");
const { ethers } = require("hardhat");

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
});

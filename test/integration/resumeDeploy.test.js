// scripts/deploy.js finishes a public-network deployment that stopped partway (for example when the
// wallet ran out of Sepolia ETH after five of the six contracts), reusing what is already on-chain.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployContracts, TESTNET_PARAMS } = require("../../scripts/lib/deployContracts");
const { findPartialDeployment } = require("../../scripts/lib/findPartialDeployment");

describe("Resuming an interrupted deployment", function () {
  let vrf;

  before(async function () {
    // Stand-in for Chainlink's Sepolia coordinator and the member's subscription.
    const coordinator = await ethers.deployContract("VRFCoordinatorV2_5Mock", [0, 0, 1]);
    const receipt = await (await coordinator.createSubscription()).wait();
    const subId = receipt.logs.map((l) => coordinator.interface.parseLog(l)).find((e) => e?.name === "SubscriptionCreated").args.subId;
    vrf = {
      coordinator: await coordinator.getAddress(),
      subscriptionId: subId,
      keyHash: "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae",
    };
  });

  /** A fresh, funded wallet, as a member's MetaMask deployer would be. */
  async function freshWallet() {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [wallet.address, "0x56BC75E2D63100000"]);
    return wallet;
  }

  /** Runs deployContracts but fails when it reaches `stopAt`, like a wallet running out of ETH. */
  async function deployUntil(signer, stopAt) {
    const original = ethers.deployContract;
    ethers.deployContract = (name, ...rest) => {
      if (name === stopAt) throw new Error("insufficient funds for gas * price + value");
      return original.call(ethers, name, ...rest);
    };
    try {
      await deployContracts(TESTNET_PARAMS, vrf, { signer });
      throw new Error("expected the deploy to stop");
    } catch (err) {
      expect(err.message).to.match(/insufficient funds/);
    } finally {
      ethers.deployContract = original;
    }
  }

  it("finds the five deployed contracts when ClaimManager never went out", async function () {
    const wallet = await freshWallet();
    await deployUntil(wallet, "ClaimManager");

    const partial = await findPartialDeployment(wallet, { subscriptionId: vrf.subscriptionId });
    expect(partial).to.not.equal(null);
    expect(Object.keys(partial.existing)).to.deep.equal(["token", "pool", "registry", "randomness", "jury"]);
    expect(partial.missing).to.deep.equal(["ClaimManager", "wiring"]);
  });

  it("finishes it by deploying only what is missing, then reports nothing left", async function () {
    const wallet = await freshWallet();
    await deployUntil(wallet, "ClaimManager");
    const partial = await findPartialDeployment(wallet, { subscriptionId: vrf.subscriptionId });
    // One link happened to go through before the run stopped; it must not be sent again.
    const randomness = await ethers.getContractAt("VRFRandomness", partial.existing.randomness, wallet);
    await (await randomness.setConsumer(partial.existing.jury)).wait();

    const nonceBefore = await ethers.provider.getTransactionCount(wallet.address);
    const logs = [];
    const ctx = await deployContracts(TESTNET_PARAMS, vrf, { signer: wallet, existing: partial.existing, log: (m) => logs.push(m) });
    // ClaimManager plus the four links still missing.
    expect((await ethers.provider.getTransactionCount(wallet.address)) - nonceBefore).to.equal(5);
    expect(logs.join("\n")).to.include("already done: linking VRFRandomness to JuryModule");

    for (const key of ["token", "pool", "registry", "randomness", "jury"]) {
      expect(await ctx[key].getAddress()).to.equal(partial.existing[key]);
    }
    const cm = await ctx.claimManager.getAddress();
    expect(await ctx.pool.registry()).to.equal(partial.existing.registry);
    expect(await ctx.pool.claimManager()).to.equal(cm);
    expect(await ctx.pool.jury()).to.equal(partial.existing.jury);
    expect(await ctx.jury.claimManager()).to.equal(cm);
    expect(await ctx.randomness.consumer()).to.equal(partial.existing.jury);
    expect(await ctx.claimManager.responsePeriod()).to.equal(TESTNET_PARAMS.responsePeriod);

    expect(await findPartialDeployment(wallet, { subscriptionId: vrf.subscriptionId })).to.equal(null);
  });

  it("picks up from an earlier stop too", async function () {
    const wallet = await freshWallet();
    await deployUntil(wallet, "VRFRandomness");
    const partial = await findPartialDeployment(wallet, { subscriptionId: vrf.subscriptionId });
    expect(Object.keys(partial.existing)).to.deep.equal(["token", "pool", "registry"]);
    const ctx = await deployContracts(TESTNET_PARAMS, vrf, { signer: wallet, existing: partial.existing });
    expect(await ctx.token.getAddress()).to.equal(partial.existing.token);
    expect(await ctx.pool.jury()).to.equal(await ctx.jury.getAddress());
  });

  it("reports nothing to finish for a new wallet or a completed deployment", async function () {
    const empty = await freshWallet();
    expect(await findPartialDeployment(empty, { subscriptionId: vrf.subscriptionId })).to.equal(null);

    const done = await freshWallet();
    await deployContracts(TESTNET_PARAMS, vrf, { signer: done });
    expect(await findPartialDeployment(done, { subscriptionId: vrf.subscriptionId })).to.equal(null);
  });

  it("does not reuse a randomness contract made for a different VRF subscription", async function () {
    const wallet = await freshWallet();
    await deployUntil(wallet, "ClaimManager");
    expect(await findPartialDeployment(wallet, { subscriptionId: vrf.subscriptionId + 1n })).to.equal(null);
  });
});

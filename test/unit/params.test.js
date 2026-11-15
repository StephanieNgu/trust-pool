const { expect } = require("chai");
const { deployContracts, TESTNET_PARAMS, USDC } = require("../../scripts/lib/deployContracts");

// The suites pin a 5% premium to keep their amounts round; this checks what a deploy actually uses.
describe("Deploy defaults", () => {
  it("charges 1.5% of the coverage per month", async () => {
    const { registry, params } = await deployContracts();
    expect(params.premiumBps).to.equal(150);
    expect(await registry.premiumFor(USDC(1_000))).to.equal(USDC(15));
  });

  it("accepts the shortened Sepolia parameters", async () => {
    const { jury, claimManager, registry } = await deployContracts(TESTNET_PARAMS);
    expect(await jury.jurySize()).to.equal(3);
    expect(await jury.quorum()).to.equal(2);
    expect(await registry.waitingPeriod()).to.equal(0);
    expect(await claimManager.responsePeriod()).to.equal(15 * 60);
  });
});

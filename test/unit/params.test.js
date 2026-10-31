const { expect } = require("chai");
const { deployContracts, USDC } = require("../../scripts/lib/deployContracts");

// The suites pin a 5% premium to keep their amounts round; this checks what a deploy actually uses.
describe("Deploy defaults", () => {
  it("charges 1.5% of the coverage per month", async () => {
    const { registry, params } = await deployContracts();
    expect(params.premiumBps).to.equal(150);
    expect(await registry.premiumFor(USDC(1_000))).to.equal(USDC(15));
  });
});

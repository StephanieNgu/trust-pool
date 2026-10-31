// Every revert a member can cause must read as a sentence, not "unknown custom error".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { Interface } from "ethers";
import { contractErrorMessage } from "../src/contracts/errors";

// Internal wiring and admin errors no member can trigger from the app.
const INTERNAL = new Set([
  "AlreadySet", "InvalidBps", "InvalidConfig", "InvalidPeriod", "InvalidBond", "NotClaimManager", "NotJury", "NotJuryModule",
  "NotRandomnessProvider", "NotRegistry", "OwnableInvalidOwner", "OwnableUnauthorizedAccount",
  "ReentrancyGuardReentrantCall", "SafeERC20FailedOperation", "ZeroAddress",
]);

describe("contract error messages", () => {
  for (const name of ["ClaimManager", "JuryModule", "Pool", "PolicyRegistry"]) {
    it(`explains every ${name} error a member can hit`, async () => {
      const { abi } = await hre.artifacts.readArtifact(name);
      const iface = new Interface(abi);
      iface.forEachError((fragment) => {
        if (INTERNAL.has(fragment.name)) return;
        const args = fragment.inputs.map((input) => (input.type === "address" ? `0x${"11".repeat(20)}` : 1n));
        const data = iface.encodeErrorResult(fragment, args);
        const message = contractErrorMessage({ code: "CALL_EXCEPTION", data });
        assert.ok(message, `${name}.${fragment.name} has no message`);
      });
    });
  }

  it("finds revert data nested inside wallet errors", () => {
    const iface = new Interface(["error NotEnoughEligibleJurors(uint256 available, uint256 required)"]);
    const data = iface.encodeErrorResult("NotEnoughEligibleJurors", [2n, 5n]);
    assert.match(contractErrorMessage({ info: { error: { data } } }) ?? "", /needs 5 other members .* only 2 are available/);
    assert.equal(contractErrorMessage(new Error("network down")), null);
  });
});

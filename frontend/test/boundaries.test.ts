// Values the frontend duplicates from the contracts and the backend. If one side changes without the
// other, the browser would send calls that revert or uploads the backend refuses; these fail first.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { Interface, type InterfaceAbi } from "ethers";
import mockStablecoinAbi from "../src/contracts/abis/MockStablecoin.json";
import policyRegistryAbi from "../src/contracts/abis/PolicyRegistry.json";
import poolAbi from "../src/contracts/abis/Pool.json";
import { ALLOWED_EVIDENCE_TYPES, MAX_EVIDENCE_FILE_BYTES, MAX_EVIDENCE_FILES } from "../src/api";
import { ALLOWED_CONTENT_TYPES, MAX_DESCRIPTION_LENGTH, MAX_FILE_BYTES, MAX_FILES } from "../../backend/src/evidence";

const FRONTEND_ABIS: Record<string, InterfaceAbi> = {
  MockStablecoin: mockStablecoinAbi,
  PolicyRegistry: policyRegistryAbi,
  Pool: poolAbi,
};

describe("frontend contract ABIs", () => {
  for (const [artifactName, abi] of Object.entries(FRONTEND_ABIS)) {
    it(`match the compiled ${artifactName}`, async () => {
      await hre.run("compile", { quiet: true });
      const compiled = new Interface((await hre.artifacts.readArtifact(artifactName)).abi);
      const ours = new Interface(abi);
      let count = 0;
      ours.forEachFunction((fn) => {
        count++;
        const real = compiled.getFunction(fn.selector);
        assert.ok(real, `${artifactName}.${fn.format()} does not exist in the compiled contract`);
        const outputs = (f: typeof fn) => f.outputs.map((o) => o.format("sighash")).join(",");
        assert.equal(outputs(fn), outputs(real), `${artifactName}.${fn.name} return types`);
        assert.equal(fn.stateMutability === "view" || fn.stateMutability === "pure", real.constant, `${artifactName}.${fn.name} mutability`);
      });
      assert.ok(count > 0, `${artifactName}.json has no functions`);
    });
  }
});

describe("frontend evidence rules", () => {
  it("match what the backend accepts", () => {
    assert.deepEqual([...ALLOWED_EVIDENCE_TYPES], [...ALLOWED_CONTENT_TYPES]);
    assert.equal(MAX_EVIDENCE_FILES, MAX_FILES);
    assert.equal(MAX_EVIDENCE_FILE_BYTES, MAX_FILE_BYTES);
    // uploadEvidence enforces 2,000 characters before sending.
    assert.equal(MAX_DESCRIPTION_LENGTH, 2_000);
  });
});
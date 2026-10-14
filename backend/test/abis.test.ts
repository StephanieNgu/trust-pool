// The backend uses hand-written ABI fragments; make sure each one matches the compiled contracts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { Interface } from "ethers";
import * as abis from "../src/abis";

const BY_NAME = {
  token: abis.tokenAbi,
  pool: abis.poolAbi,
  registry: abis.registryAbi,
  claimManager: abis.claimManagerAbi,
  jury: abis.juryAbi,
  randomness: abis.randomnessAbi,
} as const;

describe("ABI fragments", () => {
  for (const [key, artifactName] of Object.entries(abis.ARTIFACT_NAMES)) {
    it(`match the compiled ${artifactName}`, async () => {
      await hre.run("compile", { quiet: true });
      const compiled = new Interface((await hre.artifacts.readArtifact(artifactName)).abi);
      const ours = new Interface(BY_NAME[key as keyof typeof BY_NAME]);

      ours.forEachFunction((fn) => {
        const real = compiled.getFunction(fn.selector);
        assert.ok(real, `${artifactName}.${fn.format()} does not exist`);
        const outputs = (f: typeof fn) => f.outputs.map((o) => o.format("sighash")).join(",");
        assert.equal(outputs(fn), outputs(real), `${artifactName}.${fn.name} return types`);
      });
      ours.forEachError((err) => {
        assert.ok(compiled.getError(err.selector), `${artifactName} has no error ${err.format()}`);
      });
    });
  }
});

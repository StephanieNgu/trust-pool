// On a public chain the backend reads the event history at startup, not on the first history request.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp, type AppDeps } from "../src/app";

describe("warming the event history", () => {
  function fakeDeps(warmLogsEveryMs: number | null) {
    const ranges: [number, number][] = [];
    const provider = {
      getBlockNumber: async () => 125,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) => {
        ranges.push([fromBlock, toBlock]);
        return [];
      },
    };
    const deployment = { chainId: "11155111", startBlock: 100, addresses: { registry: "0x1", pool: "0x2", claimManager: "0x3" } };
    const deps = { deployment, provider, contracts: {}, evidence: {}, logBlockRange: 10, warmLogsEveryMs } as unknown as AppDeps;
    return { deps, ranges };
  }

  it("reads from the deploy block in capped steps as soon as the app starts", async () => {
    const { deps, ranges } = fakeDeps(60_000);
    createApp(deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(ranges, [[100, 109], [110, 119], [120, 125]]);
  });

  it("reads nothing until asked when warming is off", async () => {
    const { deps, ranges } = fakeDeps(null);
    createApp(deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(ranges, []);
  });
});

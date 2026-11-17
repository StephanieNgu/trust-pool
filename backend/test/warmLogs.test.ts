// On a public chain the backend reads the event history at startup, not on the first history request.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp, type AppDeps } from "../src/app";
import { LogIndex, isRateLimited } from "../src/history";

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
    // Two 250 ms pauses between the three capped steps.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(ranges, [[100, 109], [110, 119], [120, 125]]);
  });

  it("reads nothing until asked when warming is off", async () => {
    const { deps, ranges } = fakeDeps(null);
    createApp(deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(ranges, []);
  });

  it("backs off and retries when the RPC rate-limits eth_getLogs", async () => {
    let calls = 0;
    const provider = {
      getBlockNumber: async () => 19,
      getLogs: async () => {
        calls++;
        if (calls === 2) throw Object.assign(new Error("could not coalesce error"), { error: { code: 429, message: "Your app has exceeded its compute units per second capacity." } });
        return [];
      },
    };
    const index = new LogIndex(provider as never, { registry: "0x1", pool: "0x2", claimManager: "0x3" } as never, { fromBlock: 0, maxRange: 10, pauseMs: 1 });
    await index.sync();
    assert.equal(calls, 3, "two steps, one of them retried");
  });

  it("recognises rate-limit errors and nothing else", () => {
    assert.ok(isRateLimited({ error: { code: 429 } }));
    assert.ok(isRateLimited(new Error("Too Many Requests")));
    assert.ok(!isRateLimited(new Error("execution reverted")));
  });
});

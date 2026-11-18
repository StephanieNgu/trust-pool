// The backend's RPC provider retries rate-limited requests and caps how many are in flight.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { RateLimitedProvider } from "../src/rpc";

describe("RateLimitedProvider", () => {
  let server: Server;
  let url = "";
  let limitedLeft = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let requests = 0;

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const payload = JSON.parse(body);
        assert.ok(!Array.isArray(payload), "requests are not batched");
        if (payload.method === "eth_blockNumber") requests++;
        setTimeout(() => {
          inFlight--;
          res.setHeader("content-type", "application/json");
          const reply =
            payload.method === "eth_chainId"
              ? { jsonrpc: "2.0", id: payload.id, result: "0xaa36a7" }
              : limitedLeft-- > 0
                ? { jsonrpc: "2.0", id: payload.id, error: { code: 429, message: "Your app has exceeded its compute units per second capacity." } }
                : { jsonrpc: "2.0", id: payload.id, result: "0x10" };
          res.end(JSON.stringify(reply));
        }, 15);
      });
    }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("retries a request the RPC rate-limited", async () => {
    const provider = new RateLimitedProvider(url, { baseDelayMs: 5 });
    await provider.getNetwork();
    limitedLeft = 2;
    requests = 0;
    assert.equal(await provider.getBlockNumber(), 16);
    assert.equal(requests, 3, "two rate-limited answers, then the result");
    provider.destroy();
  });

  it("keeps at most maxConcurrency requests in flight, unbatched", async () => {
    const provider = new RateLimitedProvider(url, { maxConcurrency: 2, baseDelayMs: 5 });
    await provider.getNetwork();
    limitedLeft = 0;
    maxInFlight = 0;
    const balances = await Promise.all(
      Array.from({ length: 10 }, (_, i) => provider.getBalance(`0x${String(i + 1).padStart(40, "0")}`)),
    );
    assert.deepEqual(balances, Array(10).fill(16n));
    assert.equal(maxInFlight, 2);
    provider.destroy();
  });
});

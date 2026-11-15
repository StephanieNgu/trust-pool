// The hosted deployment serves the built web app from the same origin as the API.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp, type AppDeps } from "../src/app";
import { loadConfig } from "../src/config";

describe("serving the web app", () => {
  let base = "";
  let close: () => void = () => {};

  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), "trustpool-static-"));
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>TrustPool</title>");
    await writeFile(join(dir, "assets", "app-abc123.js"), "console.log(1)");
    // Static routes never touch the chain, so the chain-facing dependencies can be empty.
    const deps = { deployment: {}, provider: {}, contracts: {}, evidence: {}, staticDir: dir } as unknown as AppDeps;
    const server = createApp(deps).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  after(() => close());

  it("serves index.html at / and for client-side routes, uncached", async () => {
    for (const path of ["/", "/claims/3"]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /<title>TrustPool<\/title>/);
      assert.equal(res.headers.get("cache-control"), "no-cache");
    }
  });

  it("serves fingerprinted assets with a long cache", async () => {
    const res = await fetch(`${base}/assets/app-abc123.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /immutable/);
  });

  it("still answers unknown API paths with a JSON 404", async () => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not found." });
  });

  it("reads STATIC_DIR from the environment, and serves nothing by default", () => {
    assert.equal(loadConfig({}).staticDir, null);
    assert.equal(loadConfig({ STATIC_DIR: "/srv/web" }).staticDir, "/srv/web");
  });
});

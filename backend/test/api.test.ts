import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keeper } from "../src/keeper";
import { PHOTO, USDC, setup } from "./helpers";

describe("API", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  before(async () => {
    t = await setup();
  });
  after(async () => {
    await t.close();
  });

  it("reports health, config and pool stats", async () => {
    const health = (await t.api("/api/health")).body;
    assert.equal(health.ok, true);
    assert.equal(health.chainId, "31337");
    assert.equal(health.keeper.address, t.deployer.address);
    assert.equal(health.keeper.fulfillRandomness, true);

    const config = (await t.api("/api/config")).body;
    assert.equal(config.addresses.claimManager, await t.claimManager.getAddress());
    assert.deepEqual(config.token, { symbol: "mUSDC", decimals: 6 });
    assert.equal(config.params.jurySize, "5");

    const pool = (await t.api("/api/pool")).body;
    // 10,000 seed + 7 premiums of 50.
    assert.equal(pool.balance, USDC(10_350).toString());
    assert.equal(pool.maxPayout, USDC(2_070).toString());
    assert.equal(pool.maxPayoutBps, 2_000);
    assert.equal(pool.policyCount, 7);
    assert.equal(pool.claimCount, 0);
  });

  it("describes a member and their policy", async () => {
    const member = (await t.api(`/api/members/${t.claimant.address}`)).body;
    assert.equal(member.balance, USDC(950).toString());
    assert.equal(member.contributed, USDC(50).toString());
    assert.equal(member.policy.status, "Active");
    assert.equal(member.policy.coverageLimit, USDC(1_000).toString());
    assert.equal(member.policy.pastWaitingPeriod, true);
    assert.equal(member.policy.claimEligibleAt, member.policy.startTime + 7 * 24 * 3600);

    const stranger = (await t.api(`/api/members/${t.signers[15].address}`)).body;
    assert.equal(stranger.policy, null);
  });

  it("stores evidence and serves it back byte for byte", async () => {
    const files = [
      { name: "front.jpg", contentType: "image/jpeg", data: PHOTO },
      { name: "back.png", contentType: "image/png", data: Buffer.from("png bytes").toString("base64") },
    ];
    const res = await t.post("/api/evidence", { description: "Both sides", files });
    assert.equal(res.status, 201);
    const hash = res.body.evidenceHash;
    assert.match(hash, /^0x[0-9a-f]{64}$/);

    const again = await t.post("/api/evidence", { description: "Both sides", files });
    assert.equal(again.body.evidenceHash, hash, "same evidence, same hash");

    const summary = (await t.api(`/api/evidence/${hash}`)).body;
    assert.equal(summary.description, "Both sides");
    assert.deepEqual(
      summary.files.map((f: { name: string; size: number; url: string }) => [f.name, f.size, f.url]),
      [
        ["front.jpg", Buffer.from(PHOTO, "base64").length, `/api/evidence/${hash}/files/0`],
        ["back.png", 9, `/api/evidence/${hash}/files/1`],
      ],
    );

    const file = await t.api(`/api/evidence/${hash}/files/1`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "image/png");
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.equal(file.text, "png bytes");

    // Uppercase hex is accepted too.
    assert.equal((await t.api(`/api/evidence/0x${hash.slice(2).toUpperCase()}`)).status, 200);
  });

  it("rejects bad input with 4xx errors", async () => {
    const cases: [string, number][] = [
      ["/api/claims/0", 400],
      ["/api/claims/abc", 400],
      ["/api/claims/99", 404],
      ["/api/claims?juror=nope", 400],
      ["/api/claims?state=Lost", 400],
      ["/api/members/0x123", 400],
      ["/api/evidence/0x1234", 400],
      [`/api/evidence/0x${"ab".repeat(32)}`, 404],
      [`/api/evidence/0x${"ab".repeat(32)}/raw`, 404],
      ["/api/nothing-here", 404],
    ];
    for (const [path, status] of cases) {
      const res = await t.api(path);
      assert.equal(res.status, status, path);
      assert.equal(typeof res.body.error, "string", path);
    }

    const bad = [
      {},
      { files: [] },
      { files: [{ name: "x.svg", contentType: "image/svg+xml", data: PHOTO }] },
      { files: [{ name: "", contentType: "image/png", data: PHOTO }] },
      { files: [{ name: "x.png", contentType: "image/png", data: "not base64!" }] },
      { description: 5, files: [{ name: "x.png", contentType: "image/png", data: PHOTO }] },
    ];
    for (const body of bad) {
      const res = await t.post("/api/evidence", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }

    const malformed = await t.api("/api/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
  });

  it("turns randomness off for a keeper that does not own MockRandomness", async () => {
    const warnings: string[] = [];
    const keeper = await Keeper.create(t.contracts, t.signers[9], {
      fulfillRandomness: true,
      autoResolve: true,
      logger: { info: () => {}, warn: (m) => warnings.push(m) },
    });
    assert.equal(keeper.status().fulfillRandomness, false);
    assert.equal(keeper.status().autoResolve, true);
    assert.equal(warnings.length, 1);
  });

  it("sends CORS headers for the frontend", async () => {
    const res = await t.api("/api/evidence", { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });
});

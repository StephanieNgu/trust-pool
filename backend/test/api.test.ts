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
    const res = await t.post("/api/evidence", { description: "Both sides", files }, t.claimant);
    assert.equal(res.status, 201);
    const hash = res.body.evidenceHash;
    assert.match(hash, /^0x[0-9a-f]{64}$/);

    const again = await t.post("/api/evidence", { description: "Both sides", files }, t.claimant);
    assert.equal(again.body.evidenceHash, hash, "same evidence, same hash");

    const summary = (await t.getAs(`/api/evidence/${hash}`, t.claimant)).body;
    assert.equal(summary.description, "Both sides");
    assert.deepEqual(
      summary.files.map((f: { name: string; size: number; url: string }) => [f.name, f.size, f.url]),
      [
        ["front.jpg", Buffer.from(PHOTO, "base64").length, `/api/evidence/${hash}/files/0`],
        ["back.png", 9, `/api/evidence/${hash}/files/1`],
      ],
    );

    const file = await t.getAs(`/api/evidence/${hash}/files/1`, t.claimant);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "image/png");
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.equal(file.headers.get("cache-control"), "private, no-store");
    assert.equal(file.text, "png bytes");

    // Uppercase hex is accepted too.
    assert.equal((await t.getAs(`/api/evidence/0x${hash.slice(2).toUpperCase()}`, t.claimant)).status, 200);
  });

  describe("evidence privacy", () => {
    const files = [{ name: "private.jpg", contentType: "image/jpeg", data: PHOTO }];

    it("requires a valid, fresh wallet signature", async () => {
      const { hash } = { hash: (await t.post("/api/evidence", { files }, t.claimant)).body.evidenceHash };
      const path = `/api/evidence/${hash}/raw`;

      assert.equal((await t.api(path)).status, 401, "no signature");
      assert.equal((await t.post("/api/evidence", { files })).status, 401, "anonymous upload");

      const stale = await t.authHeaders(t.claimant, Math.floor(Date.now() / 1000) - 3600);
      assert.equal((await t.api(path, { headers: stale })).status, 401, "expired");

      // Someone else's signature presented with the claimant's address.
      const forged = { ...(await t.authHeaders(t.holders[4])), "x-trustpool-address": t.claimant.address };
      assert.equal((await t.api(path, { headers: forged })).status, 401, "forged");

      assert.equal((await t.getAs(path, t.claimant)).status, 200);
    });

    it("only lets policyholders upload", async () => {
      const res = await t.post("/api/evidence", { files }, t.signers[15]);
      assert.equal(res.status, 403);
    });

    it("hides evidence from other members, even if they file a claim with the copied hash", async () => {
      const victim = t.holders[5];
      const attacker = t.holders[6];
      const hash = (await t.post("/api/evidence", { files, description: "victim" }, victim)).body.evidenceHash;
      assert.equal((await t.getAs(`/api/evidence/${hash}`, attacker)).status, 403);

      // The attacker reads the hash off-chain and files their own claim with it.
      await (await t.claimManager.connect(attacker).submitClaim(USDC(10), hash)).wait();
      const id = Number(await t.claimManager.claimCount());
      await t.keeper.tick();
      const jurors: string[] = (await t.api(`/api/claims/${id}`)).body.jury.jurors.map(
        (j: { address: string }) => j.address,
      );
      assert.equal((await t.getAs(`/api/evidence/${hash}`, attacker)).status, 403, "attacker as claimant");
      for (const addr of jurors.filter((a) => a !== victim.address)) {
        const juror = t.signers.find((s) => s.address === addr)!;
        assert.equal((await t.getAs(`/api/evidence/${hash}`, juror)).status, 403, "juror of the copycat claim");
      }
      assert.equal((await t.getAs(`/api/evidence/${hash}`, victim)).status, 200, "uploader keeps access");
    });

    it("serves the message to sign", async () => {
      const res = (await t.api(`/api/auth/message?address=${t.claimant.address}`)).body;
      assert.match(res.message, /^TrustPool evidence access\nWallet: 0x[0-9a-fA-F]{40}\nChain ID: 31337\nIssued at: \d+$/);
      assert.equal(res.expiresAt - res.issuedAt, 600);
    });
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
    for (const [hashPath, status] of [
      [`/api/evidence/0x${"ab".repeat(32)}`, 404],
      [`/api/evidence/0x${"ab".repeat(32)}/raw`, 404],
    ] as const) {
      assert.equal((await t.getAs(hashPath, t.claimant)).status, status, hashPath);
    }

    for (const body of bad) {
      const res = await t.post("/api/evidence", body, t.claimant);
      assert.equal(res.status, 400, JSON.stringify(body));
    }

    const malformed = await t.api("/api/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await t.authHeaders(t.claimant)) },
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

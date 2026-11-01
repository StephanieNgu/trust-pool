import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keeper } from "../src/keeper";
import { PHOTO, photo, USDC, setup, testDevice, testImei } from "./helpers";

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
    // Seven jurors' stakes of 40 are held by the pool but are not part of the reserve above.
    assert.equal(pool.totalStaked, USDC(280).toString());
    assert.equal(pool.totalJurorFees, "0");
    assert.equal(pool.totalBonded, "0");
    assert.equal(pool.claimBondBps, 500);
    assert.equal(pool.minClaimBond, USDC(5).toString());
  });

  it("describes a member and their policy", async () => {
    const member = (await t.api(`/api/members/${t.claimant.address}`)).body;
    assert.equal(member.balance, USDC(910).toString(), "1,000 less the 50 premium and the 40 stake");
    assert.equal(member.contributed, USDC(50).toString());
    assert.deepEqual(member.juror, { stake: USDC(40).toString(), minStake: USDC(20).toString(), activeJuries: 0, staked: true });
    assert.equal(member.policy.status, "Active");
    assert.equal(member.policy.coverageLimit, USDC(1_000).toString());
    assert.equal(member.policy.pastWaitingPeriod, true);
    assert.equal(member.policy.claimEligibleAt, member.policy.startTime + 7 * 24 * 3600);
    // Six other covered, staked holders could sit on a jury for this member's claim; a jury takes five.
    assert.deepEqual(member.jury, { available: 6, required: 5 });

    const stranger = (await t.api(`/api/members/${t.signers[15].address}`)).body;
    assert.equal(stranger.policy, null);
    assert.equal(stranger.juror.staked, false);
  });

  it("stores evidence and serves it back byte for byte", async () => {
    const files = [
      { name: "front.jpg", contentType: "image/jpeg", data: photo() },
      { name: "back.png", contentType: "image/png", data: Buffer.from("png bytes").toString("base64") },
    ];
    const res = await t.post("/api/evidence", { description: "Both sides", files }, t.claimant);
    assert.equal(res.status, 201);
    const hash = res.body.evidenceHash;
    assert.match(hash, /^0x[0-9a-f]{64}$/);

    // Photos must be fresh: the same files sent again under a new capture code are refused.
    const again = await t.post("/api/evidence", { description: "Both sides", files }, t.claimant);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /uploaded before/);

    const summary = (await t.getAs(`/api/evidence/${hash}`, t.claimant)).body;
    assert.equal(summary.description, "Both sides");
    assert.equal(summary.kind, "claim");
    assert.equal(summary.device, null);
    assert.match(summary.capture.code, /^TP-[2-9A-Z]{6}$/);
    assert.ok(summary.capture.receivedAt >= summary.capture.issuedAt);
    assert.deepEqual(
      summary.files.map((f: { name: string; size: number; url: string }) => [f.name, f.size, f.url]),
      [
        ["front.jpg", Buffer.from(files[0].data, "base64").length, `/api/evidence/${hash}/files/0`],
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

  describe("capture codes", () => {
    const files = () => [{ name: "front.jpg", contentType: "image/jpeg", data: photo() }];

    it("issues a code only to a signed-in wallet", async () => {
      assert.equal((await t.postRaw("/api/capture/code", {})).status, 401);
      const res = await t.postRaw("/api/capture/code", {}, t.claimant);
      assert.equal(res.status, 201);
      assert.match(res.body.code, /^TP-[2-9A-Z]{6}$/);
      assert.equal(res.body.expiresAt - res.body.issuedAt, 15 * 60);
    });

    it("requires an unused code issued to the uploading wallet", async () => {
      const upload = (json: object, signer = t.claimant) => t.postRaw("/api/evidence", { files: files(), ...json }, signer);
      assert.equal((await upload({})).status, 400, "no code");
      assert.equal((await upload({ captureCode: "TP-AAAAAA" })).status, 400, "never issued");

      const othersCode = await t.captureCode(t.holders[3]);
      assert.equal((await upload({ captureCode: othersCode })).status, 400, "issued to another wallet");

      const code = await t.captureCode(t.claimant);
      const res = await upload({ captureCode: code });
      assert.equal(res.status, 201);
      assert.equal(res.body.capture.code, code);
      assert.equal((await upload({ captureCode: code })).status, 400, "already used");
    });

    it("keeps the code when the upload is rejected for another reason", async () => {
      const code = await t.captureCode(t.claimant);
      assert.equal((await t.postRaw("/api/evidence", { files: [], captureCode: code }, t.claimant)).status, 400);
      assert.equal((await t.postRaw("/api/evidence", { files: files(), captureCode: code }, t.claimant)).status, 201);
    });
  });

  describe("enrollment", () => {
    const files = () => [{ name: "front.jpg", contentType: "image/jpeg", data: photo() }];

    it("lets a wallet without a policy enrol a device", async () => {
      const newcomer = t.signers[15];
      const res = await t.post("/api/evidence", { kind: "enrollment", device: testDevice(40), files: files() }, newcomer);
      assert.equal(res.status, 201);
      assert.equal(res.body.kind, "enrollment");
      assert.deepEqual(res.body.device, testDevice(40));
    });

    it("rejects missing or invalid device details", async () => {
      const newcomer = t.signers[15];
      const bad = [
        {},
        { device: { ...testDevice(41), imei: "12345" } },
        { device: { ...testDevice(41), imei: testImei(41).slice(0, 14) + ((Number(testImei(41)[14]) + 1) % 10) } },
        { device: { ...testDevice(41), model: "" } },
        { device: { imei: testImei(41) } },
        { device: { ...testDevice(41), type: "drone" } },
        { device: { ...testDevice(41), imei: undefined } },
        { device: { ...testDevice(41), type: "camera", imei: undefined, serial: undefined } },
      ];
      for (const extra of bad) {
        const res = await t.post("/api/evidence", { kind: "enrollment", files, ...extra }, newcomer);
        assert.equal(res.status, 400, JSON.stringify(extra));
      }
      assert.equal((await t.post("/api/evidence", { kind: "selfie", files: files() }, newcomer)).status, 400);
    });

    it("enrols a device without an IMEI by its serial number", async () => {
      const camera = { type: "camera", serial: " 0123 456 ", make: "Canon", model: "EOS R50", color: "Black" };
      const res = await t.post("/api/evidence", { kind: "enrollment", device: camera, files: files() }, t.signers[15]);
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.device, { ...camera, serial: "0123 456" });
      // A tablet may give an IMEI, but it must be a valid one.
      const tablet = { ...testDevice(42), type: "tablet" };
      assert.equal((await t.post("/api/evidence", { kind: "enrollment", device: tablet, files: files() }, t.signers[15])).status, 201);
      const badTablet = { ...tablet, imei: "12345" };
      assert.equal((await t.post("/api/evidence", { kind: "enrollment", device: badTablet, files: files() }, t.signers[15])).status, 400);
    });

    it("shows the policy's enrollment hash in the member view", async () => {
      const member = (await t.api(`/api/members/${t.claimant.address}`)).body;
      assert.match(member.policy.enrollmentHash, /^0x[0-9a-f]{64}$/);
      assert.equal((await t.getAs(`/api/evidence/${member.policy.enrollmentHash}`, t.claimant)).body.kind, "enrollment");
      assert.equal((await t.getAs(`/api/evidence/${member.policy.enrollmentHash}`, t.holders[4])).status, 403);
    });
  });

  describe("evidence privacy", () => {
    const files = () => [{ name: "private.jpg", contentType: "image/jpeg", data: photo() }];

    it("requires a valid, fresh wallet signature", async () => {
      const { hash } = { hash: (await t.post("/api/evidence", { files: files() }, t.claimant)).body.evidenceHash };
      const path = `/api/evidence/${hash}/raw`;

      assert.equal((await t.api(path)).status, 401, "no signature");
      assert.equal((await t.post("/api/evidence", { files: files() })).status, 401, "anonymous upload");

      const stale = await t.authHeaders(t.claimant, Math.floor(Date.now() / 1000) - 3600);
      assert.equal((await t.api(path, { headers: stale })).status, 401, "expired");

      // Someone else's signature presented with the claimant's address.
      const forged = { ...(await t.authHeaders(t.holders[4])), "x-trustpool-address": t.claimant.address };
      assert.equal((await t.api(path, { headers: forged })).status, 401, "forged");

      assert.equal((await t.getAs(path, t.claimant)).status, 200);
    });

    it("only lets policyholders upload", async () => {
      const res = await t.post("/api/evidence", { files: files() }, t.signers[15]);
      assert.equal(res.status, 403);
    });

    it("hides evidence from other members, even if they file a claim with the copied hash", async () => {
      const victim = t.holders[5];
      const attacker = t.holders[6];
      const hash = (await t.post("/api/evidence", { files: files(), description: "victim" }, victim)).body.evidenceHash;
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
      { files: [{ name: "", contentType: "image/png", data: photo() }] },
      { files: [{ name: "x.png", contentType: "image/png", data: "not base64!" }] },
      { description: 5, files: [{ name: "x.png", contentType: "image/png", data: photo() }] },
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

  it("turns randomness off when Chainlink VRF delivers it (no local coordinator mock)", async () => {
    const warnings: string[] = [];
    const keeper = await Keeper.create({ ...t.contracts, vrfCoordinatorMock: null }, t.signers[9], {
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

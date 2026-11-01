// Sign-in sessions and member profiles: sign once, then use a token; profiles follow the wallet.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, SESSION_TTL_SECONDS } from "../src/accounts";
import { setup } from "./helpers";

const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("AccountStore", () => {
  it("resolves a session until it expires or ends, and keeps it across restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trustpool-accounts-"));
    try {
      const store = new AccountStore(dir);
      const { token, address, expiresAt } = await store.createSession(ALICE.toLowerCase(), 1_000);
      assert.equal(address, ALICE);
      assert.equal(expiresAt, 1_000 + SESSION_TTL_SECONDS);
      assert.equal((await store.resolveSession(token, 2_000))?.address, ALICE);
      assert.equal(await store.resolveSession(token, expiresAt), null);
      assert.equal(await store.resolveSession("not-a-token", 2_000), null);

      // A second store over the same folder (a backend restart) still knows the session.
      const now = Math.floor(Date.now() / 1000);
      const live = await store.createSession(ALICE);
      const reopened = new AccountStore(dir);
      assert.equal((await reopened.resolveSession(live.token, now + 60))?.address, ALICE);
      await reopened.endSession(live.token);
      assert.equal(await reopened.resolveSession(live.token, now + 60), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("merges profile updates and validates them", async () => {
    const store = new AccountStore();
    assert.deepEqual(await store.getProfile(ALICE), { displayName: "", deviceNickname: "", readNotifications: [], updatedAt: 0 });
    await store.updateProfile(ALICE, { displayName: "  Max   Vlock " }, 5);
    const profile = await store.updateProfile(ALICE.toLowerCase(), { readNotifications: ["a", "b", "a"] }, 6);
    assert.deepEqual(profile, { displayName: "Max Vlock", deviceNickname: "", readNotifications: ["a", "b"], updatedAt: 6 });
    await assert.rejects(store.updateProfile(ALICE, { displayName: "x".repeat(41) }), /at most 40/);
    await assert.rejects(store.updateProfile(ALICE, { readNotifications: "a" }), /list of notification ids/);
    await assert.rejects(store.updateProfile(ALICE, ["x"]), /JSON object/);
  });
});

describe("sessions and profiles over the API", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  before(async () => {
    t = await setup();
  });
  after(async () => {
    await t.close();
  });

  it("opens a session with one signature, then serves the profile and evidence routes with the token", async () => {
    const member = t.holders[1];
    // Opening a session needs the signed headers.
    assert.equal((await t.api("/api/auth/session", { method: "POST" })).status, 401);
    const opened = await t.postRaw("/api/auth/session", {}, member);
    assert.equal(opened.status, 201);
    assert.equal(opened.body.address, member.address);
    const bearer = { Authorization: `Bearer ${opened.body.token}` };

    // The token works where a signature did.
    assert.equal((await t.api("/api/profile")).status, 401);
    const saved = await t.api("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer },
      body: JSON.stringify({ displayName: "Juror One", deviceNickname: "Work phone" }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await t.api("/api/profile", { headers: bearer })).body.displayName, "Juror One");
    assert.equal((await t.api("/api/capture/code", { method: "POST", headers: bearer })).status, 201);

    // Profiles are per wallet.
    assert.equal((await t.getAs("/api/profile", t.holders[2])).body.displayName, "");
    // A bad field is a 400, not a crash.
    const bad = await t.api("/api/profile", { method: "POST", headers: { "Content-Type": "application/json", ...bearer }, body: JSON.stringify({ displayName: 7 }) });
    assert.equal(bad.status, 400);

    // Signing out ends the token everywhere.
    assert.equal((await t.api("/api/auth/session/end", { method: "POST", headers: bearer })).status, 204);
    const after = await t.api("/api/profile", { headers: bearer });
    assert.equal(after.status, 401);
    assert.match(after.body.error, /expired/);
  });
});

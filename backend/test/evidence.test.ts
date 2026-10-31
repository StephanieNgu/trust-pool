import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "ethers";
import {
  deviceIdHash,
  deviceIdentifier,
  encodeBundle,
  EvidenceError,
  LocalEvidenceStore,
  sameDevice,
  MAX_FILE_BYTES,
  loadOrCreateKeyFile,
  parseEvidenceKey,
  noteHash,
  deviceProofMessage,
  verifyDeviceSignature,
  type DeviceKey,
} from "../src/evidence";

const ALICE = "0x00000000000000000000000000000000000000A1";
const BOB = "0x00000000000000000000000000000000000000B0";

const file = (data: string | Buffer, name = "a.jpg") => ({
  name,
  contentType: "image/jpeg",
  data: Buffer.from(data).toString("base64"),
});

describe("LocalEvidenceStore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trustpool-evidence-"));
  const key = randomBytes(32);
  const store = new LocalEvidenceStore(dir, key);
  after(() => rm(dir, { recursive: true, force: true }));

  it("addresses evidence by the keccak256 of its stored bytes", async () => {
    const { evidenceHash, files } = await store.put({ description: "d", files: [file("one"), file("two", "b.jpg")] }, ALICE);
    const raw = await store.getRaw(evidenceHash);
    assert.ok(raw);
    assert.equal(keccak256(raw), evidenceHash);
    assert.deepEqual(
      files.map((f) => [f.index, f.name, f.size]),
      [
        [0, "a.jpg", 3],
        [1, "b.jpg", 3],
      ],
    );
    assert.equal((await store.getFile(evidenceHash, 1))?.data.toString(), "two");
    assert.equal(await store.getFile(evidenceHash, 2), null);
  });

  it("lets a receipt file back only one claim", async () => {
    const receipt = (claimId: string, files = [file("invoice #0042")]) => ({
      kind: "receipt",
      receipt: { claimId, shop: "Fix-It Phones", total: "180000000", date: "2026-10-30" },
      files,
    });
    const first = await store.put(receipt("7"), ALICE);
    assert.equal(first.kind, "receipt");
    assert.deepEqual(first.receipt, { claimId: "7", shop: "Fix-It Phones", total: "180000000", date: "2026-10-30" });
    // The same file again for the same claim is fine (a retry); for another claim it is refused,
    // even bundled with other files.
    assert.equal((await store.put(receipt("7"), ALICE)).evidenceHash, first.evidenceHash);
    await assert.rejects(
      store.put(receipt("8", [file("photo of the shop"), file("invoice #0042")]), BOB),
      (err: unknown) => err instanceof EvidenceError && err.status === 409 && /claim #7/.test(err.message),
    );
    assert.equal((await store.put(receipt("8", [file("invoice #0043")]), BOB)).kind, "receipt");
  });

  it("checks a receipt's details", async () => {
    const base = { kind: "receipt", files: [file("x")] };
    const bad = [
      {},
      { claimId: "0", shop: "s", total: "1", date: "2026-10-30" },
      { claimId: "1", shop: " ", total: "1", date: "2026-10-30" },
      { claimId: "1", shop: "s", total: "0", date: "2026-10-30" },
      { claimId: "1", shop: "s", total: "1.5", date: "2026-10-30" },
      { claimId: "1", shop: "s", total: "1", date: "30/10/2026" },
    ];
    for (const receipt of bad) {
      await assert.rejects(store.put({ ...base, receipt }, ALICE), (err: unknown) => err instanceof EvidenceError && err.status === 400);
    }
    await assert.rejects(
      store.put({ files: [file("x")], receipt: { claimId: "1", shop: "s", total: "1", date: "2026-10-30" } }, ALICE),
      /only for receipt/,
    );
  });

  it("records every uploader of the same bundle", async () => {
    const { evidenceHash } = await store.put({ files: [file("shared")] }, ALICE);
    await store.put({ files: [file("shared")] }, BOB);
    await store.put({ files: [file("shared")] }, ALICE);
    assert.deepEqual(await store.getUploaders(evidenceHash), [ALICE.toLowerCase(), BOB.toLowerCase()]);
  });

  it("gives different evidence different hashes", async () => {
    const a = keccak256(encodeBundle({ files: [file("one")] }));
    const b = keccak256(encodeBundle({ files: [file("one")], description: "with a note" }));
    const c = keccak256(encodeBundle({ files: [file("one", "renamed.jpg")] }));
    assert.equal(new Set([a, b, c]).size, 3);
  });

  it("takes each photo in one bundle only, but lets the same bundle be retried", async () => {
    const first = await store.put({ files: [file("fresh photo")] }, ALICE);
    assert.equal((await store.put({ files: [file("fresh photo")] }, ALICE)).evidenceHash, first.evidenceHash);
    for (const reuse of [
      { files: [file("fresh photo")], description: "again" },
      { files: [file("another"), file("fresh photo", "b.jpg")] },
      { kind: "enrollment", device: { type: "camera", serial: "S1", make: "M", model: "X", color: "Black" }, files: [file("fresh photo")] },
    ]) {
      await assert.rejects(store.put(reuse, BOB), (err: unknown) => err instanceof EvidenceError && err.status === 409);
    }
  });

  it("checks a device key's signature over the claimant's wallet and capture code", () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const { kty, crv, x, y } = pair.publicKey.export({ format: "jwk" });
    const key = { kty, crv, x, y } as DeviceKey;
    const signature = sign("sha256", Buffer.from(deviceProofMessage(ALICE, "TP-ABC234")), {
      key: pair.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64");
    assert.equal(verifyDeviceSignature(key, ALICE.toUpperCase(), "TP-ABC234", signature), true);
    assert.equal(verifyDeviceSignature(key, BOB, "TP-ABC234", signature), false, "another wallet");
    assert.equal(verifyDeviceSignature(key, ALICE, "TP-ABC235", signature), false, "another code");
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
    assert.equal(verifyDeviceSignature({ ...key, x: other.x!, y: other.y! }, ALICE, "TP-ABC234", signature), false, "another key");

    // Device keys go only in enrollments, signatures only in claims, and both must be well formed.
    const enrollment = { kind: "enrollment", device: { type: "camera", serial: "S", make: "M", model: "X", color: "C" }, files: [file("k")] };
    assert.ok(encodeBundle({ ...enrollment, deviceKey: key, purchaseProof: [0] }));
    assert.throws(() => encodeBundle({ ...enrollment, deviceKey: { ...key, crv: "P-384" } }), EvidenceError);
    assert.throws(() => encodeBundle({ ...enrollment, purchaseProof: [1] }), EvidenceError);
    assert.throws(() => encodeBundle({ files: [file("k")], deviceKey: key }), EvidenceError);
    assert.ok(encodeBundle({ files: [file("k")], deviceSignature: signature }));
    assert.throws(() => encodeBundle({ files: [file("k")], deviceSignature: "short" }), EvidenceError);
    assert.throws(() => encodeBundle({ ...enrollment, deviceSignature: signature }), EvidenceError);
  });

  it("encrypts files at rest", async () => {
    const secret = "SECRET-PHOTO-CONTENTS";
    const { evidenceHash } = await store.put({ description: "kitchen floor", files: [file(secret)] }, ALICE);
    const onDisk = await readFile(join(dir, `${evidenceHash}.enc`));
    for (const plain of [secret, Buffer.from(secret).toString("base64"), "kitchen floor", "a.jpg"]) {
      assert.ok(!onDisk.includes(plain), `${plain} visible on disk`);
    }
    assert.equal((await store.getFile(evidenceHash, 0))?.data.toString(), secret);
    // Only the encrypted file and the uploader list are written.
    const names = (await readdir(dir)).filter((n) => n.startsWith(evidenceHash));
    assert.deepEqual(names.sort(), [`${evidenceHash}.enc`, `${evidenceHash}.uploaders.json`]);
  });

  it("cannot be read with a different key", async () => {
    const { evidenceHash } = await store.put({ files: [file("keyed")] }, ALICE);
    const other = new LocalEvidenceStore(dir, randomBytes(32));
    await assert.rejects(other.getRaw(evidenceHash), (err: unknown) => err instanceof EvidenceError);
  });

  it("refuses to serve evidence that was altered on disk", async () => {
    const { evidenceHash } = await store.put({ files: [file("original")] }, ALICE);
    const path = join(dir, `${evidenceHash}.enc`);
    const bytes = await readFile(path);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(path, bytes);
    await assert.rejects(store.getRaw(evidenceHash), (err: unknown) => err instanceof EvidenceError);
  });

  it("refuses a ciphertext copied onto another hash", async () => {
    const a = await store.put({ files: [file("first")] }, ALICE);
    const b = await store.put({ files: [file("second")] }, ALICE);
    await writeFile(join(dir, `${b.evidenceHash}.enc`), await readFile(join(dir, `${a.evidenceHash}.enc`)));
    await assert.rejects(store.getRaw(b.evidenceHash), (err: unknown) => err instanceof EvidenceError);
  });

  it("parses keys and creates a private key file once", async () => {
    const hex = randomBytes(32).toString("hex");
    assert.equal(parseEvidenceKey(hex).toString("hex"), hex);
    assert.equal(parseEvidenceKey(`0x${hex}`).toString("hex"), hex);
    assert.equal(parseEvidenceKey(Buffer.from(hex, "hex").toString("base64")).toString("hex"), hex);
    assert.throws(() => parseEvidenceKey("too-short"));

    const keyFile = join(dir, "keys", "evidence.key");
    const first = await loadOrCreateKeyFile(keyFile);
    const second = await loadOrCreateKeyFile(keyFile);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.ok(first.key.equals(second.key));
    // Windows has no POSIX permission bits (files report 0o666), so only check the mode elsewhere.
    if (process.platform !== "win32") assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
  });

  it("rejects oversized files", async () => {
    await assert.rejects(store.put({ files: [file(Buffer.alloc(MAX_FILE_BYTES + 1))] }, ALICE), (err: unknown) => {
      return err instanceof EvidenceError && err.status === 413;
    });
  });

  it("keeps the claimant's amount explanation in claim bundles only", async () => {
    const { evidenceHash, amountReason } = await store.put({ amountReason: "Quote: 280", files: [file("q")] }, ALICE);
    assert.equal(amountReason, "Quote: 280");
    assert.equal((await store.getSummary(evidenceHash))?.amountReason, "Quote: 280");
    assert.throws(() => encodeBundle({ amountReason: 5, files: [file("q")] }), EvidenceError);
    assert.throws(() => encodeBundle({ kind: "enrollment", amountReason: "x", files: [file("q")] }), EvidenceError);
    // Bundles without one serialize exactly as before.
    assert.ok(!encodeBundle({ files: [file("q")] }).toString().includes("amountReason"));
  });

  it("records which covered event a claim is for", async () => {
    const { evidenceHash, event } = await store.put({ event: "liquid", files: [file("e")] }, ALICE);
    assert.equal(event, "liquid");
    assert.equal((await store.getSummary(evidenceHash))?.event, "liquid");
    // Not a covered event, or not a claim.
    assert.throws(() => encodeBundle({ event: "loss", files: [file("e")] }), EvidenceError);
    assert.throws(() => encodeBundle({ kind: "enrollment", event: "screen", files: [file("e")] }), EvidenceError);
    // Older claims have none, and serialize exactly as before.
    assert.equal((await store.put({ files: [file("e2")] }, ALICE)).event, null);
    assert.ok(!encodeBundle({ files: [file("e")] }).toString().includes("event"));
  });

  it("stores juror notes encrypted, under the hash sealed into the vote", async () => {
    const hash = await store.putNote(7, BOB, "Only the screen is cracked.");
    assert.equal(hash, noteHash("Only the screen is cracked."));
    assert.equal(await store.getNote(7, BOB, hash), "Only the screen is cracked.");
    assert.equal(await store.getNote(7, ALICE, hash), null, "notes are per juror");
    assert.equal(await store.getNote(8, BOB, hash), null, "and per claim");
    const notes = await readdir(join(dir, "notes"));
    for (const name of notes) assert.ok(!(await readFile(join(dir, "notes", name))).includes("screen"));
    await assert.rejects(store.putNote(7, BOB, "  "), EvidenceError);
    await assert.rejects(store.putNote(7, BOB, "x".repeat(501)), EvidenceError);
  });

  it("returns null for unknown or malformed hashes", async () => {
    assert.equal(await store.getRaw(`0x${"00".repeat(32)}`), null);
    assert.equal(await store.getRaw("../../etc/passwd"), null);
    assert.equal(await store.has("../../etc/passwd"), false);
  });
});

describe("device identity", () => {
  it("identifies a device by IMEI when it has one, otherwise by make and serial", () => {
    assert.equal(deviceIdentifier({ imei: "490154203237518", serial: "X", make: "Apple" }), "490154203237518");
    assert.equal(deviceIdentifier({ serial: " ab 12c ", make: " Canon " }), "canon:AB12C");
    assert.equal(deviceIdHash({ serial: "AB12C", make: "canon" }), keccak256(Buffer.from("canon:AB12C")));
    assert.throws(() => deviceIdentifier({ serial: "AB12C" }));
  });

  it("matches a claim to the enrolled device by IMEI, else by serial", () => {
    const phone = { type: "phone" as const, imei: "490154203237518", serial: "F2LX", make: "Apple" };
    assert.equal(sameDevice({ imei: "490154203237518" }, phone), true);
    assert.equal(sameDevice({ imei: "356938035643809" }, phone), false);
    assert.equal(sameDevice({ serial: "f2 lx" }, phone), true);
    assert.equal(sameDevice({ serial: "OTHER" }, { type: "camera", serial: "AB12C", make: "Canon" }), false);
    assert.equal(sameDevice(null, phone), null);
    assert.equal(sameDevice({ imei: "490154203237518" }, { type: "camera", serial: "AB12C", make: "Canon" }), null);
  });

  it("accepts a claim's IMEI or serial, but not neither", () => {
    assert.doesNotThrow(() => encodeBundle({ device: { serial: "AB12C" }, files: [file("x")] }));
    assert.throws(() => encodeBundle({ device: {}, files: [file("x")] }), EvidenceError);
  });
});

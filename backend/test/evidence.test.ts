import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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

  it("records every uploader of the same bundle", async () => {
    const { evidenceHash } = await store.put({ files: [file("shared")] }, ALICE);
    await store.put({ files: [file("shared")] }, BOB);
    await store.put({ files: [file("shared")] }, ALICE);
    assert.deepEqual(await store.getUploaders(evidenceHash), [ALICE.toLowerCase(), BOB.toLowerCase()]);
  });

  it("gives different evidence different hashes", async () => {
    const a = await store.put({ files: [file("one")] }, ALICE);
    const b = await store.put({ files: [file("one")], description: "with a note" }, ALICE);
    const c = await store.put({ files: [file("one", "renamed.jpg")] }, ALICE);
    assert.equal(new Set([a.evidenceHash, b.evidenceHash, c.evidenceHash]).size, 3);
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

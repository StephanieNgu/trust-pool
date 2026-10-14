import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "ethers";
import { EvidenceError, LocalEvidenceStore, MAX_FILE_BYTES } from "../src/evidence";

const file = (data: string | Buffer, name = "a.jpg") => ({
  name,
  contentType: "image/jpeg",
  data: Buffer.from(data).toString("base64"),
});

describe("LocalEvidenceStore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trustpool-evidence-"));
  const store = new LocalEvidenceStore(dir);
  after(() => rm(dir, { recursive: true, force: true }));

  it("addresses evidence by the keccak256 of its stored bytes", async () => {
    const { evidenceHash, files } = await store.put({ description: "d", files: [file("one"), file("two", "b.jpg")] });
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

  it("gives different evidence different hashes", async () => {
    const a = await store.put({ files: [file("one")] });
    const b = await store.put({ files: [file("one")], description: "with a note" });
    const c = await store.put({ files: [file("one", "renamed.jpg")] });
    assert.equal(new Set([a.evidenceHash, b.evidenceHash, c.evidenceHash]).size, 3);
  });

  it("refuses to serve evidence that was altered on disk", async () => {
    const { evidenceHash } = await store.put({ files: [file("original")] });
    await writeFile(join(dir, `${evidenceHash}.json`), '{"version":1,"description":"","files":[]}');
    await assert.rejects(store.getRaw(evidenceHash), (err: unknown) => err instanceof EvidenceError);
  });

  it("rejects oversized files", async () => {
    await assert.rejects(store.put({ files: [file(Buffer.alloc(MAX_FILE_BYTES + 1))] }), (err: unknown) => {
      return err instanceof EvidenceError && err.status === 413;
    });
  });

  it("returns null for unknown or malformed hashes", async () => {
    assert.equal(await store.getRaw(`0x${"00".repeat(32)}`), null);
    assert.equal(await store.getRaw("../../etc/passwd"), null);
    assert.equal(await store.has("../../etc/passwd"), false);
  });
});

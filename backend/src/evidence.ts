// Off-chain evidence storage. A claimant uploads their photos as one bundle; the store saves the
// bundle's exact bytes under their keccak256 hash, and that hash is what goes on-chain as the
// claim's `evidenceHash`. A juror fetches the raw bytes and recomputes the hash to check the evidence
// has not changed since the claim was filed. The hash proves the file is unchanged, not that the
// claim is true; judging that is the jury's job.
//
// The store is private: the HTTP layer only serves a bundle to its uploader and to the jurors of a
// claim the uploader filed with it (see app.ts). It is deliberately not public IPFS. Files are not
// encrypted at rest, so whoever operates the backend can read them.
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keccak256 } from "ethers";

export const BUNDLE_VERSION = 1;
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DESCRIPTION_LENGTH = 2_000;
export const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "application/pdf",
] as const;

export interface EvidenceFileInput {
  name: string;
  contentType: string;
  /** File contents, base64-encoded. */
  data: string;
}

export interface EvidenceUpload {
  description?: string;
  files: EvidenceFileInput[];
}

interface StoredFile {
  name: string;
  contentType: string;
  size: number;
  data: string;
}

/** The bundle as stored. Its JSON serialization is what gets hashed. */
interface StoredBundle {
  version: number;
  description: string;
  files: StoredFile[];
}

export interface EvidenceFileInfo {
  index: number;
  name: string;
  contentType: string;
  size: number;
}

export interface EvidenceSummary {
  evidenceHash: string;
  description: string;
  size: number;
  files: EvidenceFileInfo[];
}

export class EvidenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function isEvidenceHash(value: string): boolean {
  return HASH_PATTERN.test(value);
}

/** Validates an upload and returns the canonical bundle bytes that will be hashed and stored. */
export function encodeBundle(upload: unknown): Buffer {
  if (!upload || typeof upload !== "object") throw new EvidenceError("Body must be a JSON object.", 400);
  const { description = "", files } = upload as Partial<EvidenceUpload>;

  if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new EvidenceError(`description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters.`, 400);
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    throw new EvidenceError(`files must be an array of 1 to ${MAX_FILES} files.`, 400);
  }

  const stored = files.map((file, i): StoredFile => {
    const { name, contentType, data } = (file ?? {}) as Partial<EvidenceFileInput>;
    if (typeof name !== "string" || name.length === 0 || name.length > 255) {
      throw new EvidenceError(`files[${i}].name must be a non-empty string of at most 255 characters.`, 400);
    }
    if (typeof contentType !== "string" || !(ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      throw new EvidenceError(`files[${i}].contentType must be one of ${ALLOWED_CONTENT_TYPES.join(", ")}.`, 400);
    }
    if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
      throw new EvidenceError(`files[${i}].data must be non-empty base64.`, 400);
    }
    const size = Buffer.from(data, "base64").length;
    if (size > MAX_FILE_BYTES) {
      throw new EvidenceError(`files[${i}] is ${size} bytes; the limit is ${MAX_FILE_BYTES}.`, 413);
    }
    // Fixed key order keeps the serialization, and therefore the hash, deterministic.
    return { name, contentType, size, data };
  });

  const bundle: StoredBundle = { version: BUNDLE_VERSION, description, files: stored };
  return Buffer.from(JSON.stringify(bundle), "utf8");
}

export function hashBundle(bytes: Uint8Array): string {
  return keccak256(bytes);
}

/** Write then rename, so a reader never sees a half-written file. */
async function writeAtomic(path: string, bytes: Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

function summarize(evidenceHash: string, bytes: Buffer): EvidenceSummary {
  const bundle = JSON.parse(bytes.toString("utf8")) as StoredBundle;
  return {
    evidenceHash,
    description: bundle.description,
    size: bytes.length,
    files: bundle.files.map((f, index) => ({ index, name: f.name, contentType: f.contentType, size: f.size })),
  };
}

/** Content-addressed evidence store on the local filesystem. */
export class LocalEvidenceStore {
  constructor(readonly dir: string) {}

  private pathFor(evidenceHash: string): string {
    return join(this.dir, `${evidenceHash}.json`);
  }

  private uploadersPathFor(evidenceHash: string): string {
    return join(this.dir, `${evidenceHash}.uploaders.json`);
  }

  /**
   * Stores an upload, records `uploader` as allowed to file a claim with it, and returns its hash.
   * Uploading identical evidence twice stores it once.
   */
  async put(upload: unknown, uploader: string): Promise<EvidenceSummary> {
    const bytes = encodeBundle(upload);
    const evidenceHash = hashBundle(bytes);
    await mkdir(this.dir, { recursive: true });
    if (!(await this.has(evidenceHash))) {
      await writeAtomic(this.pathFor(evidenceHash), bytes);
    }
    const uploaders = await this.getUploaders(evidenceHash);
    if (!uploaders.includes(uploader.toLowerCase())) {
      uploaders.push(uploader.toLowerCase());
      await writeAtomic(this.uploadersPathFor(evidenceHash), Buffer.from(JSON.stringify(uploaders)));
    }
    return summarize(evidenceHash, bytes);
  }

  /** Lower-cased addresses of everyone who uploaded this exact bundle. */
  async getUploaders(evidenceHash: string): Promise<string[]> {
    if (!isEvidenceHash(evidenceHash)) return [];
    try {
      return JSON.parse(await readFile(this.uploadersPathFor(evidenceHash), "utf8")) as string[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async has(evidenceHash: string): Promise<boolean> {
    if (!isEvidenceHash(evidenceHash)) return false;
    try {
      await access(this.pathFor(evidenceHash));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns the stored bytes, or null if none are stored under this hash. Throws if the stored
   * bytes no longer match their hash, so tampered evidence is never served as genuine.
   */
  async getRaw(evidenceHash: string): Promise<Buffer | null> {
    const bytes = await this.read(evidenceHash);
    if (bytes && hashBundle(bytes) !== evidenceHash) {
      throw new EvidenceError("Stored evidence does not match its hash.", 500);
    }
    return bytes;
  }

  async getSummary(evidenceHash: string): Promise<EvidenceSummary | null> {
    const bytes = await this.getRaw(evidenceHash);
    return bytes && summarize(evidenceHash, bytes);
  }

  async getFile(evidenceHash: string, index: number): Promise<{ info: EvidenceFileInfo; data: Buffer } | null> {
    const bytes = await this.getRaw(evidenceHash);
    if (!bytes) return null;
    const file = (JSON.parse(bytes.toString("utf8")) as StoredBundle).files[index];
    if (!file) return null;
    return {
      info: { index, name: file.name, contentType: file.contentType, size: file.size },
      data: Buffer.from(file.data, "base64"),
    };
  }

  private async read(evidenceHash: string): Promise<Buffer | null> {
    if (!isEvidenceHash(evidenceHash)) return null;
    try {
      return await readFile(this.pathFor(evidenceHash));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}

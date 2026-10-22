// Off-chain evidence storage. A claimant uploads their photos as one bundle; the store saves the
// bundle's exact bytes under their keccak256 hash, and that hash is what goes on-chain as the
// claim's `evidenceHash`. A juror fetches the raw bytes and recomputes the hash to check the evidence
// has not changed since the claim was filed. The hash proves the file is unchanged, not that the
// claim is true; judging that is the jury's job.
//
// The store is private: the HTTP layer only serves a bundle to its uploader and to the jurors of a
// claim the uploader filed with it, while that claim is being voted on (see app.ts). It is
// deliberately not public IPFS. Every bundle is encrypted at rest with AES-256-GCM under the
// backend's evidence key, so the files on disk (and any backup or copy of them) are unreadable
// without that key. The hash is taken over the plaintext, so jurors can still verify it.
//
// There are two kinds of bundle. An "enrollment" bundle is uploaded at signup: the device's IMEI,
// serial, make, model and colour, plus photos of the phone. Its hash goes on-chain with the policy.
// A "claim" bundle holds the damage photos. Both carry a capture stamp (see capture.ts) so jurors can
// check the photos were taken just now, and jurors compare a claim's photos with the enrollment ones
// to check it is the same phone.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getBytes, keccak256, toUtf8Bytes } from "ethers";
import type { CaptureStamp } from "./capture";

export const BUNDLE_VERSION = 2;
export const BUNDLE_KINDS = ["claim", "enrollment"] as const;
export type BundleKind = (typeof BUNDLE_KINDS)[number];
export const MAX_DEVICE_FIELD_LENGTH = 64;
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

export const DEVICE_TYPES = ["phone", "tablet", "laptop", "camera", "other"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/**
 * Device details. Enrollment needs the type, serial, make, model and colour, plus the IMEI for a
 * phone (optional for other devices). A claim may include just the IMEI or serial, to be matched.
 */
export interface DeviceDetails {
  type?: DeviceType;
  imei?: string;
  serial?: string;
  make?: string;
  model?: string;
  color?: string;
}

export interface EvidenceUpload {
  kind?: BundleKind;
  description?: string;
  device?: DeviceDetails;
  files: EvidenceFileInput[];
}

interface StoredFile {
  name: string;
  contentType: string;
  size: number;
  data: string;
}

/** The bundle as stored. Its JSON serialization is what gets hashed. Version 1 had no kind, device or capture. */
interface StoredBundle {
  version: number;
  kind?: BundleKind;
  description: string;
  device?: DeviceDetails | null;
  capture?: CaptureStamp | null;
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
  kind: BundleKind;
  description: string;
  device: DeviceDetails | null;
  capture: CaptureStamp | null;
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

/** True for a 15-digit IMEI whose last digit is its Luhn check digit. Catches most typos. */
export function isValidImei(imei: string): boolean {
  if (!/^\d{15}$/.test(imei)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let digit = Number(imei[14 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Serial numbers are compared without spaces and case, since people type them both ways. */
export function normalizeSerial(serial: string): string {
  return serial.replace(/\s+/g, "").toUpperCase();
}

/**
 * The string whose keccak256 is the policy's on-chain `deviceIdHash`: the IMEI when the device has
 * one, otherwise make and serial (serials are only unique per manufacturer). The frontend computes
 * the same thing before buyPolicy; frontend/test/boundaries.test.ts keeps the two in step.
 */
export function deviceIdentifier(device: Pick<DeviceDetails, "imei" | "serial" | "make">): string {
  if (device.imei) return device.imei;
  if (!device.serial || !device.make) throw new Error("A device needs an IMEI, or a make and serial number.");
  return `${device.make.trim().toLowerCase()}:${normalizeSerial(device.serial)}`;
}

export function deviceIdHash(device: Pick<DeviceDetails, "imei" | "serial" | "make">): string {
  return keccak256(toUtf8Bytes(deviceIdentifier(device)));
}

function validateDevice(device: unknown, kind: BundleKind): DeviceDetails | null {
  if (device === undefined || device === null) {
    if (kind === "enrollment") throw new EvidenceError("Enrollment needs device details: type, serial, make, model, color.", 400);
    return null;
  }
  if (typeof device !== "object") throw new EvidenceError("device must be an object.", 400);
  const { type, imei, serial, make, model, color } = device as Partial<DeviceDetails>;
  const enrolling = kind === "enrollment";
  if (enrolling && !(DEVICE_TYPES as readonly unknown[]).includes(type)) {
    throw new EvidenceError(`device.type must be one of ${DEVICE_TYPES.join(", ")}.`, 400);
  }
  const imeiRequired = enrolling && type === "phone";
  if (imei !== undefined || imeiRequired) {
    if (typeof imei !== "string" || !isValidImei(imei)) {
      throw new EvidenceError("device.imei must be the 15-digit IMEI (dial *#06# on a phone to see it).", 400);
    }
  }
  const text = (value: unknown, name: string, required: boolean): string | undefined => {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_DEVICE_FIELD_LENGTH) {
      throw new EvidenceError(`device.${name} must be a non-empty string of at most ${MAX_DEVICE_FIELD_LENGTH} characters.`, 400);
    }
    return value.trim();
  };
  // A claim's device details are only there to be matched against the enrollment.
  const fields = {
    type: enrolling ? type : undefined,
    imei,
    serial: text(serial, "serial", enrolling),
    make: enrolling ? text(make, "make", true) : undefined,
    model: enrolling ? text(model, "model", true) : undefined,
    color: enrolling ? text(color, "color", true) : undefined,
  };
  if (!enrolling && !fields.imei && !fields.serial) {
    throw new EvidenceError("A claim's device details need an imei or a serial to match against.", 400);
  }
  // Fixed key order keeps the serialization deterministic; absent optional fields are left out.
  const result: DeviceDetails = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

/**
 * Whether a claim's device details name the enrolled device: by IMEI when both have one, otherwise
 * by serial. null when there is nothing to compare.
 */
export function sameDevice(claimed: DeviceDetails | null, enrolled: DeviceDetails | null): boolean | null {
  if (!claimed || !enrolled) return null;
  if (claimed.imei && enrolled.imei) return claimed.imei === enrolled.imei;
  if (claimed.serial && enrolled.serial) return normalizeSerial(claimed.serial) === normalizeSerial(enrolled.serial);
  return null;
}

/**
 * Validates an upload and returns the canonical bundle bytes that will be hashed and stored.
 * `capture` is the stamp from a consumed capture code; the HTTP layer always supplies one.
 */
export function encodeBundle(upload: unknown, capture: CaptureStamp | null = null): Buffer {
  if (!upload || typeof upload !== "object") throw new EvidenceError("Body must be a JSON object.", 400);
  const { kind = "claim", description = "", device, files } = upload as Partial<EvidenceUpload>;

  if (!(BUNDLE_KINDS as readonly unknown[]).includes(kind)) {
    throw new EvidenceError(`kind must be one of ${BUNDLE_KINDS.join(", ")}.`, 400);
  }
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

  const bundle: StoredBundle = {
    version: BUNDLE_VERSION,
    kind,
    description,
    device: validateDevice(device, kind),
    capture,
    files: stored,
  };
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
    kind: bundle.kind ?? "claim",
    description: bundle.description,
    device: bundle.device ?? null,
    capture: bundle.capture ?? null,
    size: bytes.length,
    files: bundle.files.map((f, index) => ({ index, name: f.name, contentType: f.contentType, size: f.size })),
  };
}

// On-disk format: MAGIC | 12-byte IV | 16-byte GCM tag | ciphertext. The evidence hash is bound in
// as additional authenticated data, so a ciphertext cannot be swapped onto another hash's file.
const MAGIC = Buffer.from("TPE1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const KEY_BYTES = 32;

function encrypt(key: Buffer, evidenceHash: string, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(getBytes(evidenceHash));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(key: Buffer, evidenceHash: string, stored: Buffer): Buffer {
  const headerBytes = MAGIC.length + IV_BYTES + TAG_BYTES;
  if (stored.length < headerBytes || !stored.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new EvidenceError("Stored evidence is not in the encrypted format.", 500);
  }
  const iv = stored.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = stored.subarray(MAGIC.length + IV_BYTES, headerBytes);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(getBytes(evidenceHash));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(stored.subarray(headerBytes)), decipher.final()]);
  } catch {
    throw new EvidenceError("Stored evidence could not be decrypted (wrong key or altered file).", 500);
  }
}

/** Parses a 32-byte key given as 64 hex characters (optionally 0x-prefixed) or base64. */
export function parseEvidenceKey(value: string): Buffer {
  const hex = value.replace(/^0x/, "");
  const key = /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, "hex") : Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES) throw new Error("The evidence key must be 32 bytes, as 64 hex characters or base64.");
  return key;
}

/**
 * Reads the evidence key from `file`, creating a random one (readable by this user only) if it does
 * not exist yet. For local development; deployments should pass EVIDENCE_ENCRYPTION_KEY instead.
 */
export async function loadOrCreateKeyFile(file: string): Promise<{ key: Buffer; created: boolean }> {
  try {
    return { key: parseEvidenceKey((await readFile(file, "utf8")).trim()), created: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = randomBytes(KEY_BYTES);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, key.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
  return { key, created: true };
}

/** Content-addressed, encrypted evidence store on the local filesystem. */
export class LocalEvidenceStore {
  private readonly key: Buffer;
  private readonly deviceCache = new Map<string, DeviceDetails | null>();

  constructor(
    readonly dir: string,
    key: Buffer,
  ) {
    if (key.length !== KEY_BYTES) throw new Error(`Evidence key must be ${KEY_BYTES} bytes.`);
    this.key = key;
  }

  private pathFor(evidenceHash: string): string {
    return join(this.dir, `${evidenceHash}.enc`);
  }

  private uploadersPathFor(evidenceHash: string): string {
    return join(this.dir, `${evidenceHash}.uploaders.json`);
  }

  /**
   * Stores an upload, records `uploader` as allowed to file a claim with it, and returns its hash.
   * Uploading identical evidence twice stores it once.
   */
  async put(upload: unknown, uploader: string, capture: CaptureStamp | null = null): Promise<EvidenceSummary> {
    const bytes = encodeBundle(upload, capture);
    const evidenceHash = hashBundle(bytes);
    await mkdir(this.dir, { recursive: true });
    if (!(await this.has(evidenceHash))) {
      await writeAtomic(this.pathFor(evidenceHash), encrypt(this.key, evidenceHash, bytes));
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
   * Returns the decrypted bundle bytes, or null if none are stored under this hash. Throws if the
   * file cannot be decrypted or no longer matches its hash, so tampered evidence is never served.
   */
  async getRaw(evidenceHash: string): Promise<Buffer | null> {
    const stored = await this.read(evidenceHash);
    if (!stored) return null;
    const bytes = decrypt(this.key, evidenceHash, stored);
    if (hashBundle(bytes) !== evidenceHash) {
      throw new EvidenceError("Stored evidence does not match its hash.", 500);
    }
    return bytes;
  }

  /**
   * The device details in a bundle, or null if it has none or is not stored. Bundles never change once
   * stored, so the answer is cached rather than decrypting the whole bundle on every claim view.
   */
  async getDevice(evidenceHash: string): Promise<DeviceDetails | null> {
    const cached = this.deviceCache.get(evidenceHash);
    if (cached !== undefined) return cached;
    const summary = await this.getSummary(evidenceHash);
    if (!summary) return null;
    this.deviceCache.set(evidenceHash, summary.device);
    return summary.device;
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

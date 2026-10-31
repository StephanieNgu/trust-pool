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
// There are three kinds of bundle. An "enrollment" bundle is uploaded at signup: the device's IMEI,
// serial, make, model and colour, plus photos of the phone. Its hash goes on-chain with the policy.
// A "claim" bundle holds the damage photos. Both carry a capture stamp (see capture.ts) so jurors can
// check the photos were taken just now, and jurors compare a claim's photos with the enrollment ones
// to check it is the same phone. A "receipt" bundle is uploaded after the claimant accepts the jury's
// offer: the invoice for the repair or replacement, with the shop, date and total. Its hash goes
// on-chain with the total, and the claim pays the smaller of the offer and that total. A receipt file
// can back only one claim: the store remembers a keyed hash of every receipt file it has taken.
//
// Ownership. Photos only show that someone held a device, so three things make it harder to insure,
// or claim on, a device that is not yours:
//   - Fresh photos: a signup or claim photo file can be used in one bundle only, so the same pictures
//     cannot insure one phone twice or back a second claim.
//   - Device key: enrolling from the device itself, the browser makes a P-256 key that cannot leave
//     it and puts the public half in the enrollment bundle. A claim filed from the same browser signs
//     its capture code with it, so jurors can see the claim came from the insured device.
//   - Proof of purchase: signup may include an invoice or carrier bill naming the device.
//
// The store also keeps jurors' notes: the short reasoning a juror gives with the amount they vote.
// Only the note's keccak256 goes into the sealed vote on-chain; the text is stored here, encrypted
// like the bundles, and shown to the claimant and the other jurors once that juror reveals.
import { createCipheriv, createDecipheriv, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getBytes, keccak256, toUtf8Bytes } from "ethers";
import type { CaptureStamp } from "./capture";

export const BUNDLE_VERSION = 2;
export const BUNDLE_KINDS = ["claim", "enrollment", "receipt"] as const;
export type BundleKind = (typeof BUNDLE_KINDS)[number];
export const MAX_DEVICE_FIELD_LENGTH = 64;
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DESCRIPTION_LENGTH = 2_000;
/** A claim's explanation of the amount asked for, e.g. "repair quote from the shop: 280". */
export const MAX_AMOUNT_REASON_LENGTH = 1_000;
export const MAX_NOTE_LENGTH = 500;

/** The hash a juror seals into their vote for `note`. Must match the frontend's. */
export function noteHash(note: string): string {
  return keccak256(toUtf8Bytes(note));
}

/** A juror note must be non-empty, not just whitespace, and at most MAX_NOTE_LENGTH characters. */
export function validateNote(note: unknown): string {
  if (typeof note !== "string" || note.trim().length === 0 || note.length > MAX_NOTE_LENGTH) {
    throw new EvidenceError(`note must be a non-empty string of at most ${MAX_NOTE_LENGTH} characters.`, 400);
  }
  return note;
}
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

/** What a receipt bundle says it is for: which claim, from which shop, when, and its total. */
export interface ReceiptDetails {
  claimId: string;
  shop: string;
  /** The total in token base units, as a decimal string. */
  total: string;
  /** The invoice date, YYYY-MM-DD. */
  date: string;
}

export const MAX_SHOP_LENGTH = 120;

/** The public half of a device key: an ECDSA P-256 key as a JWK. */
export interface DeviceKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** What a claim's device signature signs: the claimant's wallet and the claim's capture code. */
export function deviceProofMessage(wallet: string, captureCode: string): string {
  return `TrustPool device proof\nwallet: ${wallet.toLowerCase()}\ncode: ${captureCode}`;
}

/**
 * Whether `signature` (base64, IEEE P1363 r||s as WebCrypto produces) is `key`'s ECDSA P-256 SHA-256
 * signature over deviceProofMessage(wallet, captureCode).
 */
export function verifyDeviceSignature(key: DeviceKey, wallet: string, captureCode: string, signature: string): boolean {
  try {
    const publicKey = createPublicKey({ key: { ...key }, format: "jwk" });
    return verify(
      "sha256",
      Buffer.from(deviceProofMessage(wallet, captureCode), "utf8"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export interface EvidenceUpload {
  kind?: BundleKind;
  /** Receipts only. */
  receipt?: ReceiptDetails;
  /** Enrollment only: the public key of a key kept in the enrolling browser. */
  deviceKey?: DeviceKey;
  /** Enrollment only: indexes into `files` of the proof of purchase. */
  purchaseProof?: number[];
  /** Claims only: the device key's signature over deviceProofMessage(claimant, captureCode). */
  deviceSignature?: string;
  description?: string;
  /** Claims only: why the claimant asked for this amount. A repair quote can be one of the files. */
  amountReason?: string;
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
  amountReason?: string;
  device?: DeviceDetails | null;
  receipt?: ReceiptDetails;
  deviceKey?: DeviceKey;
  purchaseProof?: number[];
  deviceSignature?: string;
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
  /** Claims: the claimant's explanation of the amount, or "" if they gave none. */
  amountReason: string;
  device: DeviceDetails | null;
  /** Receipts: what the claimant entered from the invoice; null for other kinds. */
  receipt: ReceiptDetails | null;
  /** Enrollment: the device key's public half, or null if signup was not done from the device. */
  deviceKey: DeviceKey | null;
  /** Enrollment: indexes of the files that are proof of purchase (empty if none). */
  purchaseProof: number[];
  /** Claims: the device key's signature, or null if the claim was not filed from the device. */
  deviceSignature: string | null;
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

function validateDeviceKey(key: unknown, kind: BundleKind): DeviceKey | undefined {
  if (key === undefined) return undefined;
  if (kind !== "enrollment") throw new EvidenceError("deviceKey is only for enrollment bundles.", 400);
  const { kty, crv, x, y } = (key ?? {}) as Partial<DeviceKey>;
  const coordinate = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
  if (kty !== "EC" || crv !== "P-256" || !coordinate(x) || !coordinate(y)) {
    throw new EvidenceError("deviceKey must be a P-256 public key as a JWK (kty, crv, x, y).", 400);
  }
  try {
    createPublicKey({ key: { kty, crv, x: x as string, y: y as string }, format: "jwk" });
  } catch {
    throw new EvidenceError("deviceKey is not a valid P-256 public key.", 400);
  }
  return { kty, crv, x: x as string, y: y as string };
}

function validatePurchaseProof(indexes: unknown, kind: BundleKind, fileCount: number): number[] | undefined {
  if (indexes === undefined) return undefined;
  if (kind !== "enrollment") throw new EvidenceError("purchaseProof is only for enrollment bundles.", 400);
  if (
    !Array.isArray(indexes) ||
    indexes.length === 0 ||
    !indexes.every((i, n) => Number.isSafeInteger(i) && i >= 0 && i < fileCount && (n === 0 || i > indexes[n - 1]))
  ) {
    throw new EvidenceError("purchaseProof must list file indexes in increasing order.", 400);
  }
  return indexes as number[];
}

function validateDeviceSignature(signature: unknown, kind: BundleKind): string | undefined {
  if (signature === undefined) return undefined;
  if (kind !== "claim") throw new EvidenceError("deviceSignature is only for claim bundles.", 400);
  // A P-256 signature in IEEE P1363 form is 64 bytes: 88 base64 characters.
  if (typeof signature !== "string" || signature.length !== 88 || !BASE64_PATTERN.test(signature)) {
    throw new EvidenceError("deviceSignature must be a base64 P-256 signature.", 400);
  }
  return signature;
}

function validateReceipt(receipt: unknown, kind: BundleKind): ReceiptDetails | undefined {
  if (kind !== "receipt") {
    if (receipt !== undefined) throw new EvidenceError("receipt details are only for receipt bundles.", 400);
    return undefined;
  }
  if (!receipt || typeof receipt !== "object") {
    throw new EvidenceError("A receipt needs its details: claimId, shop, total and date.", 400);
  }
  const { claimId, shop, total, date } = receipt as Partial<ReceiptDetails>;
  if (typeof claimId !== "string" || !/^[1-9]\d{0,18}$/.test(claimId)) {
    throw new EvidenceError("receipt.claimId must be the claim's id.", 400);
  }
  if (typeof shop !== "string" || shop.trim().length === 0 || shop.length > MAX_SHOP_LENGTH) {
    throw new EvidenceError(`receipt.shop must be the shop's name, at most ${MAX_SHOP_LENGTH} characters.`, 400);
  }
  if (typeof total !== "string" || !/^[1-9]\d{0,30}$/.test(total)) {
    throw new EvidenceError("receipt.total must be the total in token base units, above 0.", 400);
  }
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new EvidenceError("receipt.date must be the invoice date as YYYY-MM-DD.", 400);
  }
  // Fixed key order keeps the serialization deterministic.
  return { claimId, shop: shop.trim(), total, date };
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
  const { kind = "claim", description = "", amountReason, device, receipt, deviceKey, purchaseProof, deviceSignature, files } =
    upload as Partial<EvidenceUpload>;

  if (!(BUNDLE_KINDS as readonly unknown[]).includes(kind)) {
    throw new EvidenceError(`kind must be one of ${BUNDLE_KINDS.join(", ")}.`, 400);
  }
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new EvidenceError(`description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters.`, 400);
  }
  if (amountReason !== undefined) {
    if (kind !== "claim") throw new EvidenceError("amountReason is only for claim evidence.", 400);
    if (typeof amountReason !== "string" || amountReason.length > MAX_AMOUNT_REASON_LENGTH) {
      throw new EvidenceError(`amountReason must be a string of at most ${MAX_AMOUNT_REASON_LENGTH} characters.`, 400);
    }
  }
  if (kind === "receipt" && device !== undefined) throw new EvidenceError("A receipt has no device details.", 400);
  const receiptDetails = validateReceipt(receipt, kind);
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
    // Left out when absent, so bundles without one hash exactly as before.
    ...(amountReason ? { amountReason } : {}),
    device: validateDevice(device, kind),
    ...(receiptDetails ? { receipt: receiptDetails } : {}),
    // Each left out when absent, so bundles without them hash exactly as before.
    ...optional("deviceKey", validateDeviceKey(deviceKey, kind)),
    ...optional("purchaseProof", validatePurchaseProof(purchaseProof, kind, stored.length)),
    ...optional("deviceSignature", validateDeviceSignature(deviceSignature, kind)),
    capture,
    files: stored,
  };
  return Buffer.from(JSON.stringify(bundle), "utf8");
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
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
    amountReason: bundle.amountReason ?? "",
    device: bundle.device ?? null,
    receipt: bundle.receipt ?? null,
    deviceKey: bundle.deviceKey ?? null,
    purchaseProof: bundle.purchaseProof ?? [],
    deviceSignature: bundle.deviceSignature ?? null,
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
  /** Bundles never change once stored, so their summaries are cached rather than decrypted on every view. */
  private readonly summaryCache = new Map<string, EvidenceSummary>();

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

  /** Keyed, so the marker names say nothing about the files to anyone without the evidence key. */
  private markPathFor(folder: "receipts" | "photos", fileData: string): string {
    const id = createHmac("sha256", this.key).update(Buffer.from(fileData, "base64")).digest("hex");
    return join(this.dir, folder, `${id}.json`);
  }

  /**
   * Refuses a signup or claim bundle any of whose files is already in another bundle, then records its
   * files as belonging to this one. Uploading the identical bundle again (a retry) is fine.
   */
  private async claimPhotoFiles(bundle: StoredBundle, evidenceHash: string): Promise<void> {
    if (bundle.kind === "receipt") return;
    const paths = bundle.files.map((f) => this.markPathFor("photos", f.data));
    for (const path of paths) {
      try {
        const used = (JSON.parse(await readFile(path, "utf8")) as { evidenceHash: string }).evidenceHash;
        if (used !== evidenceHash) {
          throw new EvidenceError("A photo in this upload has been uploaded before. Take new photos of the device.", 409);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    await mkdir(join(this.dir, "photos"), { recursive: true });
    for (const path of paths) await writeAtomic(path, Buffer.from(JSON.stringify({ evidenceHash })));
  }

  /**
   * Refuses a receipt any of whose files already backs another claim, then records its files as
   * used by this claim. Re-uploading the same file for the same claim is fine.
   */
  private async claimReceiptFiles(bundle: StoredBundle): Promise<void> {
    const claimId = bundle.receipt?.claimId;
    if (!claimId) return;
    const paths = bundle.files.map((f) => this.markPathFor("receipts", f.data));
    for (const path of paths) {
      try {
        const used = (JSON.parse(await readFile(path, "utf8")) as { claimId: string }).claimId;
        if (used !== claimId) {
          throw new EvidenceError(`This receipt was already used for claim #${used}. Each receipt can back one claim.`, 409);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    await mkdir(join(this.dir, "receipts"), { recursive: true });
    for (const path of paths) await writeAtomic(path, Buffer.from(JSON.stringify({ claimId })));
  }

  /**
   * Stores an upload, records `uploader` as allowed to file a claim with it, and returns its hash.
   * Uploading identical evidence twice stores it once.
   */
  async put(upload: unknown, uploader: string, capture: CaptureStamp | null = null): Promise<EvidenceSummary> {
    const bytes = encodeBundle(upload, capture);
    const evidenceHash = hashBundle(bytes);
    await mkdir(this.dir, { recursive: true });
    const bundle = JSON.parse(bytes.toString("utf8")) as StoredBundle;
    await this.claimReceiptFiles(bundle);
    await this.claimPhotoFiles(bundle, evidenceHash);
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
    return (await this.getSummary(evidenceHash))?.device ?? null;
  }

  async getSummary(evidenceHash: string): Promise<EvidenceSummary | null> {
    const cached = this.summaryCache.get(evidenceHash);
    if (cached) return cached;
    const bytes = await this.getRaw(evidenceHash);
    if (!bytes) return null;
    const summary = summarize(evidenceHash, bytes);
    this.summaryCache.set(evidenceHash, summary);
    return summary;
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

  private notePathFor(claimId: number, juror: string, hash: string): string {
    return join(this.dir, "notes", `${claimId}.${juror.toLowerCase()}.${hash}.enc`);
  }

  /**
   * Stores a juror's note for a claim and returns its hash, the value sealed into their vote. A juror
   * may store several drafts; only the one whose hash they reveal is ever shown.
   */
  async putNote(claimId: number, juror: string, note: unknown): Promise<string> {
    const text = validateNote(note);
    const hash = noteHash(text);
    const path = this.notePathFor(claimId, juror, hash);
    await mkdir(dirname(path), { recursive: true });
    await writeAtomic(path, encrypt(this.key, hash, Buffer.from(text, "utf8")));
    return hash;
  }

  /** The note `juror` stored for `claimId` with this hash, or null if there is none. */
  async getNote(claimId: number, juror: string, hash: string): Promise<string | null> {
    if (!isEvidenceHash(hash)) return null;
    let stored: Buffer;
    try {
      stored = await readFile(this.notePathFor(claimId, juror, hash));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const text = decrypt(this.key, hash, stored).toString("utf8");
    if (noteHash(text) !== hash) throw new EvidenceError("Stored note does not match its hash.", 500);
    return text;
  }

  /**
   * Every note `juror` stored for `claimId`, with its hash. Lets a juror who lost the browser copy of
   * their sealed vote reveal it without retyping the note word for word.
   */
  async listNotes(claimId: number, juror: string): Promise<{ noteHash: string; note: string }[]> {
    const prefix = `${claimId}.${juror.toLowerCase()}.`;
    let names: string[];
    try {
      names = await readdir(join(this.dir, "notes"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const notes: { noteHash: string; note: string }[] = [];
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".enc")) continue;
      const hash = name.slice(prefix.length, -".enc".length);
      const note = await this.getNote(claimId, juror, hash);
      if (note !== null) notes.push({ noteHash: hash, note });
    }
    return notes;
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

import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import { getWalletAuthHeaders } from "./auth";
import { ApiError, apiRequest } from "./client";
import type { DeviceKeyJwk } from "../member/deviceKey";
import type {
  CaptureCode,
  ClaimDetailView,
  ClaimState,
  ClaimView,
  DeviceDetails,
  DeviceType,
  EvidenceDetail,
  EvidenceKind,
  EvidenceSummary,
  JuryVote,
  ReceiptDetails,
} from "./types";

export const MAX_EVIDENCE_FILES = 10;
export const MAX_EVIDENCE_FILE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_EVIDENCE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "application/pdf",
] as const;

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      const value = String(reader.result);
      const separator = value.indexOf(",");
      if (separator < 0) reject(new Error(`Could not encode ${file.name}.`));
      else resolve(value.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function validateEvidenceFiles(files: File[]): void {
  if (files.length === 0 || files.length > MAX_EVIDENCE_FILES) {
    throw new Error(`Choose between 1 and ${MAX_EVIDENCE_FILES} evidence files.`);
  }
  for (const file of files) {
    if (!(ALLOWED_EVIDENCE_TYPES as readonly string[]).includes(file.type)) {
      throw new Error(`${file.name} is not a supported image or PDF.`);
    }
    if (file.size === 0 || file.size > MAX_EVIDENCE_FILE_BYTES) {
      throw new Error(`${file.name} must be between 1 byte and 5 MB.`);
    }
  }
}

export const MAX_DEVICE_FIELD_LENGTH = 64;
export const DEVICE_TYPES: readonly DeviceType[] = ["phone", "tablet", "laptop", "camera", "other"];
const DEVICE_TEXT_FIELDS = ["serial", "make", "model", "color"] as const;

/** True for a 15-digit IMEI whose last digit is its Luhn check digit, as the backend requires. */
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

/** Serial numbers are compared without spaces and case, as the backend does. */
export function normalizeSerial(serial: string): string {
  return serial.replace(/\s+/g, "").toUpperCase();
}

/**
 * The string whose hash goes on-chain as the policy's deviceIdHash: the IMEI when the device has one,
 * otherwise make and serial. Must match backend/src/evidence.ts deviceIdentifier.
 */
export function deviceIdentifier(device: Pick<DeviceDetails, "imei" | "serial" | "make">): string {
  if (device.imei) return device.imei;
  if (!device.serial || !device.make) throw new Error("A device needs an IMEI, or a make and serial number.");
  return `${device.make.trim().toLowerCase()}:${normalizeSerial(device.serial)}`;
}

export function deviceIdHash(device: Pick<DeviceDetails, "imei" | "serial" | "make">): string {
  return keccak256(toUtf8Bytes(deviceIdentifier(device)));
}

/**
 * Trims the enrollment fields and checks them the way the backend will; throws a readable error.
 * Every device needs a serial number; a phone also needs its IMEI, and a tablet may give one.
 */
export function validateDeviceDetails(device: DeviceDetails): DeviceDetails {
  if (!device.type || !DEVICE_TYPES.includes(device.type)) throw new Error("Choose what kind of device this is.");
  const result: DeviceDetails = { type: device.type };
  const imei = device.imei?.replace(/[\s-]/g, "") ?? "";
  if (imei || device.type === "phone") {
    if (!isValidImei(imei)) throw new Error("Enter the 15-digit IMEI. On a phone, dial *#06# or look in Settings > About.");
    result.imei = imei;
  }
  for (const field of DEVICE_TEXT_FIELDS) {
    const value = device[field]?.trim() ?? "";
    if (!value || value.length > MAX_DEVICE_FIELD_LENGTH) {
      throw new Error(`Enter the device ${field} (up to ${MAX_DEVICE_FIELD_LENGTH} characters).`);
    }
    result[field] = value;
  }
  return result;
}

/** What a claimant typed to identify the device: a valid IMEI is taken as one, anything else as a serial. */
export function claimDeviceId(value: string): Pick<DeviceDetails, "imei" | "serial"> | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const digits = trimmed.replace(/[\s-]/g, "");
  if (isValidImei(digits)) return { imei: digits };
  if (trimmed.length > MAX_DEVICE_FIELD_LENGTH) throw new Error(`The serial number can be at most ${MAX_DEVICE_FIELD_LENGTH} characters.`);
  return { serial: trimmed };
}

/** A one-time code for the photos about to be taken. Asks the wallet to sign in if needed. */
export async function requestCaptureCode(address: string): Promise<CaptureCode> {
  const headers = await getWalletAuthHeaders(address);
  return apiRequest<CaptureCode>("/api/capture/code", { method: "POST", headers });
}

export const MAX_AMOUNT_REASON_LENGTH = 1_000;
export const MAX_JURY_NOTE_LENGTH = 500;

async function postBundle(
  address: string,
  body: {
    kind: EvidenceKind;
    description: string;
    amountReason?: string;
    device?: DeviceDetails;
    receipt?: ReceiptDetails;
    deviceKey?: DeviceKeyJwk;
    purchaseProof?: number[];
    deviceSignature?: string;
    captureCode?: string;
  },
  files: File[],
): Promise<EvidenceSummary> {
  validateEvidenceFiles(files);
  if (body.description.length > 2_000) throw new Error("Evidence description must be 2,000 characters or fewer.");
  if ((body.amountReason?.length ?? 0) > MAX_AMOUNT_REASON_LENGTH) {
    throw new Error(`The explanation of the amount must be ${MAX_AMOUNT_REASON_LENGTH.toLocaleString()} characters or fewer.`);
  }
  if (body.kind !== "receipt" && !body.captureCode) throw new Error("Get a capture code before taking the photos.");
  const headers = await getWalletAuthHeaders(address);
  const encoded = await Promise.all(
    files.map(async (file) => ({ name: file.name, contentType: file.type, data: await fileAsBase64(file) })),
  );
  return apiRequest<EvidenceSummary>("/api/evidence", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ ...body, files: encoded }),
    timeoutMs: 60_000,
  });
}

/**
 * Uploads claim evidence. `captureCode` must be one this wallet requested and the photos should show.
 * `deviceId` is optional: the IMEI or serial number the claimant typed, matched against the enrollment.
 * `amountReason` tells jurors why the claim asks for this amount; a repair quote can be one of `files`.
 */
export async function uploadEvidence(
  address: string,
  description: string,
  files: File[],
  captureCode: string,
  deviceId = "",
  amountReason = "",
  deviceSignature?: string,
): Promise<EvidenceSummary> {
  const device = claimDeviceId(deviceId);
  const reason = amountReason.trim();
  return postBundle(
    address,
    { kind: "claim", description, ...(reason ? { amountReason: reason } : {}), device, ...(deviceSignature ? { deviceSignature } : {}), captureCode },
    files,
  );
}

/**
 * Uploads the signup photos and device details. Pass the returned hash to purchaseCoverage. Optional:
 * `deviceKey`, the public half of a key made in this browser when signing up from the device itself,
 * and `purchaseProof`, an invoice or bill naming the device, sent after the photos.
 */
export async function enrollDevice(
  address: string,
  device: DeviceDetails,
  files: File[],
  captureCode: string,
  options: { deviceKey?: DeviceKeyJwk; purchaseProof?: File[] } = {},
): Promise<EvidenceSummary> {
  const details = validateDeviceDetails(device);
  const proof = options.purchaseProof ?? [];
  return postBundle(
    address,
    {
      kind: "enrollment",
      description: "",
      device: details,
      ...(options.deviceKey ? { deviceKey: options.deviceKey } : {}),
      ...(proof.length ? { purchaseProof: proof.map((_, i) => files.length + i) } : {}),
      captureCode,
    },
    [...files, ...proof],
  );
}

export const MAX_SHOP_LENGTH = 120;

/**
 * Uploads the receipt for an accepted claim: the invoice files, the shop, the total in base units
 * and the invoice date (YYYY-MM-DD). Pass the returned hash and the same total to submitReceipt.
 */
export async function uploadReceipt(
  address: string,
  claimId: string,
  details: { shop: string; total: bigint; date: string; description?: string },
  files: File[],
): Promise<EvidenceSummary> {
  const shop = details.shop.trim();
  if (!shop || shop.length > MAX_SHOP_LENGTH) throw new Error(`Enter the shop's name, up to ${MAX_SHOP_LENGTH} characters.`);
  if (details.total <= 0n) throw new Error("Enter the receipt's total.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(details.date)) throw new Error("Enter the date on the receipt.");
  return postBundle(
    address,
    { kind: "receipt", description: details.description?.trim() ?? "", receipt: { claimId, shop, total: details.total.toString(), date: details.date } },
    files,
  );
}

export async function getClaimsForMember(address: string, state?: ClaimState): Promise<ClaimView[]> {
  const query = new URLSearchParams({ claimant: getAddress(address) });
  if (state) query.set("state", state);
  const response = await apiRequest<{ claims: ClaimView[] }>(
    `/api/claims?${query.toString()}`,
  );
  return response.claims;
}

export async function getClaimsForJuror(address: string, state?: ClaimState): Promise<ClaimView[]> {
  const query = new URLSearchParams({ juror: getAddress(address) });
  if (state) query.set("state", state);
  const response = await apiRequest<{ claims: ClaimView[] }>(
    `/api/claims?${query.toString()}`,
  );
  return response.claims;
}

export function getClaim(claimId: string): Promise<ClaimDetailView> {
  if (!/^\d+$/.test(claimId) || claimId === "0") throw new Error("Claim id must be a positive integer.");
  return apiRequest<ClaimDetailView>(`/api/claims/${claimId}`);
}

/**
 * Stores a juror's note for a claim, before they seal their vote, and returns the hash to seal with it.
 * The note stays private until the juror reveals; then the claimant and the other jurors can read it.
 */
export async function submitJuryNote(address: string, claimId: string, note: string): Promise<string> {
  if (!/^\d+$/.test(claimId) || claimId === "0") throw new Error("Claim id must be a positive integer.");
  if (!note.trim() || note.length > MAX_JURY_NOTE_LENGTH) {
    throw new Error(`Write a note of up to ${MAX_JURY_NOTE_LENGTH} characters.`);
  }
  const headers = await getWalletAuthHeaders(address);
  const { noteHash } = await apiRequest<{ noteHash: string }>(`/api/claims/${claimId}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ note }),
  });
  return noteHash;
}

/** The notes this juror stored for a claim, each with the hash a sealed vote would carry. */
export async function getMyJuryNotes(address: string, claimId: string): Promise<{ noteHash: string; note: string }[]> {
  if (!/^\d+$/.test(claimId) || claimId === "0") throw new Error("Claim id must be a positive integer.");
  const headers = await getWalletAuthHeaders(address);
  return (await apiRequest<{ notes: { noteHash: string; note: string }[] }>(`/api/claims/${claimId}/notes/mine`, { headers })).notes;
}

/** Every revealed juror's amount and note. Only the claimant and the claim's jurors may read them. */
export async function getJuryVotes(address: string, claimId: string): Promise<JuryVote[]> {
  if (!/^\d+$/.test(claimId) || claimId === "0") throw new Error("Claim id must be a positive integer.");
  const headers = await getWalletAuthHeaders(address);
  return (await apiRequest<{ votes: JuryVote[] }>(`/api/claims/${claimId}/votes`, { headers })).votes;
}

export async function getEvidence(address: string, evidenceHash: string): Promise<EvidenceDetail> {
  const headers = await getWalletAuthHeaders(address);
  return apiRequest<EvidenceDetail>(`/api/evidence/${encodeURIComponent(evidenceHash)}`, { headers });
}

export async function getEvidenceResource(address: string, path: string): Promise<Uint8Array> {
  if (!path.startsWith("/api/evidence/")) throw new Error("The backend returned an invalid evidence URL.");
  const headers = await getWalletAuthHeaders(address);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(path, { headers: { Accept: "*/*", ...headers }, signal: controller.signal });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(body?.error ?? `Evidence request failed with status ${response.status}.`, response.status);
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError("The evidence request timed out.", 0);
    }
    throw new ApiError("Could not download the evidence from the TrustPool backend.", 0);
  } finally {
    window.clearTimeout(timer);
  }
}

import { getAddress } from "ethers";
import { getWalletAuthHeaders } from "./auth";
import { ApiError, apiRequest } from "./client";
import type {
  CaptureCode,
  ClaimDetailView,
  ClaimState,
  ClaimView,
  DeviceDetails,
  EvidenceDetail,
  EvidenceKind,
  EvidenceSummary,
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
export const DEVICE_TEXT_FIELDS = ["serial", "make", "model", "color"] as const;

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

/** Trims the device fields and checks them the way the backend will; throws a readable error. */
export function validateDeviceDetails(device: DeviceDetails, kind: EvidenceKind): DeviceDetails {
  const imei = device.imei.replace(/[\s-]/g, "");
  if (!isValidImei(imei)) throw new Error("Enter the phone's 15-digit IMEI. Dial *#06# or look in Settings > About.");
  const result: DeviceDetails = { imei };
  for (const field of DEVICE_TEXT_FIELDS) {
    const value = device[field]?.trim() ?? "";
    if (!value && kind === "claim") continue;
    if (!value || value.length > MAX_DEVICE_FIELD_LENGTH) {
      throw new Error(`Enter the device ${field} (up to ${MAX_DEVICE_FIELD_LENGTH} characters).`);
    }
    result[field] = value;
  }
  return result;
}

/** A one-time code for the photos about to be taken. Asks the wallet to sign in if needed. */
export async function requestCaptureCode(address: string): Promise<CaptureCode> {
  const headers = await getWalletAuthHeaders(address);
  return apiRequest<CaptureCode>("/api/capture/code", { method: "POST", headers });
}

async function postBundle(
  address: string,
  body: { kind: EvidenceKind; description: string; device?: DeviceDetails; captureCode: string },
  files: File[],
): Promise<EvidenceSummary> {
  validateEvidenceFiles(files);
  if (body.description.length > 2_000) throw new Error("Evidence description must be 2,000 characters or fewer.");
  if (!body.captureCode) throw new Error("Get a capture code before taking the photos.");
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
 * `imei` is optional: include it when the phone still turns on, so it can be matched to the enrollment.
 */
export async function uploadEvidence(
  address: string,
  description: string,
  files: File[],
  captureCode: string,
  imei?: string,
): Promise<EvidenceSummary> {
  const device = imei?.trim() ? validateDeviceDetails({ imei }, "claim") : undefined;
  return postBundle(address, { kind: "claim", description, device, captureCode }, files);
}

/** Uploads the signup photos and device details. Pass the returned hash to purchaseCoverage. */
export async function enrollDevice(
  address: string,
  device: DeviceDetails,
  files: File[],
  captureCode: string,
): Promise<EvidenceSummary> {
  const details = validateDeviceDetails(device, "enrollment");
  return postBundle(address, { kind: "enrollment", description: "", device: details, captureCode }, files);
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

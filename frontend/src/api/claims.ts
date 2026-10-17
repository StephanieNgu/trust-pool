import { getAddress } from "ethers";
import { getWalletAuthHeaders } from "./auth";
import { ApiError, apiRequest } from "./client";
import type { ClaimDetailView, ClaimView, EvidenceDetail, EvidenceSummary } from "./types";

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

export async function uploadEvidence(address: string, description: string, files: File[]): Promise<EvidenceSummary> {
  validateEvidenceFiles(files);
  if (description.length > 2_000) throw new Error("Evidence description must be 2,000 characters or fewer.");
  const headers = await getWalletAuthHeaders(address);
  const encoded = await Promise.all(
    files.map(async (file) => ({ name: file.name, contentType: file.type, data: await fileAsBase64(file) })),
  );
  return apiRequest<EvidenceSummary>("/api/evidence", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ description, files: encoded }),
    timeoutMs: 60_000,
  });
}

export async function getClaimsForMember(address: string): Promise<ClaimView[]> {
  const response = await apiRequest<{ claims: ClaimView[] }>(
    `/api/claims?claimant=${encodeURIComponent(getAddress(address))}`,
  );
  return response.claims;
}

export async function getClaimsForJuror(address: string): Promise<ClaimView[]> {
  const response = await apiRequest<{ claims: ClaimView[] }>(
    `/api/claims?juror=${encodeURIComponent(getAddress(address))}`,
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

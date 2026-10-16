import { getAddress } from "ethers";
import { getWalletAuthHeaders } from "./auth";
import { apiRequest } from "./client";
import type { ClaimView, EvidenceSummary } from "./types";

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

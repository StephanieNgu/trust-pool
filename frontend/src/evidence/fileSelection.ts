import { MAX_EVIDENCE_FILES, validateEvidenceFiles } from "../api";

function validateFile(file: File): void {
  validateEvidenceFiles([file]);
}

async function fingerprint(file: File): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) return `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Validates before upload and rejects duplicate content, even when a duplicate was renamed. */
export async function appendEvidenceFiles(existing: readonly File[], picked: readonly File[], maximum = MAX_EVIDENCE_FILES): Promise<File[]> {
  if (existing.length + picked.length > maximum) {
    throw new Error(`Choose no more than ${maximum} evidence files in total.`);
  }
  for (const file of picked) validateFile(file);
  const seen = new Set(await Promise.all(existing.map(fingerprint)));
  for (const file of picked) {
    const id = await fingerprint(file);
    if (seen.has(id)) throw new Error(`${file.name} duplicates a file already selected.`);
    seen.add(id);
  }
  return [...existing, ...picked];
}

export async function validateEvidenceFile(file: File, others: readonly File[], maximum = MAX_EVIDENCE_FILES): Promise<void> {
  await appendEvidenceFiles(others, [file], maximum);
}

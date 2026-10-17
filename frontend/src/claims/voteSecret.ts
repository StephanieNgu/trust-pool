const LEGACY_PREFIX = "trustpool:jury-vote:";

export interface LegacyVoteSecret {
  approve: boolean;
  salt: string;
  commitment: string;
}

function isBytes32(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Reads only an existing pre-migration secret. New votes never write secrets to
 * browser storage; this bridge keeps an already committed vote revealable once.
 */
export function loadLegacyVoteSecret(account: string, claimId: string): LegacyVoteSecret | null {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(LEGACY_PREFIX)) continue;
    try {
      const record = JSON.parse(localStorage.getItem(key) ?? "null") as Record<string, unknown> | null;
      if (
        record?.version === 1
        && String(record.claimId) === claimId
        && typeof record.juror === "string"
        && record.juror.toLowerCase() === account.toLowerCase()
        && typeof record.approve === "boolean"
        && isBytes32(record.salt)
        && isBytes32(record.commitment)
      ) {
        return { approve: record.approve, salt: record.salt, commitment: record.commitment };
      }
    } catch {
      // Ignore malformed records; they cannot safely be used to reveal a vote.
    }
  }
  return null;
}

export function removeLegacyVoteSecret(account: string, claimId: string): void {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(LEGACY_PREFIX)) continue;
    try {
      const record = JSON.parse(localStorage.getItem(key) ?? "null") as Record<string, unknown> | null;
      if (String(record?.claimId) === claimId && typeof record?.juror === "string" && record.juror.toLowerCase() === account.toLowerCase()) {
        localStorage.removeItem(key);
      }
    } catch {
      // Leave unrelated malformed storage untouched.
    }
  }
}

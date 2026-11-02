import type { CaptureCode, ClaimEvent } from "../api";

const STORAGE_PREFIX = "trustpool:claim-draft:v1:";
const CLAIM_EVENTS: readonly ClaimEvent[] = ["screen", "accidental", "liquid", "theft", "breakdown"];

export interface ClaimDraft {
  amount: string;
  description: string;
  captureCode: CaptureCode | null;
  capturePhoto: File | null;
  files: File[];
  deviceId: string;
  amountReason: string;
  claimEvent: ClaimEvent | "";
}

interface StoredClaimDraft {
  version: 1;
  amount: string;
  description: string;
  deviceId: string;
  amountReason: string;
  claimEvent: ClaimEvent | "";
}

export function emptyClaimDraft(): ClaimDraft {
  return {
    amount: "",
    description: "",
    captureCode: null,
    capturePhoto: null,
    files: [],
    deviceId: "",
    amountReason: "",
    claimEvent: "",
  };
}

function storageKey(account: string) {
  return `${STORAGE_PREFIX}${account.toLowerCase()}`;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** Restore text fields after a refresh. Capture codes and files must be selected again. */
export function loadClaimDraft(account: string | null): ClaimDraft {
  const draft = emptyClaimDraft();
  if (!account) return draft;
  try {
    const raw = sessionStorage.getItem(storageKey(account));
    if (!raw) return draft;
    const stored = JSON.parse(raw) as Partial<StoredClaimDraft>;
    if (stored.version !== 1) return draft;
    const event = (CLAIM_EVENTS as readonly unknown[]).includes(stored.claimEvent) ? (stored.claimEvent as ClaimEvent) : "";
    return {
      ...draft,
      amount: text(stored.amount, 80),
      description: text(stored.description, 2_000),
      deviceId: text(stored.deviceId, 64),
      amountReason: text(stored.amountReason, 1_000),
      claimEvent: event,
    };
  } catch {
    return draft;
  }
}

/** Keep text in session storage; binary files remain only in App memory while navigating. */
export function persistClaimDraft(account: string, draft: ClaimDraft): void {
  try {
    const stored: StoredClaimDraft = {
      version: 1,
      amount: draft.amount,
      description: draft.description,
      deviceId: draft.deviceId,
      amountReason: draft.amountReason,
      claimEvent: draft.claimEvent,
    };
    if (!stored.amount && !stored.description && !stored.deviceId && !stored.amountReason && !stored.claimEvent) {
      sessionStorage.removeItem(storageKey(account));
      return;
    }
    sessionStorage.setItem(storageKey(account), JSON.stringify(stored));
  } catch {
    // The in-memory draft still works when browser storage is unavailable.
  }
}

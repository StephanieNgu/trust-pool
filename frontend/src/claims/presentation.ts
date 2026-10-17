import type { ClaimState } from "../api";

export const CLAIM_STATE_COPY: Record<ClaimState, string> = {
  Submitted: "Submitted",
  JuryPending: "Selecting jury",
  Voting: "Voting",
  Approved: "Approved",
  Rejected: "Rejected",
  Paid: "Paid",
  Cancelled: "Cancelled",
};

export function shortHash(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function dateTime(timestamp: number | null) {
  return timestamp ? new Date(timestamp * 1000).toLocaleString() : "—";
}

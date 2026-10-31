import { formatUnits } from "ethers";
import type { ClaimState } from "../api";

export const CLAIM_STATE_COPY: Record<ClaimState, string> = {
  Submitted: "Submitted",
  JuryPending: "Selecting jury",
  Voting: "Voting",
  Approved: "Approved",
  Rejected: "Rejected",
  Paid: "Paid",
  Cancelled: "Cancelled",
  Offered: "Offer made",
  Withdrawn: "Withdrawn",
  Expired: "Expired",
};

/** The claim list filter: most members only need to tell live claims from finished ones. */
export type ClaimFilter = "All" | "Open" | "Closed";
export const CLAIM_FILTERS: { value: ClaimFilter; label: string }[] = [
  { value: "All", label: "All claims" },
  { value: "Open", label: "Open" },
  { value: "Closed", label: "Closed" },
];
const OPEN_STATES: readonly ClaimState[] = ["Submitted", "JuryPending", "Voting", "Offered", "Approved"];
export function matchesClaimFilter(state: ClaimState, filter: ClaimFilter) {
  return filter === "All" || OPEN_STATES.includes(state) === (filter === "Open");
}

export function shortHash(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

/**
 * Jurors by their seat on the jury ("Juror A" to "Juror E") rather than their wallet, so the claimant
 * and the other jurors don't see who voted what.
 */
export function jurorLabel(index: number) {
  return index >= 0 && index < 26 ? `Juror ${String.fromCharCode(65 + index)}` : "Juror";
}

export function dateTime(timestamp: number | null) {
  return timestamp ? new Date(timestamp * 1000).toLocaleString() : "—";
}

/** A token amount for display: grouped, at most 2 decimals, no trailing ".0" (800.0 → 800, 5.333333 → 5.33). */
export function formatAmount(value: string | bigint, decimals: number) {
  return Number(formatUnits(value, decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** The same for an amount already in whole tokens, such as a dashboard figure. */
export function displayAmount(value: string | number) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

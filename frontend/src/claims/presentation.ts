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

export function shortHash(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
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

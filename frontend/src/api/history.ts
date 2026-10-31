import { getAddress } from "ethers";
import { apiRequest } from "./client";

export type HistoryKind =
  | "coverage"
  | "premium"
  | "lapse"
  | "contribution"
  | "stake"
  | "unstake"
  | "fee"
  | "penalty"
  | "bond"
  | "bondReturn"
  | "claim"
  | "payout";

/** One line of a member's account history, built by the backend from contract events. */
export interface HistoryEntry {
  id: string;
  kind: HistoryKind;
  title: string;
  /** Token base units, or null when no money moved. */
  amount: string | null;
  /** "in" = to the wallet, "out" = from it. */
  direction: "in" | "out" | null;
  claimId: string | null;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  /** Unix seconds of the block. */
  at: number;
}

export async function getMemberHistory(address: string): Promise<HistoryEntry[]> {
  return (await apiRequest<{ history: HistoryEntry[] }>(`/api/members/${getAddress(address)}/history`)).history;
}

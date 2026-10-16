export interface ApiHealth {
  ok: boolean;
  chainId: string;
  blockNumber: number;
  keeper: {
    address: string;
    fulfillRandomness: boolean;
    autoResolve: boolean;
    running: boolean;
    lastTickAt: number | null;
    lastError: string | null;
  } | null;
}

export interface ApiConfig {
  network: string;
  chainId: string;
  addresses: Record<string, string>;
  params: Record<string, string>;
  token: { symbol: string; decimals: number };
  claimStates: string[];
}

export interface PoolView {
  balance: string;
  maxPayout: string;
  maxPayoutBps: number;
  totalContributed: string;
  totalPaidOut: string;
  policyCount: number;
  holderCount: number;
  claimCount: number;
}

export interface MemberPolicy {
  id: string;
  deviceIdHash: string;
  coverageLimit: string;
  startTime: number;
  status: "Active" | "Lapsed";
  claimEligibleAt: number;
  pastWaitingPeriod: boolean;
  openClaimId: string | null;
}

export interface MemberView {
  address: string;
  balance: string;
  contributed: string;
  policy: MemberPolicy | null;
}

export type ClaimState =
  | "Submitted"
  | "JuryPending"
  | "Voting"
  | "Approved"
  | "Rejected"
  | "Paid"
  | "Cancelled";

export interface ClaimJuror {
  address: string;
  committed: boolean;
  revealed: boolean;
}

export interface ClaimJury {
  phase: "AwaitingRandomness" | "Voting" | "Tallied" | "Cancelled";
  commitDeadline: number | null;
  revealDeadline: number | null;
  revealOpen: boolean;
  commits: number;
  approvals: number;
  rejections: number;
  quorum: number;
  outcome: "None" | "Approved" | "Rejected";
  outcomeReason: "majorityApproved" | "majorityRejected" | "tie" | "noQuorum" | null;
  jurors: ClaimJuror[];
  canTally: boolean;
  cancelAvailableAt: number | null;
}

export interface ClaimView {
  id: string;
  claimant: string;
  policyId: string;
  amount: string;
  coverageLimit: string;
  evidenceHash: string;
  state: ClaimState;
  submittedAt: number;
  paidAmount: string;
  payoutAmount: string;
  jury: ClaimJury | null;
}

export interface EvidenceFileInfo {
  index: number;
  name: string;
  contentType: string;
  size: number;
}

export interface EvidenceSummary {
  evidenceHash: string;
  description: string;
  size: number;
  files: EvidenceFileInfo[];
}

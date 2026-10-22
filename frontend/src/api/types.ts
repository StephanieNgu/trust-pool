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
  /** Hash of the enrollment bundle: device details and the photos taken at signup. */
  enrollmentHash: string;
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
  /** The enrollment bundle of the policy this claim was filed on, or null if it is no longer on-chain. */
  enrollmentHash: string | null;
  state: ClaimState;
  submittedAt: number;
  paidAmount: string;
  payoutAmount: string;
  jury: ClaimJury | null;
}

export interface ClaimDetailView extends ClaimView {
  evidence: {
    available: boolean;
    url: string | null;
  };
  /** The photos taken at signup, which jurors compare with the claim's photos. */
  enrollment: {
    available: boolean;
    url: string | null;
  };
  /** Automatic IMEI comparisons; null when there was nothing to compare. */
  deviceCheck: {
    enrollmentImeiMatchesPolicy: boolean | null;
    claimImeiMatchesEnrollment: boolean | null;
  };
}

export interface EvidenceFileInfo {
  index: number;
  name: string;
  contentType: string;
  size: number;
}

export interface EvidenceFileAccess extends EvidenceFileInfo {
  url: string;
}

export type EvidenceKind = "claim" | "enrollment";

/** Device details. Enrollment has all of them; a claim may carry just the IMEI. */
export interface DeviceDetails {
  imei: string;
  serial?: string;
  make?: string;
  model?: string;
  color?: string;
}

/** A one-time code the user shows in the photos they are about to take. Unix seconds. */
export interface CaptureCode {
  code: string;
  issuedAt: number;
  expiresAt: number;
}

/** Stamped on a bundle by the backend: the code the photos should show, and when it was used. */
export interface CaptureStamp {
  code: string;
  issuedAt: number;
  receivedAt: number;
}

export interface EvidenceSummary {
  evidenceHash: string;
  kind: EvidenceKind;
  description: string;
  device: DeviceDetails | null;
  capture: CaptureStamp | null;
  size: number;
  files: EvidenceFileInfo[];
}

export interface EvidenceDetail extends Omit<EvidenceSummary, "files"> {
  rawUrl: string;
  files: EvidenceFileAccess[];
}

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
  /** Jurors' stakes, held by the pool but not part of `balance`. */
  totalStaked: string;
  totalJurorFees: string;
  totalPenalties: string;
  /** Claimants' bonds, held outside `balance` until their claims are decided. */
  totalBonded: string;
  totalBondsForfeited: string;
  /** A claim's bond is `claimBondBps` of the amount asked, but at least `minClaimBond`. */
  claimBondBps: number;
  minClaimBond: string;
}

/**
 * A claim's bond. Once the jury decides, `returned` went back to the claimant and `forfeited` (the
 * bond times the share of the ask the jury cut) joined the reserve; both are null until then.
 */
export interface ClaimBond {
  amount: string;
  returned: string | null;
  forfeited: string | null;
}

/** A member's jury duty: their stake, and whether it is enough to be picked. */
export interface MemberJuror {
  stake: string;
  minStake: string;
  /** Juries they sit on now; the stake cannot be withdrawn while above 0. */
  activeJuries: number;
  staked: boolean;
}

/** Where a member's monthly premiums stand. Times are unix seconds of chain time. */
export interface MemberPremium {
  /**
   * Paid: covered by a paid premium. Grace: the due date passed unpaid; still covered until
   * `graceEndsAt`. Overdue: the grace period ended and the policy no longer covers anything.
   * Lapsed: the policy is closed.
   */
  status: "Paid" | "Grace" | "Overdue" | "Lapsed";
  /** Premium for one period, in token base units. */
  amount: string;
  /** Length of one premium period, in seconds. */
  period: number;
  /** End of the paid coverage, which is also when the next premium is due. */
  paidThrough: number;
  /** When the next premium is due; null once it can no longer be paid. */
  dueAt: number | null;
  graceEndsAt: number;
  secondsUntilDue: number | null;
  /** Due within 7 days, or missed and in grace. */
  dueSoon: boolean;
  /** A payment would be accepted now (at most one period ahead). */
  canPay: boolean;
  asOf: number;
}

export interface MemberPolicy {
  id: string;
  deviceIdHash: string;
  /** Hash of the enrollment bundle: device details and the photos taken at signup. */
  enrollmentHash: string;
  coverageLimit: string;
  startTime: number;
  status: "Active" | "Lapsed";
  /** Covered right now: open, with premiums paid or in their grace period. */
  covered: boolean;
  premium: MemberPremium | null;
  claimEligibleAt: number;
  pastWaitingPeriod: boolean;
  openClaimId: string | null;
}

export interface MemberView {
  address: string;
  balance: string;
  contributed: string;
  juror: MemberJuror;
  policy: MemberPolicy | null;
}

export type ClaimState =
  | "Submitted"
  | "JuryPending"
  | "Voting"
  | "Approved"
  | "Rejected"
  | "Paid"
  | "Cancelled"
  /** The jury voted an amount; the claimant accepts it or withdraws before `offerDeadline`. */
  | "Offered"
  /** The claimant turned the jury's offer down. */
  | "Withdrawn"
  /** The offer was accepted but no receipt arrived within the receipt window, so nothing was paid. */
  | "Expired";

export interface ClaimJuror {
  address: string;
  committed: boolean;
  revealed: boolean;
  /** The amount this juror voted to pay once revealed, in token base units ("0" rejects); null while sealed. */
  amount: string | null;
  /** Hash of the juror's note once revealed, or null if sealed or no note. */
  noteHash: string | null;
  /** Once tallied: the fee paid to this juror for agreeing with the outcome, in base units. */
  reward: string | null;
  /** Once tallied: what was taken from their stake for not revealing, in base units. */
  penalty: string | null;
}

export interface ClaimJury {
  phase: "AwaitingRandomness" | "Voting" | "Tallied" | "Cancelled";
  commitDeadline: number | null;
  revealDeadline: number | null;
  revealOpen: boolean;
  commits: number;
  approvals: number;
  rejections: number;
  /** The most a juror may vote: the amount asked for, in base units. */
  maxAmount: string;
  /** Once tallied: the median juror amount, in base units. */
  award: string | null;
  /** The fee agreeing jurors share, before no-show penalties are added, in base units. */
  fee: string;
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
  /** While Offered: when the time to accept or withdraw ends. Silence then counts as accepting. */
  offerDeadline: number | null;
  paidAmount: string;
  payoutAmount: string;
  bond: ClaimBond;
  /**
   * The claim pays against a receipt for the repair or replacement: the smaller of the offer and the
   * receipt's total. `deadline` is set once the offer is accepted; `hash` and `amount` (base units) once
   * the claimant submits the receipt.
   */
  receipt: { deadline: number | null; hash: string | null; amount: string | null };
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
  /** Automatic comparisons; null when there was nothing to compare. */
  deviceCheck: {
    /** The enrolled IMEI (or make and serial) hashes to the policy's on-chain deviceIdHash. */
    enrollmentMatchesPolicy: boolean | null;
    /** The IMEI or serial given with the claim is the enrolled one. */
    claimMatchesEnrollment: boolean | null;
    /**
     * The claim was signed by the key made when signing up from the device. null when signup was not
     * done from the device (no key on record), which is normal for devices without a browser.
     */
    filedFromDevice: boolean | null;
    /** Signup included proof of purchase; null without signup details. */
    purchaseProof: boolean | null;
  };
  receiptFile: {
    available: boolean;
    url: string | null;
  };
  /** Checks on a submitted receipt; null when there is none or it is not stored. */
  receiptCheck: {
    /** The total in the uploaded receipt is the one submitted on-chain. */
    totalMatches: boolean | null;
    /** The invoice is dated on or after the day the claim was filed. */
    datedAfterClaim: boolean | null;
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

export type EvidenceKind = "claim" | "enrollment" | "receipt";

/** What a receipt says: the claim it is for, the shop, the total (base units) and the invoice date. */
export interface ReceiptDetails {
  claimId: string;
  shop: string;
  total: string;
  date: string;
}

export type DeviceType = "phone" | "tablet" | "laptop" | "camera" | "other";

/**
 * Device details. Enrollment has the type, serial, make, model and colour, plus the IMEI for a phone;
 * a claim may carry just the IMEI or serial, to be matched against the enrollment.
 */
export interface DeviceDetails {
  type?: DeviceType;
  imei?: string;
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
  /** Claims: why the claimant asked for this amount, or "". */
  amountReason: string;
  device: DeviceDetails | null;
  receipt?: ReceiptDetails | null;
  /** Enrollment: whether signup was done from the device (a device key was made), and proof-of-purchase file indexes. */
  deviceKey?: { kty: "EC"; crv: "P-256"; x: string; y: string } | null;
  purchaseProof?: number[];
  capture: CaptureStamp | null;
  size: number;
  files: EvidenceFileInfo[];
}

/** A revealed juror vote, shown to the claimant and the other jurors. */
export interface JuryVote {
  juror: string;
  /** Token base units; "0" means the juror voted to reject. */
  amount: string;
  /** The juror's reasoning, or null if they left none. */
  note: string | null;
}

export interface EvidenceDetail extends Omit<EvidenceSummary, "files"> {
  rawUrl: string;
  files: EvidenceFileAccess[];
}

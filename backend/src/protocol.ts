// Read-side views of on-chain state, shaped for the frontend. Amounts are returned as decimal
// strings in token base units (mUSDC has 6 decimals) so they survive JSON without losing precision.
import { CLAIM_STATES, JURY_PHASES, OUTCOMES, POLICY_STATUSES, type ClaimState } from "./abis";
import type { ProtocolContracts } from "./chain";

const ZERO_HASH = `0x${"0".repeat(64)}`;

export interface JurorView {
  address: string;
  /** Has submitted a sealed vote. */
  committed: boolean;
  /** Has opened it; only revealed votes count. */
  revealed: boolean;
  /** The amount this juror voted to pay, once revealed ("0" rejects); null while sealed. */
  amount: string | null;
  /** keccak256 of the juror's note once revealed, or null if sealed or the juror left no note. */
  noteHash: string | null;
}

/**
 * Why a tallied jury reached its outcome. Anything but "majorityApproved" rejects the claim:
 * a tie is not a majority, and fewer than `quorum` votes counts as no decision. A juror who votes
 * any amount above 0 counts as approving.
 */
export type OutcomeReason = "majorityApproved" | "majorityRejected" | "tie" | "noQuorum";

export interface JuryView {
  phase: (typeof JURY_PHASES)[number];
  /** Sealed votes are accepted until this time. */
  commitDeadline: number | null;
  /** Votes are revealed until this time; voting is over after it. */
  revealDeadline: number | null;
  /** Reveals are accepted now: the commit window ended or every juror committed. */
  revealOpen: boolean;
  commits: number;
  /** Revealed votes only, so both stay 0 while votes are sealed. */
  approvals: number;
  rejections: number;
  /** The most a juror may vote: the amount the claimant asked for. */
  maxAmount: string;
  /** Once tallied: the median juror amount, which becomes the offer (before the pool cap). */
  award: string | null;
  quorum: number;
  outcome: (typeof OUTCOMES)[number];
  outcomeReason: OutcomeReason | null;
  jurors: JurorView[];
  canTally: boolean;
  /** While waiting for randomness: when the claim may be cancelled if it still has not arrived. */
  cancelAvailableAt: number | null;
}

export interface ClaimView {
  id: string;
  claimant: string;
  policyId: string;
  amount: string;
  coverageLimit: string;
  evidenceHash: string;
  /** The enrollment bundle of the policy the claim was filed on: the device as it was at signup. */
  enrollmentHash: string | null;
  state: ClaimState;
  submittedAt: number;
  /** While Offered: when the claimant's time to accept or withdraw ends; silence then accepts. */
  offerDeadline: number | null;
  paidAmount: string;
  /**
   * Fixed when the jury decides: min(jury's median amount, coverage limit, 20% pool cap at that
   * moment). Before that it is what a full approval would fix right now; "0" for Rejected,
   * Cancelled and Withdrawn claims.
   */
  payoutAmount: string;
  jury: JuryView | null;
}

export interface ClaimFilter {
  claimant?: string;
  juror?: string;
  state?: ClaimState;
  evidenceHash?: string;
}

export async function claimCount(c: ProtocolContracts): Promise<number> {
  return Number(await c.claimManager.claimCount());
}

export async function getClaimView(c: ProtocolContracts, claimId: number): Promise<ClaimView | null> {
  const claim = await c.claimManager.getClaim(claimId);
  const state = CLAIM_STATES[Number(claim.state)];
  if (state === "None") return null;

  const [jury, payoutAmount, policy] = await Promise.all([
    getJuryView(c, claimId),
    c.claimManager.payoutAmount(claimId),
    c.registry.getPolicy(claim.claimant),
  ]);
  // A claim keeps its policy open, so the holder's current policy is the claim's unless it has since
  // been closed and replaced; then the original enrollment is no longer on-chain.
  const enrollmentHash = policy.id === claim.policyId && policy.enrollmentHash !== ZERO_HASH ? policy.enrollmentHash : null;
  return {
    id: claim.id.toString(),
    claimant: claim.claimant,
    policyId: claim.policyId.toString(),
    amount: claim.amount.toString(),
    coverageLimit: claim.coverageLimit.toString(),
    evidenceHash: claim.evidenceHash,
    enrollmentHash,
    state,
    submittedAt: Number(claim.submittedAt),
    offerDeadline: state === "Offered" ? Number(claim.offerDeadline) : null,
    paidAmount: claim.paidAmount.toString(),
    payoutAmount: state === "Rejected" || state === "Cancelled" || state === "Withdrawn" ? "0" : payoutAmount.toString(),
    jury,
  };
}

async function getJuryView(c: ProtocolContracts, claimId: number): Promise<JuryView | null> {
  const [phase, , commitDeadline, revealDeadline, commits, approvals, rejections, outcome, jurors] =
    await c.jury.getJury(claimId);
  if (JURY_PHASES[Number(phase)] === "None") return null;

  const addresses = [...(jurors as string[])];
  const [committed, revealed, amounts, noteHashes, canTally, revealOpen, quorum, cancelAt, [award, maxAmount]] = await Promise.all([
    Promise.all(addresses.map(async (a) => (await c.jury.commitmentOf(claimId, a)) !== ZERO_HASH)),
    Promise.all(addresses.map((a) => c.jury.hasRevealed(claimId, a) as Promise<boolean>)),
    Promise.all(addresses.map((a) => c.jury.amountOf(claimId, a) as Promise<bigint>)),
    Promise.all(addresses.map((a) => c.jury.noteHashOf(claimId, a) as Promise<string>)),
    c.jury.canTally(claimId) as Promise<boolean>,
    c.jury.revealOpen(claimId) as Promise<boolean>,
    c.jury.quorum(),
    c.jury.cancelAvailableAt(claimId),
    c.jury.getAward(claimId) as Promise<[bigint, bigint]>,
  ]);
  const yes = Number(approvals);
  const no = Number(rejections);
  const tallied = JURY_PHASES[Number(phase)] === "Tallied";
  return {
    phase: JURY_PHASES[Number(phase)],
    commitDeadline: Number(commitDeadline) || null,
    revealDeadline: Number(revealDeadline) || null,
    revealOpen,
    commits: Number(commits),
    approvals: yes,
    rejections: no,
    maxAmount: maxAmount.toString(),
    award: tallied ? award.toString() : null,
    quorum: Number(quorum),
    outcome: OUTCOMES[Number(outcome)],
    outcomeReason: tallied ? outcomeReason(yes, no, Number(quorum)) : null,
    jurors: addresses.map((address, i) => ({
      address,
      committed: committed[i],
      revealed: revealed[i],
      amount: revealed[i] ? amounts[i].toString() : null,
      noteHash: revealed[i] && noteHashes[i] !== ZERO_HASH ? noteHashes[i] : null,
    })),
    canTally,
    cancelAvailableAt: Number(cancelAt) || null,
  };
}

/**
 * Mirrors JuryModule.tally: approved only with quorum and a median amount above 0, which is the same
 * as strictly more jurors voting to pay than to reject.
 */
export function outcomeReason(approvals: number, rejections: number, quorum: number): OutcomeReason {
  if (approvals + rejections < quorum) return "noQuorum";
  if (approvals === rejections) return "tie";
  return approvals > rejections ? "majorityApproved" : "majorityRejected";
}

/** All claims matching `filter`, newest first. Scans every claim, which is fine for a demo pool. */
export async function listClaims(c: ProtocolContracts, filter: ClaimFilter = {}): Promise<ClaimView[]> {
  const count = await claimCount(c);
  const ids = Array.from({ length: count }, (_, i) => count - i);
  const views = await Promise.all(ids.map((id) => getClaimView(c, id)));
  const claimant = filter.claimant?.toLowerCase();
  const juror = filter.juror?.toLowerCase();
  return views.filter(
    (v): v is ClaimView =>
      v !== null &&
      (!claimant || v.claimant.toLowerCase() === claimant) &&
      (!juror || (v.jury?.jurors.some((j) => j.address.toLowerCase() === juror) ?? false)) &&
      (!filter.state || v.state === filter.state) &&
      (!filter.evidenceHash || v.evidenceHash.toLowerCase() === filter.evidenceHash.toLowerCase()),
  );
}

export async function getPoolView(c: ProtocolContracts) {
  const [balance, maxPayout, maxPayoutBps, totalContributed, totalPaidOut, policyCount, holderCount, claims] =
    await Promise.all([
      c.pool.balance(),
      c.pool.maxPayout(),
      c.pool.maxPayoutBps(),
      c.pool.totalContributed(),
      c.pool.totalPaidOut(),
      c.registry.policyCount(),
      c.registry.holderCount(),
      c.claimManager.claimCount(),
    ]);
  return {
    balance: balance.toString(),
    maxPayout: maxPayout.toString(),
    maxPayoutBps: Number(maxPayoutBps),
    totalContributed: totalContributed.toString(),
    totalPaidOut: totalPaidOut.toString(),
    policyCount: Number(policyCount),
    holderCount: Number(holderCount),
    claimCount: Number(claims),
  };
}

export async function getMemberView(c: ProtocolContracts, address: string) {
  const [policy, pastWaitingPeriod, waitingPeriod, balance, contributed] = await Promise.all([
    c.registry.getPolicy(address),
    c.registry.isPastWaitingPeriod(address),
    c.registry.waitingPeriod(),
    c.token.balanceOf(address),
    c.pool.contributionsOf(address),
  ]);
  const status = POLICY_STATUSES[Number(policy.status)];
  const openClaimId = status === "None" ? 0n : await c.claimManager.openClaimOfPolicy(policy.id);
  return {
    address,
    balance: balance.toString(),
    contributed: contributed.toString(),
    policy:
      status === "None"
        ? null
        : {
            id: policy.id.toString(),
            deviceIdHash: policy.deviceIdHash,
            enrollmentHash: policy.enrollmentHash,
            coverageLimit: policy.coverageLimit.toString(),
            startTime: Number(policy.startTime),
            status,
            claimEligibleAt: Number(policy.startTime + waitingPeriod),
            pastWaitingPeriod: pastWaitingPeriod as boolean,
            openClaimId: openClaimId === 0n ? null : openClaimId.toString(),
          },
  };
}

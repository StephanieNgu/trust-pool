// Read-side views of on-chain state, shaped for the frontend. Amounts are returned as decimal
// strings in token base units (mUSDC has 6 decimals) so they survive JSON without losing precision.
import { CLAIM_STATES, JURY_PHASES, OUTCOMES, POLICY_STATUSES, type ClaimState } from "./abis";
import type { ProtocolContracts } from "./chain";

export interface JurorView {
  address: string;
  hasVoted: boolean;
}

/**
 * Why a tallied jury reached its outcome. Anything but "majorityApproved" rejects the claim:
 * a tie is not a majority, and fewer than `quorum` votes counts as no decision.
 */
export type OutcomeReason = "majorityApproved" | "majorityRejected" | "tie" | "noQuorum";

export interface JuryView {
  phase: (typeof JURY_PHASES)[number];
  votingDeadline: number | null;
  approvals: number;
  rejections: number;
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
  state: ClaimState;
  submittedAt: number;
  paidAmount: string;
  /**
   * Fixed when the jury approves: min(amount, coverage limit, 20% pool cap at that moment). Before
   * approval it is what approval would fix right now; "0" for Rejected and Cancelled claims.
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

  const [jury, payoutAmount] = await Promise.all([getJuryView(c, claimId), c.claimManager.payoutAmount(claimId)]);
  return {
    id: claim.id.toString(),
    claimant: claim.claimant,
    policyId: claim.policyId.toString(),
    amount: claim.amount.toString(),
    coverageLimit: claim.coverageLimit.toString(),
    evidenceHash: claim.evidenceHash,
    state,
    submittedAt: Number(claim.submittedAt),
    paidAmount: claim.paidAmount.toString(),
    payoutAmount: state === "Rejected" || state === "Cancelled" ? "0" : payoutAmount.toString(),
    jury,
  };
}

async function getJuryView(c: ProtocolContracts, claimId: number): Promise<JuryView | null> {
  const [phase, , votingDeadline, approvals, rejections, outcome, jurors] = await c.jury.getJury(claimId);
  if (JURY_PHASES[Number(phase)] === "None") return null;

  const addresses = [...(jurors as string[])];
  const [voted, canTally, quorum, cancelAt] = await Promise.all([
    Promise.all(addresses.map((a) => c.jury.hasVoted(claimId, a) as Promise<boolean>)),
    c.jury.canTally(claimId) as Promise<boolean>,
    c.jury.quorum(),
    c.jury.cancelAvailableAt(claimId),
  ]);
  const yes = Number(approvals);
  const no = Number(rejections);
  const tallied = JURY_PHASES[Number(phase)] === "Tallied";
  return {
    phase: JURY_PHASES[Number(phase)],
    votingDeadline: Number(votingDeadline) || null,
    approvals: yes,
    rejections: no,
    quorum: Number(quorum),
    outcome: OUTCOMES[Number(outcome)],
    outcomeReason: tallied ? outcomeReason(yes, no, Number(quorum)) : null,
    jurors: addresses.map((address, i) => ({ address, hasVoted: voted[i] })),
    canTally,
    cancelAvailableAt: Number(cancelAt) || null,
  };
}

/** Mirrors JuryModule.tally: approved only with quorum and strictly more approvals than rejections. */
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
            coverageLimit: policy.coverageLimit.toString(),
            startTime: Number(policy.startTime),
            status,
            claimEligibleAt: Number(policy.startTime + waitingPeriod),
            pastWaitingPeriod: pastWaitingPeriod as boolean,
            openClaimId: openClaimId === 0n ? null : openClaimId.toString(),
          },
  };
}

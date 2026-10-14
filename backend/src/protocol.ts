// Read-side views of on-chain state, shaped for the frontend. Amounts are returned as decimal
// strings in token base units (mUSDC has 6 decimals) so they survive JSON without losing precision.
import { CLAIM_STATES, JURY_PHASES, OUTCOMES, POLICY_STATUSES, type ClaimState } from "./abis";
import type { ProtocolContracts } from "./chain";

export interface JurorView {
  address: string;
  hasVoted: boolean;
}

export interface JuryView {
  phase: (typeof JURY_PHASES)[number];
  votingDeadline: number | null;
  approvals: number;
  rejections: number;
  outcome: (typeof OUTCOMES)[number];
  jurors: JurorView[];
  canTally: boolean;
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
  /** Amount paid once Paid; before that, what executePayout would pay right now (min of amount, coverage limit, pool cap). */
  payoutAmount: string;
  jury: JuryView | null;
}

export interface ClaimFilter {
  claimant?: string;
  juror?: string;
  state?: ClaimState;
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
    payoutAmount: state === "Paid" || state === "Rejected" ? claim.paidAmount.toString() : payoutAmount.toString(),
    jury,
  };
}

async function getJuryView(c: ProtocolContracts, claimId: number): Promise<JuryView | null> {
  const [phase, , votingDeadline, approvals, rejections, outcome, jurors] = await c.jury.getJury(claimId);
  if (JURY_PHASES[Number(phase)] === "None") return null;

  const addresses = [...(jurors as string[])];
  const [voted, canTally] = await Promise.all([
    Promise.all(addresses.map((a) => c.jury.hasVoted(claimId, a) as Promise<boolean>)),
    c.jury.canTally(claimId) as Promise<boolean>,
  ]);
  return {
    phase: JURY_PHASES[Number(phase)],
    votingDeadline: Number(votingDeadline) || null,
    approvals: Number(approvals),
    rejections: Number(rejections),
    outcome: OUTCOMES[Number(outcome)],
    jurors: addresses.map((address, i) => ({ address, hasVoted: voted[i] })),
    canTally,
  };
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
      (!filter.state || v.state === filter.state),
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

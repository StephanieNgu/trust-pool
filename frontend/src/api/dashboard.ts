import { formatUnits, getAddress } from "ethers";
import { apiRequest } from "./client";
import type { ApiConfig, ApiHealth, MemberPremium, MemberView, PoolView } from "./types";

/** The member's premium schedule, with the amount formatted in whole tokens. */
export interface PremiumOverview {
  status: MemberPremium["status"];
  amount: string;
  /** Length of one premium period, in days. */
  periodDays: number;
  dueAt: number | null;
  paidThrough: number;
  graceEndsAt: number;
  dueSoon: boolean;
  canPay: boolean;
}

export interface DashboardOverview {
  balance: string;
  contributed: string;
  pool: string;
  cap: string;
  totalContributed: string;
  totalPaidOut: string;
  maxPayoutBps: number;
  policyCount: number;
  holderCount: number;
  claimCount: number;
  /** Jury duty: this wallet's stake, the minimum to be picked, and juries it sits on now. */
  jurorStake: string;
  minJurorStake: string;
  activeJuries: number;
  jurorStaked: boolean;
  /** Other members who could be picked for a jury on this wallet's claim, and the jury size. */
  jurorsAvailable: number;
  jurySize: number;
  totalStaked: string;
  totalJurorFees: string;
  /** A claim's bond: `claimBondBps` of the amount asked, but at least `minClaimBond`. */
  claimBondBps: number;
  minClaimBond: string;
  coverage: string;
  /** The policy is open and covered: premiums paid, or missed but still in their grace period. */
  active: boolean;
  /** The policy is still open on-chain but its premium grace period ended unpaid. */
  overdue: boolean;
  /** Null without a policy. */
  premium: PremiumOverview | null;
  policyId: string;
  startTime: number;
  waitingPeriod: number;
  maxCoverage: string;
  tokenSymbol: string;
  tokenDecimals: number;
  claimEligibleAt: number | null;
  pastWaitingPeriod: boolean;
  openClaimId: string | null;
  backendBlock: number;
  keeperRunning: boolean;
  keeperLastTickAt: number | null;
  keeperLastError: string | null;
  keeperAutoResolve: boolean;
}

export function getHealth(): Promise<ApiHealth> {
  return apiRequest<ApiHealth>("/api/health");
}

export function getProtocolConfig(): Promise<ApiConfig> {
  return apiRequest<ApiConfig>("/api/config");
}

export function getPool(): Promise<PoolView> {
  return apiRequest<PoolView>("/api/pool");
}

export function getMember(address: string): Promise<MemberView> {
  return apiRequest<MemberView>(`/api/members/${getAddress(address)}`);
}

export async function getDashboardOverview(address: string): Promise<DashboardOverview> {
  const [health, config, pool, member] = await Promise.all([
    getHealth(),
    getProtocolConfig(),
    getPool(),
    getMember(address),
  ]);
  if (!health.ok) throw new Error("The TrustPool backend is not healthy.");
  if (health.chainId !== config.chainId) throw new Error("The backend configuration does not match its connected chain.");

  const decimals = config.token.decimals;
  const policy = member.policy;
  const maxCoverage = config.params.maxCoverageLimit;
  if (!maxCoverage) throw new Error("The backend did not return the maximum coverage limit.");

  return {
    balance: formatUnits(member.balance, decimals),
    contributed: formatUnits(member.contributed, decimals),
    pool: formatUnits(pool.balance, decimals),
    cap: formatUnits(pool.maxPayout, decimals),
    totalContributed: formatUnits(pool.totalContributed, decimals),
    totalPaidOut: formatUnits(pool.totalPaidOut, decimals),
    maxPayoutBps: pool.maxPayoutBps,
    policyCount: pool.policyCount,
    holderCount: pool.holderCount,
    claimCount: pool.claimCount,
    jurorStake: formatUnits(member.juror.stake, decimals),
    minJurorStake: formatUnits(member.juror.minStake, decimals),
    activeJuries: member.juror.activeJuries,
    jurorStaked: member.juror.staked,
    jurorsAvailable: member.jury.available,
    jurySize: member.jury.required,
    totalStaked: formatUnits(pool.totalStaked, decimals),
    totalJurorFees: formatUnits(pool.totalJurorFees, decimals),
    claimBondBps: pool.claimBondBps,
    minClaimBond: formatUnits(pool.minClaimBond, decimals),
    coverage: formatUnits(policy?.coverageLimit ?? "0", decimals),
    active: policy?.status === "Active" && policy.covered,
    overdue: policy?.status === "Active" && !policy.covered,
    premium: policy?.premium
      ? {
          status: policy.premium.status,
          amount: formatUnits(policy.premium.amount, decimals),
          periodDays: Math.round(policy.premium.period / 86_400),
          dueAt: policy.premium.dueAt,
          paidThrough: policy.premium.paidThrough,
          graceEndsAt: policy.premium.graceEndsAt,
          dueSoon: policy.premium.dueSoon,
          canPay: policy.premium.canPay,
        }
      : null,
    policyId: policy?.id ?? "0",
    startTime: policy?.startTime ?? 0,
    waitingPeriod: policy ? Math.max(0, policy.claimEligibleAt - policy.startTime) : 0,
    maxCoverage: formatUnits(maxCoverage, decimals),
    tokenSymbol: config.token.symbol,
    tokenDecimals: decimals,
    claimEligibleAt: policy?.claimEligibleAt ?? null,
    pastWaitingPeriod: policy?.pastWaitingPeriod ?? false,
    openClaimId: policy?.openClaimId ?? null,
    backendBlock: health.blockNumber,
    keeperRunning: health.keeper?.running ?? false,
    keeperLastTickAt: health.keeper?.lastTickAt ?? null,
    keeperLastError: health.keeper?.lastError ?? null,
    keeperAutoResolve: health.keeper?.autoResolve ?? false,
  };
}

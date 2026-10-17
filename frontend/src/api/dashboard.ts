import { formatUnits, getAddress } from "ethers";
import { apiRequest } from "./client";
import type { ApiConfig, ApiHealth, MemberView, PoolView } from "./types";

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
  coverage: string;
  active: boolean;
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
    coverage: formatUnits(policy?.coverageLimit ?? "0", decimals),
    active: policy?.status === "Active",
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

import { formatUnits, getAddress } from "ethers";
import { apiRequest } from "./client";
import type { ApiConfig, ApiHealth, MemberView, PoolView } from "./types";

export interface DashboardOverview {
  balance: string;
  pool: string;
  cap: string;
  coverage: string;
  active: boolean;
  policyId: string;
  startTime: number;
  waitingPeriod: number;
  maxCoverage: string;
  tokenSymbol: string;
  backendBlock: number;
  keeperRunning: boolean;
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
    pool: formatUnits(pool.balance, decimals),
    cap: formatUnits(pool.maxPayout, decimals),
    coverage: formatUnits(policy?.coverageLimit ?? "0", decimals),
    active: policy?.status === "Active",
    policyId: policy?.id ?? "0",
    startTime: policy?.startTime ?? 0,
    waitingPeriod: policy ? Math.max(0, policy.claimEligibleAt - policy.startTime) : 0,
    maxCoverage: formatUnits(maxCoverage, decimals),
    tokenSymbol: config.token.symbol,
    backendBlock: health.blockNumber,
    keeperRunning: health.keeper?.running ?? false,
  };
}

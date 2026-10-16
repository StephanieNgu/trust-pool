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

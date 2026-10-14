// Human-readable ABI fragments for the parts of each contract the backend uses.
// backend/test/abis.test.ts checks every fragment against the compiled Hardhat artifacts,
// so a contract change that breaks one of these fails the tests instead of failing at runtime.

export const tokenAbi = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
] as const;

export const poolAbi = [
  "function balance() view returns (uint256)",
  "function maxPayout() view returns (uint256)",
  "function maxPayoutBps() view returns (uint256)",
  "function totalContributed() view returns (uint256)",
  "function totalPaidOut() view returns (uint256)",
  "function contributionsOf(address account) view returns (uint256)",
] as const;

export const registryAbi = [
  "function getPolicy(address holder) view returns (tuple(uint256 id, address holder, bytes32 deviceIdHash, uint256 coverageLimit, uint256 startTime, uint8 status))",
  "function isPastWaitingPeriod(address holder) view returns (bool)",
  "function premiumFor(uint256 coverageLimit) view returns (uint256)",
  "function waitingPeriod() view returns (uint256)",
  "function premiumBps() view returns (uint256)",
  "function maxCoverageLimit() view returns (uint256)",
  "function policyCount() view returns (uint256)",
  "function holderCount() view returns (uint256)",
] as const;

export const claimManagerAbi = [
  "function claimCount() view returns (uint256)",
  "function getClaim(uint256 claimId) view returns (tuple(uint256 id, address claimant, uint256 policyId, uint256 amount, uint256 coverageLimit, bytes32 evidenceHash, uint8 state, uint256 submittedAt, uint256 paidAmount))",
  "function payoutAmount(uint256 claimId) view returns (uint256)",
  "function openClaimOfPolicy(uint256 policyId) view returns (uint256)",
  "function finalize(uint256 claimId)",
  "function executePayout(uint256 claimId)",
  "error WrongState(uint8 expected, uint8 actual)",
  "error NothingToPay()",
] as const;

export const juryAbi = [
  "function getJury(uint256 claimId) view returns (uint8 phase, address claimant, uint64 votingDeadline, uint8 approvals, uint8 rejections, uint8 outcome, address[] jurors)",
  "function hasVoted(uint256 claimId, address juror) view returns (bool)",
  "function canTally(uint256 claimId) view returns (bool)",
  "function jurySize() view returns (uint8)",
  "function quorum() view returns (uint8)",
  "function votingPeriod() view returns (uint256)",
  "error VotingStillOpen()",
] as const;

export const randomnessAbi = [
  "function owner() view returns (address)",
  "function pendingRequester(uint256 claimId) view returns (address)",
  "function fulfill(uint256 claimId, uint256 seed)",
  "error NoPendingRequest()",
] as const;

/** Mirrors of the Solidity enums, indexed by their numeric value. */
export const CLAIM_STATES = ["None", "Submitted", "JuryPending", "Voting", "Approved", "Rejected", "Paid"] as const;
export const JURY_PHASES = ["None", "AwaitingRandomness", "Voting", "Tallied"] as const;
export const OUTCOMES = ["None", "Approved", "Rejected"] as const;
export const POLICY_STATUSES = ["None", "Active", "Lapsed"] as const;

export type ClaimState = (typeof CLAIM_STATES)[number];

/** Compiled artifact name for each ABI above, used by the consistency test. */
export const ARTIFACT_NAMES = {
  token: "MockStablecoin",
  pool: "Pool",
  registry: "PolicyRegistry",
  claimManager: "ClaimManager",
  jury: "JuryModule",
  randomness: "MockRandomness",
} as const;

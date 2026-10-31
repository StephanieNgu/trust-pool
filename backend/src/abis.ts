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
  "function stakeOf(address juror) view returns (uint256)",
  "function activeJuriesOf(address juror) view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function totalJurorFees() view returns (uint256)",
  "function totalPenalties() view returns (uint256)",
  "function totalBonded() view returns (uint256)",
  "function totalBondsForfeited() view returns (uint256)",
] as const;

export const registryAbi = [
  "function isActive(address holder) view returns (bool)",
  "function getPolicy(address holder) view returns (tuple(uint256 id, address holder, bytes32 deviceIdHash, uint256 coverageLimit, uint256 startTime, uint8 status, bytes32 enrollmentHash))",
  "function isPastWaitingPeriod(address holder) view returns (bool)",
  "function premiumFor(uint256 coverageLimit) view returns (uint256)",
  "function waitingPeriod() view returns (uint256)",
  "function premiumBps() view returns (uint256)",
  "function maxCoverageLimit() view returns (uint256)",
  "function policyCount() view returns (uint256)",
  "function holderCount() view returns (uint256)",
  "function premiumPeriod() view returns (uint256)",
  "function gracePeriod() view returns (uint256)",
  "function paidThrough(address holder) view returns (uint256)",
  "function premiumStatus(address holder) view returns (uint8 state, uint256 paidUntil, uint256 graceEndsAt, uint256 amount)",
  "function isOverdue(address holder) view returns (bool)",
  "function overdueHolders() view returns (address[])",
  "function lapseOverdue(address holder)",
  "error NotOverdue()",
  "error OpenClaimExists(uint256 claimId)",
] as const;

export const claimManagerAbi = [
  "function claimCount() view returns (uint256)",
  "function getClaim(uint256 claimId) view returns (tuple(uint256 id, address claimant, uint256 policyId, uint256 amount, uint256 coverageLimit, bytes32 evidenceHash, uint8 state, uint256 submittedAt, uint256 paidAmount, uint256 approvedAmount, uint256 offerDeadline, uint256 bond, uint256 bondForfeited, uint256 receiptDeadline, bytes32 receiptHash, uint256 receiptAmount))",
  "function payoutAmount(uint256 claimId) view returns (uint256)",
  "function openClaimOfPolicy(uint256 policyId) view returns (uint256)",
  "function finalize(uint256 claimId)",
  "function executePayout(uint256 claimId)",
  "function cancelStalledClaim(uint256 claimId)",
  "function acceptOffer(uint256 claimId)",
  "function withdrawClaim(uint256 claimId)",
  "function expireClaim(uint256 claimId)",
  "function receiptPeriod() view returns (uint256)",
  "function responsePeriod() view returns (uint256)",
  "function bondBps() view returns (uint256)",
  "function minBond() view returns (uint256)",
  "function bondFor(uint256 amount) view returns (uint256)",
  "error WrongState(uint8 expected, uint8 actual)",
  "error NothingToPay()",
] as const;

export const juryAbi = [
  "function getJury(uint256 claimId) view returns (uint8 phase, address claimant, uint64 commitDeadline, uint64 revealDeadline, uint8 commits, uint8 approvals, uint8 rejections, uint8 outcome, address[] jurors)",
  "function commitmentOf(uint256 claimId, address juror) view returns (bytes32)",
  "function hasRevealed(uint256 claimId, address juror) view returns (bool)",
  "function revealOpen(uint256 claimId) view returns (bool)",
  "function computeCommitment(uint256 claimId, address juror, uint256 amount, bytes32 noteHash, bytes32 salt) pure returns (bytes32)",
  "function amountOf(uint256 claimId, address juror) view returns (uint256)",
  "function noteHashOf(uint256 claimId, address juror) view returns (bytes32)",
  "function getAward(uint256 claimId) view returns (uint256 award, uint256 maxAmount)",
  "function rewardOf(uint256 claimId, address juror) view returns (uint256)",
  "function penaltyOf(uint256 claimId, address juror) view returns (uint256)",
  "function feeFor(uint256 claimId) view returns (uint256)",
  "function minStake() view returns (uint256)",
  "function noShowPenalty() view returns (uint256)",
  "function agreementBandBps() view returns (uint256)",
  "function canTally(uint256 claimId) view returns (bool)",
  "function canCancel(uint256 claimId) view returns (bool)",
  "function cancelAvailableAt(uint256 claimId) view returns (uint256)",
  "function randomnessTimeout() view returns (uint256)",
  "function jurySize() view returns (uint8)",
  "function eligibleJurors(address claimant) view returns (address[])",
  "function quorum() view returns (uint8)",
  "function commitPeriod() view returns (uint256)",
  "function revealPeriod() view returns (uint256)",
  "error VotingStillOpen()",
] as const;

export const randomnessAbi = [
  "function owner() view returns (address)",
  "function pendingRequester(uint256 claimId) view returns (address)",
  "function fulfill(uint256 claimId, uint256 seed)",
  "error NoPendingRequest()",
] as const;

/** Mirrors of the Solidity enums, indexed by their numeric value. */
export const CLAIM_STATES = ["None", "Submitted", "JuryPending", "Voting", "Approved", "Rejected", "Paid", "Cancelled", "Offered", "Withdrawn", "Expired"] as const;
export const JURY_PHASES = ["None", "AwaitingRandomness", "Voting", "Tallied", "Cancelled"] as const;
export const OUTCOMES = ["None", "Approved", "Rejected"] as const;
export const POLICY_STATUSES = ["None", "Active", "Lapsed"] as const;
/** PolicyRegistry.PremiumState: Paid, Grace (missed, still covered), Overdue (grace over), Lapsed. */
export const PREMIUM_STATES = ["None", "Paid", "Grace", "Overdue", "Lapsed"] as const;

export type PremiumState = Exclude<(typeof PREMIUM_STATES)[number], "None">;

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

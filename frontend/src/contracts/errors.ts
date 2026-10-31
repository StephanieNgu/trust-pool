import { Interface, formatUnits } from "ethers";

/**
 * Every custom error the protocol contracts (and the ERC-20 token) can revert with. The contract
 * ABIs the pages use list only their functions, so without this a revert reads "unknown custom error".
 */
const PROTOCOL_ERRORS = new Interface([
  // ClaimManager
  "error ExceedsCoverageLimit(uint256 amount, uint256 limit)",
  "error InvalidAmount()",
  "error InvalidEvidence()",
  "error NoActivePolicy()",
  "error NotClaimant()",
  "error NothingToPay()",
  "error OpenClaimExists(uint256 claimId)",
  "error ReceiptAlreadySubmitted()",
  "error ReceiptRequired()",
  "error ReceiptWindowClosed(uint256 deadline)",
  "error ReceiptWindowOpen(uint256 deadline)",
  "error ResponseWindowClosed(uint256 deadline)",
  "error ResponseWindowOpen(uint256 deadline)",
  "error WaitingPeriodNotElapsed()",
  "error WrongState(uint8 expected, uint8 actual)",
  // JuryModule
  "error AlreadyCommitted()",
  "error AlreadyRevealed()",
  "error AmountTooHigh(uint256 amount, uint256 maxAmount)",
  "error CommitClosed()",
  "error CommitmentMismatch()",
  "error EmptyCommitment()",
  "error NotAJuror()",
  "error NotCommitted()",
  "error NotEnoughEligibleJurors(uint256 available, uint256 required)",
  "error RandomnessNotTimedOut()",
  "error RevealClosed()",
  "error RevealNotOpen()",
  "error VotingStillOpen()",
  "error WrongPhase(uint8 expected, uint8 actual)",
  // Pool
  "error InsufficientPoolBalance(uint256 amount, uint256 balance)",
  "error InsufficientStake(uint256 amount, uint256 staked)",
  "error StakeLocked(uint256 activeJuries)",
  "error ZeroAmount()",
  // PolicyRegistry
  "error AlreadyHasActivePolicy()",
  "error DeviceAlreadyCovered()",
  "error InvalidCoverage()",
  "error InvalidDevice()",
  "error InvalidEnrollment()",
  "error NotOverdue()",
  "error PaidTooFarAhead(uint256 paidThrough)",
  "error PolicyOverdue()",
  // OpenZeppelin ERC-20
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
]);

const TOKEN_DECIMALS = 6;
const amount = (value: unknown) => `${Number(formatUnits(value as bigint, TOKEN_DECIMALS)).toLocaleString("en-US", { maximumFractionDigits: 2 })} mUSDC`;
const date = (value: unknown) => new Date(Number(value) * 1000).toLocaleString();

const MESSAGES: Record<string, (args: readonly unknown[]) => string> = {
  ExceedsCoverageLimit: ([asked, limit]) => `You asked for ${amount(asked)}, more than your coverage of ${amount(limit)}.`,
  InvalidAmount: () => "Enter an amount above zero.",
  InvalidEvidence: () => "The evidence upload is missing. Upload your photos again.",
  NoActivePolicy: () => "This wallet has no active coverage.",
  NotClaimant: () => "Only the member who filed this claim can do that.",
  NothingToPay: () => "There is nothing to pay on this claim.",
  OpenClaimExists: ([claimId]) => `Claim #${String(claimId)} is still open on this policy. Wait until it is decided.`,
  ReceiptAlreadySubmitted: () => "A receipt was already submitted for this claim.",
  ReceiptRequired: () => "The claimant has to submit a receipt before this claim can be paid.",
  ReceiptWindowClosed: ([deadline]) => `The time to submit a receipt ended on ${date(deadline)}.`,
  ReceiptWindowOpen: ([deadline]) => `The claimant can still submit a receipt until ${date(deadline)}.`,
  ResponseWindowClosed: ([deadline]) => `The time to answer this offer ended on ${date(deadline)}.`,
  ResponseWindowOpen: ([deadline]) => `The claimant can still answer this offer until ${date(deadline)}.`,
  WaitingPeriodNotElapsed: () => "Your coverage is still in its waiting period, so you can't file a claim yet.",
  WrongState: () => "This claim has already moved on. Refresh to see where it stands.",
  AlreadyCommitted: () => "You have already sealed your vote on this claim.",
  AlreadyRevealed: () => "You have already revealed your vote on this claim.",
  AmountTooHigh: ([, max]) => `A vote can't be more than the ${amount(max)} asked for.`,
  CommitClosed: () => "Voting has closed on this claim.",
  CommitmentMismatch: () => "That amount and note don't match the vote you sealed. Enter exactly what you sealed.",
  EmptyCommitment: () => "The sealed vote was empty. Try again.",
  NotAJuror: () => "This wallet is not on the jury for this claim.",
  NotCommitted: () => "You didn't seal a vote on this claim, so there is nothing to reveal.",
  NotEnoughEligibleJurors: ([available, required]) =>
    `A jury needs ${String(required)} other members with active coverage and a juror stake, and only ${String(available)} are available right now. Try again once more members have joined juries.`,
  RandomnessNotTimedOut: () => "Jury selection is still within its time limit, so the claim can't be cancelled yet.",
  RevealClosed: () => "The reveal window has closed on this claim.",
  RevealNotOpen: () => "Reveals open once every juror has voted or the voting deadline passes.",
  VotingStillOpen: () => "Voting is still open on this claim.",
  WrongPhase: () => "The jury has already moved on. Refresh to see where it stands.",
  InsufficientPoolBalance: ([needed, balance]) => `The pool holds ${amount(balance)}, less than the ${amount(needed)} needed. It can be paid once more funds arrive.`,
  InsufficientStake: ([requested, staked]) => `You have ${amount(staked)} staked, less than the ${amount(requested)} requested.`,
  StakeLocked: ([juries]) => `Your stake is locked while you sit on ${String(juries)} ${Number(juries) === 1 ? "jury" : "juries"}.`,
  ZeroAmount: () => "Enter an amount above zero.",
  AlreadyHasActivePolicy: () => "This wallet already has active coverage.",
  DeviceAlreadyCovered: () => "This device is already covered by another policy.",
  InvalidCoverage: () => "Choose a coverage amount above zero and within the maximum.",
  InvalidDevice: () => "Enter the device's IMEI or serial number.",
  InvalidEnrollment: () => "The signup photos are missing. Upload them again.",
  NotOverdue: () => "This policy's premium is not overdue.",
  PaidTooFarAhead: ([paidThrough]) => `Premiums are already paid through ${date(paidThrough)}. You can pay one period ahead at most.`,
  PolicyOverdue: () => "Your premium is overdue and the grace period has ended, so this coverage has stopped.",
  ERC20InsufficientBalance: ([, balance, needed]) => `Your wallet holds ${amount(balance)}, less than the ${amount(needed)} needed.`,
  ERC20InsufficientAllowance: () => "The token approval was too low. Try again and approve the full amount.",
};

/** Finds revert data in the shapes ethers and wallets wrap it in. */
function revertData(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== "object" || depth > 4) return null;
  const record = error as Record<string, unknown>;
  const data = record.data;
  if (typeof data === "string" && /^0x[0-9a-fA-F]{8}/.test(data)) return data;
  if (data && typeof data === "object") {
    const nested = revertData(data, depth + 1);
    if (nested) return nested;
  }
  for (const key of ["error", "info", "cause"]) {
    const nested = revertData(record[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** A plain sentence for a protocol revert, or null when the error is not one. */
export function contractErrorMessage(error: unknown): string | null {
  const data = revertData(error);
  if (!data) return null;
  try {
    const parsed = PROTOCOL_ERRORS.parseError(data);
    if (!parsed) return null;
    const describe = MESSAGES[parsed.name];
    return describe ? describe(parsed.args) : null;
  } catch {
    return null;
  }
}

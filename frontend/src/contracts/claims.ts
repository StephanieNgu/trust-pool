import { Contract, parseUnits } from "ethers";
import { getBrowserProvider } from "../wallet";
import { loadContracts } from "./contracts";

const CLAIM_MANAGER_ABI = [
  "function submitClaim(uint256 amount, bytes32 evidenceHash) returns (uint256 claimId)",
  "function finalize(uint256 claimId)",
  "function executePayout(uint256 claimId)",
  "function cancelStalledClaim(uint256 claimId)",
  "function acceptOffer(uint256 claimId)",
  "function withdrawClaim(uint256 claimId)",
  "function bondFor(uint256 amount) view returns (uint256)",
  "function submitReceipt(uint256 claimId, bytes32 receiptHash, uint256 amount)",
  "function expireClaim(uint256 claimId)",
] as const;

function claimNumber(claimId: string): bigint {
  if (!/^\d+$/.test(claimId) || claimId === "0") throw new Error("Claim id must be a positive integer.");
  return BigInt(claimId);
}

async function claimManagerFor(account: string) {
  const provider = getBrowserProvider();
  if ((await provider.getNetwork()).chainId !== 31337n) throw new Error("Switch to Hardhat Local (31337) to continue.");
  const { deployment } = await loadContracts(provider);
  if (await provider.getCode(deployment.addresses.claimManager) === "0x") {
    throw new Error("ClaimManager is unavailable. Deploy the contracts and refresh.");
  }
  return new Contract(deployment.addresses.claimManager, CLAIM_MANAGER_ABI, await provider.getSigner(account));
}

async function runResolution(
  account: string,
  claimId: string,
  method: "finalize" | "executePayout" | "cancelStalledClaim" | "acceptOffer" | "withdrawClaim" | "expireClaim",
  pendingMessage: string,
  progress: (message: string) => void,
): Promise<string> {
  const manager = await claimManagerFor(account);
  progress(pendingMessage);
  const transaction = await manager[method](claimNumber(claimId));
  progress("Waiting for the transaction to confirm…");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The transaction did not succeed.");
  return transaction.hash as string;
}

export function finalizeClaim(account: string, claimId: string, progress: (message: string) => void) {
  return runResolution(account, claimId, "finalize", "Confirm finalizing the jury result in your wallet.", progress);
}

export function executeClaimPayout(account: string, claimId: string, progress: (message: string) => void) {
  return runResolution(account, claimId, "executePayout", "Confirm executing the approved payout in your wallet.", progress);
}

export function cancelStalledClaim(account: string, claimId: string, progress: (message: string) => void) {
  return runResolution(account, claimId, "cancelStalledClaim", "Confirm cancelling the stalled jury request in your wallet.", progress);
}

/** Take the jury's offer. The payout follows automatically. */
export function acceptOffer(account: string, claimId: string, progress: (message: string) => void) {
  return runResolution(account, claimId, "acceptOffer", "Confirm accepting the jury's offer in your wallet.", progress);
}

/** Close an accepted claim whose receipt window passed without a receipt. Nothing is paid. */
export function expireClaim(account: string, claimId: string, progress: (message: string) => void) {
  return runResolution(account, claimId, "expireClaim", "Confirm closing the claim in your wallet.", progress);
}

/**
 * Records the receipt on-chain: its bundle hash (from uploadReceipt) and total in base units. The claim
 * then pays the smaller of the offer and the total; the keeper sends it.
 */
export async function submitReceipt(
  account: string,
  claimId: string,
  receiptHash: string,
  total: bigint,
  progress: (message: string) => void,
): Promise<string> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(receiptHash)) throw new Error("The backend returned an invalid receipt hash.");
  if (total <= 0n) throw new Error("Enter the receipt's total.");
  const manager = await claimManagerFor(account);
  progress("Confirm the receipt in your wallet.");
  const transaction = await manager.submitReceipt(claimNumber(claimId), receiptHash, total);
  progress("Waiting for the transaction to confirm…");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The transaction did not succeed.");
  return transaction.hash as string;
}

/** Turn the jury's offer down. Nothing is paid and the claim closes. */
export function withdrawClaim(account: string, claimId: string, progress: (message: string) => void) {
  return runResolution(account, claimId, "withdrawClaim", "Confirm withdrawing your claim in your wallet.", progress);
}

export async function submitClaim(
  account: string,
  amount: string,
  decimals: number,
  evidenceHash: string,
  progress: (message: string) => void,
): Promise<string> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(evidenceHash)) throw new Error("The backend returned an invalid evidence hash.");
  const units = parseUnits(amount, decimals);
  if (units <= 0n) throw new Error("Enter a claim amount greater than zero.");

  const provider = getBrowserProvider();
  if ((await provider.getNetwork()).chainId !== 31337n) throw new Error("Switch to Hardhat Local (31337) to continue.");
  const signer = await provider.getSigner(account);
  const { deployment, token } = await loadContracts(signer);
  if (await provider.getCode(deployment.addresses.claimManager) === "0x") {
    throw new Error("ClaimManager is unavailable. Deploy the contracts and refresh.");
  }
  const claimManager = new Contract(deployment.addresses.claimManager, CLAIM_MANAGER_ABI, signer);

  // The bond is held by the pool until the jury decides, so the pool must be allowed to take it.
  const bond: bigint = await claimManager.bondFor(units);
  if (await token.balanceOf(account) < bond) throw new Error("Your wallet does not have enough mUSDC for the claim bond.");
  if (bond > 0n && await token.allowance(account, deployment.addresses.pool) < bond) {
    progress("Approve the mUSDC claim bond in your wallet.");
    const approval = await token.approve(deployment.addresses.pool, bond);
    progress("Waiting for the token approval to confirm…");
    const approvalReceipt = await approval.wait();
    if (!approvalReceipt || approvalReceipt.status !== 1) throw new Error("The token approval did not succeed.");
  }

  progress("Confirm your claim in MetaMask.");
  const transaction = await claimManager.submitClaim(units, evidenceHash);
  progress("Your claim transaction is confirming…");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The claim transaction did not succeed.");
  return transaction.hash as string;
}

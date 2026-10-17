import { Contract, parseUnits } from "ethers";
import { getBrowserProvider } from "../wallet";
import { loadLocalDeployment } from "./deployments";

const CLAIM_MANAGER_ABI = [
  "function submitClaim(uint256 amount, bytes32 evidenceHash) returns (uint256 claimId)",
  "function finalize(uint256 claimId)",
  "function executePayout(uint256 claimId)",
  "function cancelStalledClaim(uint256 claimId)",
] as const;

function claimNumber(claimId: string): bigint {
  if (!/^\d+$/.test(claimId) || claimId === "0") throw new Error("Claim id must be a positive integer.");
  return BigInt(claimId);
}

async function claimManagerFor(account: string) {
  const provider = getBrowserProvider();
  if ((await provider.getNetwork()).chainId !== 31337n) throw new Error("Switch to Hardhat Local (31337) to continue.");
  const deployment = await loadLocalDeployment();
  if (await provider.getCode(deployment.addresses.claimManager) === "0x") {
    throw new Error("ClaimManager is unavailable. Deploy the contracts and refresh.");
  }
  return new Contract(deployment.addresses.claimManager, CLAIM_MANAGER_ABI, await provider.getSigner(account));
}

async function runResolution(
  account: string,
  claimId: string,
  method: "finalize" | "executePayout" | "cancelStalledClaim",
  pendingMessage: string,
  progress: (message: string) => void,
): Promise<string> {
  const manager = await claimManagerFor(account);
  progress(pendingMessage);
  const transaction = await manager[method](claimNumber(claimId));
  progress("Waiting for the recovery transaction to confirm…");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The recovery transaction did not succeed.");
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
  const deployment = await loadLocalDeployment();
  if (await provider.getCode(deployment.addresses.claimManager) === "0x") {
    throw new Error("ClaimManager is unavailable. Deploy the contracts and refresh.");
  }

  const signer = await provider.getSigner(account);
  const claimManager = new Contract(deployment.addresses.claimManager, CLAIM_MANAGER_ABI, signer);
  progress("Confirm your claim in MetaMask.");
  const transaction = await claimManager.submitClaim(units, evidenceHash);
  progress("Your claim transaction is confirming…");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The claim transaction did not succeed.");
  return transaction.hash as string;
}

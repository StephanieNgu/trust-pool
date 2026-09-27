import { formatUnits, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import { getBrowserProvider } from "../wallet";
import { loadContracts } from "./contracts";

export interface Overview {
  balance: string; pool: string; cap: string; coverage: string; active: boolean;
  policyId: string; startTime: number; waitingPeriod: number; maxCoverage: string;
}

async function session(account: string, write = false) {
  const provider = getBrowserProvider();
  if ((await provider.getNetwork()).chainId !== 31337n) throw new Error("Switch to Hardhat Local (31337) to continue.");
  const signer = await provider.getSigner(account);
  const contracts = await loadContracts(write ? signer : provider);
  for (const address of [contracts.deployment.addresses.token, contracts.deployment.addresses.pool, contracts.deployment.addresses.registry]) {
    if (await provider.getCode(address) === "0x") throw new Error("Local contracts are unavailable. Deploy the contracts and refresh.");
  }
  return contracts;
}

export async function readOverview(account: string): Promise<Overview> {
  const { token, pool, registry } = await session(account);
  const [balance, pooled, cap, policy, waiting, max] = await Promise.all([
    token.balanceOf(account), pool.balance(), pool.maxPayout(), registry.getPolicy(account), registry.waitingPeriod(), registry.maxCoverageLimit()
  ]);
  return { balance: formatUnits(balance, 6), pool: formatUnits(pooled, 6), cap: formatUnits(cap, 6), coverage: formatUnits(policy.coverageLimit, 6), active: Number(policy.status) === 1, policyId: String(policy.id), startTime: Number(policy.startTime), waitingPeriod: Number(waiting), maxCoverage: formatUnits(max, 6) };
}

export async function quoteCoverage(account: string, amount: string) {
  const { registry } = await session(account);
  const units = parseUnits(amount, 6);
  if (units <= 0n || units > await registry.maxCoverageLimit()) throw new Error("Enter a coverage amount within the available limit.");
  const premium: bigint = await registry.premiumFor(units);
  if (premium === 0n) throw new Error("The coverage amount is too small.");
  return formatUnits(premium, 6);
}

export async function purchaseCoverage(account: string, device: string, amount: string, quote: string, progress: (message: string) => void) {
  const { token, registry, deployment } = await session(account, true);
  const units = parseUnits(amount, 6);
  const premium: bigint = await registry.premiumFor(units);
  if (premium !== parseUnits(quote, 6)) throw new Error("The premium has changed. Please review a new quote.");
  if (await token.balanceOf(account) < premium) throw new Error("Insufficient mUSDC. Fund this local test wallet before continuing.");
  if (await token.allowance(account, deployment.addresses.pool) < premium) {
    progress("Approve the mUSDC payment in MetaMask.");
    const approval = await token.approve(deployment.addresses.pool, premium);
    progress("Waiting for payment approval to confirm…");
    await approval.wait();
  }
  progress("Confirm your device coverage in MetaMask.");
  const transaction = await registry.buyPolicy(keccak256(toUtf8Bytes(device.trim())), units);
  progress("Your coverage transaction is confirming…");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The coverage transaction did not succeed.");
  return transaction.hash as string;
}

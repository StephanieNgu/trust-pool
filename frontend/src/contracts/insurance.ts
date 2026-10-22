import { ZeroHash, formatUnits, isHexString, parseUnits } from "ethers";
import { deviceIdHash, validateDeviceDetails, type DeviceDetails } from "../api";
import { getBrowserProvider } from "../wallet";
import { loadContracts } from "./contracts";

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

export async function quoteCoverage(account: string, amount: string) {
  const { registry } = await session(account);
  const units = parseUnits(amount, 6);
  if (units <= 0n || units > await registry.maxCoverageLimit()) throw new Error("Enter a coverage amount within the available limit.");
  const premium: bigint = await registry.premiumFor(units);
  if (premium === 0n) throw new Error("The coverage amount is too small.");
  return formatUnits(premium, 6);
}

/**
 * Buys a policy for the enrolled device. `enrollmentHash` is the hash enrollDevice returned for the
 * signup photos; only hashes go on-chain, never the IMEI or serial number itself.
 */
export async function purchaseCoverage(account: string, device: DeviceDetails, amount: string, quote: string, enrollmentHash: string, progress: (message: string) => void) {
  if (!isHexString(enrollmentHash, 32) || enrollmentHash === ZeroHash) throw new Error("Upload the device photos before buying coverage.");
  const deviceHash = deviceIdHash(validateDeviceDetails(device));
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
  const transaction = await registry.buyPolicy(deviceHash, units, enrollmentHash);
  progress("Your coverage transaction is confirming…");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The coverage transaction did not succeed.");
  return transaction.hash as string;
}

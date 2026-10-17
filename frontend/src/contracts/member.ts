import { parseUnits } from "ethers";
import { getBrowserProvider } from "../wallet";
import { loadContracts } from "./contracts";

async function session(account: string) {
  const provider = getBrowserProvider();
  if ((await provider.getNetwork()).chainId !== 31337n) {
    throw new Error("Switch to Hardhat Local (31337) to continue.");
  }
  const signer = await provider.getSigner(account);
  const contracts = await loadContracts(signer);
  for (const address of [contracts.deployment.addresses.token, contracts.deployment.addresses.pool, contracts.deployment.addresses.registry]) {
    if (await provider.getCode(address) === "0x") {
      throw new Error("Local contracts are unavailable. Deploy the contracts and refresh.");
    }
  }
  return contracts;
}

export async function contributeToPool(
  account: string,
  amount: string,
  tokenDecimals: number,
  progress: (message: string) => void,
): Promise<string> {
  const { token, pool, deployment } = await session(account);
  let units: bigint;
  try {
    units = parseUnits(amount, tokenDecimals);
  } catch {
    throw new Error(`Enter a valid amount with no more than ${tokenDecimals} decimal places.`);
  }
  if (units <= 0n) throw new Error("Enter a contribution greater than zero.");
  if (await token.balanceOf(account) < units) throw new Error("Your wallet does not have enough mUSDC for this contribution.");

  if (await token.allowance(account, deployment.addresses.pool) < units) {
    progress("Approve the mUSDC contribution in your wallet.");
    const approval = await token.approve(deployment.addresses.pool, units);
    progress("Waiting for the token approval to confirm…");
    const approvalReceipt = await approval.wait();
    if (!approvalReceipt || approvalReceipt.status !== 1) throw new Error("The token approval did not succeed.");
  }

  progress("Confirm the pool contribution in your wallet.");
  const transaction = await pool.contribute(units);
  progress("Your contribution is confirming on-chain…");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The pool contribution did not succeed.");
  return transaction.hash as string;
}

export async function cancelCoverage(
  account: string,
  progress: (message: string) => void,
): Promise<string> {
  const { registry } = await session(account);
  if (!(await registry.isActive(account))) throw new Error("This wallet does not have active coverage to cancel.");
  progress("Confirm the coverage cancellation in your wallet.");
  const transaction = await registry.cancelPolicy();
  progress("Your cancellation is confirming on-chain…");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The coverage cancellation did not succeed.");
  return transaction.hash as string;
}

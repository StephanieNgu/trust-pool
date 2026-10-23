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

/** Locks `amount` as a juror stake, approving the pool first if needed. */
export async function stakeAsJuror(
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
  if (units <= 0n) throw new Error("Enter a stake greater than zero.");
  if (await token.balanceOf(account) < units) throw new Error("Your wallet does not have enough mUSDC for this stake.");

  if (await token.allowance(account, deployment.addresses.pool) < units) {
    progress("Approve the mUSDC stake in your wallet.");
    const approval = await token.approve(deployment.addresses.pool, units);
    progress("Waiting for the token approval to confirm…");
    const approvalReceipt = await approval.wait();
    if (!approvalReceipt || approvalReceipt.status !== 1) throw new Error("The token approval did not succeed.");
  }

  progress("Confirm the juror stake in your wallet.");
  const transaction = await pool.stake(units);
  progress("Your stake is confirming on-chain…");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The stake did not succeed.");
  return transaction.hash as string;
}

/** Withdraws the whole juror stake. The pool refuses while the wallet sits on a jury. */
export async function withdrawJurorStake(account: string, progress: (message: string) => void): Promise<string> {
  const { pool } = await session(account);
  const staked: bigint = await pool.stakeOf(account);
  if (staked === 0n) throw new Error("This wallet has no juror stake to withdraw.");
  if (await pool.activeJuriesOf(account) > 0n) throw new Error("You are on a jury right now. Withdraw once its vote has closed.");
  progress("Confirm withdrawing your juror stake in your wallet.");
  const transaction = await pool.unstake(staked);
  progress("Your withdrawal is confirming on-chain…");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The withdrawal did not succeed.");
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

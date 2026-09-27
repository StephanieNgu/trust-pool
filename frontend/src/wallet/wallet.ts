import { BrowserProvider } from "ethers";
import type { InjectedEthereumProvider } from "./ethereum";

export const HARDHAT_LOCAL_CHAIN_ID = "0x7a69";

export interface WalletSnapshot {
  account: string | null;
  chainId: string | null;
}

export function getInjectedProvider(): InjectedEthereumProvider | null {
  return window.ethereum ?? null;
}

export async function readWalletSnapshot(): Promise<WalletSnapshot> {
  const ethereum = getInjectedProvider();

  if (!ethereum) {
    return { account: null, chainId: null };
  }

  const [accounts, chainId] = await Promise.all([
    ethereum.request({ method: "eth_accounts" }) as Promise<string[]>,
    ethereum.request({ method: "eth_chainId" }) as Promise<string>
  ]);

  return {
    account: accounts[0] ?? null,
    chainId
  };
}

export async function connectInjectedWallet(): Promise<WalletSnapshot> {
  const ethereum = getInjectedProvider();

  if (!ethereum) {
    throw new Error("MetaMask is not installed or available in this browser.");
  }

  const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as string[];
  const chainId = (await ethereum.request({ method: "eth_chainId" })) as string;

  return {
    account: accounts[0] ?? null,
    chainId
  };
}

export function getBrowserProvider(): BrowserProvider {
  const ethereum = getInjectedProvider();

  if (!ethereum) {
    throw new Error("MetaMask is not installed or available in this browser.");
  }

  return new BrowserProvider(ethereum);
}

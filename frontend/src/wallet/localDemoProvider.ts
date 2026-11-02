import { getAddress } from "ethers";
import type { InjectedEthereumProvider } from "./ethereum";

const HARDHAT_RPC_URL = "http://127.0.0.1:8545";
const SELECTED_ACCOUNT_KEY = "trustpool:demo-account";
const HARDHAT_DEMO_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
] as const;

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface LocalDemoProvider extends InjectedEthereumProvider {
  isTrustPoolDemo: true;
  demoAccounts: readonly { id: string; label: string; address: string }[];
  selectDemoAccount(address: string): void;
}

export function createLocalDemoProvider(): LocalDemoProvider {
  const demoAccounts = HARDHAT_DEMO_ADDRESSES.map((address, index) => ({
    id: String(index),
    label: index === 0 ? "Claimant · Account 0" : `Juror ${index} · Account ${index}`,
    address,
  }));
  const remembered = localStorage.getItem(SELECTED_ACCOUNT_KEY);
  let selectedIndex = Math.max(0, demoAccounts.findIndex((account) => account.address.toLowerCase() === remembered?.toLowerCase()));
  let requestId = 0;
  const accountListeners = new Set<(accounts: string[]) => void>();

  const selectedAccount = () => demoAccounts[selectedIndex];

  return {
    isTrustPoolDemo: true,
    demoAccounts,
    selectDemoAccount(address: string) {
      const nextIndex = demoAccounts.findIndex((account) => account.address === getAddress(address));
      if (nextIndex < 0 || nextIndex === selectedIndex) return;
      selectedIndex = nextIndex;
      localStorage.setItem(SELECTED_ACCOUNT_KEY, demoAccounts[nextIndex].address);
      for (const listener of accountListeners) listener([demoAccounts[nextIndex].address]);
    },
    on(event, listener) {
      if (event === "accountsChanged") accountListeners.add(listener as (accounts: string[]) => void);
    },
    removeListener(event, listener) {
      if (event === "accountsChanged") accountListeners.delete(listener as (accounts: string[]) => void);
    },
    async request({ method, params }) {
      const account = selectedAccount();
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
      if (method === "eth_chainId") return "0x7a69";

      const response = await fetch(HARDHAT_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params: params ?? [] }),
      });
      const payload = await response.json() as JsonRpcResponse;
      if (payload.error) {
        const error = new Error(payload.error.message ?? `Hardhat RPC request ${method} failed.`) as Error & { code?: number; data?: unknown };
        error.code = payload.error.code;
        error.data = payload.error.data;
        throw error;
      }
      return payload.result;
    },
  };
}


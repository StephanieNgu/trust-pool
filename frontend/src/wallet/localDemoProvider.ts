import { getAddress, getBytes, HDNodeWallet, isHexString } from "ethers";
import type { InjectedEthereumProvider } from "./ethereum";

const HARDHAT_RPC_URL = "http://127.0.0.1:8545";
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
const SELECTED_ACCOUNT_KEY = "trustpool:demo-account";

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
  const wallets = Array.from({ length: 6 }, (_, index) =>
    HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`),
  );
  const demoAccounts = wallets.map((wallet, index) => ({
    id: String(index),
    label: index === 0 ? "Claimant · Account 0" : `Juror ${index} · Account ${index}`,
    address: wallet.address,
  }));
  const remembered = localStorage.getItem(SELECTED_ACCOUNT_KEY);
  let selectedIndex = Math.max(0, demoAccounts.findIndex((account) => account.address.toLowerCase() === remembered?.toLowerCase()));
  let requestId = 0;
  const accountListeners = new Set<(accounts: string[]) => void>();

  const selectedWallet = () => wallets[selectedIndex];

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
      const wallet = selectedWallet();
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [wallet.address];
      if (method === "eth_chainId") return "0x7a69";
      if (method === "personal_sign") {
        const values = Array.isArray(params) ? params : [];
        const message = String(values.find((value) => typeof value === "string" && value.toLowerCase() !== wallet.address.toLowerCase()) ?? "");
        return wallet.signMessage(isHexString(message) ? getBytes(message) : message);
      }

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


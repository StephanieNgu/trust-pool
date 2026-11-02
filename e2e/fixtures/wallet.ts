import { expect, test as base, type Page } from "@playwright/test";

export { expect };

export const HARDHAT_ACCOUNTS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
  "0xBcd4042DE499D14e55001CcbB24a551F3b954096",
  "0x71bE63f3384f5fb98995898A86B02Fb2426c5788",
] as const;

interface WalletController {
  selectAccount(index: number): void;
  setChainId(chainId: string): void;
  rejectNext(method: string): void;
  reset(): void;
}

declare global {
  interface Window {
    __trustPoolE2EWallet: WalletController;
  }
}

async function installWallet(page: Page) {
  await page.addInitScript(
    ({ accounts, defaultChainId, rpcUrl }) => {
      const storedIndex = Number(sessionStorage.getItem("trustpool:e2e-account"));
      let selectedIndex = Number.isInteger(storedIndex) && storedIndex >= 0 && storedIndex < accounts.length ? storedIndex : 0;
      let chainId = sessionStorage.getItem("trustpool:e2e-chain") ?? defaultChainId;
      let connected = sessionStorage.getItem("trustpool:e2e-connected") === "1";
      const rejected = new Set<string>();
      const listeners = new Map<string, Set<(value: unknown) => void>>();

      const emit = (event: string, value: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(value);
      };

      window.ethereum = {
        isMetaMask: true,
        on(event, listener) {
          const eventListeners = listeners.get(event) ?? new Set();
          eventListeners.add(listener as (value: unknown) => void);
          listeners.set(event, eventListeners);
        },
        removeListener(event, listener) {
          listeners.get(event)?.delete(listener as (value: unknown) => void);
        },
        async request({ method, params }) {
          if (rejected.delete(method)) {
            const error = new Error(`User rejected ${method}.`) as Error & { code: number };
            error.code = 4001;
            throw error;
          }
          if (method === "eth_accounts") return connected ? [accounts[selectedIndex]] : [];
          if (method === "eth_requestAccounts") {
            connected = true;
            sessionStorage.setItem("trustpool:e2e-connected", "1");
            emit("accountsChanged", [accounts[selectedIndex]]);
            return [accounts[selectedIndex]];
          }
          if (method === "eth_chainId") return chainId;

          const response = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? [] }),
          });
          const payload = await response.json() as {
            result?: unknown;
            error?: { code?: number; message?: string; data?: unknown };
          };
          if (payload.error) {
            const error = new Error(payload.error.message ?? `${method} failed.`) as Error & { code?: number; data?: unknown };
            error.code = payload.error.code;
            error.data = payload.error.data;
            throw error;
          }
          return payload.result;
        },
      };

      window.__trustPoolE2EWallet = {
        selectAccount(index) {
          if (!Number.isInteger(index) || index < 0 || index >= accounts.length) throw new Error(`Unknown account index ${index}.`);
          selectedIndex = index;
          sessionStorage.setItem("trustpool:e2e-account", String(index));
          if (connected) emit("accountsChanged", [accounts[selectedIndex]]);
        },
        setChainId(nextChainId) {
          chainId = nextChainId;
          sessionStorage.setItem("trustpool:e2e-chain", chainId);
          emit("chainChanged", chainId);
        },
        rejectNext(method) {
          rejected.add(method);
        },
        reset() {
          selectedIndex = 0;
          chainId = defaultChainId;
          connected = false;
          rejected.clear();
          sessionStorage.removeItem("trustpool:e2e-account");
          sessionStorage.removeItem("trustpool:e2e-chain");
          sessionStorage.removeItem("trustpool:e2e-connected");
          emit("accountsChanged", []);
          emit("chainChanged", chainId);
        },
      };
    },
    { accounts: HARDHAT_ACCOUNTS, defaultChainId: "0x7a69", rpcUrl: "http://127.0.0.1:28545" },
  );
}

export interface E2EWallet {
  readonly accounts: typeof HARDHAT_ACCOUNTS;
  selectAccount(index: number): Promise<void>;
  setChainId(chainId: string): Promise<void>;
  rejectNext(method: string): Promise<void>;
  reset(): Promise<void>;
}

export const test = base.extend<{ wallet: E2EWallet }>({
  wallet: async ({ page }, use) => {
    await installWallet(page);
    await use({
      accounts: HARDHAT_ACCOUNTS,
      selectAccount: (index) => page.evaluate((value) => window.__trustPoolE2EWallet.selectAccount(value), index),
      setChainId: (chainId) => page.evaluate((value) => window.__trustPoolE2EWallet.setChainId(value), chainId),
      rejectNext: (method) => page.evaluate((value) => window.__trustPoolE2EWallet.rejectNext(value), method),
      reset: () => page.evaluate(() => window.__trustPoolE2EWallet.reset()),
    });
  },
});

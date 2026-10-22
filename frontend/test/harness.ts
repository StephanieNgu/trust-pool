// Runs the real frontend modules (frontend/src/api and frontend/src/contracts) under Node against the
// same stack the app talks to in development: an in-process Hardhat chain with the contracts deployed
// and the Express backend. Only the browser is faked, with the smallest surface the modules touch:
//
//   window.ethereum   an EIP-1193 wallet backed by Hardhat's unlocked dev accounts (like MetaMask)
//   fetch             relative URLs go to the backend; /deployments/localhost.json is served from the
//                     test deployment, as the Vite plugin does
//   window, sessionStorage, localStorage, FileReader
//
// Nothing in the code under test is mocked, so a change on either side of the frontend/backend or
// frontend/contract boundary fails these tests the way it would fail in the browser.
import hre from "hardhat";
import { setup } from "../../backend/test/helpers";

export { PHOTO, USDC, ethers, increaseTime, signerFor, testDevice, testImei } from "../../backend/test/helpers";

export type Stack = Awaited<ReturnType<typeof setup>>;

class MemoryStorage {
  private readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  clear() {
    this.items.clear();
  }
}

/** Just enough of FileReader for readAsDataURL, which the evidence upload uses. */
class TestFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob) {
    blob.arrayBuffer().then(
      (bytes) => {
        this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(bytes).toString("base64")}`;
        this.onload?.();
      },
      () => this.onerror?.(),
    );
  }
}

interface BrowserState {
  stack: Stack | null;
  /** Serve /deployments/localhost.json; false makes it 404 like a missing local deployment. */
  deploymentAvailable: boolean;
  /** Report this chain id from the wallet instead of Hardhat's, to simulate a wrong network. */
  walletChainId: string | null;
}

export const browser: BrowserState = { stack: null, deploymentAvailable: true, walletChainId: null };

const ethereum = {
  isMetaMask: true,
  async request({ method, params }: { method: string; params?: unknown[] | Record<string, unknown> }) {
    if (method === "eth_chainId" && browser.walletChainId) return browser.walletChainId;
    // Hardhat has no account-permission prompt; every dev account is already "connected".
    const rpcMethod = method === "eth_requestAccounts" ? "eth_accounts" : method;
    return hre.network.provider.request({ method: rpcMethod, params: (params as unknown[] | undefined) ?? [] });
  },
};

const nodeFetch = globalThis.fetch;

function installBrowserGlobals() {
  const globals = globalThis as Record<string, unknown>;
  if (globals.window) return;
  globals.window = {
    ethereum,
    location: { search: "" },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    btoa: globalThis.btoa.bind(globalThis),
    atob: globalThis.atob.bind(globalThis),
  };
  globals.sessionStorage = new MemoryStorage();
  globals.localStorage = new MemoryStorage();
  globals.FileReader = TestFileReader;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("/")) return nodeFetch(input, init);
    const stack = browser.stack;
    if (!stack) throw new Error("No test stack is running; call startStack() first.");
    if (url.split("?")[0] === "/deployments/localhost.json") {
      if (!browser.deploymentAvailable) return Response.json({ error: "not found" }, { status: 404 });
      // `npm run deploy:local` writes network "localhost"; the frontend refuses anything else.
      return Response.json({ ...stack.deployment, network: "localhost" });
    }
    return nodeFetch(stack.baseUrl + url, init);
  };
}

/** Deploys the protocol, starts the backend and points the fake browser at both. */
export async function startStack(...args: Parameters<typeof setup>): Promise<Stack> {
  installBrowserGlobals();
  const stack = await setup(...args);
  browser.stack = stack;
  browser.deploymentAvailable = true;
  browser.walletChainId = null;
  sessionStorage.clear();
  localStorage.clear();
  return stack;
}

export async function stopStack(stack: Stack) {
  if (browser.stack === stack) browser.stack = null;
  await stack.close();
}

/** Collects the progress messages a workflow reports to the UI. */
export function progressLog() {
  const messages: string[] = [];
  return { messages, report: (message: string) => void messages.push(message) };
}

/** A File as the browser's file picker would hand it to the upload form. */
export function pickedFile(name: string, type: string, contents: string | Uint8Array<ArrayBuffer>) {
  return new File([contents], name, { type });
}
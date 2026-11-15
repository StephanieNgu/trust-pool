import type { BrowserProvider } from "ethers";

/**
 * The backend serves the deployment it is connected to, so one frontend build works against the
 * local Hardhat chain in development and against Sepolia when hosted.
 */
const DEPLOYMENT_URL = "/api/config";

export interface DeploymentAddresses {
  token: string;
  pool: string;
  registry: string;
  randomness: string;
  jury: string;
  claimManager: string;
}

export interface Deployment {
  network: string;
  chainId: string;
  addresses: DeploymentAddresses;
  params: Record<string, string>;
}

/** @deprecated Kept for older imports; every deployment now has this shape. */
export type LocalDeployment = Deployment;

/** Networks the app knows how to name and switch MetaMask to. */
const KNOWN_NETWORKS: Record<string, { label: string; local: boolean }> = {
  "31337": { label: "Hardhat Local", local: true },
  "1337": { label: "Local chain", local: true },
  "11155111": { label: "Sepolia", local: false },
};

export function networkLabel(chainId: string | null | undefined): string {
  if (!chainId) return "Unknown network";
  return KNOWN_NETWORKS[chainId]?.label ?? `Chain ${chainId}`;
}

export function isLocalChain(chainId: string | null | undefined): boolean {
  return Boolean(chainId && KNOWN_NETWORKS[chainId]?.local);
}

/** "11155111" -> "0xaa36a7", the form MetaMask reports in eth_chainId. */
export function chainIdHex(chainId: string): string {
  return `0x${BigInt(chainId).toString(16)}`;
}

/** The error shown when the wallet is on another chain than the deployment. */
export function wrongNetworkMessage(chainId: string): string {
  return `Switch to ${networkLabel(chainId)} (${chainId}) to continue.`;
}

function isDeployment(value: unknown): value is Deployment {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Deployment>;
  return (
    typeof candidate.chainId === "string" &&
    /^\d+$/.test(candidate.chainId) &&
    Boolean(candidate.addresses?.token) &&
    Boolean(candidate.addresses?.pool) &&
    Boolean(candidate.addresses?.registry)
  );
}

export async function loadDeployment(): Promise<Deployment> {
  let response: Response;
  try {
    response = await fetch(DEPLOYMENT_URL, { cache: "no-store", headers: { Accept: "application/json" } });
  } catch {
    throw new Error("Contract addresses are unavailable: the TrustPool backend cannot be reached.");
  }
  if (!response.ok) {
    throw new Error(
      "Contract addresses are unavailable. Start the backend against a deployment (npm run deploy:local, then npm run dev:backend).",
    );
  }
  const deployment: unknown = await response.json();
  if (!isDeployment(deployment)) throw new Error("The backend returned a deployment in an unexpected format.");
  return deployment;
}

/** @deprecated Use loadDeployment. */
export const loadLocalDeployment = loadDeployment;

/** Loads the deployment and checks the wallet is on its chain, so no transaction goes to the wrong one. */
export async function deploymentFor(provider: BrowserProvider): Promise<Deployment> {
  const [deployment, network] = await Promise.all([loadDeployment(), provider.getNetwork()]);
  if (network.chainId.toString() !== deployment.chainId) throw new Error(wrongNetworkMessage(deployment.chainId));
  return deployment;
}

import { readFile } from "node:fs/promises";
import { Contract, type ContractRunner } from "ethers";
import { claimManagerAbi, juryAbi, poolAbi, randomnessAbi, registryAbi, tokenAbi } from "./abis";

export interface DeploymentAddresses {
  token: string;
  pool: string;
  registry: string;
  randomness: string;
  jury: string;
  claimManager: string;
}

/** Shape of deployments/<network>.json as written by scripts/deploy.js. */
export interface Deployment {
  network: string;
  chainId: string;
  deployer: string;
  /** "mock" (MockRandomness) or "vrf" (Chainlink VRF); absent in files written before VRF support. */
  randomnessProvider?: "mock" | "vrf";
  addresses: DeploymentAddresses;
  params: Record<string, string>;
}

export interface ProtocolContracts {
  token: Contract;
  pool: Contract;
  registry: Contract;
  claimManager: Contract;
  jury: Contract;
  randomness: Contract;
}

const ADDRESS_KEYS: (keyof DeploymentAddresses)[] = ["token", "pool", "registry", "randomness", "jury", "claimManager"];

export async function loadDeployment(file: string): Promise<Deployment> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`${file} was not found. Start a chain (npm run chain) and deploy (npm run deploy:local) first.`);
  }
  const parsed = JSON.parse(raw) as Partial<Deployment>;
  const missing = ADDRESS_KEYS.filter((k) => !parsed.addresses?.[k]);
  if (!parsed.chainId || missing.length > 0) {
    throw new Error(`${file} is not a valid deployment file (missing: ${["chainId", ...missing].join(", ")}).`);
  }
  return parsed as Deployment;
}

export function connectContracts(addresses: DeploymentAddresses, runner: ContractRunner): ProtocolContracts {
  return {
    token: new Contract(addresses.token, tokenAbi, runner),
    pool: new Contract(addresses.pool, poolAbi, runner),
    registry: new Contract(addresses.registry, registryAbi, runner),
    claimManager: new Contract(addresses.claimManager, claimManagerAbi, runner),
    jury: new Contract(addresses.jury, juryAbi, runner),
    randomness: new Contract(addresses.randomness, randomnessAbi, runner),
  };
}

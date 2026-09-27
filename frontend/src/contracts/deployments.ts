const LOCAL_DEPLOYMENT_URL = "/deployments/localhost.json";

export interface DeploymentAddresses {
  token: string;
  pool: string;
  registry: string;
  randomness: string;
  jury: string;
  claimManager: string;
}

export interface LocalDeployment {
  network: string;
  chainId: string;
  deployer: string;
  addresses: DeploymentAddresses;
  params: Record<string, string>;
}


function isLocalDeployment(value: unknown): value is LocalDeployment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<LocalDeployment>;
  return (
    candidate.network === "localhost" &&
    candidate.chainId === "31337" &&
    Boolean(candidate.addresses?.token) &&
    Boolean(candidate.addresses?.pool) &&
    Boolean(candidate.addresses?.registry)
  );
}

export async function loadLocalDeployment(): Promise<LocalDeployment> {

  const response = await fetch(LOCAL_DEPLOYMENT_URL, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(
      "Local contract addresses are unavailable. Run the Hardhat local deployment to create deployments/localhost.json."
    );
  }

  const deployment: unknown = await response.json();
  if (!isLocalDeployment(deployment)) {
    throw new Error("deployments/localhost.json does not match the expected local deployment format.");
  }

  return deployment;
}

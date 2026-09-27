import { Contract, type ContractRunner } from "ethers";
import mockStablecoinAbi from "./abis/MockStablecoin.json";
import policyRegistryAbi from "./abis/PolicyRegistry.json";
import poolAbi from "./abis/Pool.json";
import { loadLocalDeployment } from "./deployments";

export async function loadContracts(runner: ContractRunner) {
  const deployment = await loadLocalDeployment();

  return {
    deployment,
    token: new Contract(deployment.addresses.token, mockStablecoinAbi, runner),
    pool: new Contract(deployment.addresses.pool, poolAbi, runner),
    registry: new Contract(deployment.addresses.registry, policyRegistryAbi, runner)
  };
}

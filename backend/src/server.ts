// TrustPool off-chain service: evidence storage, protocol read API, and the claim keeper.
//
//   npm run chain         # terminal 1
//   npm run deploy:local  # terminal 2
//   npm run dev:backend   # terminal 3, http://localhost:3000/api/health
import { JsonRpcProvider, Wallet, type Signer } from "ethers";
import { createApp } from "./app";
import { connectContracts, loadDeployment } from "./chain";
import { loadConfig } from "./config";
import { LocalEvidenceStore, loadOrCreateKeyFile, parseEvidenceKey } from "./evidence";
import { Keeper } from "./keeper";

const LOCAL_CHAIN_ID = 31337n;

async function main() {
  const config = loadConfig();
  const deployment = await loadDeployment(config.deploymentFile);
  const provider = new JsonRpcProvider(config.rpcUrl);

  const { chainId } = await provider.getNetwork();
  if (chainId.toString() !== deployment.chainId) {
    throw new Error(
      `${config.rpcUrl} is chain ${chainId}, but ${config.deploymentFile} is for chain ${deployment.chainId}.`,
    );
  }
  const contracts = connectContracts(deployment.addresses, provider);
  if ((await provider.getCode(deployment.addresses.claimManager)) === "0x") {
    throw new Error(`No ClaimManager at ${deployment.addresses.claimManager}. Was the chain restarted? Redeploy.`);
  }

  let keeper: Keeper | null = null;
  if (config.keeper.enabled) {
    let signer: Signer | null = null;
    if (config.keeper.privateKey) {
      signer = new Wallet(config.keeper.privateKey, provider);
    } else if (chainId === LOCAL_CHAIN_ID) {
      // Hardhat node accounts are unlocked, and the deployer owns MockRandomness.
      signer = await provider.getSigner(deployment.deployer);
    } else {
      console.warn("Keeper disabled: set KEEPER_PRIVATE_KEY to run it on a non-local chain.");
    }
    if (signer) {
      keeper = await Keeper.create(contracts, signer, {
        fulfillRandomness: config.keeper.fulfillRandomness,
        autoResolve: config.keeper.autoResolve,
        logger: { info: (m) => console.log(`[keeper] ${m}`), warn: (m) => console.warn(`[keeper] ${m}`) },
      });
      keeper.start(config.keeper.intervalMs);
    }
  }

  let evidenceKey: Buffer;
  if (config.evidenceKey) {
    evidenceKey = parseEvidenceKey(config.evidenceKey);
  } else if (chainId === LOCAL_CHAIN_ID) {
    const { key, created } = await loadOrCreateKeyFile(config.evidenceKeyFile);
    if (created) console.warn(`Created a local evidence encryption key at ${config.evidenceKeyFile}.`);
    evidenceKey = key;
  } else {
    throw new Error("Set EVIDENCE_ENCRYPTION_KEY (32 bytes, hex or base64) to store evidence on a non-local chain.");
  }
  const evidence = new LocalEvidenceStore(config.evidenceDir, evidenceKey);
  const app = createApp({ deployment, provider, contracts, evidence, keeper, corsOrigin: config.corsOrigin });

  const server = app.listen(config.port, () => {
    console.log(`TrustPool backend on http://localhost:${config.port} (chain ${chainId}, ${config.rpcUrl})`);
    console.log(`Evidence stored encrypted in ${config.evidenceDir}`);
    if (keeper) {
      const s = keeper.status();
      console.log(
        `Keeper ${s.address}: randomness ${s.fulfillRandomness ? "on" : "off"}, auto-resolve ${s.autoResolve ? "on" : "off"}`,
      );
    }
  });

  const shutdown = async () => {
    await keeper?.stop();
    server.close();
    provider.destroy();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

import { resolve } from "node:path";

export interface Config {
  port: number;
  rpcUrl: string;
  deploymentFile: string;
  evidenceDir: string;
  /** 32-byte evidence encryption key, or null to use (and create if needed) `evidenceKeyFile`. */
  evidenceKey: string | null;
  evidenceKeyFile: string;
  /** Sign-in sessions and member profiles. */
  accountsDir: string;
  corsOrigin: string;
  keeper: {
    enabled: boolean;
    /** Signs keeper transactions. Unset on a local chain means "use the deployer's unlocked account". */
    privateKey: string | null;
    intervalMs: number;
    fulfillRandomness: boolean;
    autoResolve: boolean;
  };
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${value}".`);
  return n;
}

/** Reads configuration from environment variables. Paths are relative to the working directory. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.PORT, 3000, "PORT"),
    rpcUrl: env.RPC_URL || "http://127.0.0.1:8545",
    deploymentFile: resolve(env.DEPLOYMENT_FILE || "deployments/localhost.json"),
    evidenceDir: resolve(env.EVIDENCE_DIR || "data/evidence"),
    evidenceKey: env.EVIDENCE_ENCRYPTION_KEY || null,
    evidenceKeyFile: resolve(env.EVIDENCE_KEY_FILE || "data/evidence.key"),
    accountsDir: resolve(env.ACCOUNTS_DIR || "data/accounts"),
    corsOrigin: env.CORS_ORIGIN || "*",
    keeper: {
      enabled: flag(env.KEEPER_ENABLED, true),
      privateKey: env.KEEPER_PRIVATE_KEY || null,
      intervalMs: int(env.KEEPER_INTERVAL_MS, 5_000, "KEEPER_INTERVAL_MS"),
      fulfillRandomness: flag(env.KEEPER_FULFILL_RANDOMNESS, true),
      autoResolve: flag(env.KEEPER_AUTO_RESOLVE, true),
    },
  };
}

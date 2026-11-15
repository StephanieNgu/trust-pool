const { ethers } = require("hardhat");

const ZERO = "0x0000000000000000000000000000000000000000";

/** Calls `fn`, returning undefined instead of throwing (e.g. when probing an unrelated contract). */
async function probe(fn) {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Looks through the contracts `deployer` created recently for a Trust Pool deployment that an earlier
 * run of scripts/deploy.js started but did not finish (for example because the wallet ran out of
 * gas money). Contracts are recognised by how they point at each other, so unrelated contracts the
 * wallet created are ignored.
 *
 * Returns null when there is nothing to finish. Otherwise returns `{ existing, missing }`: `existing`
 * maps token/pool/registry/randomness/jury/claimManager to the addresses found, and `missing` lists
 * what still has to happen ("ClaimManager", "wiring", ...) for the log.
 *
 * @param deployer      signer or address whose deployments to search
 * @param subscriptionId only reuse a VRFRandomness made for this VRF subscription
 * @param maxScan       how many of the wallet's most recent transactions to look through
 */
async function findPartialDeployment(deployer, { subscriptionId, maxScan = 60 } = {}) {
  const from = typeof deployer === "string" ? deployer : await deployer.getAddress();
  const provider = ethers.provider;
  const nonce = await provider.getTransactionCount(from, "latest");

  // Every contract this wallet created, oldest first. A contract's address follows from the
  // creator's address and the transaction's nonce, so no block explorer is needed.
  const created = [];
  for (let n = Math.max(0, nonce - maxScan); n < nonce; n++) {
    const address = ethers.getCreateAddress({ from, nonce: n });
    if ((await provider.getCode(address)) !== "0x") created.push(address);
  }
  if (created.length === 0) return null;

  const at = (name, address) => ethers.getContractAt(name, address);
  /** The first contract after index `after` that `matches`, as [index, address], or null. */
  const findAfter = async (after, matches) => {
    for (let i = after + 1; i < created.length; i++) {
      if (await matches(created[i])) return [i, created[i]];
    }
    return null;
  };

  // Start from the newest stablecoin: a fresh deploy always begins with one.
  for (let t = created.length - 1; t >= 0; t--) {
    const token = await at("MockStablecoin", created[t]);
    if ((await probe(() => token.decimals())) !== 6n) continue;
    if ((await probe(() => token.owner())) === undefined) continue;

    const existing = { token: created[t] };
    const pool = await findAfter(t, async (a) => same(await probe(async () => (await at("Pool", a)).token()), existing.token));
    if (pool) existing.pool = pool[1];
    const registry =
      pool && (await findAfter(pool[0], async (a) => same(await probe(async () => (await at("PolicyRegistry", a)).pool()), existing.pool)));
    if (registry) existing.registry = registry[1];

    const randomness =
      registry &&
      (await findAfter(registry[0], async (a) => {
        const r = await at("VRFRandomness", a);
        const sub = await probe(() => r.subscriptionId());
        const consumer = await probe(() => r.consumer());
        if (sub === undefined || consumer === undefined) return false;
        return subscriptionId === undefined || sub === BigInt(subscriptionId);
      }));
    if (registry && !randomness && subscriptionId !== undefined) {
      // A VRFRandomness may exist for another subscription; it cannot be reused for this one.
      const other = await findAfter(registry[0], async (a) => (await probe(async () => (await at("VRFRandomness", a)).subscriptionId())) !== undefined);
      if (other) return null;
    }
    if (randomness) existing.randomness = randomness[1];

    const jury =
      randomness &&
      (await findAfter(randomness[0], async (a) => {
        const j = await at("JuryModule", a);
        return (
          same(await probe(() => j.registry()), existing.registry) &&
          same(await probe(() => j.randomness()), existing.randomness) &&
          same(await probe(() => j.pool()), existing.pool)
        );
      }));
    if (jury) existing.jury = jury[1];

    const claimManager =
      jury && (await findAfter(jury[0], async (a) => same(await probe(async () => (await at("ClaimManager", a)).jury()), existing.jury)));
    if (claimManager) existing.claimManager = claimManager[1];

    const missing = ["Pool", "PolicyRegistry", "VRFRandomness", "JuryModule", "ClaimManager"].filter(
      (_, i) => !existing[["pool", "registry", "randomness", "jury", "claimManager"][i]],
    );
    if (missing.length === 0) {
      // Everything is deployed; it is unfinished only if a link is still missing.
      const p = await at("Pool", existing.pool);
      const j = await at("JuryModule", existing.jury);
      const r = await at("VRFRandomness", existing.randomness);
      const links = [await p.registry(), await p.claimManager(), await p.jury(), await j.claimManager(), await r.consumer()];
      if (links.every((a) => a !== ZERO)) return null;
      missing.push("wiring");
    } else {
      missing.push("wiring");
    }
    return { existing, missing };
  }
  return null;
}

module.exports = { findPartialDeployment };

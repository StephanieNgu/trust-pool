// Shared setup for backend tests: an in-process Hardhat chain with the real contracts deployed,
// plus the Express app listening on a random port.
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hre from "hardhat";
import { type Contract, type Signer, ZeroHash, id } from "ethers";
import { createApp } from "../src/app";
import { AUTH_HEADERS, authMessage } from "../src/auth";
import { connectContracts, type Deployment, type DeploymentAddresses } from "../src/chain";
import { CaptureChallenges } from "../src/capture";
import { deviceIdHash, deviceProofMessage, LocalEvidenceStore, type DeviceKey } from "../src/evidence";
import { Keeper, type KeeperOptions } from "../src/keeper";
import { deployContracts, USDC } from "../../scripts/lib/deployContracts";

export { USDC };
export const { ethers } = hre;

export const PHOTO = Buffer.from("not really a jpeg, but the bytes are what matter").toString("base64");

let photoCount = 0;
/** A different photo on every call: the backend refuses a photo file that was uploaded before. */
export function photo(): string {
  photoCount += 1;
  return Buffer.from(`not really a jpeg, photo #${String(photoCount).padStart(6, "0")}`).toString("base64");
}

/** A valid IMEI (Luhn check digit included) for test device `i`: 35000000000000 + i, then the check digit. */
export function testImei(i: number): string {
  const body = (35_000_000_000_000 + i).toString();
  for (let check = 0; check <= 9; check++) {
    const imei = body + check;
    let sum = 0;
    for (let k = 0; k < 15; k++) {
      let digit = Number(imei[14 - k]);
      if (k % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
      sum += digit;
    }
    if (sum % 10 === 0) return imei;
  }
  throw new Error("unreachable");
}

/** The device details a member enters at signup, for test device `i`. */
export const testDevice = (i: number) => ({
  type: "phone" as const,
  imei: testImei(i),
  serial: `SERIAL${i}`,
  make: "Apple",
  model: "iPhone 13",
  color: "Blue",
});

const saltFor = (claimId: number, juror: string) => id(`salt:${claimId}:${juror}`);

/** A juror's vote: the amount to pay, or true for the full claim and false (0) to reject. */
export type Vote = bigint | boolean;

async function voteAmount(jury: Contract, claimId: number, vote: Vote): Promise<bigint> {
  if (typeof vote === "bigint") return vote;
  return vote ? (await jury.getAward(claimId)).maxAmount : 0n;
}

/** Commits a sealed vote, as a juror's wallet would. `noteHash` is from POST /api/claims/:id/notes. */
export async function commit(jury: Contract, juror: Signer, claimId: number, vote: Vote, noteHash = ZeroHash) {
  const address = await juror.getAddress();
  const amount = await voteAmount(jury, claimId, vote);
  const commitment = await jury.computeCommitment(claimId, address, amount, noteHash, saltFor(claimId, address));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (await (jury.connect(juror) as any).commitVote(claimId, commitment)).wait();
}

/** Reveals a vote committed with `commit`. */
export async function reveal(jury: Contract, juror: Signer, claimId: number, vote: Vote, noteHash = ZeroHash) {
  const address = await juror.getAddress();
  const amount = await voteAmount(jury, claimId, vote);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (await (jury.connect(juror) as any).revealVote(claimId, amount, noteHash, saltFor(claimId, address))).wait();
}

export async function increaseTime(seconds: number | bigint) {
  await hre.network.provider.send("evm_increaseTime", [Number(seconds)]);
  await hre.network.provider.send("evm_mine", []);
}

/**
 * Pays the next monthly premium for each holder, as members do, so tests that skip weeks ahead keep
 * their policies (and their jurors) active.
 */
export async function payPremiums(registry: Contract, holders: Signer[]) {
  for (const h of holders) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (await (registry.connect(h) as any).payPremium()).wait();
  }
}

// The suites were written against a 5% premium, which keeps their amounts round. The deploy
// default is 1.5% (checked in test/unit/params.test.js); premium logic does not depend on the rate.
const TEST_PARAMS = { premiumBps: 500 };

/** Deploys the protocol with seven policyholders past the waiting period and a seeded pool. */
export async function setup(keeperOptions: Partial<KeeperOptions> = {}) {
  await hre.run("compile", { quiet: true });
  const ctx = await deployContracts(TEST_PARAMS);
  const signers = await ethers.getSigners();
  const holders = signers.slice(1, 8);
  const poolAddr = await ctx.pool.getAddress();
  const evidenceDir = await mkdtemp(join(tmpdir(), "trustpool-evidence-"));
  const evidence = new LocalEvidenceStore(evidenceDir, randomBytes(32));
  const captures = new CaptureChallenges();

  await (await ctx.token.mint(ctx.deployer.address, USDC(10_000))).wait();
  await (await ctx.token.approve(poolAddr, USDC(10_000))).wait();
  await (await ctx.pool.contribute(USDC(10_000))).wait();
  // The claimant (holders[0]) enrols from the device itself, so the browser makes a device key, and
  // adds a proof of purchase. The other holders enrol from another device and give no proof.
  const device = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { kty, crv, x, y } = device.publicKey.export({ format: "jwk" });
  const deviceKey = { kty, crv, x, y } as DeviceKey;
  /** What the claimant's browser on the insured device signs when filing a claim with `code`. */
  const deviceSign = (wallet: string, code: string) =>
    sign("sha256", Buffer.from(deviceProofMessage(wallet, code)), { key: device.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  for (const [i, h] of holders.entries()) {
    await (await ctx.token.mint(h.address, USDC(1_000))).wait();
    await (await ctx.token.connect(h).approve(poolAddr, ethers.MaxUint256)).wait();
    // Enrol as the app would: device details and signup photos stamped with a capture code.
    const stamp = captures.consume(h.address, captures.issue(h.address).code);
    const files = [{ name: "front.jpg", contentType: "image/jpeg", data: photo() }];
    const fromDevice = i === 0 ? { deviceKey, purchaseProof: [1] } : {};
    if (i === 0) files.push({ name: "invoice.pdf", contentType: "application/pdf", data: photo() });
    const enrollment = await evidence.put({ kind: "enrollment", device: testDevice(i), ...fromDevice, files }, h.address, stamp);
    await (await ctx.registry.connect(h).buyPolicy(deviceIdHash(testDevice(i)), USDC(1_000), enrollment.evidenceHash)).wait();
    // Opt in to jury duty with twice the minimum, so one no-show penalty does not end their eligibility.
    await (await ctx.pool.connect(h).stake(ctx.params.minJurorStake * 2n)).wait();
  }
  await increaseTime(ctx.params.waitingPeriod);

  const addresses = {} as DeploymentAddresses;
  for (const name of ["token", "pool", "registry", "randomness", "jury", "claimManager"] as const) {
    addresses[name] = await ctx[name].getAddress();
  }
  addresses.vrfCoordinatorMock = await ctx.vrfCoordinator.getAddress();
  const deployment: Deployment = {
    network: "hardhat",
    chainId: "31337",
    deployer: ctx.deployer.address,
    addresses,
    params: Object.fromEntries(Object.entries(ctx.params).map(([k, v]) => [k, String(v)])),
  };

  const provider = ethers.provider;
  const contracts = connectContracts(addresses, provider);
  const keeper = await Keeper.create(contracts, ctx.deployer, {
    fulfillRandomness: true,
    autoResolve: true,
    ...keeperOptions,
  });
  const app = createApp({ deployment, provider, contracts, evidence, captures, keeper, corsOrigin: "*" });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(baseUrl + path, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, headers: res.headers, body: body as any, text };
  };
  /** Headers proving `signer` controls its wallet, as the frontend would send after personal_sign. */
  const authHeaders = async (signer: Signer, issuedAt = Math.floor(Date.now() / 1000)) => {
    const address = await signer.getAddress();
    return {
      [AUTH_HEADERS.address]: address,
      [AUTH_HEADERS.issuedAt]: String(issuedAt),
      [AUTH_HEADERS.signature]: await signer.signMessage(authMessage(address, deployment.chainId, issuedAt)),
    };
  };
  /** POST exactly `json`. */
  const postRaw = async (path: string, json: unknown, signer?: Signer) =>
    api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(signer ? await authHeaders(signer) : {}) },
      body: JSON.stringify(json),
    });
  /** A fresh capture code for `signer`, as the app requests before opening the camera. */
  const captureCode = async (signer: Signer): Promise<string> => (await postRaw("/api/capture/code", {}, signer)).body.code;
  /**
   * POST as the app would. Evidence uploads get a fresh capture code unless `json` already has one,
   * so tests about other things need not repeat that step; capture tests use postRaw.
   */
  const post = async (path: string, json: unknown, signer?: Signer) => {
    if (path === "/api/evidence" && signer && json && typeof json === "object" && !("captureCode" in json)) {
      json = { ...json, captureCode: await captureCode(signer) };
    }
    return postRaw(path, json, signer);
  };
  /** GET as `signer`. */
  const getAs = async (path: string, signer: Signer) => api(path, { headers: await authHeaders(signer) });

  const close = async () => {
    await new Promise((r) => server.close(r));
    await rm(evidenceDir, { recursive: true, force: true });
  };

  return {
    ...ctx,
    deployment,
    baseUrl,
    signers,
    holders,
    claimant: holders[0],
    contracts,
    keeper,
    evidence,
    api,
    post,
    postRaw,
    captureCode,
    captures,
    deviceSign,
    getAs,
    authHeaders,
    close,
  };
}

export function signerFor(signers: Awaited<ReturnType<typeof ethers.getSigners>>, address: string) {
  const s = signers.find((x) => x.address === address);
  if (!s) throw new Error(`No signer for ${address}`);
  return s;
}

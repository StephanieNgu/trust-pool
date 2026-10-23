import { AbiCoder, Contract, ZeroHash, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { getBrowserProvider } from "../wallet";
import { loadLocalDeployment } from "./deployments";

const JURY_ABI = [
  "function commitVote(uint256 claimId, bytes32 commitment)",
  "function revealVote(uint256 claimId, uint256 amount, bytes32 noteHash, bytes32 salt)",
  "function commitmentOf(uint256 claimId, address juror) view returns (bytes32)",
] as const;

function claimNumber(claimId: string): bigint {
  if (!/^\d+$/.test(claimId) || claimId === "0") throw new Error("Claim id must be a positive integer.");
  return BigInt(claimId);
}

async function jurySession(account: string, write = false) {
  const provider = getBrowserProvider();
  if ((await provider.getNetwork()).chainId !== 31337n) throw new Error("Switch to Hardhat Local (31337) to continue.");
  const deployment = await loadLocalDeployment();
  if (await provider.getCode(deployment.addresses.jury) === "0x") {
    throw new Error("JuryModule is unavailable. Deploy the contracts and refresh.");
  }
  const runner = write ? await provider.getSigner(getAddress(account)) : provider;
  return new Contract(deployment.addresses.jury, JURY_ABI, runner);
}

/** The hash sealed into a vote for a juror's note: keccak256 of its text, or zero for no note. */
export function juryNoteHash(note: string): string {
  return note.trim() ? keccak256(toUtf8Bytes(note)) : ZeroHash;
}

/**
 * The sealed vote: the amount to pay in token base units (0 rejects), the note's hash and the salt,
 * bound to this claim and juror. Matches JuryModule.computeCommitment.
 */
export function computeVoteCommitment(claimId: string, juror: string, amount: bigint, noteHash: string, salt: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error("Vote salt must be 32 bytes of hexadecimal data.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(noteHash)) throw new Error("Note hash must be 32 bytes of hexadecimal data.");
  if (amount < 0n) throw new Error("A vote amount cannot be negative.");
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "uint256", "bytes32", "bytes32"],
      [claimNumber(claimId), getAddress(juror), amount, noteHash, salt],
    ),
  );
}

/**
 * Derives a salt from a wallet signature without sending that signature anywhere. The fixed message
 * binds it to this chain, JuryModule, claim and juror. The frontend also stores an encrypted copy
 * because byte-for-byte deterministic signatures are common but are not guaranteed by EIP-191.
 */
export async function deriveVoteSalt(account: string, claimId: string): Promise<string> {
  const provider = getBrowserProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== 31337n) throw new Error("Switch to Hardhat Local (31337) to continue.");
  const deployment = await loadLocalDeployment();
  const juror = getAddress(account);
  const message = [
    "TrustPool private jury salt",
    "Signing this message does not cast or reveal a vote.",
    `Chain ID: ${network.chainId}`,
    `JuryModule: ${getAddress(deployment.addresses.jury)}`,
    `Claim ID: ${claimNumber(claimId)}`,
    `Juror: ${juror}`,
  ].join("\n");
  const signature = await (await provider.getSigner(juror)).signMessage(message);
  return keccak256(signature);
}

export async function readChainTimestamp(): Promise<number> {
  const provider = getBrowserProvider();
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("Could not read the latest block timestamp.");
  return block.timestamp;
}

export async function readVoteCommitment(account: string, claimId: string): Promise<string> {
  const jury = await jurySession(account);
  return jury.commitmentOf(claimNumber(claimId), getAddress(account)) as Promise<string>;
}

export async function commitJuryVote(
  account: string,
  claimId: string,
  commitment: string,
  progress: (message: string) => void,
): Promise<string> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(commitment)) throw new Error("Vote commitment must be a bytes32 hash.");
  const jury = await jurySession(account, true);
  progress("Confirm the sealed vote commitment in MetaMask.");
  const transaction = await jury.commitVote(claimNumber(claimId), commitment);
  progress("Waiting for the vote commitment to confirm…");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The vote commitment did not succeed.");
  return transaction.hash as string;
}

export async function revealJuryVote(
  account: string,
  claimId: string,
  amount: bigint,
  noteHash: string,
  salt: string,
  progress: (message: string) => void,
): Promise<string> {
  const jury = await jurySession(account, true);
  progress("Confirm the vote reveal in MetaMask.");
  const transaction = await jury.revealVote(claimNumber(claimId), amount, noteHash, salt);
  progress("Waiting for the vote reveal to confirm…");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The vote reveal did not succeed.");
  return transaction.hash as string;
}

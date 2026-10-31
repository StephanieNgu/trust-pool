// A member's account history, read from contract events: what they paid in (premiums,
// contributions, stakes, bonds) and what came back (payouts, bond refunds, juror fees). Nothing is
// stored server side; every request reads the logs again, like the notifications.
import { Interface, zeroPadValue, type Log, type Provider } from "ethers";
import type { DeploymentAddresses } from "./chain";

const registryEvents = new Interface([
  "event PolicyPurchased(uint256 indexed policyId, address indexed holder, bytes32 deviceIdHash, uint256 coverageLimit, uint256 premium, bytes32 enrollmentHash)",
  "event PolicyLapsed(uint256 indexed policyId, address indexed holder)",
  "event PremiumPaid(uint256 indexed policyId, address indexed holder, uint256 amount, uint256 paidThrough)",
]);
const poolEvents = new Interface([
  "event Contributed(address indexed from, uint256 amount)",
  "event Staked(address indexed juror, uint256 amount)",
  "event Unstaked(address indexed juror, uint256 amount)",
  "event JurorFeePaid(address indexed juror, uint256 amount)",
  "event StakePenalized(address indexed juror, uint256 amount)",
  "event BondPosted(address indexed claimant, uint256 amount)",
  "event BondSettled(address indexed claimant, uint256 returned, uint256 forfeited)",
]);
const claimEvents = new Interface([
  "event ClaimSubmitted(uint256 indexed claimId, address indexed claimant, uint256 indexed policyId, uint256 amount, bytes32 evidenceHash)",
  "event ClaimPaid(uint256 indexed claimId, address indexed claimant, uint256 amount)",
]);

export type HistoryKind =
  | "coverage"
  | "premium"
  | "lapse"
  | "contribution"
  | "stake"
  | "unstake"
  | "fee"
  | "penalty"
  | "bond"
  | "bondReturn"
  | "claim"
  | "payout";

export interface HistoryEntry {
  /** `txHash:logIndex`, unique per entry. */
  id: string;
  kind: HistoryKind;
  title: string;
  /** Token base units moved, or null for an entry without money (a claim filed, a policy closed). */
  amount: string | null;
  /** "in" = to the member's wallet, "out" = from it, null when no money moved. */
  direction: "in" | "out" | null;
  claimId: string | null;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  /** Unix seconds of the block. */
  at: number;
}

const topicFor = (address: string) => zeroPadValue(address, 32);

/** Every money movement and milestone for `address`, newest first. */
export async function getMemberHistory(provider: Provider, addresses: DeploymentAddresses, address: string): Promise<HistoryEntry[]> {
  const me = topicFor(address);
  const logs = (filters: { address: string; topics: (string | null)[] }[]) =>
    Promise.all(filters.map((filter) => provider.getLogs({ ...filter, fromBlock: 0, toBlock: "latest" })));

  const ev = (iface: Interface, name: string) => iface.getEvent(name)!.topicHash;
  const [purchased, lapsed, premiums, contributed, staked, unstaked, fees, penalties, bonds, bondsBack, submitted, paid] = await logs([
    { address: addresses.registry, topics: [ev(registryEvents, "PolicyPurchased"), null, me] },
    { address: addresses.registry, topics: [ev(registryEvents, "PolicyLapsed"), null, me] },
    { address: addresses.registry, topics: [ev(registryEvents, "PremiumPaid"), null, me] },
    { address: addresses.pool, topics: [ev(poolEvents, "Contributed"), me] },
    { address: addresses.pool, topics: [ev(poolEvents, "Staked"), me] },
    { address: addresses.pool, topics: [ev(poolEvents, "Unstaked"), me] },
    { address: addresses.pool, topics: [ev(poolEvents, "JurorFeePaid"), me] },
    { address: addresses.pool, topics: [ev(poolEvents, "StakePenalized"), me] },
    { address: addresses.pool, topics: [ev(poolEvents, "BondPosted"), me] },
    { address: addresses.pool, topics: [ev(poolEvents, "BondSettled"), me] },
    { address: addresses.claimManager, topics: [ev(claimEvents, "ClaimSubmitted"), null, me] },
    { address: addresses.claimManager, topics: [ev(claimEvents, "ClaimPaid"), null, me] },
  ]);

  // Premiums also emit Contributed (they go into the pool the same way); show those once, as premiums.
  const premiumTxs = new Set([...purchased, ...premiums].map((log) => log.transactionHash));
  // Claims are numbered in their submit transaction; the bond posted there belongs to that claim.
  const claimByTx = new Map(submitted.map((log) => [log.transactionHash, claimEvents.parseLog(log)!.args.claimId.toString() as string]));

  type Draft = Omit<HistoryEntry, "at">;
  const entry = (log: Log, kind: HistoryKind, title: string, amount: bigint | null, direction: HistoryEntry["direction"], claimId: string | null = null): Draft => ({
    id: `${log.transactionHash}:${log.index}`,
    kind,
    title,
    amount: amount === null ? null : amount.toString(),
    direction,
    claimId,
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.index,
  });
  const drafts: Draft[] = [];

  for (const log of purchased) {
    const { policyId, premium } = registryEvents.parseLog(log)!.args;
    drafts.push(entry(log, "coverage", `Coverage #${policyId} bought, first month's premium`, premium, "out"));
  }
  // Buying a policy also emits PremiumPaid for the first month; the coverage entry already shows it.
  const purchaseTxs = new Set(purchased.map((log) => log.transactionHash));
  for (const log of premiums) {
    if (purchaseTxs.has(log.transactionHash)) continue;
    drafts.push(entry(log, "premium", "Monthly premium", registryEvents.parseLog(log)!.args.amount, "out"));
  }
  for (const log of lapsed) {
    drafts.push(entry(log, "lapse", `Coverage #${registryEvents.parseLog(log)!.args.policyId} ended`, null, null));
  }
  for (const log of contributed) {
    if (premiumTxs.has(log.transactionHash)) continue;
    drafts.push(entry(log, "contribution", "Pool contribution", poolEvents.parseLog(log)!.args.amount, "out"));
  }
  for (const log of staked) drafts.push(entry(log, "stake", "Juror stake locked", poolEvents.parseLog(log)!.args.amount, "out"));
  for (const log of unstaked) drafts.push(entry(log, "unstake", "Juror stake withdrawn", poolEvents.parseLog(log)!.args.amount, "in"));
  for (const log of fees) drafts.push(entry(log, "fee", "Juror fee", poolEvents.parseLog(log)!.args.amount, "in"));
  for (const log of penalties) drafts.push(entry(log, "penalty", "Juror stake penalty (vote not revealed)", poolEvents.parseLog(log)!.args.amount, null));
  for (const log of bonds) {
    const claimId = claimByTx.get(log.transactionHash) ?? null;
    drafts.push(entry(log, "bond", claimId ? `Claim #${claimId} bond` : "Claim bond", poolEvents.parseLog(log)!.args.amount, "out", claimId));
  }
  for (const log of bondsBack) {
    const { returned, forfeited } = poolEvents.parseLog(log)!.args;
    if (returned === 0n) continue;
    drafts.push(entry(log, "bondReturn", forfeited > 0n ? "Claim bond returned, in part" : "Claim bond returned", returned, "in"));
  }
  for (const log of submitted) {
    const claimId = claimEvents.parseLog(log)!.args.claimId.toString() as string;
    drafts.push(entry(log, "claim", `Claim #${claimId} filed`, null, null, claimId));
  }
  for (const log of paid) {
    const { claimId, amount } = claimEvents.parseLog(log)!.args;
    drafts.push(entry(log, "payout", `Claim #${claimId} paid`, amount, "in", claimId.toString()));
  }

  // Block times, fetched once per block.
  const blockNumbers = [...new Set(drafts.map((draft) => draft.blockNumber))];
  const times = new Map<number, number>();
  await Promise.all(blockNumbers.map(async (number) => {
    const block = await provider.getBlock(number);
    times.set(number, block?.timestamp ?? 0);
  }));

  return drafts
    .map((draft) => ({ ...draft, at: times.get(draft.blockNumber) ?? 0 }))
    .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
}

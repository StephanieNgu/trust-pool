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
const ev = (iface: Interface, name: string) => iface.getEvent(name)!.topicHash;

export interface LogIndexOptions {
  /** First block to read; the block the contracts were deployed in, from deployments/<network>.json. */
  fromBlock?: number;
  /** Most blocks per eth_getLogs call (free RPC tiers cap it), or null/undefined for no limit. */
  maxRange?: number | null;
  /** Pause between capped steps, and the base of the backoff after a rate-limit error. Default 250 ms. */
  pauseMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for "too many requests" errors, e.g. Alchemy's 429 "exceeded its compute units per second capacity". */
export function isRateLimited(err: unknown): boolean {
  const text = JSON.stringify(err, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + String(err);
  return /\b429\b|rate limit|compute units per second|too many requests/i.test(text);
}

/**
 * Every log the history needs, from all three contracts, read once and kept. Each sync reads only the
 * blocks added since the last one, in steps of at most `maxRange` blocks, so a public RPC that caps
 * eth_getLogs ranges still works and a page load does not rescan the chain.
 */
export class LogIndex {
  private readonly logs: Log[] = [];
  private next: number;
  private syncing: Promise<void> | null = null;
  private readonly blockTimes = new Map<number, number>();

  constructor(
    private readonly provider: Provider,
    private readonly addresses: DeploymentAddresses,
    private readonly options: LogIndexOptions = {},
  ) {
    this.next = options.fromBlock ?? 0;
  }

  /** Reads any new blocks, then returns every indexed log. Concurrent calls share one read. */
  async sync(): Promise<readonly Log[]> {
    this.syncing ??= this.read().finally(() => {
      this.syncing = null;
    });
    await this.syncing;
    return this.logs;
  }

  async blockTime(blockNumber: number): Promise<number> {
    let at = this.blockTimes.get(blockNumber);
    if (at === undefined) {
      at = (await this.provider.getBlock(blockNumber))?.timestamp ?? 0;
      this.blockTimes.set(blockNumber, at);
    }
    return at;
  }

  private async read(): Promise<void> {
    const latest = await this.provider.getBlockNumber();
    const { maxRange } = this.options;
    const address = [this.addresses.registry, this.addresses.pool, this.addresses.claimManager];
    while (this.next <= latest) {
      const toBlock = maxRange ? Math.min(latest, this.next + maxRange - 1) : latest;
      const logs = await this.getLogsWithRetry({ address, topics: [INDEXED_TOPICS], fromBlock: this.next, toBlock });
      this.logs.push(...logs);
      this.next = toBlock + 1;
      // Small steps mean many calls; pace them so a free RPC tier's per-second limit isn't hit.
      if (maxRange && this.next <= latest) await sleep(this.options.pauseMs ?? 250);
    }
  }

  /** eth_getLogs, retried with backoff when the RPC says it is rate limited (HTTP 429). */
  private async getLogsWithRetry(filter: Parameters<Provider["getLogs"]>[0]): Promise<Log[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.provider.getLogs(filter);
      } catch (err) {
        if (!isRateLimited(err) || attempt >= 6) throw err;
        await sleep((this.options.pauseMs ?? 250) * 4 * 2 ** attempt);
      }
    }
  }
}

const EVENTS = {
  purchased: [registryEvents, "PolicyPurchased", "registry", 2],
  lapsed: [registryEvents, "PolicyLapsed", "registry", 2],
  premiums: [registryEvents, "PremiumPaid", "registry", 2],
  contributed: [poolEvents, "Contributed", "pool", 1],
  staked: [poolEvents, "Staked", "pool", 1],
  unstaked: [poolEvents, "Unstaked", "pool", 1],
  fees: [poolEvents, "JurorFeePaid", "pool", 1],
  penalties: [poolEvents, "StakePenalized", "pool", 1],
  bonds: [poolEvents, "BondPosted", "pool", 1],
  bondsBack: [poolEvents, "BondSettled", "pool", 1],
  submitted: [claimEvents, "ClaimSubmitted", "claimManager", 2],
  paid: [claimEvents, "ClaimPaid", "claimManager", 2],
} as const satisfies Record<string, readonly [Interface, string, keyof DeploymentAddresses, number]>;

const INDEXED_TOPICS = Object.values(EVENTS).map(([iface, name]) => ev(iface, name));

/**
 * Every money movement and milestone for `address`, newest first. Pass the app's shared `index` so
 * logs are read once; without one, the whole chain is read for this call.
 */
export async function getMemberHistory(
  provider: Provider,
  addresses: DeploymentAddresses,
  address: string,
  index: LogIndex = new LogIndex(provider, addresses),
): Promise<HistoryEntry[]> {
  const me = topicFor(address).toLowerCase();
  const all = await index.sync();
  const pick = ([iface, name, contract, position]: (typeof EVENTS)[keyof typeof EVENTS]) => {
    const topic = ev(iface, name);
    const at = addresses[contract]!.toLowerCase();
    return all.filter((log) => log.address.toLowerCase() === at && log.topics[0] === topic && log.topics[position]?.toLowerCase() === me);
  };
  const purchased = pick(EVENTS.purchased);
  const lapsed = pick(EVENTS.lapsed);
  const premiums = pick(EVENTS.premiums);
  const contributed = pick(EVENTS.contributed);
  const staked = pick(EVENTS.staked);
  const unstaked = pick(EVENTS.unstaked);
  const fees = pick(EVENTS.fees);
  const penalties = pick(EVENTS.penalties);
  const bonds = pick(EVENTS.bonds);
  const bondsBack = pick(EVENTS.bondsBack);
  const submitted = pick(EVENTS.submitted);
  const paid = pick(EVENTS.paid);

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

  // Block times, fetched once per block and kept by the index.
  const blockNumbers = [...new Set(drafts.map((draft) => draft.blockNumber))];
  const times = new Map<number, number>();
  await Promise.all(blockNumbers.map(async (number) => times.set(number, await index.blockTime(number))));

  return drafts
    .map((draft) => ({ ...draft, at: times.get(draft.blockNumber) ?? 0 }))
    .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
}

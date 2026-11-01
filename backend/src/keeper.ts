// The keeper moves claims along without anyone having to push them by hand:
//
//   JuryPending  -> on a local chain, asks Chainlink's VRF coordinator mock to answer the pending
//                   VRF request, which selects the jury. The mock derives the word from the request
//                   id; the keeper never picks a seed. On Sepolia or mainnet Chainlink's oracles
//                   answer by themselves and the keeper does nothing here. If randomness is still
//                   missing after the timeout (or too few jurors were left), cancels the claim.
//   Voting       -> calls finalize once the voting window has closed or every juror has voted
//   Offered      -> calls acceptOffer once the claimant's response window has passed without an answer
//   Approved     -> calls executePayout once the claimant has submitted the receipt, so the claim is
//                   paid automatically; or expireClaim if the receipt window passes without one
//
// It also closes policies whose premium grace period ended unpaid (PolicyRegistry.lapseOverdue),
// freeing their devices. A policy with an open claim stays open until the claim is decided.
//
// finalize, acceptOffer (after the deadline), executePayout, expireClaim, cancelStalledClaim and lapseOverdue are permissionless on-chain, so the keeper only saves users a
// transaction; it cannot change an outcome.
import type { Signer } from "ethers";
import { CLAIM_STATES } from "./abis";
import type { ProtocolContracts } from "./chain";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export interface KeeperOptions {
  /** Answer pending VRF requests through the local coordinator mock. Ignored without one. */
  fulfillRandomness: boolean;
  /** Finalize claims whose voting has closed and pay approved claims. */
  autoResolve: boolean;
  logger?: Logger;
}

export type KeeperAction =
  | {
      claimId: number;
      action: "fulfillRandomness" | "cancelStalledClaim" | "finalize" | "acceptOffer" | "executePayout" | "expireClaim";
      txHash?: string;
      error?: string;
    }
  | {
      /** The holder whose overdue policy was closed. */
      holder: string;
      action: "lapseOverdue";
      txHash?: string;
      error?: string;
    };

type Target = { claimId: number } | { holder: string };

export interface KeeperStatus {
  address: string;
  fulfillRandomness: boolean;
  autoResolve: boolean;
  running: boolean;
  lastTickAt: number | null;
  lastError: string | null;
}

const silent: Logger = { info: () => {}, warn: () => {} };
const ZERO_HASH = `0x${"0".repeat(64)}`;
const TERMINAL: string[] = ["Rejected", "Paid", "Cancelled", "Withdrawn", "Expired"];

export class Keeper {
  private readonly logger: Logger;
  private readonly done = new Set<number>();
  private readonly lastErrors = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<KeeperAction[]> | null = null;
  private lastTickAt: number | null = null;
  private lastError: string | null = null;

  private constructor(
    private readonly contracts: ProtocolContracts,
    private readonly address: string,
    private readonly options: KeeperOptions,
  ) {
    this.logger = options.logger ?? silent;
  }

  /**
   * Builds a keeper whose contracts send transactions from `signer`. Randomness fulfilment is
   * switched off, with a warning, when there is no local VRF coordinator mock to drive: on a public
   * network Chainlink's oracles deliver randomness themselves.
   */
  static async create(contracts: ProtocolContracts, signer: Signer, options: KeeperOptions): Promise<Keeper> {
    const logger = options.logger ?? silent;
    const address = await signer.getAddress();
    const connected = Object.fromEntries(
      Object.entries(contracts).map(([name, contract]) => [name, contract ? contract.connect(signer) : null]),
    ) as unknown as ProtocolContracts;

    let fulfillRandomness = options.fulfillRandomness;
    if (fulfillRandomness && !contracts.vrfCoordinatorMock) {
      logger.warn("No local VRF coordinator mock: Chainlink VRF delivers jury randomness, so the keeper will not.");
      fulfillRandomness = false;
    }
    return new Keeper(connected, address, { ...options, fulfillRandomness });
  }

  status(): KeeperStatus {
    return {
      address: this.address,
      fulfillRandomness: this.options.fulfillRandomness,
      autoResolve: this.options.autoResolve,
      running: this.timer !== null,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
    };
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    const run = () => {
      this.tick().catch((err) => {
        const error = message(err);
        if (error !== this.lastError) this.logger.warn(`Keeper tick failed: ${error}`);
        this.lastError = error;
      });
    };
    run();
    this.timer = setInterval(run, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
  }

  /** Runs one pass over every open claim. Concurrent calls share the pass already in flight. */
  tick(): Promise<KeeperAction[]> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(): Promise<KeeperAction[]> {
    const { claimManager } = this.contracts;
    const count = Number(await claimManager.claimCount());
    const actions: KeeperAction[] = [];

    for (let id = 1; id <= count; id++) {
      if (this.done.has(id)) continue;
      let state = CLAIM_STATES[Number((await claimManager.getClaim(id)).state)];

      if (state === "JuryPending") {
        let fulfilled = false;
        const { randomness, vrfCoordinatorMock } = this.contracts;
        if (this.options.fulfillRandomness && vrfCoordinatorMock && (await randomness.isPending(id))) {
          const requestId: bigint = await randomness.requestIdOf(id);
          const consumer = await randomness.getAddress();
          // The mock answers with keccak256(requestId, 0); nothing here chooses the word.
          fulfilled = await this.attempt(actions, id, "fulfillRandomness", () =>
            vrfCoordinatorMock.fulfillRandomWords(requestId, consumer),
          );
        }
        if (!fulfilled && this.options.autoResolve && (await this.contracts.jury.canCancel(id))) {
          if (await this.attempt(actions, id, "cancelStalledClaim", () => claimManager.cancelStalledClaim(id))) {
            state = "Cancelled";
          }
        }
      }

      if (state === "Voting" && this.options.autoResolve && (await this.contracts.jury.canTally(id))) {
        if (await this.attempt(actions, id, "finalize", () => claimManager.finalize(id))) {
          state = CLAIM_STATES[Number((await claimManager.getClaim(id)).state)];
        }
      }

      // The claimant has until offerDeadline to accept or withdraw; after it, silence accepts.
      if (
        state === "Offered" &&
        this.options.autoResolve &&
        (await this.chainTime()) > Number((await claimManager.getClaim(id)).offerDeadline)
      ) {
        if (await this.attempt(actions, id, "acceptOffer", () => claimManager.acceptOffer(id))) {
          state = "Approved";
        }
      }

      // An accepted claim pays once its receipt is in, and expires if the receipt window passes first.
      if (state === "Approved" && this.options.autoResolve) {
        const claim = await claimManager.getClaim(id);
        if (claim.receiptHash !== ZERO_HASH) {
          if (await this.attempt(actions, id, "executePayout", () => claimManager.executePayout(id))) {
            state = "Paid";
          }
        } else if ((await this.chainTime()) > Number(claim.receiptDeadline)) {
          if (await this.attempt(actions, id, "expireClaim", () => claimManager.expireClaim(id))) {
            state = "Expired";
          }
        }
      }

      if (TERMINAL.includes(state)) this.done.add(id);
    }

    if (this.options.autoResolve) await this.lapseOverduePolicies(actions);

    this.lastTickAt = Date.now();
    this.lastError = null;
    return actions;
  }

  /** Closes policies past their premium grace period, skipping any with a claim still open. */
  private async lapseOverduePolicies(actions: KeeperAction[]): Promise<void> {
    const { registry, claimManager } = this.contracts;
    const overdue: string[] = [...(await registry.overdueHolders())];
    for (const holder of overdue) {
      const policy = await registry.getPolicy(holder);
      if ((await claimManager.openClaimOfPolicy(policy.id)) !== 0n) continue;
      await this.attempt(actions, { holder }, "lapseOverdue", () => registry.lapseOverdue(holder));
    }
  }

  private async chainTime(): Promise<number> {
    const block = await this.contracts.claimManager.runner?.provider?.getBlock("latest");
    return block?.timestamp ?? Math.floor(Date.now() / 1000);
  }

  /** Sends one transaction and waits for it. Failures are recorded and retried on the next tick. */
  private async attempt(
    actions: KeeperAction[],
    target: number | Target,
    action: KeeperAction["action"],
    send: () => Promise<{ hash: string; wait(): Promise<unknown> }>,
  ): Promise<boolean> {
    const subject: Target = typeof target === "number" ? { claimId: target } : target;
    const label = "claimId" in subject ? `Claim #${subject.claimId}` : `Policy of ${subject.holder}`;
    const key = `${action}:${"claimId" in subject ? subject.claimId : subject.holder}`;
    try {
      const tx = await send();
      await tx.wait();
      actions.push({ ...subject, action, txHash: tx.hash } as KeeperAction);
      this.lastErrors.delete(key);
      this.logger.info(`${label}: ${action} (${tx.hash})`);
      return true;
    } catch (err) {
      const error = message(err);
      actions.push({ ...subject, action, error } as KeeperAction);
      // Log a failure once, not on every tick while it keeps failing.
      if (this.lastErrors.get(key) !== error) this.logger.warn(`${label}: ${action} failed: ${error}`);
      this.lastErrors.set(key, error);
      return false;
    }
  }
}

function message(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { revert?: { name?: string }; shortMessage?: string; message?: string };
    if (e.revert?.name) return `reverted with ${e.revert.name}`;
    return e.shortMessage ?? e.message ?? String(err);
  }
  return String(err);
}

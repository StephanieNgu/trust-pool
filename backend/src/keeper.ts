// The keeper moves claims along without anyone having to push them by hand:
//
//   JuryPending  -> fulfils the pending randomness request, which selects the jury (needs the
//                   MockRandomness owner key; production swaps this for Chainlink VRF). If the
//                   randomness is still missing after the timeout, cancels the claim instead.
//   Voting       -> calls finalize once the voting window has closed or every juror has voted
//   Approved     -> calls executePayout, so approved claims are paid automatically
//
// finalize, executePayout and cancelStalledClaim are permissionless on-chain, so the keeper only saves users a
// transaction; it cannot change an outcome.
import { randomBytes } from "node:crypto";
import type { Signer } from "ethers";
import { CLAIM_STATES } from "./abis";
import type { ProtocolContracts } from "./chain";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export interface KeeperOptions {
  /** Fulfil randomness requests. Requires `signer` to own MockRandomness. */
  fulfillRandomness: boolean;
  /** Finalize claims whose voting has closed and pay approved claims. */
  autoResolve: boolean;
  logger?: Logger;
  /** Seed source for jury selection; defaults to 32 bytes from the OS CSPRNG. */
  seed?: () => bigint;
}

export interface KeeperAction {
  claimId: number;
  action: "fulfillRandomness" | "cancelStalledClaim" | "finalize" | "executePayout";
  txHash?: string;
  error?: string;
}

export interface KeeperStatus {
  address: string;
  fulfillRandomness: boolean;
  autoResolve: boolean;
  running: boolean;
  lastTickAt: number | null;
  lastError: string | null;
}

const silent: Logger = { info: () => {}, warn: () => {} };
const TERMINAL: string[] = ["Rejected", "Paid", "Cancelled"];

export class Keeper {
  private readonly logger: Logger;
  private readonly seed: () => bigint;
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
    this.seed = options.seed ?? (() => BigInt(`0x${randomBytes(32).toString("hex")}`));
  }

  /**
   * Builds a keeper whose contracts send transactions from `signer`. Randomness fulfilment is
   * switched off, with a warning, when the signer does not own the randomness provider.
   */
  static async create(contracts: ProtocolContracts, signer: Signer, options: KeeperOptions): Promise<Keeper> {
    const logger = options.logger ?? silent;
    const address = await signer.getAddress();
    const connected = Object.fromEntries(
      Object.entries(contracts).map(([name, contract]) => [name, contract.connect(signer)]),
    ) as unknown as ProtocolContracts;

    let fulfillRandomness = options.fulfillRandomness;
    if (fulfillRandomness) {
      const owner: string = await contracts.randomness.owner();
      if (owner.toLowerCase() !== address.toLowerCase()) {
        logger.warn(`Keeper ${address} does not own MockRandomness (${owner}); juries will not be selected automatically.`);
        fulfillRandomness = false;
      }
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
        if (this.options.fulfillRandomness) {
          const pending: string = await this.contracts.randomness.pendingRequester(id);
          if (pending !== "0x0000000000000000000000000000000000000000") {
            fulfilled = await this.attempt(actions, id, "fulfillRandomness", () =>
              this.contracts.randomness.fulfill(id, this.seed()),
            );
          }
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

      if (state === "Approved" && this.options.autoResolve) {
        if (await this.attempt(actions, id, "executePayout", () => claimManager.executePayout(id))) {
          state = "Paid";
        }
      }

      if (TERMINAL.includes(state)) this.done.add(id);
    }

    this.lastTickAt = Date.now();
    this.lastError = null;
    return actions;
  }

  /** Sends one transaction and waits for it. Failures are recorded and retried on the next tick. */
  private async attempt(
    actions: KeeperAction[],
    claimId: number,
    action: KeeperAction["action"],
    send: () => Promise<{ hash: string; wait(): Promise<unknown> }>,
  ): Promise<boolean> {
    const key = `${action}:${claimId}`;
    try {
      const tx = await send();
      await tx.wait();
      actions.push({ claimId, action, txHash: tx.hash });
      this.lastErrors.delete(key);
      this.logger.info(`Claim #${claimId}: ${action} (${tx.hash})`);
      return true;
    } catch (err) {
      const error = message(err);
      actions.push({ claimId, action, error });
      // Log a failure once, not on every tick while it keeps failing.
      if (this.lastErrors.get(key) !== error) this.logger.warn(`Claim #${claimId}: ${action} failed: ${error}`);
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

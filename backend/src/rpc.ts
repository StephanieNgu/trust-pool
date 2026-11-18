// A JSON-RPC provider that stays inside a hosted RPC's per-second limit.
//
// ethers batches concurrent calls into one HTTP request by default. Loading the claims list fans out
// into dozens of eth_calls at once, and Alchemy's free tier answers a big batch with per-request 429
// errors ("exceeded its compute units per second capacity") inside an HTTP 200, which ethers does not
// retry. The API then turned those into 502s. This provider sends requests one per HTTP call, with
// a few in flight at a time, and retries any request the RPC rate-limits, with backoff.
import { JsonRpcProvider, type JsonRpcPayload, type JsonRpcResult } from "ethers";
import { isRateLimited } from "./history";

export interface RateLimitOptions {
  /** Most requests in flight at once. */
  maxConcurrency?: number;
  /** Retries of a rate-limited request before giving up. */
  maxRetries?: number;
  /** First backoff; doubles on each retry. */
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimitedProvider extends JsonRpcProvider {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly limits: Required<RateLimitOptions>;

  constructor(url: string, limits: RateLimitOptions = {}) {
    // One request per HTTP call, so a rate-limited answer affects one request, not a batch of 100.
    super(url, undefined, { batchMaxCount: 1 });
    this.limits = { maxConcurrency: 4, maxRetries: 6, baseDelayMs: 500, ...limits };
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    for (let attempt = 0; ; attempt++) {
      const results = await this.slot(() => super._send(payload));
      const limited = results.some((r) => "error" in r && isRateLimited((r as { error?: unknown }).error));
      if (!limited || attempt >= this.limits.maxRetries) return results;
      // Jitter keeps several waiting requests from retrying in the same instant.
      await sleep(this.limits.baseDelayMs * 2 ** attempt * (0.75 + Math.random() / 2));
    }
  }

  private async slot<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= this.limits.maxConcurrency) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await run();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

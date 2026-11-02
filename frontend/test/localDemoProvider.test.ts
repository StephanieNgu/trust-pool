import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createLocalDemoProvider } from "../src/wallet/localDemoProvider";

class MemoryStorage {
  private readonly items = new Map<string, string>();

  getItem(key: string) {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("local demo wallet", () => {
  it("uses the Hardhat node for signatures instead of holding signing keys in the browser", async () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
    let forwarded: { method: string; params: unknown } | null = null;
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
      forwarded = body;
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0xnode-signature" });
    };

    const provider = createLocalDemoProvider();
    const juror = provider.demoAccounts[1].address;
    provider.selectDemoAccount(juror);

    assert.deepEqual(await provider.request({ method: "eth_accounts" }), [juror]);
    assert.equal(
      await provider.request({ method: "personal_sign", params: ["0x68656c6c6f", juror] }),
      "0xnode-signature",
    );
    assert.deepEqual(forwarded, {
      jsonrpc: "2.0",
      id: 1,
      method: "personal_sign",
      params: ["0x68656c6c6f", juror],
    });
  });
});

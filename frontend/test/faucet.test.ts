// The testnet faucet button and the network checks a hosted (non-local) deployment relies on.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chainIdHex, isLocalChain, loadDeployment, networkLabel, wrongNetworkMessage } from "../src/contracts/deployments";
import { claimTestTokens } from "../src/contracts/member";
import { USDC, browser, progressLog, startStack, stopStack, type Stack } from "./harness";

describe("testnet faucet", () => {
  let t: Stack;
  let account: string;

  before(async () => {
    t = await startStack({ autoResolve: false });
    account = t.signers[11].address;
  });
  after(async () => {
    await stopStack(t);
  });

  it("loads the deployment the backend serves", async () => {
    const deployment = await loadDeployment();
    assert.equal(deployment.chainId, "31337");
    assert.equal(deployment.addresses.token, await t.token.getAddress());
  });

  it("gives a wallet 1,000 mUSDC once a day", async () => {
    const before = await t.token.balanceOf(account);
    const log = progressLog();
    await claimTestTokens(account, log.report);
    assert.equal((await t.token.balanceOf(account)) - before, USDC(1_000));
    assert.match(log.messages[0], /Confirm the faucet transaction/);
    await assert.rejects(claimTestTokens(account, () => {}), /already used the faucet today/);
  });

  it("refuses to send the faucet transaction on the wrong network", async () => {
    browser.walletChainId = "0xaa36a7";
    try {
      await assert.rejects(claimTestTokens(t.signers[12].address, () => {}), /Switch to Hardhat Local \(31337\)/);
    } finally {
      browser.walletChainId = null;
    }
  });

  it("names and converts the networks it knows", () => {
    assert.equal(networkLabel("11155111"), "Sepolia");
    assert.equal(chainIdHex("11155111"), "0xaa36a7");
    assert.equal(chainIdHex("31337"), "0x7a69");
    assert.equal(isLocalChain("11155111"), false);
    assert.equal(isLocalChain("31337"), true);
    assert.equal(wrongNetworkMessage("11155111"), "Switch to Sepolia (11155111) to continue.");
  });
});

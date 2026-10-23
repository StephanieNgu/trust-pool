// Jury duty as the Jury Queue page runs it: lock a stake (approving mUSDC first), see it on the
// dashboard, and withdraw it, which the pool refuses while the wallet sits on a jury.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDashboardOverview } from "../src/api";
import { stakeAsJuror, withdrawJurorStake } from "../src/contracts/member";
import { USDC, progressLog, startStack, stopStack, type Stack } from "./harness";

describe("frontend jury duty", () => {
  let t: Stack;
  let account: string;

  before(async () => {
    t = await startStack({ autoResolve: false });
    // A fresh wallet with mUSDC that has not approved the pool yet.
    account = t.signers[12].address;
    await (await t.token.mint(account, USDC(100))).wait();
  });
  after(async () => {
    await stopStack(t);
  });

  it("shows a wallet with no stake as not picked for juries", async () => {
    const overview = await getDashboardOverview(account);
    assert.equal(overview.jurorStake, "0.0");
    assert.equal(overview.minJurorStake, "20.0");
    assert.equal(overview.jurorStaked, false);
    assert.equal(overview.activeJuries, 0);
    assert.equal(overview.totalStaked, "280.0", "the seven test holders' stakes");
  });

  it("approves and locks a stake, then shows it on the dashboard", async () => {
    await assert.rejects(stakeAsJuror(account, "0", 6, () => {}), /greater than zero/);
    await assert.rejects(stakeAsJuror(account, "500", 6, () => {}), /not have enough mUSDC/);

    const progress = progressLog();
    await stakeAsJuror(account, "20", 6, progress.report);
    assert.deepEqual(progress.messages, [
      "Approve the mUSDC stake in your wallet.",
      "Waiting for the token approval to confirm…",
      "Confirm the juror stake in your wallet.",
      "Your stake is confirming on-chain…",
    ]);
    const overview = await getDashboardOverview(account);
    assert.equal(overview.jurorStake, "20.0");
    assert.equal(overview.jurorStaked, true);
    assert.equal(overview.balance, "80.0");
    assert.equal(overview.pool, (await getDashboardOverview(t.claimant.address)).pool, "stakes are not pool reserve");
  });

  it("refuses to withdraw while on a jury, and withdraws the whole stake otherwise", async () => {
    // Seat a jury: any claim will do, so file one on-chain with a placeholder evidence hash.
    await (await t.claimManager.connect(t.claimant).submitClaim(USDC(100), `0x${"22".repeat(32)}`)).wait();
    await t.keeper.tick();
    const [seated] = await t.jury.getJurors(1);
    assert.equal((await getDashboardOverview(seated)).activeJuries, 1);
    await assert.rejects(withdrawJurorStake(seated, () => {}), /on a jury right now/);

    await withdrawJurorStake(account, () => {});
    const overview = await getDashboardOverview(account);
    assert.equal(overview.jurorStake, "0.0");
    assert.equal(overview.balance, "100.0");
    await assert.rejects(withdrawJurorStake(account, () => {}), /no juror stake/);
  });
});

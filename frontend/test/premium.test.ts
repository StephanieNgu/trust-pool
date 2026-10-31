// Monthly premiums as the dashboard runs them: show when the next one is due, pay it (approving mUSDC
// when needed), warn during the grace period, and offer new coverage once the old one has ended.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDashboardOverview } from "../src/api";
import { purchaseCoverage } from "../src/contracts/insurance";
import { payPremium } from "../src/contracts/member";
import { premiumMessage } from "../src/member/PremiumPanel";
import { USDC, increaseTime, progressLog, startStack, stopStack, testDevice, type Stack } from "./harness";

const DAY = 24 * 60 * 60;
const SOME_ENROLLMENT = `0x${"11".repeat(32)}`;

describe("frontend monthly premiums", () => {
  let t: Stack;
  let account: string;

  before(async () => {
    t = await startStack({ autoResolve: false });
    account = t.signers[10].address;
    await (await t.token.mint(account, USDC(500))).wait();
    await purchaseCoverage(account, testDevice(70), "800", "40.0", SOME_ENROLLMENT, () => {});
  });
  after(async () => {
    await stopStack(t);
  });

  it("shows the monthly premium and when it is next due", async () => {
    const overview = await getDashboardOverview(account);
    assert.equal(overview.active, true);
    assert.equal(overview.overdue, false);
    assert.ok(overview.premium);
    assert.equal(overview.premium.status, "Paid");
    assert.equal(overview.premium.amount, "40.0");
    assert.equal(overview.premium.periodDays, 30);
    assert.equal(overview.premium.dueAt, overview.startTime + 30 * DAY);
    assert.equal(overview.premium.dueSoon, false);
    assert.equal(overview.premium.canPay, true);
    assert.equal(premiumMessage(overview.premium, "mUSDC").tone, "ok");
    assert.match(premiumMessage(overview.premium, "mUSDC").text, /^Paid through .* Next premium 40 mUSDC every 30 days\.$/);

    const stranger = await getDashboardOverview(t.signers[15].address);
    assert.equal(stranger.premium, null);
    assert.equal(stranger.overdue, false);
  });

  it("pays the next premium, approving the pool first", async () => {
    const before = await getDashboardOverview(account);
    const progress = progressLog();
    assert.match(await payPremium(account, progress.report), /^0x[0-9a-f]{64}$/);
    assert.deepEqual(progress.messages, [
      "Approve the mUSDC premium in your wallet.",
      "Waiting for the token approval to confirm…",
      "Confirm the premium payment in your wallet.",
      "Your premium payment is confirming on-chain…",
    ]);

    const after = await getDashboardOverview(account);
    assert.equal(after.premium?.paidThrough, before.premium!.paidThrough + 30 * DAY);
    assert.equal(after.premium?.canPay, false);
    assert.equal(after.contributed, "80.0");
    assert.equal(after.balance, "420.0");
    await assert.rejects(payPremium(account, () => {}), /already paid a full month ahead/);
  });

  it("warns during the grace period and lets the member catch up", async () => {
    const late = t.holders[1].address;
    await increaseTime(24 * DAY); // the setup holders' first month ended a day ago
    const overview = await getDashboardOverview(late);
    assert.equal(overview.active, true, "still covered in grace");
    assert.equal(overview.premium?.status, "Grace");
    assert.equal(overview.premium?.dueSoon, true);
    const message = premiumMessage(overview.premium!, "mUSDC");
    assert.equal(message.tone, "warning");
    assert.match(message.text, /^Your premium of 50 mUSDC was due .*\. Pay by .* to keep your coverage\.$/);

    const progress = progressLog();
    await payPremium(late, progress.report);
    assert.equal(progress.messages[0], "Confirm the premium payment in your wallet.", "setup holders approved the pool already");
    assert.equal((await getDashboardOverview(late)).premium?.status, "Paid");
  });

  it("flags a premium due within a week", async () => {
    const overview = await getDashboardOverview(account);
    // Paid through day 60 from purchase; now about day 24.
    assert.equal(overview.premium?.dueSoon, false);
    await increaseTime(30 * DAY);
    const due = await getDashboardOverview(account);
    assert.equal(due.premium?.dueSoon, true);
    assert.equal(due.premium?.canPay, true);
    assert.equal(premiumMessage(due.premium!, "mUSDC").tone, "due");
  });

  it("ends coverage after the grace period and offers new coverage", async () => {
    await increaseTime(15 * DAY);
    const overview = await getDashboardOverview(account);
    assert.equal(overview.active, false);
    assert.equal(overview.overdue, true);
    assert.equal(overview.premium?.status, "Overdue");
    assert.match(premiumMessage(overview.premium!, "mUSDC").text, /^Coverage ended .* because the premium was not paid\./);
    await assert.rejects(payPremium(account, () => {}), /grace period has ended/);

    // Buying again closes the unpaid policy and starts a new one on the same device.
    await purchaseCoverage(account, testDevice(70), "500", "25.0", SOME_ENROLLMENT, () => {});
    const renewed = await getDashboardOverview(account);
    assert.equal(renewed.active, true);
    assert.equal(renewed.coverage, "500.0");
    assert.equal(renewed.premium?.status, "Paid");
  });
});

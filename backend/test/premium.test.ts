// Monthly premiums through the API: due dates and reminders for the dashboard, paying the next month,
// the grace period after a missed one, and the keeper closing policies whose grace period ran out.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { USDC, increaseTime, setup } from "./helpers";

const DAY = 24 * 60 * 60;

describe("Monthly premiums", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  before(async () => {
    t = await setup();
  });
  after(async () => {
    await t.close();
  });

  const premiumOf = async (address: string) => (await t.api(`/api/members/${address}/premium`)).body.premium;

  it("publishes the premium period and grace period", async () => {
    const config = (await t.api("/api/config")).body;
    assert.equal(config.params.premiumPeriod, String(30 * DAY));
    assert.equal(config.params.gracePeriod, String(7 * DAY));
  });

  it("shows when the next premium is due", async () => {
    const member = (await t.api(`/api/members/${t.claimant.address}`)).body;
    const premium = member.policy.premium;
    assert.equal(member.policy.covered, true);
    assert.equal(premium.status, "Paid");
    assert.equal(premium.amount, USDC(50).toString());
    assert.equal(premium.period, 30 * DAY);
    assert.equal(premium.dueAt, member.policy.startTime + 30 * DAY);
    assert.equal(premium.paidThrough, premium.dueAt);
    assert.equal(premium.graceEndsAt, premium.dueAt + 7 * DAY);
    assert.equal(premium.secondsUntilDue, premium.dueAt - premium.asOf);
    assert.equal(premium.dueSoon, false, "23 days away after the 7-day waiting period");
    assert.equal(premium.canPay, true);
    assert.deepEqual(await premiumOf(t.claimant.address), { ...premium, asOf: premium.asOf });

    assert.equal(await premiumOf(t.signers[15].address), null);
    assert.equal((await t.api("/api/members/not-an-address/premium")).status, 400);
  });

  it("flags a premium due within a week, and clears it once paid", async () => {
    await increaseTime(20 * DAY);
    const due = await premiumOf(t.claimant.address);
    assert.equal(due.dueSoon, true);
    assert.ok(due.secondsUntilDue > 0 && due.secondsUntilDue <= 7 * DAY);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (await (t.registry.connect(t.claimant) as any).payPremium()).wait();
    const paid = await premiumOf(t.claimant.address);
    assert.equal(paid.paidThrough, due.paidThrough + 30 * DAY);
    assert.equal(paid.dueAt, paid.paidThrough);
    assert.equal(paid.dueSoon, false);
    assert.equal(paid.canPay, false, "already paid a full month ahead");
    const member = (await t.api(`/api/members/${t.claimant.address}`)).body;
    assert.equal(member.contributed, USDC(100).toString(), "two months of premiums");
  });

  it("keeps coverage through the grace period after a missed premium", async () => {
    await increaseTime(5 * DAY); // three days past the other holders' due date
    const member = (await t.api(`/api/members/${t.holders[1].address}`)).body;
    assert.equal(member.policy.status, "Active");
    assert.equal(member.policy.covered, true);
    assert.equal(member.policy.premium.status, "Grace");
    assert.equal(member.policy.premium.dueSoon, true);
    assert.ok(member.policy.premium.secondsUntilDue < 0);
    assert.equal(member.policy.premium.canPay, true);
    assert.deepEqual(await t.keeper.tick(), [], "nothing to close during grace");
  });

  it("stops covering once the grace period ends, and the keeper closes the policy", async () => {
    await increaseTime(5 * DAY);
    const overdue = (await t.api(`/api/members/${t.holders[1].address}`)).body;
    assert.equal(overdue.policy.status, "Active", "still open on-chain until the keeper closes it");
    assert.equal(overdue.policy.covered, false);
    assert.equal(overdue.policy.premium.status, "Overdue");
    assert.equal(overdue.policy.premium.dueAt, null);
    assert.equal(overdue.policy.premium.canPay, false);
    assert.equal(overdue.policy.pastWaitingPeriod, false);

    const actions = await t.keeper.tick();
    const lapsed = t.holders.slice(1).map((h) => h.address);
    assert.deepEqual(
      actions.map((a) => ("holder" in a ? a.holder : null)),
      lapsed,
    );
    assert.ok(actions.every((a) => a.action === "lapseOverdue" && a.txHash && !a.error));

    const closed = (await t.api(`/api/members/${t.holders[1].address}`)).body;
    assert.equal(closed.policy.status, "Lapsed");
    assert.equal(closed.policy.premium.status, "Lapsed");
    assert.deepEqual(await t.keeper.tick(), []);

    const paidUp = await premiumOf(t.claimant.address);
    assert.equal(paidUp.status, "Paid", "the member who paid keeps their coverage");
  });
});

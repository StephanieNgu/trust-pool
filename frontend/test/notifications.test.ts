// The dashboard's notification feed and its "seen" bookkeeping, through the real frontend API module.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getNotifications, markNotificationsSeen, readSeenNotifications, timeLeft, unreadCount } from "../src/api";
import { USDC, startStack, stopStack, type Stack } from "./harness";

describe("frontend notifications", () => {
  let t: Stack;
  before(async () => {
    t = await startStack({ autoResolve: false });
  });
  after(async () => {
    await stopStack(t);
  });

  it("tells picked jurors to vote and remembers which notifications were seen", async () => {
    await (await t.claimManager.connect(t.claimant).submitClaim(USDC(100), `0x${"44".repeat(32)}`)).wait();
    await t.keeper.tick();
    const [juror] = await t.jury.getJurors(1);

    const feed = await getNotifications(juror);
    const [first] = feed.notifications;
    assert.equal(first.id, "jury:1:commit");
    assert.equal(first.claimId, "1");
    assert.ok(first.deadline! > feed.now);

    assert.equal(readSeenNotifications(juror).size, 0);
    assert.equal(unreadCount(feed.notifications, readSeenNotifications(juror)), feed.notifications.length);
    markNotificationsSeen(juror, feed.notifications.map((n) => n.id), feed.notifications);
    assert.equal(unreadCount(feed.notifications, readSeenNotifications(juror)), 0);
    // Seen ids are per wallet, and ids no longer in the feed are dropped.
    assert.equal(readSeenNotifications(t.claimant.address).size, 0);
    const kept = markNotificationsSeen(juror, ["jury:9:commit"], feed.notifications.slice(1));
    assert.ok(!kept.has("jury:1:commit") && !kept.has("jury:9:commit"));

    const claimant = await getNotifications(t.claimant.address);
    assert.ok(claimant.notifications.some((n) => n.id === "claim:1:Voting"));
  });

  it("formats time left on a deadline", () => {
    assert.equal(timeLeft(100, 100), "closed");
    assert.equal(timeLeft(100 + 30, 100), "in 1m");
    assert.equal(timeLeft(100 + 2 * 3600 + 5 * 60, 100), "in 2h 5m");
    assert.equal(timeLeft(100 + 3 * 86_400 + 4 * 3600, 100), "in 3d 4h");
  });
});

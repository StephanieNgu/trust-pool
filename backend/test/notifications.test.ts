// Notifications follow one claim from filing to payout, as its claimant and its jurors would see them
// on the dashboard: picked for the jury, seal by the deadline, reveal, missed reveal, outcome, offer.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toUtf8Bytes } from "ethers";
import { USDC, commit, ethers, increaseTime, reveal, setup, signerFor } from "./helpers";

type Note = { id: string; kind: string; severity: string; title: string; body: string; deadline: number | null; claimId: string | null };

describe("notifications", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  const notes = async (address: string): Promise<Note[]> => {
    const res = await t.api(`/api/members/${address}/notifications`);
    assert.equal(res.status, 200);
    return res.body.notifications;
  };
  const ids = async (address: string) => (await notes(address)).map((n) => n.id);

  before(async () => {
    t = await setup({ autoResolve: false });
  });
  after(async () => {
    await t.close();
  });

  it("tells a covered member they can file claims, and nothing else", async () => {
    const policy = await t.registry.getPolicy(t.claimant.address);
    assert.deepEqual(await ids(t.claimant.address), [`policy:${policy.id}:eligible`]);
    // A wallet with no policy and no claims has nothing to hear about.
    assert.deepEqual(await ids(t.signers[15].address), []);
    assert.equal((await t.api("/api/members/nope/notifications")).status, 400);
  });

  it("follows a claim through jury duty and the claimant's offer", async () => {
    const { claimant, claimManager, jury, keeper, signers } = t;
    await (await claimManager.connect(claimant).submitClaim(USDC(300), `0x${"33".repeat(32)}`)).wait();
    assert.ok((await ids(claimant.address)).includes("claim:1:JuryPending"));

    await keeper.tick();
    const jurors: string[] = [...(await jury.getJurors(1))];
    assert.ok((await ids(claimant.address)).includes("claim:1:Voting"));

    // Every juror is told to seal a vote, with the commit deadline, ahead of anything informational.
    const [, , commitDeadline, revealDeadline] = await jury.getJury(1);
    for (const addr of jurors) {
      const [first] = await notes(addr);
      assert.equal(first.id, "jury:1:commit");
      assert.equal(first.severity, "action");
      assert.equal(first.deadline, Number(commitDeadline));
      assert.match(first.body, /up to 300 mUSDC/);
    }

    // Four commit; the fifth lets the commit window close.
    for (const addr of jurors.slice(0, 4)) await commit(jury, signerFor(signers, addr), 1, true);
    assert.ok(!(await ids(jurors[0])).includes("jury:1:commit"), "a sealed vote clears the reminder");
    assert.ok(!(await ids(jurors[0])).includes("jury:1:reveal"), "reveals are not open yet");
    await increaseTime(Number(commitDeadline) - (await ethers.provider.getBlock("latest"))!.timestamp + 60);
    const reveal0 = (await notes(jurors[0]))[0];
    assert.equal(reveal0.id, "jury:1:reveal");
    assert.equal(reveal0.deadline, Number(revealDeadline));
    assert.ok((await ids(jurors[4])).includes("jury:1:missed-commit"));

    // Three reveal; one sealed vote is never opened.
    for (const addr of jurors.slice(0, 3)) await reveal(jury, signerFor(signers, addr), 1, true);
    assert.ok(!(await ids(jurors[0])).includes("jury:1:reveal"));
    await increaseTime(Number(revealDeadline) - Number(commitDeadline) + 60);
    assert.ok((await ids(jurors[3])).includes("jury:1:missed-reveal"));

    // The jury is tallied: agreeing jurors hear about their fee, no-shows about their penalty.
    await (await claimManager.finalize(1)).wait();
    const winner = (await notes(jurors[0])).find((n) => n.id === "jury:1:tallied");
    assert.equal(winner?.severity, "success");
    assert.match(winner!.body, /approved: a majority voted to pay\. Your vote agreed .* you earned/);
    const noShow = (await notes(jurors[3])).find((n) => n.id === "jury:1:tallied");
    assert.equal(noShow?.severity, "warning");
    assert.match(noShow!.body, /taken from your stake/);

    // The claimant is asked to accept or withdraw the offer before it auto-accepts.
    const offer = (await notes(claimant.address))[0];
    assert.equal(offer.id, "claim:1:Offered");
    assert.equal(offer.severity, "action");
    assert.equal(offer.deadline, Number((await claimManager.getClaim(1)).offerDeadline));
    assert.match(offer.title, /offered 300 mUSDC/);

    // Once accepted, the claimant is asked for the receipt before the receipt window closes.
    await (await claimManager.connect(claimant).acceptOffer(1)).wait();
    const ask = (await notes(claimant.address)).find((n) => n.claimId === "1");
    assert.equal(ask?.id, "claim:1:Approved");
    assert.equal(ask?.severity, "action");
    assert.equal(ask?.deadline, Number((await claimManager.getClaim(1)).receiptDeadline));
    assert.match(ask!.title, /Upload your receipt/);

    await (await claimManager.connect(claimant).submitReceipt(1, keccak256(toUtf8Bytes("invoice")), USDC(300))).wait();
    assert.equal((await notes(claimant.address)).find((n) => n.claimId === "1")?.id, "claim:1:Approved:receipt");
    await (await claimManager.executePayout(1)).wait();
    const paid = (await notes(claimant.address)).find((n) => n.claimId === "1");
    assert.equal(paid?.id, "claim:1:Paid");
    assert.match(paid!.body, /300 mUSDC was sent to your wallet\. Your bond was returned in full\./);
  });

  it("reminds a member before a premium is due, in grace, and once coverage stops", async () => {
    const member = t.holders[3].address;
    const premiumOf = async () => (await t.api(`/api/members/${member}/premium`)).body.premium;
    const now = async () => (await ethers.provider.getBlock("latest"))!.timestamp;
    const premiumNotes = async () => (await notes(member)).filter((n) => n.kind === "premium");
    const policyId = (await t.registry.getPolicy(member)).id.toString();

    let premium = await premiumOf();
    // Earlier tests may have moved the clock; start from more than a week before the due date.
    if (premium.status === "Paid" && premium.dueSoon) {
      await (await t.registry.connect(t.holders[3]).payPremium()).wait();
      premium = await premiumOf();
    }
    assert.equal(premium.status, "Paid");
    assert.deepEqual(await premiumNotes(), []);

    // Six days before it is due: pay it, with the due date as the deadline.
    await increaseTime(premium.dueAt - (await now()) - 6 * 24 * 60 * 60);
    let [due] = await premiumNotes();
    assert.equal(due.id, `premium:${policyId}:${premium.paidThrough}:due`);
    assert.equal(due.severity, "action");
    assert.equal(due.deadline, premium.dueAt);
    assert.match(due.body, /^Pay 50 mUSDC/);

    // Missed: still covered, so pay before the grace period ends.
    await increaseTime(7 * 24 * 60 * 60);
    premium = await premiumOf();
    assert.equal(premium.status, "Grace");
    [due] = await premiumNotes();
    assert.equal(due.id, `premium:${policyId}:${premium.paidThrough}:grace`);
    assert.equal(due.severity, "action");
    assert.equal(due.deadline, premium.graceEndsAt);
    assert.ok((await ids(member)).includes(`policy:${policyId}:eligible`), "still covered in grace");

    // Grace over: coverage has stopped, and the member is no longer told they can file claims.
    await increaseTime(premium.graceEndsAt - (await now()) + 60);
    [due] = await premiumNotes();
    assert.equal(due.id, `premium:${policyId}:overdue`);
    assert.equal(due.severity, "warning");
    assert.ok(!(await ids(member)).includes(`policy:${policyId}:eligible`));

    await (await t.registry.lapseOverdue(member)).wait();
    [due] = await premiumNotes();
    assert.equal(due.id, `premium:${policyId}:lapsed`);
    assert.equal(due.severity, "info");
  });
});

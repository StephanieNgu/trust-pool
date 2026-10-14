// End to end through the backend: upload evidence, file the claim on-chain with the returned hash,
// let the keeper select the jury, vote, and let the keeper finalize and pay.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "ethers";
import { PHOTO, USDC, increaseTime, setup, signerFor } from "./helpers";

describe("claim flow through the backend", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  before(async () => {
    t = await setup();
  });
  after(async () => {
    await t.close();
  });

  it("approves and pays a claim with jury selection and payout done by the keeper", async () => {
    const { claimant, claimManager, token, api, post, keeper, signers, jury } = t;

    // 1. Claimant uploads photos and gets the hash to put on-chain.
    const upload = await post("/api/evidence", {
      description: "Cracked screen after a drop",
      files: [{ name: "front.jpg", contentType: "image/jpeg", data: PHOTO }],
    });
    assert.equal(upload.status, 201);
    const { evidenceHash } = upload.body;

    // 2. Claimant files the claim from their wallet.
    await (await claimManager.connect(claimant).submitClaim(USDC(300), evidenceHash)).wait();
    let claim = (await api("/api/claims/1")).body;
    assert.equal(claim.state, "JuryPending");
    assert.equal(claim.jury.phase, "AwaitingRandomness");
    assert.deepEqual(claim.evidence, { available: true, url: `/api/evidence/${evidenceHash}` });

    // 3. Keeper fulfils the randomness request; five jurors are selected, claimant excluded.
    const actions = await keeper.tick();
    assert.deepEqual(
      actions.map((a) => [a.claimId, a.action, a.error]),
      [[1, "fulfillRandomness", undefined]],
    );
    claim = (await api("/api/claims/1")).body;
    assert.equal(claim.state, "Voting");
    assert.equal(claim.jury.jurors.length, 5);
    assert.ok(!claim.jury.jurors.some((j: { address: string }) => j.address === claimant.address));
    assert.ok(claim.jury.votingDeadline > claim.submittedAt);

    // 4. Each juror finds the claim in their queue and checks the evidence against the chain.
    const jurorAddrs: string[] = claim.jury.jurors.map((j: { address: string }) => j.address);
    for (const addr of jurorAddrs) {
      const queue = (await api(`/api/claims?juror=${addr}&state=Voting`)).body.claims;
      assert.deepEqual(
        queue.map((c: { id: string }) => c.id),
        ["1"],
      );
    }
    const raw = await api(`/api/evidence/${evidenceHash}/raw`);
    assert.equal(keccak256(Buffer.from(raw.text)), (await claimManager.getClaim(1)).evidenceHash);

    // Votes: 4 approve, 1 reject. Voting is still open until everyone has voted.
    for (const [i, addr] of jurorAddrs.entries()) {
      await (await jury.connect(signerFor(signers, addr)).castVote(1, i !== 0)).wait();
      if (i < jurorAddrs.length - 1) assert.deepEqual(await keeper.tick(), []);
    }
    claim = (await api("/api/claims/1")).body;
    assert.equal(claim.jury.approvals, 4);
    assert.equal(claim.jury.rejections, 1);
    assert.ok(claim.jury.jurors.every((j: { hasVoted: boolean }) => j.hasVoted));
    assert.equal(claim.jury.canTally, true);
    assert.equal(claim.payoutAmount, USDC(300).toString());

    // 5. Keeper finalizes and pays in the same pass.
    const before = await token.balanceOf(claimant.address);
    const resolved = await keeper.tick();
    assert.deepEqual(
      resolved.map((a) => [a.action, a.error]),
      [
        ["finalize", undefined],
        ["executePayout", undefined],
      ],
    );
    assert.equal((await token.balanceOf(claimant.address)) - before, USDC(300));

    claim = (await api("/api/claims/1")).body;
    assert.equal(claim.state, "Paid");
    assert.equal(claim.jury.outcome, "Approved");
    assert.equal(claim.paidAmount, USDC(300).toString());
    assert.deepEqual(await keeper.tick(), []);

    const member = (await api(`/api/members/${claimant.address}`)).body;
    assert.equal(member.policy.status, "Active");
    assert.equal(member.policy.openClaimId, null);

    const pool = (await api("/api/pool")).body;
    assert.equal(pool.totalPaidOut, USDC(300).toString());
    assert.equal(pool.claimCount, 1);
  });

  it("rejects a claim when too few jurors vote before the deadline", async () => {
    const { holders, claimManager, api, post, keeper, signers, jury, params } = t;
    const claimant = holders[1];
    const { evidenceHash } = (
      await post("/api/evidence", { files: [{ name: "receipt.pdf", contentType: "application/pdf", data: PHOTO }] })
    ).body;
    await (await claimManager.connect(claimant).submitClaim(USDC(200), evidenceHash)).wait();
    const id = Number(await claimManager.claimCount());
    await keeper.tick();

    // Two approvals is below the quorum of three.
    const jurors: string[] = (await api(`/api/claims/${id}`)).body.jury.jurors.map((j: { address: string }) => j.address);
    for (const addr of jurors.slice(0, 2)) {
      await (await jury.connect(signerFor(signers, addr)).castVote(id, true)).wait();
    }
    assert.deepEqual(await keeper.tick(), [], "voting window still open");

    await increaseTime(Number(params.votingPeriod) + 1);
    const actions = await keeper.tick();
    assert.deepEqual(
      actions.map((a) => a.action),
      ["finalize"],
    );
    const claim = (await api(`/api/claims/${id}`)).body;
    assert.equal(claim.state, "Rejected");
    assert.equal(claim.paidAmount, "0");
    assert.equal(claim.payoutAmount, "0");

    const mine = (await api(`/api/claims?claimant=${claimant.address}`)).body.claims;
    assert.deepEqual(
      mine.map((c: { id: string; state: string }) => [c.id, c.state]),
      [[String(id), "Rejected"]],
    );
    const rejected = (await api("/api/claims?state=Rejected")).body.claims;
    assert.equal(rejected.length, 1);
  });
});

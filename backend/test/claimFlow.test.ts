// End to end through the backend: upload evidence, file the claim on-chain with the returned hash,
// let the keeper select the jury, vote, and let the keeper finalize and pay.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "ethers";
import { Keeper } from "../src/keeper";
import { PHOTO, USDC, commit, increaseTime, reveal, setup, signerFor, testImei } from "./helpers";

describe("claim flow through the backend", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  before(async () => {
    t = await setup();
  });
  after(async () => {
    await t.close();
  });

  it("approves and pays a claim with jury selection and payout done by the keeper", async () => {
    const { claimant, claimManager, token, api, post, getAs, keeper, signers, jury } = t;

    // 1. Claimant uploads photos and gets the hash to put on-chain.
    //    The phone still turns on, so they include its IMEI from Settings > About.
    const upload = await post("/api/evidence", {
      description: "Cracked screen after a drop",
      device: { imei: testImei(0) },
      files: [{ name: "front.jpg", contentType: "image/jpeg", data: PHOTO }],
    }, claimant);
    assert.equal(upload.status, 201);
    const { evidenceHash } = upload.body;

    // 2. Claimant files the claim from their wallet.
    await (await claimManager.connect(claimant).submitClaim(USDC(300), evidenceHash)).wait();
    let claim = (await api("/api/claims/1")).body;
    assert.equal(claim.state, "JuryPending");
    assert.equal(claim.jury.phase, "AwaitingRandomness");
    assert.deepEqual(claim.evidence, { available: true, url: `/api/evidence/${evidenceHash}` });
    const { enrollmentHash } = claim;
    assert.equal(enrollmentHash, (await t.registry.getPolicy(claimant.address)).enrollmentHash);
    assert.deepEqual(claim.enrollment, { available: true, url: `/api/evidence/${enrollmentHash}` });
    assert.deepEqual(claim.deviceCheck, { enrollmentMatchesPolicy: true, claimMatchesEnrollment: true });

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
    assert.ok(claim.jury.revealDeadline > claim.jury.commitDeadline && claim.jury.commitDeadline > claim.submittedAt);

    // 4. Each juror finds the claim in their queue and checks the evidence against the chain.
    const jurorAddrs: string[] = claim.jury.jurors.map((j: { address: string }) => j.address);
    for (const addr of jurorAddrs) {
      const queue = (await api(`/api/claims?juror=${addr}&state=Voting`)).body.claims;
      assert.deepEqual(
        queue.map((c: { id: string }) => c.id),
        ["1"],
      );
    }
    for (const addr of jurorAddrs) {
      const raw = await getAs(`/api/evidence/${evidenceHash}/raw`, signerFor(signers, addr));
      assert.equal(raw.status, 200);
      assert.equal(keccak256(Buffer.from(raw.text)), (await claimManager.getClaim(1)).evidenceHash);
    }
    // Jurors also see the photos taken at signup, to check it is the same phone.
    for (const addr of jurorAddrs) {
      const enrollment = await getAs(`/api/evidence/${enrollmentHash}`, signerFor(signers, addr));
      assert.equal(enrollment.status, 200);
      assert.equal(enrollment.body.kind, "enrollment");
    }
    // A policyholder who is not on this jury cannot see either.
    const outsider = t.holders.find((h) => h !== claimant && !jurorAddrs.includes(h.address));
    assert.ok(outsider);
    assert.equal((await getAs(`/api/evidence/${evidenceHash}/raw`, outsider)).status, 403);
    assert.equal((await getAs(`/api/evidence/${enrollmentHash}`, outsider)).status, 403);

    // Commit-reveal: 4 approve, 1 reject. While sealed, the API shows who committed but no tally.
    for (const [i, addr] of jurorAddrs.entries()) {
      await commit(jury, signerFor(signers, addr), 1, i !== 0);
    }
    claim = (await api("/api/claims/1")).body;
    assert.equal(claim.jury.commits, 5);
    assert.equal(claim.jury.approvals + claim.jury.rejections, 0);
    assert.equal(claim.jury.revealOpen, true, "everyone committed, so reveals open early");
    assert.ok(claim.jury.jurors.every((j: { committed: boolean; revealed: boolean }) => j.committed && !j.revealed));

    for (const [i, addr] of jurorAddrs.entries()) {
      await reveal(jury, signerFor(signers, addr), 1, i !== 0);
      if (i < jurorAddrs.length - 1) assert.deepEqual(await keeper.tick(), []);
    }
    claim = (await api("/api/claims/1")).body;
    assert.equal(claim.jury.approvals, 4);
    assert.equal(claim.jury.rejections, 1);
    assert.ok(claim.jury.jurors.every((j: { revealed: boolean }) => j.revealed));
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
    assert.equal(claim.jury.outcomeReason, "majorityApproved");
    assert.equal(claim.paidAmount, USDC(300).toString());
    assert.deepEqual(await keeper.tick(), []);

    // Jurors only see evidence while voting is open.
    assert.equal((await getAs(`/api/evidence/${evidenceHash}/raw`, signerFor(signers, jurorAddrs[0]))).status, 403);
    assert.equal((await getAs(`/api/evidence/${enrollmentHash}`, signerFor(signers, jurorAddrs[0]))).status, 403);
    assert.equal((await getAs(`/api/evidence/${evidenceHash}/raw`, claimant)).status, 200);

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
      await post(
        "/api/evidence",
        { files: [{ name: "receipt.pdf", contentType: "application/pdf", data: PHOTO }] },
        claimant,
      )
    ).body;
    await (await claimManager.connect(claimant).submitClaim(USDC(200), evidenceHash)).wait();
    const id = Number(await claimManager.claimCount());
    await keeper.tick();

    // Three approvals are committed but only two revealed: below the quorum of three.
    const jurors: string[] = (await api(`/api/claims/${id}`)).body.jury.jurors.map((j: { address: string }) => j.address);
    for (const addr of jurors.slice(0, 3)) await commit(jury, signerFor(signers, addr), id, true);
    await increaseTime(Number(params.commitPeriod) + 1);
    for (const addr of jurors.slice(0, 2)) await reveal(jury, signerFor(signers, addr), id, true);
    assert.deepEqual(await keeper.tick(), [], "reveal window still open");

    await increaseTime(Number(params.revealPeriod) + 1);
    const actions = await keeper.tick();
    assert.deepEqual(
      actions.map((a) => a.action),
      ["finalize"],
    );
    const claim = (await api(`/api/claims/${id}`)).body;
    assert.equal(claim.state, "Rejected");
    assert.equal(claim.jury.outcomeReason, "noQuorum");
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

  it("cancels a claim whose randomness never arrives", async () => {
    const { holders, claimManager, api, post, params } = t;
    const claimant = holders[2];
    // A keeper that does not own MockRandomness cannot fulfil, standing in for a VRF that never answers.
    const stalledKeeper = await Keeper.create(t.contracts, t.signers[9], { fulfillRandomness: true, autoResolve: true });
    const { evidenceHash } = (
      await post("/api/evidence", { files: [{ name: "a.png", contentType: "image/png", data: PHOTO }] }, claimant)
    ).body;
    await (await claimManager.connect(claimant).submitClaim(USDC(100), evidenceHash)).wait();
    const id = Number(await claimManager.claimCount());

    assert.deepEqual(await stalledKeeper.tick(), []);
    let claim = (await api(`/api/claims/${id}`)).body;
    assert.equal(claim.state, "JuryPending");
    assert.ok(claim.jury.cancelAvailableAt > claim.submittedAt);

    await increaseTime(Number(params.randomnessTimeout) + 1);
    const actions = await stalledKeeper.tick();
    assert.deepEqual(
      actions.map((a) => [a.claimId, a.action, a.error]),
      [[id, "cancelStalledClaim", undefined]],
    );
    claim = (await api(`/api/claims/${id}`)).body;
    assert.equal(claim.state, "Cancelled");
    assert.equal(claim.jury.phase, "Cancelled");
    assert.equal(claim.payoutAmount, "0");
    assert.equal((await api(`/api/members/${claimant.address}`)).body.policy.openClaimId, null);

    // The randomness-owning keeper leaves the cancelled claim alone.
    assert.deepEqual(await t.keeper.tick(), []);
  });
});

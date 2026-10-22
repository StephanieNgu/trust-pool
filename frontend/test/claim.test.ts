// The claim workflow as the Claims and Jury pages run it, end to end through the real frontend
// modules: sign in, upload evidence, file the claim, find it as a juror, verify the evidence against
// the chain, commit and reveal sealed votes, then finalize and pay from the frontend's recovery
// actions. The keeper only selects juries here, so every resolution step goes through the frontend.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "ethers";
import {
  ApiError,
  getClaim,
  getClaimsForJuror,
  getClaimsForMember,
  getDashboardOverview,
  getEvidence,
  getEvidenceResource,
  readCachedWalletAuth,
  requestCaptureCode,
  uploadEvidence,
  validateEvidenceFiles,
} from "../src/api";
import { cancelStalledClaim, executeClaimPayout, finalizeClaim, submitClaim } from "../src/contracts/claims";
import {
  commitJuryVote,
  computeVoteCommitment,
  deriveVoteSalt,
  readVoteCommitment,
  revealJuryVote,
} from "../src/contracts/jury";
import { USDC, increaseTime, pickedFile, progressLog, startStack, stopStack, testImei, type Stack } from "./harness";

const PHOTO_BYTES = new TextEncoder().encode("front of the phone, cracked from corner to corner");
const ZERO_HASH = `0x${"0".repeat(64)}`;

describe("frontend claim workflow", () => {
  let t: Stack;
  let claimant: string;
  let evidenceHash: string;
  let jurors: string[];

  before(async () => {
    t = await startStack({ fulfillRandomness: true, autoResolve: false });
    claimant = t.claimant.address;
  });
  after(async () => {
    await stopStack(t);
  });

  it("checks evidence files before anything is signed or uploaded", () => {
    assert.throws(() => validateEvidenceFiles([]), /between 1 and 10/);
    assert.throws(() => validateEvidenceFiles([pickedFile("notes.txt", "text/plain", "hi")]), /not a supported/);
    assert.throws(() => validateEvidenceFiles([pickedFile("empty.jpg", "image/jpeg", "")]), /between 1 byte and 5 MB/);
    assert.throws(
      () => validateEvidenceFiles(Array.from({ length: 11 }, (_, i) => pickedFile(`${i}.png`, "image/png", "x"))),
      /between 1 and 10/,
    );
    assert.equal(sessionStorage.length, 0, "no wallet signature was requested");
  });

  it("signs in, uploads evidence and caches the signature for later requests", async () => {
    const { code } = await requestCaptureCode(claimant);
    const summary = await uploadEvidence(
      claimant,
      "Cracked screen after a drop",
      [pickedFile("front.jpg", "image/jpeg", PHOTO_BYTES), pickedFile("receipt.pdf", "application/pdf", "%PDF-1.4 receipt")],
      code,
      testImei(0),
    );
    assert.equal(summary.capture?.code, code);
    assert.deepEqual(summary.device, { imei: testImei(0) });
    assert.match(summary.evidenceHash, /^0x[0-9a-f]{64}$/);
    assert.equal(summary.description, "Cracked screen after a drop");
    assert.deepEqual(
      summary.files.map((f) => [f.index, f.name, f.contentType, f.size]),
      [
        [0, "front.jpg", "image/jpeg", PHOTO_BYTES.length],
        [1, "receipt.pdf", "application/pdf", 16],
      ],
    );
    evidenceHash = summary.evidenceHash;

    const cached = readCachedWalletAuth(claimant);
    assert.ok(cached, "the evidence-access signature is cached for the session");
    assert.equal(cached.address, claimant);
    assert.ok(cached.expiresAt > Math.floor(Date.now() / 1000));
    // Past its expiry (less the safety buffer) the cached signature is discarded.
    assert.equal(readCachedWalletAuth(claimant, cached.expiresAt), null);
    assert.equal(readCachedWalletAuth(claimant), null);
  });

  it("files the claim on-chain with the backend's evidence hash", async () => {
    await assert.rejects(submitClaim(claimant, "300", 6, "0x1234", () => {}), /invalid evidence hash/);
    await assert.rejects(submitClaim(claimant, "0", 6, evidenceHash, () => {}), /greater than zero/);

    const progress = progressLog();
    const txHash = await submitClaim(claimant, "300", 6, evidenceHash, progress.report);
    assert.match(txHash, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(progress.messages, ["Confirm your claim in MetaMask.", "Your claim transaction is confirming…"]);

    const mine = await getClaimsForMember(claimant);
    assert.deepEqual(
      mine.map((c) => [c.id, c.state, c.amount, c.evidenceHash]),
      [["1", "JuryPending", USDC(300).toString(), evidenceHash]],
    );
    const detail = await getClaim("1");
    assert.deepEqual(detail.evidence, { available: true, url: `/api/evidence/${evidenceHash}` });
    assert.equal(detail.jury?.phase, "AwaitingRandomness");
    assert.equal((await getDashboardOverview(claimant)).openClaimId, "1");

    // One open claim per policy.
    await assert.rejects(submitClaim(claimant, "50", 6, evidenceHash, () => {}));
    assert.equal((await getClaimsForMember(claimant)).length, 1);
  });

  it("puts the claim in each selected juror's queue, never the claimant's", async () => {
    await t.keeper.tick();
    const claim = await getClaim("1");
    assert.equal(claim.state, "Voting");
    jurors = claim.jury?.jurors.map((j) => j.address) ?? [];
    assert.equal(jurors.length, 5);
    assert.ok(!jurors.includes(claimant));

    for (const juror of jurors) {
      assert.deepEqual(
        (await getClaimsForJuror(juror, "Voting")).map((c) => c.id),
        ["1"],
      );
    }
    assert.deepEqual(await getClaimsForJuror(claimant, "Voting"), []);
    assert.deepEqual(await getClaimsForMember(claimant, "Paid"), []);
  });

  it("lets a juror download the evidence and check it against the on-chain hash", async () => {
    const juror = jurors[0];
    const detail = await getEvidence(juror, evidenceHash);
    assert.equal(detail.evidenceHash, evidenceHash);
    assert.equal(detail.rawUrl, `/api/evidence/${evidenceHash}/raw`);
    assert.deepEqual(
      detail.files.map((f) => f.url),
      [`/api/evidence/${evidenceHash}/files/0`, `/api/evidence/${evidenceHash}/files/1`],
    );

    const raw = await getEvidenceResource(juror, detail.rawUrl);
    assert.equal(keccak256(raw), (await t.claimManager.getClaim(1)).evidenceHash);
    const photo = await getEvidenceResource(juror, detail.files[0].url);
    assert.deepEqual(photo, PHOTO_BYTES);

    await assert.rejects(getEvidenceResource(juror, "https://example.com/evidence"), /invalid evidence URL/);
  });

  it("lets a juror compare the claim with the photos taken at signup", async () => {
    const claim = await getClaim("1");
    const { enrollmentHash } = claim;
    assert.ok(enrollmentHash);
    assert.equal(enrollmentHash, (await t.registry.getPolicy(claimant)).enrollmentHash);
    assert.deepEqual(claim.enrollment, { available: true, url: `/api/evidence/${enrollmentHash}` });
    assert.deepEqual(claim.deviceCheck, { enrollmentImeiMatchesPolicy: true, claimImeiMatchesEnrollment: true });

    const signup = await getEvidence(jurors[0], enrollmentHash);
    assert.equal(signup.kind, "enrollment");
    assert.equal(signup.device?.imei, testImei(0));
    const raw = await getEvidenceResource(jurors[0], signup.rawUrl);
    assert.equal(keccak256(raw), enrollmentHash);
  });

  it("keeps the evidence from members who are not on the jury", async () => {
    const outsider = t.holders.find((h) => h.address !== claimant && !jurors.includes(h.address));
    assert.ok(outsider);
    await assert.rejects(getEvidence(outsider.address, evidenceHash), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 403);
      return true;
    });
    await assert.rejects(
      getEvidenceResource(outsider.address, `/api/evidence/${evidenceHash}/raw`),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
  });

  it("commits sealed votes whose commitments match the contract's", async () => {
    for (const [i, juror] of jurors.entries()) {
      const approve = i !== 0;
      const salt = await deriveVoteSalt(juror, "1");
      assert.equal(await deriveVoteSalt(juror, "1"), salt, "the salt can be re-derived to reveal later");

      const commitment = computeVoteCommitment("1", juror, approve, salt);
      assert.equal(commitment, await t.jury.computeCommitment(1, juror, approve, salt));
      assert.equal(await readVoteCommitment(juror, "1"), ZERO_HASH);

      const progress = progressLog();
      await commitJuryVote(juror, "1", commitment, progress.report);
      assert.equal(progress.messages[0], "Confirm the sealed vote commitment in MetaMask.");
      assert.equal(await readVoteCommitment(juror, "1"), commitment);
    }
    // Different claims and jurors get different salts.
    assert.notEqual(await deriveVoteSalt(jurors[0], "1"), await deriveVoteSalt(jurors[0], "2"));
    assert.notEqual(await deriveVoteSalt(jurors[0], "1"), await deriveVoteSalt(jurors[1], "1"));

    const claim = await getClaim("1");
    assert.equal(claim.jury?.commits, 5);
    assert.equal(claim.jury?.revealOpen, true);
    assert.equal((claim.jury?.approvals ?? 0) + (claim.jury?.rejections ?? 0), 0, "votes stay sealed");
  });

  it("reveals the votes, refusing a reveal that does not match the commitment", async () => {
    const wrongSalt = keccak256(new TextEncoder().encode("not the salt"));
    await assert.rejects(revealJuryVote(jurors[1], "1", true, wrongSalt, () => {}));
    await assert.rejects(revealJuryVote(jurors[1], "1", false, await deriveVoteSalt(jurors[1], "1"), () => {}));

    for (const [i, juror] of jurors.entries()) {
      await revealJuryVote(juror, "1", i !== 0, await deriveVoteSalt(juror, "1"), () => {});
    }
    const claim = await getClaim("1");
    assert.equal(claim.jury?.approvals, 4);
    assert.equal(claim.jury?.rejections, 1);
    assert.equal(claim.jury?.canTally, true);
    assert.equal(claim.state, "Voting", "the keeper is not auto-resolving");
    assert.equal(claim.payoutAmount, USDC(300).toString());
  });

  it("finalizes and pays the claim from the frontend's recovery actions", async () => {
    const before = await getDashboardOverview(claimant);

    const finalizeProgress = progressLog();
    await finalizeClaim(jurors[2], "1", finalizeProgress.report);
    assert.equal(finalizeProgress.messages[0], "Confirm finalizing the jury result in your wallet.");
    let claim = await getClaim("1");
    assert.equal(claim.state, "Approved");
    assert.equal(claim.jury?.outcomeReason, "majorityApproved");

    await executeClaimPayout(claimant, "1", () => {});
    claim = await getClaim("1");
    assert.equal(claim.state, "Paid");
    assert.equal(claim.paidAmount, USDC(300).toString());
    await assert.rejects(executeClaimPayout(claimant, "1", () => {}), "a claim is paid once");

    const after = await getDashboardOverview(claimant);
    assert.equal(Number(after.balance) - Number(before.balance), 300);
    assert.equal(Number(after.totalPaidOut) - Number(before.totalPaidOut), 300);
    assert.equal(after.openClaimId, null);
    assert.deepEqual(
      (await getClaimsForMember(claimant, "Paid")).map((c) => c.id),
      ["1"],
    );

    // Voting is over, so jurors lose access; the claimant keeps it.
    await assert.rejects(getEvidence(jurors[0], evidenceHash), (e: unknown) => e instanceof ApiError && e.status === 403);
    assert.equal((await getEvidence(claimant, evidenceHash)).evidenceHash, evidenceHash);
  });

  it("cancels a claim whose jury randomness never arrives", async () => {
    const other = t.holders[1].address;
    const { evidenceHash: hash } = await uploadEvidence(
      other,
      "Battery swelling",
      [pickedFile("battery.png", "image/png", "png bytes")],
      (await requestCaptureCode(other)).code,
    );
    await submitClaim(other, "120", 6, hash, () => {});
    const id = (await getClaimsForMember(other))[0].id;

    // Too early: the frontend sends the transaction and the contract refuses it.
    await assert.rejects(cancelStalledClaim(other, id, () => {}));
    const pending = await getClaim(id);
    assert.equal(pending.state, "JuryPending");
    assert.ok(pending.jury?.cancelAvailableAt);

    await increaseTime(Number(t.params.randomnessTimeout) + 1);
    const progress = progressLog();
    await cancelStalledClaim(other, id, progress.report);
    assert.equal(progress.messages[0], "Confirm cancelling the stalled jury request in your wallet.");

    const cancelled = await getClaim(id);
    assert.equal(cancelled.state, "Cancelled");
    assert.equal(cancelled.jury?.phase, "Cancelled");
    assert.equal(cancelled.payoutAmount, "0");
    assert.equal((await getDashboardOverview(other)).openClaimId, null);
  });

  it("rejects malformed claim ids before calling the backend or the chain", async () => {
    assert.throws(() => getClaim("0"), /positive integer/);
    assert.throws(() => getClaim("1; DROP"), /positive integer/);
    await assert.rejects(finalizeClaim(claimant, "-1", () => {}), /positive integer/);
    await assert.rejects(getClaim("999"), (e: unknown) => e instanceof ApiError && e.status === 404);
  });
});
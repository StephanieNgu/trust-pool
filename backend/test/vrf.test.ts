// The backend against a Chainlink VRF deployment: the coordinator, not the keeper, selects juries.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PHOTO, USDC, commit, increaseTime, reveal, setup, signerFor } from "./helpers";

describe("backend with Chainlink VRF randomness", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  const logs: string[] = [];
  before(async () => {
    t = await setup({ logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn: ${m}`) } }, { vrf: true });
  });
  after(async () => {
    await t.close();
  });

  it("reports the provider and leaves fulfilment to the coordinator", async () => {
    assert.equal((await t.api("/api/config")).body.randomnessProvider, "vrf");
    assert.equal(t.keeper.status().fulfillRandomness, false);
    assert.ok(logs.some((m) => m.includes("Chainlink VRF")));
    assert.ok(!logs.some((m) => m.startsWith("warn:")));
  });

  it("selects the jury when the coordinator answers, then finalizes and pays", async () => {
    const { claimant, claimManager, token, api, post, keeper, signers, jury, coordinator } = t;
    assert.ok(coordinator);
    const { evidenceHash } = (
      await post("/api/evidence", { files: [{ name: "front.jpg", contentType: "image/jpeg", data: PHOTO }] }, claimant)
    ).body;
    await (await claimManager.connect(claimant).submitClaim(USDC(250), evidenceHash)).wait();
    assert.deepEqual(await keeper.tick(), [], "nothing for the keeper to do while VRF is pending");

    await (await coordinator.fulfillRandomWords(1, [12345n])).wait();
    let claim = (await api("/api/claims/1")).body;
    assert.equal(claim.state, "Voting");
    const jurors: string[] = claim.jury.jurors.map((j: { address: string }) => j.address);
    assert.equal(jurors.length, 5);

    for (const addr of jurors) await commit(jury, signerFor(signers, addr), 1, true);
    for (const addr of jurors) await reveal(jury, signerFor(signers, addr), 1, true);
    const before = await token.balanceOf(claimant.address);
    assert.deepEqual(
      (await keeper.tick()).map((a) => [a.action, a.error]),
      [
        ["finalize", undefined],
        ["executePayout", undefined],
      ],
    );
    assert.equal((await token.balanceOf(claimant.address)) - before, USDC(250));
    claim = (await api("/api/claims/1")).body;
    assert.equal(claim.state, "Paid");
  });

  it("cancels a claim whose VRF request is never answered", async () => {
    const { holders, claimManager, api, post, keeper, params } = t;
    const claimant = holders[1];
    const { evidenceHash } = (
      await post("/api/evidence", { files: [{ name: "a.png", contentType: "image/png", data: PHOTO }] }, claimant)
    ).body;
    await (await claimManager.connect(claimant).submitClaim(USDC(100), evidenceHash)).wait();
    const id = Number(await claimManager.claimCount());

    await increaseTime(Number(params.randomnessTimeout) + 1);
    assert.deepEqual(
      (await keeper.tick()).map((a) => [a.claimId, a.action, a.error]),
      [[id, "cancelStalledClaim", undefined]],
    );
    assert.equal((await api(`/api/claims/${id}`)).body.state, "Cancelled");
  });
});

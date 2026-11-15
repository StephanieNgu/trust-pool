// Milestone 5 integration scenarios: several members at once, through the contracts, the keeper and
// the HTTP API together, the way the dashboard drives them. Each scenario checks what a member would
// see (claim views, notifications, account history) and that the pool's books still balance.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { JsonRpcProvider, keccak256, toUtf8Bytes, type Signer } from "ethers";
import { USDC, commit, ethers, increaseTime, payPremiums, photo, reveal, setup, signerFor } from "./helpers";
import { getMemberHistory, LogIndex } from "../src/history";

type Setup = Awaited<ReturnType<typeof setup>>;
type Note = { id: string; severity: string; claimId: string | null };

const DAY = 24 * 60 * 60;

async function now() {
  return (await ethers.provider.getBlock("latest"))!.timestamp;
}

/** Token held by the pool must equal free reserve + stakes + bonds + reservations. */
async function assertBooksBalance(t: Setup) {
  const pool = (await t.api("/api/pool")).body;
  const held = await t.token.balanceOf(await t.pool.getAddress());
  assert.equal(
    held,
    BigInt(pool.balance) + BigInt(pool.totalStaked) + BigInt(pool.totalBonded) + BigInt(pool.totalReserved),
    "pool token balance = reserve + stakes + bonds + reserved",
  );
  return pool;
}

async function fileClaim(t: Setup, claimant: Signer, amount: bigint) {
  const { evidenceHash } = (
    await t.post("/api/evidence", { files: [{ name: "front.jpg", contentType: "image/jpeg", data: photo() }] }, claimant)
  ).body;
  await (await t.claimManager.connect(claimant).submitClaim(amount, evidenceHash)).wait();
  return Number(await t.claimManager.claimCount());
}

async function jurorsOf(t: Setup, id: number): Promise<string[]> {
  return (await t.api(`/api/claims/${id}`)).body.jury.jurors.map((j: { address: string }) => j.address);
}

async function notes(t: Setup, address: string): Promise<Note[]> {
  const res = await t.api(`/api/members/${address}/notifications`);
  assert.equal(res.status, 200);
  return res.body.notifications;
}

describe("integration: concurrent claims through keeper and API", () => {
  let t: Setup;
  before(async () => {
    t = await setup();
  });
  after(async () => {
    await t.close();
  });

  it("pays two claims decided at the same time from reserved funds, and the books balance", async () => {
    const [a, b] = [t.holders[0], t.holders[1]];
    const before = { a: await t.token.balanceOf(a.address), b: await t.token.balanceOf(b.address) };
    const idA = await fileClaim(t, a, USDC(400));
    const idB = await fileClaim(t, b, USDC(300));
    await assertBooksBalance(t);

    // One keeper pass seats both juries.
    const seated = await t.keeper.tick();
    assert.deepEqual(seated.map((x) => [x.action, x.error]), [["fulfillRandomness", undefined], ["fulfillRandomness", undefined]]);
    for (const id of [idA, idB]) {
      for (const addr of await jurorsOf(t, id)) await commit(t.jury, signerFor(t.signers, addr), id, true);
      for (const addr of await jurorsOf(t, id)) await reveal(t.jury, signerFor(t.signers, addr), id, true);
    }
    const decided = await t.keeper.tick();
    assert.deepEqual(decided.map((x) => x.action), ["finalize", "finalize"]);
    const pool = await assertBooksBalance(t);
    assert.equal(pool.totalReserved, (USDC(400) + USDC(300)).toString());

    // Both accept and upload receipts; the keeper pays both in one pass.
    for (const [id, who, total] of [[idA, a, USDC(380)], [idB, b, USDC(300)]] as const) {
      await (await t.claimManager.connect(who).acceptOffer(id)).wait();
      await (await t.claimManager.connect(who).submitReceipt(id, keccak256(toUtf8Bytes(`receipt:${id}`)), total)).wait();
    }
    const paid = await t.keeper.tick();
    assert.deepEqual(paid.map((x) => [x.claimId, x.action, x.error]), [[idA, "executePayout", undefined], [idB, "executePayout", undefined]]);
    const after = await assertBooksBalance(t);
    assert.equal(after.totalReserved, "0");
    assert.equal(after.totalPaidOut, (USDC(380) + USDC(300)).toString());

    // The claimants got the receipt totals back, plus their bonds in full (the jury awarded all).
    // Each may also have sat on the other's jury and earned a fee there.
    const feeA: bigint = await t.jury.rewardOf(idB, a.address);
    const feeB: bigint = await t.jury.rewardOf(idA, b.address);
    assert.equal((await t.token.balanceOf(a.address)) - before.a - feeA, USDC(380));
    assert.equal((await t.token.balanceOf(b.address)) - before.b - feeB, USDC(300));
    assert.equal((await notes(t, a.address)).find((n) => n.claimId === String(idA))?.id, `claim:${idA}:Paid`);

    // Account history shows the bond out, bond back and payout for the claimant.
    const history = (await t.api(`/api/members/${a.address}/history`)).body.history as { kind: string; claimId: string | null }[];
    assert.deepEqual(
      history.filter((h) => ["bond", "bondReturn", "payout"].includes(h.kind)).map((h) => h.kind),
      ["payout", "bondReturn", "bond"],
    );
  });
});

describe("integration: a no-show juror", () => {
  let t: Setup;
  before(async () => {
    t = await setup();
  });
  after(async () => {
    await t.close();
  });

  it("is penalized, warned that their stake is low, and left out of the next draw", async () => {
    // Everyone holds exactly the minimum stake, so one penalty drops a juror below it.
    for (const h of t.holders) {
      await (await t.pool.connect(h).unstake(t.params.minJurorStake)).wait();
    }
    const id = await fileClaim(t, t.claimant, USDC(200));
    await t.keeper.tick();
    const jurors = await jurorsOf(t, id);
    const [noShow, ...voters] = jurors;
    for (const addr of voters) await commit(t.jury, signerFor(t.signers, addr), id, true);
    await increaseTime(BigInt(t.params.commitPeriod) + 1n);
    for (const addr of voters) await reveal(t.jury, signerFor(t.signers, addr), id, true);
    assert.ok((await notes(t, noShow)).some((n) => n.id === `jury:${id}:missed-commit`));
    await increaseTime(BigInt(t.params.revealPeriod) + 1n);
    await t.keeper.tick();

    const member = (await t.api(`/api/members/${noShow}`)).body;
    assert.equal(member.juror.stake, (BigInt(t.params.minJurorStake) - BigInt(t.params.noShowPenalty)).toString());
    assert.equal(member.juror.staked, false);
    const warned = (await notes(t, noShow)).map((n) => n.id);
    assert.ok(warned.includes(`jury:${id}:tallied`));
    assert.ok(warned.some((x) => x.includes(":stake-low:")), "told to top up the stake");

    // The penalty went to the jurors who showed up, and history says so on both sides.
    const noShowHistory = (await t.api(`/api/members/${noShow}/history`)).body.history as { kind: string }[];
    assert.ok(noShowHistory.some((h) => h.kind === "penalty"));
    const voterHistory = (await t.api(`/api/members/${voters[0]}/history`)).body.history as { kind: string }[];
    assert.ok(voterHistory.some((h) => h.kind === "fee"));
    await assertBooksBalance(t);

    // The next claim's jury is drawn from the five members still staked: the no-show is out.
    await payPremiums(t.registry, t.holders);
    await (await t.claimManager.connect(t.claimant).acceptOffer(id)).wait();
    const other = t.holders.find((h) => h.address !== noShow && h.address !== t.claimant.address)!;
    const available = (await t.api(`/api/members/${other.address}`)).body.jury.available;
    assert.equal(available, 5);
    const next = await fileClaim(t, other, USDC(100));
    await t.keeper.tick();
    assert.ok(!(await jurorsOf(t, next)).includes(noShow));
  });
});

describe("integration: premium lapses while a claim is open", () => {
  let t: Setup;
  before(async () => {
    t = await setup();
  });
  after(async () => {
    await t.close();
  });

  it("still pays the claim, then the keeper closes the overdue policy", async () => {
    const { claimant } = t;
    const others = t.holders.slice(1);
    // File two days before the claimant's premium is due, then never pay it.
    const { paidThrough } = (await t.api(`/api/members/${claimant.address}/premium`)).body.premium;
    await increaseTime(paidThrough - (await now()) - 2 * DAY);
    await payPremiums(t.registry, others);
    const id = await fileClaim(t, claimant, USDC(250));
    await t.keeper.tick();
    for (const addr of await jurorsOf(t, id)) await commit(t.jury, signerFor(t.signers, addr), id, true);
    for (const addr of await jurorsOf(t, id)) await reveal(t.jury, signerFor(t.signers, addr), id, true);
    await t.keeper.tick();
    await (await t.claimManager.connect(claimant).acceptOffer(id)).wait();

    // Grace runs out while the claim waits for the receipt.
    await increaseTime(10 * DAY);
    const premium = (await t.api(`/api/members/${claimant.address}/premium`)).body.premium;
    assert.equal(premium.status, "Overdue");
    // The keeper leaves the policy open while its claim is open, and keeps trying nothing else.
    assert.deepEqual((await t.keeper.tick()).filter((x) => x.action === "lapseOverdue"), []);
    const ids = (await notes(t, claimant.address)).map((n) => n.id);
    assert.ok(ids.includes(`claim:${id}:Approved`), "still asked for the receipt");
    assert.ok(ids.some((x) => x.endsWith(":overdue")));

    await (await t.claimManager.connect(claimant).submitReceipt(id, keccak256(toUtf8Bytes("receipt")), USDC(250))).wait();
    const actions = await t.keeper.tick();
    assert.deepEqual(actions.map((x) => [x.action, x.error]), [["executePayout", undefined], ["lapseOverdue", undefined]]);
    assert.equal((await t.api(`/api/members/${claimant.address}`)).body.policy.status, "Lapsed");
    assert.ok((await notes(t, claimant.address)).some((n) => n.id.endsWith(":lapsed")));
    await assertBooksBalance(t);
  });
});

describe("integration: account history on a public RPC", () => {
  let t: Setup;
  before(async () => {
    t = await setup();
  });
  after(async () => {
    await t.close();
  });

  it("reads history through a provider that caps eth_getLogs block ranges, like free Sepolia RPC tiers", async () => {
    const id = await fileClaim(t, t.claimant, USDC(100));
    assert.ok(id > 0);
    const local = ethers.provider;
    const MAX_RANGE = 10;
    let calls = 0;
    const capped = new Proxy(local, {
      get(target, prop, receiver) {
        if (prop === "getLogs") {
          return async (filter: { fromBlock?: number | string; toBlock?: number | string }) => {
            calls++;
            const latest = await target.getBlockNumber();
            const from = filter.fromBlock === undefined || filter.fromBlock === "latest" ? latest : Number(filter.fromBlock);
            const to = filter.toBlock === undefined || filter.toBlock === "latest" ? latest : Number(filter.toBlock);
            if (to - from + 1 > MAX_RANGE) throw new Error(`eth_getLogs is limited to a ${MAX_RANGE} block range`);
            return target.getLogs(filter);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as JsonRpcProvider;
    const full = await getMemberHistory(local, t.deployment.addresses, t.claimant.address);
    const index = new LogIndex(capped, t.deployment.addresses, { maxRange: MAX_RANGE });
    assert.deepEqual(await getMemberHistory(capped, t.deployment.addresses, t.claimant.address, index), full);

    // Later requests read only the blocks added since, not the whole chain again.
    await (await t.registry.connect(t.claimant).payPremium()).wait();
    calls = 0;
    const updated = await getMemberHistory(capped, t.deployment.addresses, t.claimant.address, index);
    assert.equal(calls, 1);
    assert.equal(updated[0].kind, "premium");
    assert.deepEqual(updated.slice(1), full);
  });
});

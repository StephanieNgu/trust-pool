const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployContracts } = require("../../scripts/lib/deployContracts");
const { USDC, EVIDENCE, RECEIPT, deviceHash, enrollmentHash, fulfillRandomness, saltFor, noteHashFor, ClaimState } = require("../helpers");

// Randomised invariant test for the Pool's token accounting.
//
// Each run deploys the protocol and applies a long, seeded random sequence of member actions:
// contributions, premiums, staking and unstaking, claims filed, juries drawn or left to stall,
// jurors committing and revealing random amounts (or not showing up), offers accepted, withdrawn or
// left to auto-accept, receipts above or below the offer, payouts, expiries, lapses and time jumps.
// After every action it checks the invariants below. Any failure prints the seed and the step so the
// sequence can be replayed with INVARIANT_SEED=<seed>.
//
// Invariants:
//  I1  Tokens held = contributions + penalties + forfeited bonds + stakes + bonds - paid out - juror fees
//      (every token that entered the Pool is accounted for, and nothing else is in it).
//  I2  Tokens held >= stakes + bonds + reserved, so balance() never underflows.
//  I3  totalReserved = sum of ClaimManager.reservedFor over all claims.
//  I4  An Offered or Approved claim has exactly its payout reserved; every other claim has nothing.
//  I5  Sum of stakeOf over all members = totalStaked.
//  I6  totalPaidOut = sum of paidAmount over Paid claims, and each payout <= its ask <= its coverage.
//  I7  Paid out + juror fees <= everything that joined the reserve (no money from nowhere).
//  I9  The offers and approved claims still outstanding can all be paid at once from the reserve.
//  I8  executePayout on an Approved claim with its receipt in never fails for lack of funds.

const RUNS = Number(process.env.INVARIANT_RUNS || 3);
const STEPS = Number(process.env.INVARIANT_STEPS || 100);
const FIXED_SEED = process.env.INVARIANT_SEED ? Number(process.env.INVARIANT_SEED) : undefined;
const HOLDERS = 10;
const COVERAGE = USDC(1_000);
const DAY = 24 * 60 * 60;

function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    big: (lo, hi) => lo + (BigInt(Math.floor(next() * 1e9)) * (hi - lo)) / 1_000_000_000n,
  };
}

/** Sends a transaction that the random sequence may legitimately make at the wrong time. */
async function attempt(promise) {
  try {
    await (await promise).wait();
    return true;
  } catch (err) {
    const msg = String(err.message || err);
    // Any custom-error or require revert is an allowed refusal, except running out of pool funds.
    if (msg.includes("InsufficientPoolBalance")) throw err;
    if (msg.includes("reverted")) return false;
    throw err;
  }
}

async function deployRun(params, seedLiquidity) {
  const ctx = await deployContracts(params);
  const signers = await ethers.getSigners();
  const { token, pool, registry, deployer } = ctx;
  const poolAddress = await pool.getAddress();
  const members = signers.slice(1, 1 + HOLDERS);
  for (const s of [deployer, ...members]) {
    await token.mint(s.address, USDC(1_000_000));
    await token.connect(s).approve(poolAddress, ethers.MaxUint256);
  }
  if (seedLiquidity > 0n) await pool.connect(deployer).contribute(seedLiquidity);
  for (const [i, m] of members.entries()) {
    await registry.connect(m).buyPolicy(deviceHash(i), COVERAGE, enrollmentHash(i));
    await pool.connect(m).stake(ctx.params.minJurorStake * 2n);
  }
  await time.increase(ctx.params.waitingPeriod);
  return { ...ctx, signers, members, everyone: [deployer, ...members] };
}

async function checkInvariants(ctx, label) {
  const { token, pool, claimManager, everyone } = ctx;
  const [held, contributed, penalties, forfeited, staked, bonded, paidOut, fees, reserved, count] = await Promise.all([
    token.balanceOf(await pool.getAddress()),
    pool.totalContributed(),
    pool.totalPenalties(),
    pool.totalBondsForfeited(),
    pool.totalStaked(),
    pool.totalBonded(),
    pool.totalPaidOut(),
    pool.totalJurorFees(),
    pool.totalReserved(),
    claimManager.claimCount(),
  ]);

  expect(held, `${label}: I1 token ledger`).to.equal(contributed + penalties + forfeited + staked + bonded - paidOut - fees);
  expect(held >= staked + bonded + reserved, `${label}: I2 reserved funds are backed`).to.equal(true);
  expect(await pool.balance(), `${label}: balance()`).to.equal(held - staked - bonded - reserved);
  expect(paidOut + fees <= contributed + penalties + forfeited, `${label}: I7 no money from nowhere`).to.equal(true);

  let reservedSum = 0n;
  let promised = 0n;
  let paidSum = 0n;
  for (let id = 1n; id <= count; id++) {
    const c = await claimManager.getClaim(id);
    const r = await claimManager.reservedFor(id);
    reservedSum += r;
    if (c.state === ClaimState.Offered || c.state === ClaimState.Approved) {
      const owed = await claimManager.payoutAmount(id);
      promised += owed;
      expect(r, `${label}: I4 claim ${id} reservation`).to.equal(owed);
    } else {
      expect(r, `${label}: I4 closed claim ${id} holds no reservation`).to.equal(0n);
    }
    if (c.state === ClaimState.Paid) {
      paidSum += c.paidAmount;
      expect(c.paidAmount <= c.amount && c.amount <= c.coverageLimit, `${label}: I6 claim ${id} bounds`).to.equal(true);
    }
  }
  expect(reservedSum, `${label}: I3 reservations add up`).to.equal(reserved);
  expect(promised <= held - staked - bonded, `${label}: I9 every outstanding offer can be paid together`).to.equal(true);
  expect(paidSum, `${label}: I6 payouts add up`).to.equal(paidOut);

  let stakeSum = 0n;
  for (const s of everyone) stakeSum += await pool.stakeOf(s.address);
  expect(stakeSum, `${label}: I5 stakes add up`).to.equal(staked);
}

async function openClaims(ctx) {
  const ids = [];
  const count = await ctx.claimManager.claimCount();
  for (let id = 1n; id <= count; id++) {
    const c = await ctx.claimManager.getClaim(id);
    if ([ClaimState.JuryPending, ClaimState.Voting, ClaimState.Offered, ClaimState.Approved].includes(c.state)) {
      ids.push({ id, claim: c });
    }
  }
  return ids;
}

/**
 * Most members pay their premiums and top their stake back up after penalties; a lapsed member signs
 * up again with a new device.
 */
async function keepCovered(ctx, r) {
  const { registry, pool, members, params } = ctx;
  for (const m of members) {
    if (!r.chance(0.85)) continue;
    const stake = await pool.stakeOf(m.address);
    if (stake < params.minJurorStake) await attempt(pool.connect(m).stake(params.minJurorStake * 2n - stake));
    if (await registry.isActive(m.address)) {
      await attempt(registry.connect(m).payPremium());
    } else {
      ctx.devices = (ctx.devices || 100) + 1;
      await attempt(registry.connect(m).buyPolicy(deviceHash(ctx.devices), COVERAGE, enrollmentHash(ctx.devices)));
    }
  }
}

const signerOf = (ctx, address) => ctx.signers.find((s) => s.address === address);

/** One random action. Returns a short description for failure messages. */
async function step(ctx, r) {
  const { pool, registry, claimManager, jury, members, params } = ctx;
  const roll = r.next();

  const submit = async () => {
    const m = r.pick(members);
    const ok = await attempt(claimManager.connect(m).submitClaim(r.big(USDC(10), COVERAGE), EVIDENCE));
    return ok ? "submit claim" : "submit refused";
  };

  if (roll < 0.06) {
    const who = r.pick(ctx.everyone);
    await attempt(pool.connect(who).contribute(r.big(1n, ctx.contributionMax)));
    return "contribute";
  }
  if (roll < 0.12) {
    await keepCovered(ctx, r);
    return "pay premiums";
  }
  if (roll < 0.16) {
    const m = r.pick(members);
    if (r.chance(0.6)) await attempt(pool.connect(m).stake(r.big(1n, USDC(30))));
    else await attempt(pool.connect(m).unstake(r.big(1n, USDC(30))));
    return "stake/unstake";
  }
  if (roll < 0.3) return submit();
  if (roll < 0.36) {
    if (r.chance(0.15)) {
      // A long jump: some members keep paying, others lapse.
      await time.increase(params.receiptPeriod);
      for (const m of members) if (r.chance(0.3)) await attempt(registry.lapseOverdue(m.address));
      await keepCovered(ctx, r);
    } else {
      await time.increase(r.int(1, 4) * DAY);
    }
    return "time passes";
  }

  // Move a random open claim forward.
  const open = await openClaims(ctx);
  if (open.length === 0) return submit();
  const { id, claim } = r.pick(open);
  const claimant = signerOf(ctx, claim.claimant);

  switch (claim.state) {
    case ClaimState.JuryPending:
      if (r.chance(0.85)) {
        await attempt(fulfillRandomness(ctx, id, BigInt(r.int(1, 1e9))));
        return `draw jury ${id}`;
      }
      if (!(await jury.canCancel(id))) await time.increase(params.randomnessTimeout + 1);
      await attempt(claimManager.cancelStalledClaim(id));
      return `cancel stalled ${id}`;

    case ClaimState.Voting: {
      if (await jury.canTally(id)) {
        await attempt(claimManager.finalize(id));
        return `finalize ${id}`;
      }
      const jurors = (await jury.getJurors(id)).map((a) => signerOf(ctx, a));
      const [, maxAmount] = await jury.getAward(id);
      const votes = new Map();
      for (const j of jurors) {
        if (!r.chance(0.8)) continue; // no-show
        const amount = r.chance(0.15) ? 0n : r.chance(0.6) ? maxAmount : r.big(0n, maxAmount);
        const note = noteHashFor(id, j, amount);
        const commitment = await jury.computeCommitment(id, j.address, amount, note, saltFor(id, j));
        if (await attempt(jury.connect(j).commitVote(id, commitment))) votes.set(j, { amount, note });
      }
      if (!(await jury.revealOpen(id))) await time.increase(params.commitPeriod + 1);
      for (const [j, v] of votes) {
        if (r.chance(0.9)) await attempt(jury.connect(j).revealVote(id, v.amount, v.note, saltFor(id, j)));
      }
      if (!(await jury.canTally(id))) await time.increase(params.revealPeriod + 1);
      return `vote ${id}`;
    }

    case ClaimState.Offered: {
      const choice = r.next();
      if (choice < 0.6) await attempt(claimManager.connect(claimant).acceptOffer(id));
      else if (choice < 0.8) await attempt(claimManager.connect(claimant).withdrawClaim(id));
      else {
        await time.increase(params.responsePeriod + 1);
        await attempt(claimManager.acceptOffer(id)); // silence accepts
      }
      return `answer offer ${id}`;
    }

    case ClaimState.Approved: {
      if (claim.receiptHash === ethers.ZeroHash) {
        if (r.chance(0.1)) {
          await time.increase(params.receiptPeriod + 1);
          await attempt(claimManager.expireClaim(id));
          return `expire ${id}`;
        }
        const receipt = r.chance(0.6) ? claim.approvedAmount : r.big(1n, claim.approvedAmount * 2n + 1n);
        await attempt(claimManager.connect(claimant).submitReceipt(id, RECEIPT, receipt));
        return `receipt ${id}`;
      }
      // Payouts are often left waiting, so several approved claims build up against the same reserve.
      if (r.chance(0.6)) return `hold payout ${id}`;
      // I8: an accepted claim with its receipt in must always be payable.
      await (await claimManager.executePayout(id)).wait();
      return `payout ${id}`;
    }
    default:
      return "idle";
  }
}

describe("Token accounting invariants (randomised)", function () {
  this.timeout(10 * 60 * 1000);

  // Three parameter sets: the deploy defaults (20% cap) with a well-funded pool, and two thin pools
  // with high per-claim caps, where several large offers compete for the same reserve. Without the
  // reservation the 90% pool breaks I8/I9 within a few dozen actions.
  const configs = [
    { name: "default cap", params: { premiumBps: 500 }, seedLiquidity: USDC(2_000), contributionMax: USDC(800) },
    {
      name: "60% cap",
      params: { premiumBps: 500, maxPayoutBps: 6_000, claimBondBps: 100 },
      seedLiquidity: USDC(500),
      contributionMax: USDC(100),
    },
    {
      name: "90% cap",
      params: { premiumBps: 500, maxPayoutBps: 9_000, claimBondBps: 100 },
      seedLiquidity: 0n,
      contributionMax: USDC(50),
    },
  ];
  const seeds = FIXED_SEED !== undefined ? [FIXED_SEED] : Array.from({ length: RUNS }, (_, i) => 1_000 + i * 7_919);

  for (const { name, params, seedLiquidity, contributionMax } of configs) {
    for (const seed of seeds) {
      it(`holds for ${STEPS} random actions (${name}, seed ${seed})`, async function () {
        const ctx = await deployRun(params, seedLiquidity);
        ctx.contributionMax = contributionMax;
        const r = rng(seed);
        await checkInvariants(ctx, `seed ${seed} setup`);
        const counts = {};
        ctx.devices = 100;
        for (let i = 0; i < STEPS; i++) {
          const what = await step(ctx, r);
          const key = what.split(" ").slice(0, 2).filter((w) => !/^\d+$/.test(w)).join(" ");
          counts[key] = (counts[key] || 0) + 1;
          await checkInvariants(ctx, `seed ${seed} step ${i} (${what})`);
        }
        // Drain: settle every open claim so the sequence also ends in a fully paid-out state.
        for (let guard = 0; guard < 200; guard++) {
          if ((await openClaims(ctx)).length === 0) break;
          await step(ctx, { ...r, next: () => 0.99 });
          await checkInvariants(ctx, `seed ${seed} drain ${guard}`);
        }
        expect(await ctx.pool.totalReserved(), "nothing stays reserved once every claim is closed").to.equal(0n);
        // Make sure the run actually exercised the interesting paths.
        expect(counts["submit claim"] || 0).to.be.greaterThan(0);
        if (process.env.INVARIANT_DEBUG) console.log(name, seed, counts);
      });
    }
  }
});

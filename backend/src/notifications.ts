// In-app notifications for one wallet, derived from on-chain state each time they are asked for.
// Nothing is stored: a notification exists while the state that causes it holds, and its `id` names
// that state (claim, step, outcome), so the frontend can remember which ids a wallet has already seen
// and a new step of the same claim shows up as new.
import { formatUnits } from "ethers";
import type { ClaimView } from "./protocol";

/** What the notification is about. Premium reminders join this list once monthly premiums land. */
export type NotificationKind = "jury" | "claim" | "policy";

/**
 * `action`: the wallet has something to do, usually before `deadline`.
 * `warning`: something went against the wallet (missed vote, rejected claim).
 * `success` / `info`: good news and everything else.
 */
export type NotificationSeverity = "action" | "warning" | "success" | "info";

export interface Notification {
  /** Stable for as long as the state it describes holds, e.g. "jury:3:commit". */
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  /** Best known time the state began (chain time, seconds). Used to sort, newest first. */
  at: number;
  /** When the action has to be done by, if there is a deadline (chain time, seconds). */
  deadline: number | null;
  claimId: string | null;
}

export interface NotificationInput {
  address: string;
  /** Latest block timestamp, so deadlines are judged as the contracts judge them. */
  now: number;
  token: { symbol: string; decimals: number };
  /** Every claim the wallet filed or sits on the jury of. */
  claims: ClaimView[];
  policy: { id: string; status: string; claimEligibleAt: number; startTime: number } | null;
  juror: { stake: string; minStake: string; staked: boolean };
  /** JuryModule.commitPeriod, to date when a jury was picked. */
  commitPeriod: number;
  /** ClaimManager.responsePeriod, to date when an offer was made. */
  responsePeriod: number;
}

/** A deadline within this many seconds is called out as closing soon. */
export const DUE_SOON_SECONDS = 24 * 60 * 60;

const OUTCOME_COPY: Record<string, string> = {
  majorityApproved: "a majority voted to pay",
  majorityRejected: "a majority voted to reject",
  tie: "the vote was tied",
  noQuorum: "too few jurors revealed a vote",
};

export function buildNotifications(input: NotificationInput): Notification[] {
  const { address, now, token, claims, policy, juror, commitPeriod, responsePeriod } = input;
  const me = address.toLowerCase();
  const amount = (value: string) => `${Number(formatUnits(value, token.decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${token.symbol}`;
  const soon = (deadline: number) => deadline - now <= DUE_SOON_SECONDS;
  const out: Notification[] = [];

  for (const claim of claims) {
    const n = `#${claim.id}`;
    const jury = claim.jury;
    const seat = jury?.jurors.find((j) => j.address.toLowerCase() === me);
    const pickedAt = jury?.commitDeadline ? jury.commitDeadline - commitPeriod : claim.submittedAt;

    // ----- Jury duty -----
    if (jury && seat) {
      const base = { kind: "jury" as const, claimId: claim.id };
      if (jury.phase === "Voting") {
        const commitDeadline = jury.commitDeadline ?? 0;
        const revealDeadline = jury.revealDeadline ?? 0;
        if (!seat.committed && now <= commitDeadline) {
          out.push({
            ...base,
            id: `jury:${claim.id}:commit`,
            severity: "action",
            title: soon(commitDeadline) ? `Seal your vote on claim ${n} soon` : `You were picked for the jury on claim ${n}`,
            body: `Review the evidence and seal the amount you would pay (up to ${amount(jury.maxAmount)}) before the commit window closes.`,
            at: pickedAt,
            deadline: commitDeadline,
          });
        } else if (!seat.committed) {
          out.push({
            ...base,
            id: `jury:${claim.id}:missed-commit`,
            severity: "warning",
            title: `You missed the vote on claim ${n}`,
            body: "The commit window closed without your sealed vote, so a no-show penalty will come out of your stake when the jury is tallied.",
            at: commitDeadline,
            deadline: null,
          });
        } else if (!seat.revealed && now <= revealDeadline && jury.revealOpen) {
          out.push({
            ...base,
            id: `jury:${claim.id}:reveal`,
            severity: "action",
            title: soon(revealDeadline) ? `Reveal your vote on claim ${n} soon` : `Reveal your vote on claim ${n}`,
            body: "Reveals are open. Only revealed votes count, and not revealing costs part of your stake.",
            at: Math.min(commitDeadline, now),
            deadline: revealDeadline,
          });
        } else if (!seat.revealed && now > revealDeadline) {
          out.push({
            ...base,
            id: `jury:${claim.id}:missed-reveal`,
            severity: "warning",
            title: `You did not reveal your vote on claim ${n}`,
            body: "The reveal window closed, so your vote will not count and a no-show penalty will come out of your stake.",
            at: revealDeadline,
            deadline: null,
          });
        }
      } else if (jury.phase === "Tallied") {
        const reward = BigInt(seat.reward ?? "0");
        const penalty = BigInt(seat.penalty ?? "0");
        const why = jury.outcomeReason ? OUTCOME_COPY[jury.outcomeReason] : "the votes were counted";
        const result =
          penalty > 0n
            ? `${amount(penalty.toString())} was taken from your stake for not revealing.`
            : reward > 0n
              ? `Your vote agreed with the outcome, so you earned ${amount(reward.toString())}.`
              : "Your vote did not match the outcome closely enough to share the fee. That costs nothing.";
        out.push({
          ...base,
          id: `jury:${claim.id}:tallied`,
          severity: penalty > 0n ? "warning" : reward > 0n ? "success" : "info",
          title: `The jury on claim ${n} has decided`,
          body: `The claim was ${jury.outcome === "Approved" ? "approved" : "rejected"}: ${why}. ${result}`,
          at: jury.revealDeadline ?? pickedAt,
          deadline: null,
        });
      } else if (jury.phase === "Cancelled") {
        out.push({
          ...base,
          id: `jury:${claim.id}:cancelled`,
          severity: "info",
          title: `Claim ${n} no longer needs your vote`,
          body: "The claim was cancelled, so your seat on its jury is released.",
          at: pickedAt,
          deadline: null,
        });
      }
    }

    // ----- My claims -----
    if (claim.claimant.toLowerCase() !== me) continue;
    const base = { kind: "claim" as const, claimId: claim.id, id: `claim:${claim.id}:${claim.state}` };
    const bondBack = claim.bond.returned !== null && BigInt(claim.bond.forfeited ?? "0") > 0n
      ? ` ${amount(claim.bond.returned)} of your ${amount(claim.bond.amount)} bond was returned.`
      : claim.bond.returned !== null ? " Your bond was returned in full." : "";
    switch (claim.state) {
      case "Submitted":
      case "JuryPending":
        out.push({ ...base, severity: "info", title: `Claim ${n} is filed`, body: `Your claim for ${amount(claim.amount)} was filed. A jury of members is being picked at random.`, at: claim.submittedAt, deadline: null });
        break;
      case "Voting":
        out.push({ ...base, severity: "info", title: `A jury is reviewing claim ${n}`, body: "Jurors are voting on your claim now. You will hear the outcome when voting closes.", at: pickedAt, deadline: jury?.revealDeadline ?? null });
        break;
      case "Offered": {
        const deadline = claim.offerDeadline ?? 0;
        out.push({
          ...base,
          severity: "action",
          title: `The jury offered ${amount(claim.payoutAmount)} on claim ${n}`,
          body: `Accept the offer or withdraw the claim. If you do nothing, the offer is accepted automatically when the time runs out.${bondBack}`,
          at: deadline - responsePeriod,
          deadline,
        });
        break;
      }
      case "Approved":
        out.push({ ...base, severity: "success", title: `Claim ${n} is approved`, body: `${amount(claim.payoutAmount)} will be paid out from the pool shortly.${bondBack}`, at: jury?.revealDeadline ?? claim.submittedAt, deadline: null });
        break;
      case "Paid":
        out.push({ ...base, severity: "success", title: `Claim ${n} was paid`, body: `${amount(claim.paidAmount)} was sent to your wallet.${bondBack}`, at: jury?.revealDeadline ?? claim.submittedAt, deadline: null });
        break;
      case "Rejected": {
        const why = jury?.outcomeReason ? OUTCOME_COPY[jury.outcomeReason] : "the jury did not approve it";
        out.push({ ...base, severity: "warning", title: `Claim ${n} was rejected`, body: `The jury did not approve your claim: ${why}.${bondBack}`, at: jury?.revealDeadline ?? claim.submittedAt, deadline: null });
        break;
      }
      case "Withdrawn":
        out.push({ ...base, severity: "info", title: `Claim ${n} was withdrawn`, body: `You turned down the jury's offer, so nothing was paid.${bondBack}`, at: jury?.revealDeadline ?? claim.submittedAt, deadline: null });
        break;
      case "Cancelled":
        out.push({ ...base, severity: "info", title: `Claim ${n} was cancelled`, body: "No jury could be picked in time, so the claim was cancelled and your bond returned. You can file it again.", at: claim.submittedAt, deadline: null });
        break;
    }
  }

  // ----- Policy and jury eligibility -----
  if (policy?.status === "Active") {
    if (now < policy.claimEligibleAt) {
      out.push({ id: `policy:${policy.id}:waiting`, kind: "policy", severity: "info", title: "Your coverage is in its waiting period", body: "You can file claims once the waiting period ends.", at: policy.startTime, deadline: policy.claimEligibleAt, claimId: null });
    } else {
      out.push({ id: `policy:${policy.id}:eligible`, kind: "policy", severity: "success", title: "You can now file claims", body: "Your coverage is past its waiting period.", at: policy.claimEligibleAt, deadline: null, claimId: null });
    }
    if (BigInt(juror.stake) > 0n && !juror.staked) {
      out.push({ id: `policy:${policy.id}:stake-low:${juror.stake}`, kind: "jury", severity: "warning", title: "Your juror stake is below the minimum", body: `Top up to ${amount(juror.minStake)} to keep being picked for juries.`, at: now, deadline: null, claimId: null });
    }
  }

  // Actions first (soonest deadline first), then everything else newest first.
  const rank = (x: Notification) => (x.severity === "action" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? (a.deadline ?? 0) - (b.deadline ?? 0) : b.at - a.at));
}

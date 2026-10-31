import { useEffect, useState } from "react";
import type { DashboardOverview } from "../api";
import { stakeAsJuror, withdrawJurorStake } from "../contracts/member";
import { contractErrorMessage } from "../contracts/errors";

interface JuryDutyProps {
  account: string | null;
  ready: boolean;
  overview: DashboardOverview | null;
  onChanged(): void;
}

function errorText(error: unknown) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) {
    return "Request cancelled in your wallet.";
  }
  const reverted = contractErrorMessage(error);
  if (reverted) return reverted;
  if (error && typeof error === "object" && "shortMessage" in error) return String(error.shortMessage);
  return error instanceof Error ? error.message : "The transaction could not be completed.";
}

const money = (value: string) => Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * Opting in to jury duty. A member locks a small stake to be picked for juries. Jurors whose amount
 * agrees with the jury's outcome share a fee; jurors who never reveal lose part of their stake.
 */
export function JuryDuty({ account, ready, overview, onChanged }: JuryDutyProps) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setFeedback("");
    setError("");
  }, [account]);

  if (!overview || !account) return null;
  const symbol = overview.tokenSymbol;
  const stake = Number(overview.jurorStake);
  const minimum = Number(overview.minJurorStake);
  const topUp = Math.max(0, minimum - stake);

  async function run(action: "stake" | "withdraw") {
    if (!account || !overview) return;
    setBusy(true);
    setError("");
    try {
      if (action === "stake") await stakeAsJuror(account, String(topUp || minimum), overview.tokenDecimals, setFeedback);
      else await withdrawJurorStake(account, setFeedback);
      setFeedback(action === "stake" ? "Stake locked. You can now be picked for juries." : "Stake withdrawn. You will not be picked for new juries.");
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
      setFeedback("");
    } finally {
      setBusy(false);
    }
  }

  return <section className="jury-duty" aria-label="Jury duty">
    <div>
      <span className="eyebrow">JURY DUTY</span>
      <h3>{!overview.jurorStaked
        ? stake > 0 ? "Top up your stake to keep serving" : "Lock a stake to join juries"
        : !overview.active ? "Your stake is in, but you need active coverage to be picked"
          : !overview.pastWaitingPeriod ? "You can be picked once your waiting period ends"
            : "You can be picked for juries"}</h3>
      <p className="muted">
        Jurors lock {money(overview.minJurorStake)} {symbol}. If your amount is close to the jury's final figure (within 10%
        of what was asked: on a 300 claim settling at 180, anything from 150 to 210), or you voted to reject a rejected claim,
        you share a fee of 2% of the claim. Not revealing your vote costs 5 {symbol} of your stake. Voting against the
        majority costs nothing.
      </p>
    </div>
    <div className="jury-duty-actions">
      <strong>{money(overview.jurorStake)} <small>{symbol} staked</small></strong>
      {overview.activeJuries > 0 && <small>On {overview.activeJuries} jur{overview.activeJuries === 1 ? "y" : "ies"} now: locked until voting closes.</small>}
      {!overview.jurorStaked && <button className="primary" type="button" disabled={!ready || busy || !overview.active} onClick={() => void run("stake")}>{busy ? "Please wait…" : `Stake ${money(String(topUp || minimum))} ${symbol}`}</button>}
      {stake > 0 && <button className="text-button" type="button" disabled={!ready || busy || overview.activeJuries > 0} onClick={() => void run("withdraw")}>Withdraw stake</button>}
      {!overview.active && <small>Only members with active coverage are picked.</small>}
    </div>
    {feedback && <p className="notice" role="status">{feedback}</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
  </section>;
}

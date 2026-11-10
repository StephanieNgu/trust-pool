import { displayAmount } from "../claims/presentation";
import { useEffect, useState, type FormEvent } from "react";
import type { DashboardOverview } from "../api";
import { contributeToPool } from "../contracts/member";
import { contractErrorMessage } from "../contracts/errors";

interface PoolPageProps {
  account: string | null;
  ready: boolean;
  overview: DashboardOverview | null;
  onContributed(hash: string, amount: string): void;
}

function money(value?: string) {
  return value === undefined ? "—" : displayAmount(value);
}

function errorText(error: unknown) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) {
    return "Request cancelled in your wallet. No contribution was made.";
  }
  const reverted = contractErrorMessage(error);
  if (reverted) return reverted;
  if (error && typeof error === "object" && "shortMessage" in error) return String(error.shortMessage);
  return error instanceof Error ? error.message : "The contribution could not be completed.";
}

export function PoolPage({ account, ready, overview, onContributed }: PoolPageProps) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const tokenSymbol = overview?.tokenSymbol ?? "mUSDC";

  useEffect(() => {
    setAmount("");
    setFeedback("");
    setError("");
    setConfirming(false);
  }, [account]);

  async function contribute(event: FormEvent) {
    event.preventDefault();
    if (!account || !overview || !ready) return;
    if (!confirming) { setConfirming(true); return; }
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      const hash = await contributeToPool(account, amount, overview.tokenDecimals, setFeedback);
      onContributed(hash, amount);
      setAmount("");
      setConfirming(false);
      setFeedback("Contribution confirmed. The shared pool balance has been updated.");
    } catch (cause) {
      setError(errorText(cause));
      setFeedback("");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return <div className="pool-layout">
    <section className="pool-overview" aria-label="Community pool overview">
      <span className="eyebrow">SHARED PROTECTION</span>
      <h2>One pool, backed by its members.</h2>
      <p className="muted">Contributions increase the funds available for approved claims. They are voluntary and cannot be withdrawn.</p>
      <div className="pool-stat-grid">
        <div><span>Pool balance</span><strong>{money(overview?.pool)} {tokenSymbol}</strong></div>
        <div><span>Set aside for approved claims</span><strong>{money(overview?.reserved)} {tokenSymbol}</strong></div>
        <div><span>Your contributions</span><strong>{money(overview?.contributed)} {tokenSymbol}</strong></div>
        <div><span>Total contributed</span><strong>{money(overview?.totalContributed)} {tokenSymbol}</strong></div>
        <div><span>Total paid out</span><strong>{money(overview?.totalPaidOut)} {tokenSymbol}</strong></div>
        <div><span>Members</span><strong>{overview?.holderCount ?? "—"}</strong></div>
        <div><span>Policies issued</span><strong>{overview?.policyCount ?? "—"}</strong></div>
        <div><span>Claims submitted</span><strong>{overview?.claimCount ?? "—"}</strong></div>
      </div>
      <p className="pool-cap-note">The current per-claim payout cap is {money(overview?.cap)} {tokenSymbol}, equal to {overview?.maxPayoutBps ? overview.maxPayoutBps / 100 : "—"}% of the live pool balance. Money already offered to a claim is set aside until it is paid, so two claims are never promised the same funds.</p>
      <div className={`keeper-health ${overview?.keeperRunning ? "healthy" : "warning"}`}><strong>Keeper {overview?.keeperRunning ? "online" : "offline"} · automatic recovery {overview?.keeperAutoResolve ? "enabled" : "disabled"}</strong><span>{overview?.keeperLastError ? overview.keeperLastError : overview?.keeperLastTickAt ? `Last successful pass ${new Date(overview.keeperLastTickAt).toLocaleTimeString()}` : "No completed pass reported"}</span></div>
    </section>

    <form className="purchase-card contribution-card" onSubmit={(event) => void contribute(event)}>
      <span className="eyebrow">CONTRIBUTE</span>
      <h2>Support the community pool.</h2>
      <p className="muted">Choose an amount from your wallet. Token approval may be required before the contribution transaction.</p>
      <label htmlFor="contribution-amount">Contribution amount</label>
      <div className="amount-input"><input id="contribution-amount" type="number" min="0.000001" step="0.000001" max={overview?.balance} value={amount} onChange={(event) => { setAmount(event.target.value); setConfirming(false); }} placeholder="0.00" required disabled={busy || confirming} /><span>{tokenSymbol}</span></div>
      <small>Available balance: {money(overview?.balance)} {tokenSymbol}</small>
      {confirming ? <div className="contribution-confirm">
        <p className="notice warning">You are contributing <strong>{money(amount)} {tokenSymbol}</strong>. This becomes shared pool money and cannot be withdrawn.</p>
        <div><button className="text-button" type="button" disabled={busy} onClick={() => setConfirming(false)}>Go back</button><button className="primary" type="submit" disabled={busy}>{busy ? "Transaction in progress…" : "Confirm contribution"}</button></div>
      </div> : <button className="primary full" type="submit" disabled={!ready || busy || !amount}>Contribute to pool</button>}
      <p className="contribution-warning">Contributions become shared pool funds and are not refundable.</p>
      {feedback && <p className="notice" role="status">{feedback}</p>}
      {error && <p className="notice warning" role="alert">{error}</p>}
    </form>
  </div>;
}

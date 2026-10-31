import { useEffect, useState } from "react";
import type { DashboardOverview } from "../api";
import { cancelCoverage } from "../contracts/member";
import { contractErrorMessage } from "../contracts/errors";

interface PolicyActionsProps {
  account: string;
  ready: boolean;
  overview: DashboardOverview;
  onCancelled(hash: string): void;
}

function errorText(error: unknown) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) {
    return "Request cancelled in your wallet. Your coverage remains active.";
  }
  const reverted = contractErrorMessage(error);
  if (reverted) return reverted;
  if (error && typeof error === "object" && "shortMessage" in error) return String(error.shortMessage);
  return error instanceof Error ? error.message : "The coverage cancellation could not be completed.";
}

export function PolicyActions({ account, ready, overview, onCancelled }: PolicyActionsProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setConfirming(false);
    setFeedback("");
    setError("");
  }, [account, overview.policyId]);

  async function cancel() {
    if (!ready || overview.openClaimId) return;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      const hash = await cancelCoverage(account, setFeedback);
      setFeedback("Coverage cancelled successfully.");
      onCancelled(hash);
    } catch (cause) {
      setError(errorText(cause));
      setFeedback("");
    } finally {
      setBusy(false);
    }
  }

  if (overview.openClaimId) {
    return <div className="policy-action-locked"><button className="policy-cancel-link" type="button" disabled>Cancel coverage</button><p className="policy-action-note">Locked while Claim #{overview.openClaimId} is open.</p></div>;
  }

  if (!confirming) {
    return <button className="policy-cancel-link" type="button" disabled={!ready} onClick={() => setConfirming(true)}>Cancel coverage</button>;
  }

  return <div className="policy-cancel-confirm" role="group" aria-label="Confirm coverage cancellation">
    <strong>End this coverage?</strong>
    <p>You will lose claim eligibility and jury eligibility immediately. Paid premiums are not refunded.</p>
    <div><button className="text-button" type="button" disabled={busy} onClick={() => setConfirming(false)}>Keep coverage</button><button className="danger-button" type="button" disabled={busy} onClick={() => void cancel()}>{busy ? "Cancelling…" : "Confirm cancellation"}</button></div>
    {feedback && <p className="notice" role="status">{feedback}</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
  </div>;
}

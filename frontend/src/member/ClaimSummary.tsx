import { useEffect, useState } from "react";
import { getClaimsForMember, type ClaimView } from "../api";
import { CLAIM_STATE_COPY, dateTime, formatAmount } from "../claims/presentation";

interface ClaimSummaryProps {
  account: string;
  ready: boolean;
  refresh: number;
  openClaimId: string | null;
  canFile: boolean;
  tokenDecimals: number;
  tokenSymbol: string;
  onOpenClaim(claimId: string): void;
  onFileClaim(): void;
}

/** What the claimant needs to do next on a claim, or null when it is waiting on someone else. */
function nextStep(claim: ClaimView): string | null {
  if (claim.state === "Offered") return "Accept or withdraw the jury's offer.";
  if (claim.state === "Approved" && !claim.receipt?.hash) return "Upload your repair or replacement receipt to get paid.";
  return null;
}

function statusLine(claim: ClaimView, tokenDecimals: number, tokenSymbol: string): string {
  const amount = (value: string) => `${formatAmount(value, tokenDecimals)} ${tokenSymbol}`;
  switch (claim.state) {
    case "Submitted":
    case "JuryPending": return "A jury is being picked.";
    case "Voting": return `The jury is voting: ${claim.jury ? `${claim.jury.commits} of ${claim.jury.jurors.length} have voted` : "votes are sealed"}.`;
    case "Offered": return `The jury offered ${amount(claim.payoutAmount)} of the ${amount(claim.amount)} you asked for.`;
    case "Approved": return claim.receipt?.hash ? `Paying ${amount(claim.payoutAmount)} against your receipt.` : `Approved for up to ${amount(claim.payoutAmount)}.`;
    case "Paid": return `${amount(claim.paidAmount)} was paid to your wallet.`;
    case "Rejected": return "The jury rejected this claim.";
    case "Withdrawn": return "You withdrew this claim.";
    case "Expired": return "No receipt arrived in time, so nothing was paid.";
    case "Cancelled": return "No jury could be picked, so the claim was cancelled and the bond returned.";
  }
}

/** The member's open claim (or latest one) on the dashboard, with what happens next. */
export function ClaimSummary({ account, ready, refresh, openClaimId, canFile, tokenDecimals, tokenSymbol, onOpenClaim, onFileClaim }: ClaimSummaryProps) {
  const [claims, setClaims] = useState<ClaimView[] | null>(null);

  useEffect(() => {
    let active = true;
    setClaims(null);
    if (!ready) return () => { active = false; };
    void getClaimsForMember(account).then((items) => { if (active) setClaims(items); }).catch(() => { if (active) setClaims([]); });
    return () => { active = false; };
  }, [account, ready, refresh, openClaimId]);

  const claim = claims?.find((item) => item.id === openClaimId) ?? claims?.[0] ?? null;
  const step = claim ? nextStep(claim) : null;
  return <article className="how-card claim-summary">
    <span className="eyebrow">{claim && claim.id === openClaimId ? "YOUR OPEN CLAIM" : "YOUR CLAIMS"}</span>
    {claims === null ? <p className="muted">Loading your claims…</p> : !claim ? <>
      <h3>No claims yet.</h3>
      <p className="muted">If your device is damaged, lost or stolen, file a claim with photos. A jury of five members decides how much to pay.</p>
      {canFile && <button className="primary" type="button" onClick={onFileClaim}>File a claim</button>}
    </> : <>
      <div className="claim-summary-heading"><h3>Claim #{claim.id}</h3><span className={`claim-status state-${claim.state.toLowerCase()}`}>{CLAIM_STATE_COPY[claim.state]}</span></div>
      <p className="claim-summary-status">{statusLine(claim, tokenDecimals, tokenSymbol)}</p>
      {step && <p className="notice">{step}</p>}
      <small className="muted">Filed {dateTime(claim.submittedAt)}{claims.length > 1 ? ` · ${claims.length} claims in all` : ""}</small>
      <div className="claim-summary-actions">
        <button className={step ? "primary" : "text-button"} type="button" onClick={() => onOpenClaim(claim.id)}>{step ? "Open claim" : "View claim →"}</button>
        {canFile && claim.id !== openClaimId && <button className="text-button" type="button" onClick={onFileClaim}>File a new claim</button>}
      </div>
    </>}
  </article>;
}

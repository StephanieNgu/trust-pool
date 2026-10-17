import { formatUnits } from "ethers";
import { useEffect, useState } from "react";
import { getClaim, type ClaimDetailView, type ClaimJury } from "../api";
import { CLAIM_STATE_COPY, dateTime, shortHash } from "./presentation";

interface ClaimDetailProps {
  claimId: string;
  account: string;
  tokenDecimals: number;
  tokenSymbol: string;
  onBack(): void;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Could not load this claim.";
}

function outcomeCopy(reason: ClaimJury["outcomeReason"]) {
  if (reason === "majorityApproved") return "Majority approved";
  if (reason === "majorityRejected") return "Majority rejected";
  if (reason === "noQuorum") return "Rejected: quorum not met";
  if (reason === "tie") return "Rejected: tied vote";
  return "Pending";
}

export function ClaimDetail({ claimId, account, tokenDecimals, tokenSymbol, onBack }: ClaimDetailProps) {
  const [claim, setClaim] = useState<ClaimDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void getClaim(claimId)
      .then((value) => { if (active) setClaim(value); })
      .catch((cause) => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [claimId, refresh]);

  if (loading && !claim) return <section className="claims-panel"><p className="muted" role="status">Loading claim #{claimId}…</p></section>;
  if (error && !claim) return <section className="claims-panel"><button className="text-button" type="button" onClick={onBack}>← Back</button><p className="notice warning" role="alert">{error}</p></section>;
  if (!claim) return null;

  const jury = claim.jury;
  const currentJuror = jury?.jurors.find((juror) => juror.address.toLowerCase() === account.toLowerCase());
  return <section className="claims-panel claim-detail" aria-label={`Claim ${claim.id} details`}>
    <div className="claims-panel-heading"><div><button className="text-button detail-back" type="button" onClick={onBack}>← Back to list</button><h2>Claim #{claim.id}</h2></div><button className="text-button" type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>Refresh</button></div>
    {error && <p className="notice warning" role="alert">{error}</p>}
    <div className="detail-hero"><div><span className="eyebrow">REQUESTED PAYOUT</span><strong>{formatUnits(claim.amount, tokenDecimals)} <small>{tokenSymbol}</small></strong></div><span className={`claim-status state-${claim.state.toLowerCase()}`}>{CLAIM_STATE_COPY[claim.state]}</span></div>

    <dl className="detail-grid">
      <div><dt>Policy</dt><dd>#{claim.policyId}</dd></div>
      <div><dt>Submitted</dt><dd>{dateTime(claim.submittedAt)}</dd></div>
      <div><dt>Coverage limit</dt><dd>{formatUnits(claim.coverageLimit, tokenDecimals)} {tokenSymbol}</dd></div>
      <div><dt>Current payout</dt><dd>{formatUnits(claim.payoutAmount, tokenDecimals)} {tokenSymbol}</dd></div>
      <div className="detail-wide"><dt>Evidence hash</dt><dd title={claim.evidenceHash}>{claim.evidenceHash}</dd></div>
      <div><dt>Evidence stored</dt><dd>{claim.evidence.available ? "Available to authorized wallets" : "Not found in backend"}</dd></div>
      <div><dt>Your role</dt><dd>{claim.claimant.toLowerCase() === account.toLowerCase() ? "Claimant" : currentJuror ? "Selected juror" : "Observer"}</dd></div>
    </dl>

    <div className="detail-section-heading"><div><span className="eyebrow">COMMUNITY REVIEW</span><h3>Jury</h3></div>{jury && <span>{jury.commits} committed · {jury.approvals + jury.rejections} revealed</span>}</div>
    {!jury ? <p className="muted">A jury has not been requested for this claim.</p> : <>
      <dl className="detail-grid compact"><div><dt>Phase</dt><dd>{jury.phase}</dd></div><div><dt>Outcome</dt><dd>{outcomeCopy(jury.outcomeReason)}</dd></div><div><dt>Commit deadline</dt><dd>{dateTime(jury.commitDeadline)}</dd></div><div><dt>Reveal deadline</dt><dd>{dateTime(jury.revealDeadline)}</dd></div></dl>
      <div className="juror-list">{jury.jurors.map((juror, index) => <div className={juror.address.toLowerCase() === account.toLowerCase() ? "juror-row current" : "juror-row"} key={juror.address}><span><b>{index + 1}</b><code title={juror.address}>{shortHash(juror.address)}</code>{juror.address.toLowerCase() === account.toLowerCase() && <small>You</small>}</span><span>{juror.revealed ? "Revealed" : juror.committed ? "Committed" : "Waiting"}</span></div>)}</div>
    </>}
  </section>;
}

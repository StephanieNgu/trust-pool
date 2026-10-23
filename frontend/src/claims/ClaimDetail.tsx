import { formatUnits } from "ethers";
import { useEffect, useState } from "react";
import { getClaim, type ClaimDetailView, type ClaimJury } from "../api";
import { readChainTimestamp } from "../contracts/jury";
import { cancelStalledClaim, executeClaimPayout, finalizeClaim } from "../contracts/claims";
import { JuryVotePanel } from "./JuryVotePanel";
import { JuryReasoning, OfferPanel } from "./OfferPanel";
import { EvidenceViewer } from "./EvidenceViewer";
import { CLAIM_STATE_COPY, dateTime, shortHash } from "./presentation";

interface ClaimDetailProps {
  claimId: string;
  account: string;
  tokenDecimals: number;
  tokenSymbol: string;
  enableJurorActions?: boolean;
  onAuthenticated?(): void;
  onClaimChanged?(): void;
  onBack(): void;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Could not load this claim.";
}

function outcomeCopy(reason: ClaimJury["outcomeReason"]) {
  if (reason === "majorityApproved") return "Majority would pay";
  if (reason === "majorityRejected") return "Majority rejected";
  if (reason === "noQuorum") return "Rejected: quorum not met";
  if (reason === "tie") return "Rejected: tied vote";
  return "Pending";
}

function DeviceCheck({ check }: { check: ClaimDetailView["deviceCheck"] }) {
  const badge = (value: boolean | null, yes: string, no: string, unknown: string) =>
    <span className={value === null ? "" : value ? "match" : "mismatch"}>{value === null ? unknown : value ? `✓ ${yes}` : `⚠ ${no}`}</span>;
  return <div className="imei-checks" aria-label="Automatic device checks">
    {badge(check.enrollmentMatchesPolicy, "Signup details match the policy", "Signup details do not match the policy", "No signup details on record")}
    {badge(check.claimMatchesEnrollment, "Claim IMEI or serial matches signup", "Claim IMEI or serial differs from signup", "No IMEI or serial given with the claim")}
  </div>;
}

export function ClaimDetail({ claimId, account, tokenDecimals, tokenSymbol, enableJurorActions = false, onAuthenticated, onClaimChanged, onBack }: ClaimDetailProps) {
  const [claim, setClaim] = useState<ClaimDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [chainTimestamp, setChainTimestamp] = useState<number | null>(null);
  const [chainTimeError, setChainTimeError] = useState("");
  const [evidenceVerified, setEvidenceVerified] = useState(false);
  const [resolutionBusy, setResolutionBusy] = useState(false);
  const [resolutionFeedback, setResolutionFeedback] = useState("");
  const [resolutionError, setResolutionError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void getClaim(claimId)
      .then((value) => { if (active) setClaim(value); })
      .catch((cause) => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    setChainTimeError("");
    void readChainTimestamp()
      .then((value) => { if (active) setChainTimestamp(value); })
      .catch((cause) => { if (active) { setChainTimestamp(null); setChainTimeError(errorText(cause)); } });
    return () => { active = false; };
  }, [claimId, refresh]);

  useEffect(() => {
    setEvidenceVerified(false);
  }, [account, claimId]);

  useEffect(() => {
    const timer = window.setInterval(() => setRefresh((value) => value + 1), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  if (loading && !claim) return <section className="claims-panel"><p className="muted" role="status">Loading claim #{claimId}…</p></section>;
  if (error && !claim) return <section className="claims-panel"><button className="text-button" type="button" onClick={onBack}>← Back</button><p className="notice warning" role="alert">{error}</p></section>;
  if (!claim) return null;

  const jury = claim.jury;
  const currentJuror = jury?.jurors.find((juror) => juror.address.toLowerCase() === account.toLowerCase());
  const canFinalize = claim.state === "Voting" && Boolean(jury?.canTally);
  const canExecutePayout = claim.state === "Approved";
  const canCancelStalled = claim.state === "JuryPending" && chainTimestamp !== null && Boolean(jury?.cancelAvailableAt && chainTimestamp > jury.cancelAvailableAt);

  async function resolve(action: "finalize" | "payout" | "cancel") {
    setResolutionBusy(true);
    setResolutionError("");
    setResolutionFeedback("");
    try {
      if (action === "finalize") await finalizeClaim(account, claimId, setResolutionFeedback);
      else if (action === "payout") await executeClaimPayout(account, claimId, setResolutionFeedback);
      else await cancelStalledClaim(account, claimId, setResolutionFeedback);
      setResolutionFeedback("Protocol recovery action confirmed.");
      setRefresh((value) => value + 1);
      onClaimChanged?.();
    } catch (cause) {
      setResolutionError(errorText(cause));
      setResolutionFeedback("");
    } finally {
      setResolutionBusy(false);
    }
  }
  return <section className="claims-panel claim-detail" aria-label={`Claim ${claim.id} details`}>
    <div className="claims-panel-heading"><div><button className="text-button detail-back" type="button" onClick={onBack}>← Back to list</button><h2>Claim #{claim.id}</h2></div><button className="text-button" type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>Refresh</button></div>
    {error && <p className="notice warning" role="alert">{error}</p>}
    <div className="detail-hero"><div><span className="eyebrow">REQUESTED PAYOUT</span><strong>{formatUnits(claim.amount, tokenDecimals)} <small>{tokenSymbol}</small></strong></div><span className={`claim-status state-${claim.state.toLowerCase()}`}>{CLAIM_STATE_COPY[claim.state]}</span></div>

    <dl className="detail-grid">
      <div><dt>Policy</dt><dd>#{claim.policyId}</dd></div>
      <div><dt>Submitted</dt><dd>{dateTime(claim.submittedAt)}</dd></div>
      <div><dt>Coverage limit</dt><dd>{formatUnits(claim.coverageLimit, tokenDecimals)} {tokenSymbol}</dd></div>
      <div><dt>{claim.jury?.phase === "Tallied" ? "Jury's offer" : "Payout if approved in full"}</dt><dd>{formatUnits(claim.payoutAmount, tokenDecimals)} {tokenSymbol}</dd></div>
      {claim.offerDeadline && <div><dt>Claimant responds by</dt><dd>{dateTime(claim.offerDeadline)}</dd></div>}
      <div className="detail-wide"><dt>Evidence hash</dt><dd title={claim.evidenceHash}>{claim.evidenceHash}</dd></div>
      <div><dt>Evidence stored</dt><dd>{claim.evidence.available ? "Available to authorized wallets" : "Not found in backend"}</dd></div>
      <div><dt>Your role</dt><dd>{claim.claimant.toLowerCase() === account.toLowerCase() ? "Claimant" : currentJuror ? "Selected juror" : "Observer"}</dd></div>
    </dl>

    <OfferPanel claim={claim} account={account} chainTimestamp={chainTimestamp} tokenDecimals={tokenDecimals} tokenSymbol={tokenSymbol} onAuthenticated={onAuthenticated} onChanged={() => { setRefresh((value) => value + 1); onClaimChanged?.(); }} />

    <div className="detail-section-heading"><div><span className="eyebrow">SAME DEVICE?</span><h3>Signup photos and claim photos</h3></div></div>
    <p className="muted">Check that the claim photos show the device registered at signup (same model, colour and marks), that the damage is real, and that the first claim photo shows its capture code.</p>
    <DeviceCheck check={claim.deviceCheck} />
    <div className="evidence-compare">
      <EvidenceViewer account={account} claim={claim} source="enrollment" onAuthenticated={onAuthenticated} />
      <EvidenceViewer account={account} claim={claim} onAuthenticated={onAuthenticated} onVerificationChange={setEvidenceVerified} />
    </div>

    <div className="detail-section-heading"><div><span className="eyebrow">COMMUNITY REVIEW</span><h3>Jury</h3></div>{jury && <span>{jury.commits} committed · {jury.approvals + jury.rejections} revealed</span>}</div>
    {!jury ? <p className="muted">A jury has not been requested for this claim.</p> : <>
      <dl className="detail-grid compact"><div><dt>Phase</dt><dd>{jury.phase}</dd></div><div><dt>Outcome</dt><dd>{outcomeCopy(jury.outcomeReason)}</dd></div><div><dt>Quorum</dt><dd>{jury.approvals + jury.rejections} / {jury.quorum} revealed</dd></div><div><dt>Vote tally</dt><dd>{jury.revealOpen || jury.phase === "Tallied" ? `${jury.approvals} would pay · ${jury.rejections} reject` : "Sealed until reveal"}</dd></div><div><dt>Commit deadline</dt><dd>{dateTime(jury.commitDeadline)}</dd></div><div><dt>Reveal deadline</dt><dd>{dateTime(jury.revealDeadline)}</dd></div>{jury.cancelAvailableAt && <div className="detail-wide"><dt>Randomness timeout</dt><dd>{dateTime(jury.cancelAvailableAt)}</dd></div>}</dl>
      {chainTimeError && <p className="notice warning">Could not synchronize blockchain time: {chainTimeError}</p>}
      <div className="juror-list">{jury.jurors.map((juror, index) => <div className={juror.address.toLowerCase() === account.toLowerCase() ? "juror-row current" : "juror-row"} key={juror.address}><span><b>{index + 1}</b><code title={juror.address}>{shortHash(juror.address)}</code>{juror.address.toLowerCase() === account.toLowerCase() && <small>You</small>}</span><span>{juror.revealed ? (juror.amount === "0" ? "Rejects" : `Pays ${formatUnits(juror.amount ?? "0", tokenDecimals)}`) : juror.committed ? "Sealed" : "Waiting"}{juror.reward && juror.reward !== "0" && <small className="juror-reward">+{formatUnits(juror.reward, tokenDecimals)} fee</small>}{juror.penalty && juror.penalty !== "0" && <small className="juror-penalty">−{formatUnits(juror.penalty, tokenDecimals)} no-show</small>}</span></div>)}</div>
      {enableJurorActions && <JuryVotePanel claim={claim} account={account} chainTimestamp={chainTimestamp} evidenceVerified={evidenceVerified} tokenDecimals={tokenDecimals} tokenSymbol={tokenSymbol} onAuthenticated={onAuthenticated} onChanged={() => { setRefresh((value) => value + 1); onClaimChanged?.(); }} />}
      {claim.state !== "Offered" && <JuryReasoning claim={claim} account={account} tokenDecimals={tokenDecimals} tokenSymbol={tokenSymbol} onAuthenticated={onAuthenticated} />}
    </>}
    {(canFinalize || canExecutePayout || canCancelStalled) && <section className="recovery-panel"><span className="eyebrow">PERMISSIONLESS RECOVERY</span><h3>Keeper fallback</h3><p>Anyone may submit this transaction if the automatic keeper has not moved the claim forward.</p>{canFinalize && <button className="primary" type="button" disabled={resolutionBusy} onClick={() => void resolve("finalize")}>Finalize jury result</button>}{canExecutePayout && <button className="primary" type="button" disabled={resolutionBusy} onClick={() => void resolve("payout")}>Execute approved payout</button>}{canCancelStalled && <button className="danger-button" type="button" disabled={resolutionBusy} onClick={() => void resolve("cancel")}>Cancel stalled claim</button>}{resolutionFeedback && <p className="notice" role="status">{resolutionFeedback}</p>}{resolutionError && <p className="notice warning" role="alert">{resolutionError}</p>}</section>}
  </section>;
}

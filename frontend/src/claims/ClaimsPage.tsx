import { formatUnits, parseUnits } from "ethers";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ALLOWED_EVIDENCE_TYPES,
  getClaimsForMember,
  uploadEvidence,
  type ClaimView,
  type DashboardOverview,
} from "../api";
import { submitClaim } from "../contracts/claims";
import { ClaimDetail } from "./ClaimDetail";
import { CLAIM_STATE_COPY, dateTime, shortHash } from "./presentation";

interface ClaimsPageProps {
  account: string | null;
  ready: boolean;
  overview: DashboardOverview | null;
  onAuthenticated(): void;
  onSubmitted(): void;
}

function message(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) {
    return "Request cancelled in your wallet. You can try again.";
  }
  if (error && typeof error === "object" && "shortMessage" in error) return String(error.shortMessage);
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function fileSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ClaimsPage({ account, ready, overview, onAuthenticated, onSubmitted }: ClaimsPageProps) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [claims, setClaims] = useState<ClaimView[]>([]);
  const [loadingClaims, setLoadingClaims] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [claimRefresh, setClaimRefresh] = useState(0);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    setClaims([]);
    setError("");
    if (!account || !ready) return () => { active = false; };
    setLoadingClaims(true);
    void getClaimsForMember(account)
      .then((items) => { if (active) setClaims(items); })
      .catch((cause) => { if (active) setError(message(cause)); })
      .finally(() => { if (active) setLoadingClaims(false); });
    return () => { active = false; };
  }, [account, ready, claimRefresh]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!account || !overview || !ready) return;
    if (!overview.active) { setError("Buy device coverage before submitting a claim."); return; }
    if (!overview.pastWaitingPeriod) { setError("Your policy waiting period has not ended yet."); return; }
    if (overview.openClaimId) { setError(`Policy already has open claim #${overview.openClaimId}.`); return; }
    try {
      const requested = parseUnits(amount, overview.tokenDecimals);
      const coverage = parseUnits(overview.coverage, overview.tokenDecimals);
      if (requested <= 0n || requested > coverage) {
        setError(`Enter an amount between 0 and ${overview.coverage} ${overview.tokenSymbol}.`);
        return;
      }
    } catch {
      setError(`Enter a valid amount with no more than ${overview.tokenDecimals} decimal places.`);
      return;
    }

    setBusy(true);
    setError("");
    setFeedback("Preparing evidence for secure upload…");
    try {
      const evidence = await uploadEvidence(account, description.trim(), files);
      onAuthenticated();
      setFeedback(`Evidence uploaded (${shortHash(evidence.evidenceHash)}).`);
      await submitClaim(account, amount, overview.tokenDecimals, evidence.evidenceHash, setFeedback);
      setFeedback("Claim submitted successfully. The keeper will select a jury next.");
      setAmount("");
      setDescription("");
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      setClaimRefresh((value) => value + 1);
      onSubmitted();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = Boolean(
    ready && overview?.active && overview.pastWaitingPeriod && !overview.openClaimId && amount && files.length,
  );
  const accepted = ALLOWED_EVIDENCE_TYPES.join(",");

  return <div className="claims-layout">
    <form className="purchase-card claim-form" onSubmit={(event) => void submit(event)}>
      <span className="eyebrow">SUBMIT A CLAIM</span>
      <h2>Tell the pool what happened.</h2>
      <p className="muted">Your evidence is encrypted by the backend. Only you and selected jurors can access it.</p>

      {!overview?.active && <p className="notice warning">An active device policy is required.</p>}
      {overview?.active && !overview.pastWaitingPeriod && overview.claimEligibleAt && <p className="notice warning">Claims become available on {new Date(overview.claimEligibleAt * 1000).toLocaleString()}.</p>}
      {overview?.openClaimId && <p className="notice warning">Claim #{overview.openClaimId} is already open for this policy.</p>}

      <label htmlFor="claim-amount">Requested payout</label>
      <div className="amount-input"><input id="claim-amount" type="number" min="0.000001" step="0.000001" max={overview?.coverage} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required disabled={busy} /><span>{overview?.tokenSymbol ?? "mUSDC"}</span></div>
      <small>Maximum: {overview?.active ? `${Number(overview.coverage).toLocaleString()} ${overview.tokenSymbol}` : "—"}</small>

      <label htmlFor="claim-description">What happened?</label>
      <textarea id="claim-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe the damage, loss, and when it occurred." maxLength={2000} rows={5} disabled={busy} />
      <small>{description.length}/2,000 characters</small>

      <label htmlFor="claim-files">Evidence files</label>
      <input ref={fileInput} id="claim-files" className="file-input" type="file" accept={accepted} multiple required disabled={busy} onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
      <small>1–10 JPEG, PNG, WebP, GIF, HEIC or PDF files. Maximum 5 MB each.</small>
      {files.length > 0 && <ul className="file-list">{files.map((file, index) => <li key={`${file.name}-${file.lastModified}-${index}`}><span><strong>{file.name}</strong><small>{fileSize(file.size)}</small></span><button type="button" disabled={busy} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}>Remove</button></li>)}</ul>}

      <button className="primary full" type="submit" disabled={!canSubmit || busy}>{busy ? "Submitting claim…" : "Upload evidence & submit claim"}</button>
      {feedback && <p className="notice" role="status">{feedback}</p>}
      {error && <p className="notice warning" role="alert">{error}</p>}
    </form>

    {selectedClaimId && account ? <ClaimDetail claimId={selectedClaimId} account={account} tokenDecimals={overview?.tokenDecimals ?? 6} tokenSymbol={overview?.tokenSymbol ?? "mUSDC"} onBack={() => setSelectedClaimId(null)} /> : <section className="claims-panel" aria-label="My claims">
      <div className="claims-panel-heading"><div><span className="eyebrow">ON-CHAIN HISTORY</span><h2>My claims</h2></div><button className="text-button" type="button" disabled={!ready || loadingClaims} onClick={() => setClaimRefresh((value) => value + 1)}>Refresh</button></div>
      {loadingClaims && <p className="muted" role="status">Loading claims from the backend…</p>}
      {!loadingClaims && claims.length === 0 && <div className="empty-claims"><strong>No claims yet</strong><p>Your submitted claims and their jury status will appear here.</p></div>}
      <div className="claim-list">{claims.map((claim) => <article className="claim-item" key={claim.id}>
        <div className="claim-item-heading"><div><span>CLAIM #{claim.id}</span><h3>{formatUnits(claim.amount, overview?.tokenDecimals ?? 6)} {overview?.tokenSymbol ?? "mUSDC"}</h3></div><span className={`claim-status state-${claim.state.toLowerCase()}`}>{CLAIM_STATE_COPY[claim.state]}</span></div>
        <dl><div><dt>Submitted</dt><dd>{dateTime(claim.submittedAt)}</dd></div><div><dt>Evidence</dt><dd title={claim.evidenceHash}>{shortHash(claim.evidenceHash)}</dd></div>{claim.state === "Approved" || claim.state === "Paid" ? <div><dt>Payout</dt><dd>{formatUnits(claim.payoutAmount, overview?.tokenDecimals ?? 6)} {overview?.tokenSymbol ?? "mUSDC"}</dd></div> : null}{claim.jury && <div><dt>Jury progress</dt><dd>{claim.jury.commits} committed · {claim.jury.approvals + claim.jury.rejections} revealed</dd></div>}</dl>
        <button className="text-button claim-detail-link" type="button" onClick={() => setSelectedClaimId(claim.id)}>View details →</button>
      </article>)}</div>
    </section>}
  </div>;
}

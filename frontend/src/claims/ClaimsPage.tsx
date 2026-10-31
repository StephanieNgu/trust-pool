import { formatUnits, parseUnits } from "ethers";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ALLOWED_EVIDENCE_TYPES,
  MAX_AMOUNT_REASON_LENGTH,
  getClaimsForMember,
  uploadEvidence,
  type CaptureCode,
  type ClaimState,
  type ClaimView,
  type DashboardOverview,
} from "../api";
import { CaptureCodePanel } from "../capture/CapturePanel";
import { submitClaim } from "../contracts/claims";
import { claimBond } from "./bond";
import { ClaimDetail } from "./ClaimDetail";
import { CLAIM_STATE_COPY, dateTime, shortHash } from "./presentation";

interface ClaimsPageProps {
  account: string | null;
  ready: boolean;
  overview: DashboardOverview | null;
  onAuthenticated(): void;
  onSubmitted(): void;
  /** A claim to open, e.g. from a notification; a new nonce reopens the same claim. */
  focusClaim?: { id: string; nonce: number } | null;
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

/** The bond for the amount typed, formatted, or null while the amount is not a valid number. */
function bondPreview(amount: string, overview: DashboardOverview | null): string | null {
  if (!overview || !amount) return null;
  try {
    const units = parseUnits(amount, overview.tokenDecimals);
    if (units <= 0n) return null;
    return formatUnits(claimBond(units, overview.claimBondBps, parseUnits(overview.minClaimBond, overview.tokenDecimals)), overview.tokenDecimals);
  } catch {
    return null;
  }
}

export function ClaimsPage({ account, ready, overview, focusClaim, onAuthenticated, onSubmitted }: ClaimsPageProps) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [captureCode, setCaptureCode] = useState<CaptureCode | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [amountReason, setAmountReason] = useState("");
  const [claims, setClaims] = useState<ClaimView[]>([]);
  const [loadingClaims, setLoadingClaims] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [claimsError, setClaimsError] = useState("");
  const [claimRefresh, setClaimRefresh] = useState(0);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<ClaimState | "All">("All");
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setClaims([]);
    setSelectedClaimId(null);
    setClaimsError("");
    setCaptureCode(null);
  }, [account]);

  useEffect(() => {
    if (focusClaim) setSelectedClaimId(focusClaim.id);
  }, [focusClaim]);

  useEffect(() => {
    let active = true;
    setClaimsError("");
    if (!account || !ready) return () => { active = false; };
    setLoadingClaims(true);
    void getClaimsForMember(account, stateFilter === "All" ? undefined : stateFilter)
      .then((items) => { if (active) setClaims(items); })
      .catch((cause) => { if (active) setClaimsError(message(cause)); })
      .finally(() => { if (active) setLoadingClaims(false); });
    return () => { active = false; };
  }, [account, ready, claimRefresh, stateFilter]);

  useEffect(() => {
    if (!account || !ready) return;
    const timer = window.setInterval(() => setClaimRefresh((value) => value + 1), 10_000);
    return () => window.clearInterval(timer);
  }, [account, ready]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!account || !overview || !ready) return;
    if (!overview.active) { setError("Buy device coverage before submitting a claim."); return; }
    if (!overview.pastWaitingPeriod) { setError("Your policy waiting period has not ended yet."); return; }
    if (overview.openClaimId) { setError(`Policy already has open claim #${overview.openClaimId}.`); return; }
    if (!amountReason.trim()) { setError("Explain how you arrived at the amount, so jurors can judge it."); return; }
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
      const evidence = await uploadEvidence(account, description.trim(), files, captureCode?.code ?? "", deviceId, amountReason);
      onAuthenticated();
      setFeedback(`Evidence uploaded (${shortHash(evidence.evidenceHash)}).`);
      await submitClaim(account, amount, overview.tokenDecimals, evidence.evidenceHash, setFeedback);
      setFeedback("Claim submitted successfully. The keeper will select a jury next.");
      setAmount("");
      setDescription("");
      setFiles([]);
      setCaptureCode(null);
      setDeviceId("");
      setAmountReason("");
      if (fileInput.current) fileInput.current.value = "";
      setClaimRefresh((value) => value + 1);
      onSubmitted();
    } catch (cause) {
      setError(message(cause));
      // The code is used up once the upload succeeds or expires; ask for a new one if it was rejected.
      if (cause instanceof Error && /capture code/i.test(cause.message)) setCaptureCode(null);
    } finally {
      setBusy(false);
    }
  }

  const bond = bondPreview(amount, overview);
  const canSubmit = Boolean(
    ready && overview?.active && overview.pastWaitingPeriod && !overview.openClaimId && amount && amountReason.trim() && files.length && captureCode,
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
      {overview && <p className="claim-bond-note">
        <strong>Claim bond: {bond ?? `${overview.claimBondBps / 100}% of your claim, at least ${Number(overview.minClaimBond).toLocaleString()}`} {overview.tokenSymbol}</strong>
        You get it back when the jury decides, less the share of your ask they cut. Paid in full, you get it all back; paid half, half; rejected, none.
      </p>}

      <label htmlFor="claim-amount-reason">How did you arrive at this amount?</label>
      <textarea id="claim-amount-reason" value={amountReason} onChange={(event) => setAmountReason(event.target.value)} placeholder="e.g. The repair shop quoted 280 for a new screen. Add the quote below if you have one." maxLength={MAX_AMOUNT_REASON_LENGTH} rows={3} required disabled={busy} />
      <small>Jurors vote how much to pay, from nothing up to what you ask. A repair quote or price for a replacement helps them agree with your amount.</small>

      <label htmlFor="claim-description">What happened?</label>
      <textarea id="claim-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe the damage, loss, and when it occurred." maxLength={2000} rows={5} disabled={busy} />
      <small>{description.length}/2,000 characters</small>

      <label htmlFor="claim-device-id">IMEI or serial number <span className="muted">(optional)</span></label>
      <input id="claim-device-id" value={deviceId} placeholder="As shown on the device or its label" maxLength={64} disabled={busy} onChange={(event) => setDeviceId(event.target.value)} />
      <small>Checked against the device you registered. If it no longer turns on, photograph its serial label or SIM tray instead.</small>

      <label>Photos of the damage</label>
      <CaptureCodePanel account={account} code={captureCode} disabled={busy || !ready} onCode={setCaptureCode} onAuthenticated={onAuthenticated} />
      {captureCode && <>
        <small>Jurors compare these with the photos you took at signup, so show the whole device, the damage, and your code.</small>
        <div className="capture-buttons">
          <button className="primary" type="button" disabled={busy} onClick={() => cameraInput.current?.click()}>Take a photo</button>
          <button className="text-button" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>Add a repair quote or receipt</button>
        </div>
        <input ref={cameraInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/heic" capture="environment" disabled={busy} onChange={(event) => { const picked = Array.from(event.target.files ?? []); setFiles((current) => [...current, ...picked]); event.target.value = ""; }} />
        <input ref={fileInput} id="claim-files" className="visually-hidden" type="file" accept={accepted} multiple disabled={busy} onChange={(event) => { const picked = Array.from(event.target.files ?? []); setFiles((current) => [...current, ...picked]); event.target.value = ""; }} />
        <small>1–10 JPEG, PNG, WebP, GIF, HEIC or PDF files. Maximum 5 MB each.</small>
      </>}
      {files.length > 0 && <ul className="file-list">{files.map((file, index) => <li key={`${file.name}-${file.lastModified}-${index}`}><span><strong>{file.name}</strong><small>{fileSize(file.size)}</small></span><button type="button" disabled={busy} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}>Remove</button></li>)}</ul>}

      <button className="primary full" type="submit" disabled={!canSubmit || busy}>{busy ? "Submitting claim…" : "Upload evidence & submit claim"}</button>
      {feedback && <p className="notice" role="status">{feedback}</p>}
      {error && <p className="notice warning" role="alert">{error}</p>}
    </form>

    {selectedClaimId && account ? <ClaimDetail claimId={selectedClaimId} account={account} tokenDecimals={overview?.tokenDecimals ?? 6} tokenSymbol={overview?.tokenSymbol ?? "mUSDC"} onAuthenticated={onAuthenticated} onClaimChanged={() => setClaimRefresh((value) => value + 1)} onBack={() => setSelectedClaimId(null)} /> : <section className="claims-panel" aria-label="My claims">
      <div className="claims-panel-heading"><div><span className="eyebrow">ON-CHAIN HISTORY</span><h2>My claims</h2></div><div className="claims-panel-actions"><label htmlFor="claim-state-filter">Status</label><select id="claim-state-filter" value={stateFilter} disabled={!ready || loadingClaims} onChange={(event) => setStateFilter(event.target.value as ClaimState | "All")}><option value="All">All statuses</option>{(["JuryPending", "Voting", "Offered", "Approved", "Rejected", "Paid", "Withdrawn", "Cancelled"] satisfies ClaimState[]).map((state) => <option key={state} value={state}>{CLAIM_STATE_COPY[state]}</option>)}</select><button className="text-button" type="button" disabled={!ready || loadingClaims} onClick={() => setClaimRefresh((value) => value + 1)}>Refresh</button></div></div>
      {claimsError && <p className="notice warning" role="alert">{claimsError}</p>}
      {loadingClaims && <p className="muted" role="status">Loading claims from the backend…</p>}
      {!loadingClaims && claims.length === 0 && <div className="empty-claims"><strong>{stateFilter === "All" ? "No claims yet" : `No ${CLAIM_STATE_COPY[stateFilter].toLowerCase()} claims`}</strong><p>{stateFilter === "All" ? "Your submitted claims and their jury status will appear here." : "Choose another status to view the rest of your claim history."}</p></div>}
      <div className="claim-list">{claims.map((claim) => <article className="claim-item" key={claim.id}>
        <div className="claim-item-heading"><div><span>CLAIM #{claim.id}</span><h3>{formatUnits(claim.amount, overview?.tokenDecimals ?? 6)} {overview?.tokenSymbol ?? "mUSDC"}</h3></div><span className={`claim-status state-${claim.state.toLowerCase()}`}>{CLAIM_STATE_COPY[claim.state]}</span></div>
        <dl><div><dt>Submitted</dt><dd>{dateTime(claim.submittedAt)}</dd></div><div><dt>Evidence</dt><dd title={claim.evidenceHash}>{shortHash(claim.evidenceHash)}</dd></div>{claim.state === "Offered" || claim.state === "Approved" || claim.state === "Paid" ? <div><dt>{claim.state === "Offered" ? "Jury's offer" : "Payout"}</dt><dd>{formatUnits(claim.payoutAmount, overview?.tokenDecimals ?? 6)} {overview?.tokenSymbol ?? "mUSDC"}</dd></div> : null}{claim.jury && <div><dt>Jury progress</dt><dd>{claim.jury.commits} committed · {claim.jury.approvals + claim.jury.rejections} revealed</dd></div>}</dl>
        {claim.state === "Offered" && <p className="notice">The jury made an offer. Open the claim to accept it or withdraw.</p>}
        <button className="text-button claim-detail-link" type="button" onClick={() => setSelectedClaimId(claim.id)}>{claim.state === "Offered" ? "Review offer →" : "View details →"}</button>
      </article>)}</div>
    </section>}
  </div>;
}

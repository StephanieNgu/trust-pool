import { formatUnits } from "ethers";
import { useEffect, useState } from "react";
import { getClaimsForJuror, type ClaimState, type ClaimView, type DashboardOverview } from "../api";
import { JuryDuty } from "../member/JuryDuty";
import { ClaimDetail } from "./ClaimDetail";
import { CLAIM_STATE_COPY, dateTime } from "./presentation";

interface JuryPageProps {
  account: string | null;
  ready: boolean;
  overview: DashboardOverview | null;
  onAuthenticated(): void;
  onStakeChanged(): void;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Could not load the jury queue.";
}

function jurorTask(claim: ClaimView, account: string) {
  const jury = claim.jury;
  const juror = jury?.jurors.find((item) => item.address.toLowerCase() === account.toLowerCase());
  if (!jury || !juror) return "Unavailable";
  if (claim.state !== "Voting") return "Review complete";
  if (!juror.committed) return "Commit required";
  if (!juror.revealed && jury.revealOpen) return "Reveal required";
  if (!juror.revealed) return "Waiting for reveal";
  return "Vote revealed";
}

export function JuryPage({ account, ready, overview, onAuthenticated, onStakeChanged }: JuryPageProps) {
  const [claims, setClaims] = useState<ClaimView[]>([]);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [stateFilter, setStateFilter] = useState<ClaimState | "All">("All");

  useEffect(() => {
    setClaims([]);
    setSelectedClaimId(null);
    setError("");
  }, [account]);

  useEffect(() => {
    let active = true;
    setError("");
    if (!account || !ready) return () => { active = false; };
    setLoading(true);
    void getClaimsForJuror(account, stateFilter === "All" ? undefined : stateFilter)
      .then((items) => { if (active) setClaims(items); })
      .catch((cause) => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [account, ready, refresh, stateFilter]);

  useEffect(() => {
    if (!account || !ready) return;
    const timer = window.setInterval(() => setRefresh((value) => value + 1), 10_000);
    return () => window.clearInterval(timer);
  }, [account, ready]);

  if (selectedClaimId && account) {
    return <div className="jury-detail-layout"><ClaimDetail claimId={selectedClaimId} account={account} tokenDecimals={overview?.tokenDecimals ?? 6} tokenSymbol={overview?.tokenSymbol ?? "mUSDC"} enableJurorActions onAuthenticated={onAuthenticated} onClaimChanged={() => setRefresh((value) => value + 1)} onBack={() => setSelectedClaimId(null)} /></div>;
  }

  const activeTasks = account ? claims.filter((claim) => jurorTask(claim, account).includes("required")).length : 0;
  return <section className="claims-panel jury-panel" aria-label="Jury queue">
    <div className="claims-panel-heading"><div><span className="eyebrow">COMMUNITY REVIEW</span><h2>Jury queue</h2><p className="muted">Claims where this wallet was selected as a juror.</p></div><div className="claims-panel-actions"><label htmlFor="jury-state-filter">Status</label><select id="jury-state-filter" value={stateFilter} disabled={!ready || loading} onChange={(event) => setStateFilter(event.target.value as ClaimState | "All")}><option value="All">All statuses</option>{(["JuryPending", "Voting", "Offered", "Approved", "Rejected", "Paid", "Withdrawn", "Cancelled"] satisfies ClaimState[]).map((state) => <option key={state} value={state}>{CLAIM_STATE_COPY[state]}</option>)}</select><button className="text-button" type="button" disabled={!ready || loading} onClick={() => setRefresh((value) => value + 1)}>Refresh</button></div></div>
    <JuryDuty account={account} ready={ready} overview={overview} onChanged={onStakeChanged} />
    <div className="jury-summary"><div><strong>{claims.length}</strong><span>Total assignments</span></div><div><strong>{activeTasks}</strong><span>Actions required</span></div></div>
    {error && <p className="notice warning" role="alert">{error}</p>}
    {loading && <p className="muted" role="status">Loading jury assignments from the backend…</p>}
    {!loading && claims.length === 0 && <div className="empty-claims"><strong>{stateFilter === "All" ? "No jury assignments" : `No ${CLAIM_STATE_COPY[stateFilter].toLowerCase()} assignments`}</strong><p>{stateFilter === "All" ? "When the protocol selects this wallet, the claim will appear here." : "Choose another status to view the rest of your jury history."}</p></div>}
    <div className="jury-queue">{account && claims.map((claim) => {
      const task = jurorTask(claim, account);
      return <article className="jury-card" key={claim.id}>
        <div className="claim-item-heading"><div><span>CLAIM #{claim.id}</span><h3>{formatUnits(claim.amount, overview?.tokenDecimals ?? 6)} {overview?.tokenSymbol ?? "mUSDC"}</h3></div><span className={`claim-status state-${claim.state.toLowerCase()}`}>{CLAIM_STATE_COPY[claim.state]}</span></div>
        <p>Submitted {dateTime(claim.submittedAt)}</p>
        <div className={task.includes("required") ? "jury-action required" : "jury-action"}>{task}</div>
        <button className="text-button claim-detail-link" type="button" onClick={() => setSelectedClaimId(claim.id)}>Review claim →</button>
      </article>;
    })}</div>
  </section>;
}

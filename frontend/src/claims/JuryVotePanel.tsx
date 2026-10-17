import { useEffect, useState } from "react";
import type { ClaimDetailView } from "../api";
import { commitJuryVote, computeVoteCommitment, deriveVoteSalt, readVoteCommitment, revealJuryVote } from "../contracts/jury";
import { loadLegacyVoteSecret, removeLegacyVoteSecret, type LegacyVoteSecret } from "./voteSecret";

interface JuryVotePanelProps {
  claim: ClaimDetailView;
  account: string;
  chainTimestamp: number | null;
  evidenceVerified: boolean;
  onChanged(): void;
}

function errorText(error: unknown) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) {
    return "Request cancelled in your wallet. Your local reveal data has been kept.";
  }
  if (error && typeof error === "object" && "shortMessage" in error) return String(error.shortMessage);
  return error instanceof Error ? error.message : "The jury transaction could not be completed.";
}

function remaining(deadline: number | null, chainTimestamp: number | null) {
  if (!deadline || chainTimestamp === null) return null;
  const seconds = Math.max(0, deadline - chainTimestamp);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m remaining` : `${minutes}m remaining`;
}

export function JuryVotePanel({ claim, account, chainTimestamp, evidenceVerified, onChanged }: JuryVotePanelProps) {
  const juror = claim.jury?.jurors.find((item) => item.address.toLowerCase() === account.toLowerCase());
  const [choice, setChoice] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [legacySecret, setLegacySecret] = useState<LegacyVoteSecret | null>(null);

  useEffect(() => {
    setLegacySecret(loadLegacyVoteSecret(account, claim.id));
    setChoice(null);
    setFeedback("");
    setError("");
  }, [account, claim.id]);

  if (!juror) return null;

  async function commit() {
    if (choice === null) { setError("Choose Approve or Reject before committing."); return; }
    if (!evidenceVerified) { setError("Open and verify the evidence before committing a vote."); return; }
    try {
      setBusy(true);
      setError("");
      setFeedback("Sign the private salt message. This does not reveal or cast your vote.");
      const salt = await deriveVoteSalt(account, claim.id);
      const commitment = computeVoteCommitment(claim.id, account, choice, salt);
      await commitJuryVote(account, claim.id, commitment, setFeedback);
      removeLegacyVoteSecret(account, claim.id);
      setLegacySecret(null);
      setFeedback("Vote committed. Your wallet can recreate the reveal secret later.");
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    setBusy(true);
    setError("");
    try {
      const onChain = await readVoteCommitment(account, claim.id);
      const legacyMatches = legacySecret !== null
        && onChain.toLowerCase() === legacySecret.commitment.toLowerCase()
        && computeVoteCommitment(claim.id, account, legacySecret.approve, legacySecret.salt).toLowerCase() === onChain.toLowerCase();
      let salt: string;
      let approve: boolean | null;
      if (legacyMatches) {
        salt = legacySecret.salt;
        approve = legacySecret.approve;
        setFeedback("Recovered the earlier browser-stored commitment. It will be deleted after reveal.");
      } else {
        setFeedback("Sign the same private message to recover your reveal secret.");
        salt = await deriveVoteSalt(account, claim.id);
        const approveCommitment = computeVoteCommitment(claim.id, account, true, salt);
        const rejectCommitment = computeVoteCommitment(claim.id, account, false, salt);
        approve = onChain.toLowerCase() === approveCommitment.toLowerCase()
          ? true
          : onChain.toLowerCase() === rejectCommitment.toLowerCase()
            ? false
            : null;
      }
      if (approve === null) throw new Error("This wallet could not reproduce the secret used for the on-chain commitment.");
      await revealJuryVote(account, claim.id, approve, salt, setFeedback);
      removeLegacyVoteSecret(account, claim.id);
      setLegacySecret(null);
      setFeedback("Vote revealed successfully.");
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (juror.revealed) {
    return <section className="vote-panel complete"><span className="eyebrow">YOUR JURY VOTE</span><h3>Vote revealed</h3><p>Your revealed vote is included in the jury tally.</p></section>;
  }

  const isVoting = claim.state === "Voting" && claim.jury?.phase === "Voting";
  const commitOpen = Boolean(isVoting && chainTimestamp !== null && (!claim.jury?.commitDeadline || chainTimestamp <= claim.jury.commitDeadline));
  const revealOpen = Boolean(claim.jury?.revealOpen && chainTimestamp !== null && (!claim.jury.revealDeadline || chainTimestamp <= claim.jury.revealDeadline));
  const deadlineCopy = remaining(juror.committed ? claim.jury?.revealDeadline ?? null : claim.jury?.commitDeadline ?? null, chainTimestamp);
  return <section className="vote-panel">
    <div className="vote-panel-heading"><span className="eyebrow">YOUR JURY VOTE</span>{deadlineCopy && <span>{deadlineCopy}</span>}</div>
    {!juror.committed ? <>
      <h3>Commit a sealed vote</h3>
      <p>Review the verified evidence, then choose privately. Only the commitment is published until reveal.</p>
      <div className="vote-choices"><button type="button" className={choice === true ? "selected approve" : ""} disabled={!commitOpen || busy} onClick={() => setChoice(true)}>Approve claim</button><button type="button" className={choice === false ? "selected reject" : ""} disabled={!commitOpen || busy} onClick={() => setChoice(false)}>Reject claim</button></div>
      {!evidenceVerified && <p className="notice warning">Open the evidence above and verify its on-chain hash to unlock voting.</p>}
      <button className="primary full" type="button" disabled={!commitOpen || !evidenceVerified || busy || choice === null} onClick={() => void commit()}>{busy ? "Committing…" : "Commit sealed vote"}</button>
      {chainTimestamp === null && <p className="notice warning">Synchronizing the latest blockchain time…</p>}
      {!commitOpen && <p className="notice warning">The commit window is closed.</p>}
    </> : <>
      <h3>{revealOpen ? "Reveal your vote" : "Vote committed"}</h3>
      <p>The reveal secret is not stored in this browser. Your wallet will reproduce it by signing the same private message.</p>
      {legacySecret && <p className="notice">An earlier browser-stored commitment is available for one-time reveal and will be deleted afterward.</p>}
      {revealOpen ? <button className="primary full" type="button" disabled={busy} onClick={() => void reveal()}>{busy ? "Recovering & revealing…" : "Recover secret & reveal vote"}</button> : <p className="notice">Reveal opens after all jurors commit or the commit deadline passes.</p>}
    </>}
    {feedback && <p className="notice" role="status">{feedback}</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
  </section>;
}

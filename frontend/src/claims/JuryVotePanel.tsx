import { formatUnits, parseUnits } from "ethers";
import { useEffect, useState } from "react";
import { MAX_JURY_NOTE_LENGTH, getMyJuryNotes, submitJuryNote, type ClaimDetailView } from "../api";
import { commitJuryVote, computeVoteCommitment, deriveVoteSalt, juryNoteHash, readVoteCommitment, revealJuryVote } from "../contracts/jury";
import { loadVoteSecret, removeVoteSecret, saveVoteSecret, type VoteSecret } from "./voteSecret";
import { contractErrorMessage } from "../contracts/errors";
import { formatAmount } from "./presentation";

interface JuryVotePanelProps {
  claim: ClaimDetailView;
  account: string;
  chainTimestamp: number | null;
  evidenceVerified: boolean;
  tokenDecimals: number;
  tokenSymbol: string;
  onAuthenticated?(): void;
  onChanged(): void;
}

function errorText(error: unknown) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) {
    return "Request cancelled in your wallet. Your local reveal data has been kept.";
  }
  const reverted = contractErrorMessage(error);
  if (reverted) return reverted;
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

/**
 * A juror votes the amount they think the claim should pay: anything from 0 (reject) up to what was
 * asked. Paying less than asked needs a short note saying why, which the claimant will read. The
 * amount and the note's hash are sealed together, so neither can change after seeing other votes.
 */
export function JuryVotePanel({ claim, account, chainTimestamp, evidenceVerified, tokenDecimals, tokenSymbol, onAuthenticated, onChanged }: JuryVotePanelProps) {
  const juror = claim.jury?.jurors.find((item) => item.address.toLowerCase() === account.toLowerCase());
  const maxAmount = BigInt(claim.jury?.maxAmount ?? claim.amount);
  const requested = formatUnits(maxAmount, tokenDecimals);
  const [amount, setAmount] = useState(requested);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [storedSecret, setStoredSecret] = useState<VoteSecret | null>(null);

  useEffect(() => {
    let active = true;
    setStoredSecret(null);
    void loadVoteSecret(account, claim.id).then((secret) => { if (active) setStoredSecret(secret); });
    setAmount(requested);
    setNote("");
    setFeedback("");
    setError("");
    return () => { active = false; };
  }, [account, claim.id, requested]);

  useEffect(() => {
    if (!juror?.revealed) return;
    removeVoteSecret(account, claim.id);
    setStoredSecret(null);
  }, [account, claim.id, juror?.revealed]);

  if (!juror) return null;

  /** The amount typed, in base units, or an error message. */
  function parsedAmount(): bigint | string {
    try {
      const units = parseUnits(amount.trim() || "0", tokenDecimals);
      if (units < 0n || units > maxAmount) return `Enter an amount from 0 to ${formatAmount(maxAmount, tokenDecimals)} ${tokenSymbol}.`;
      return units;
    } catch {
      return `Enter an amount with no more than ${tokenDecimals} decimal places.`;
    }
  }

  const units = parsedAmount();
  const paysLess = typeof units === "bigint" && units < maxAmount;
  const noteMissing = paysLess && !note.trim();

  async function commit() {
    if (typeof units === "string") { setError(units); return; }
    if (noteMissing) { setError("Add a short note saying why you would pay less than asked."); return; }
    if (!evidenceVerified) { setError("Open and verify the evidence before voting."); return; }
    try {
      setBusy(true);
      setError("");
      let noteHash = juryNoteHash("");
      if (note.trim()) {
        setFeedback("Saving your note privately. It is shown only after you reveal.");
        noteHash = await submitJuryNote(account, claim.id, note);
        onAuthenticated?.();
        if (noteHash.toLowerCase() !== juryNoteHash(note).toLowerCase()) throw new Error("The backend stored a different note.");
      }
      setFeedback("Sign the private salt message. This does not reveal or cast your vote.");
      const salt = await deriveVoteSalt(account, claim.id);
      const commitment = computeVoteCommitment(claim.id, account, units, noteHash, salt);
      const secret: VoteSecret = { amount: units.toString(), noteHash, note: note.trim() ? note : "", salt, commitment };
      await saveVoteSecret(account, claim.id, secret);
      await commitJuryVote(account, claim.id, commitment, setFeedback);
      setStoredSecret(secret);
      setFeedback("Vote sealed. An encrypted copy is saved in this browser for the reveal.");
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
      const onChain = (await readVoteCommitment(account, claim.id)).toLowerCase();
      let vote: { amount: bigint; noteHash: string; salt: string } | null = null;
      if (storedSecret && storedSecret.commitment.toLowerCase() === onChain) {
        vote = { amount: BigInt(storedSecret.amount), noteHash: storedSecret.noteHash, salt: storedSecret.salt };
        setFeedback("Recovered your sealed vote from this browser.");
      } else {
        // No copy in this browser: re-derive the salt, then try the amount typed with the note typed,
        // every note this juror saved on the backend before sealing, and no note.
        if (typeof units === "string") throw new Error(units);
        setFeedback("Sign the same private message to recover your reveal secret.");
        const salt = await deriveVoteSalt(account, claim.id);
        const saved = await getMyJuryNotes(account, claim.id).catch(() => []);
        onAuthenticated?.();
        const candidates = [juryNoteHash(note), ...saved.map((item) => item.noteHash), juryNoteHash("")];
        const noteHash = candidates.find((hash) => computeVoteCommitment(claim.id, account, units, hash, salt).toLowerCase() === onChain);
        if (noteHash) vote = { amount: units, noteHash, salt };
      }
      if (!vote) {
        throw new Error("That amount doesn't match the vote you sealed. Enter exactly the amount you sealed, then reveal again.");
      }
      await revealJuryVote(account, claim.id, vote.amount, vote.noteHash, vote.salt, setFeedback);
      removeVoteSecret(account, claim.id);
      setStoredSecret(null);
      setFeedback("Vote revealed.");
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (juror.revealed) {
    return <section className="vote-panel complete"><span className="eyebrow">YOUR JURY VOTE</span><h3>Vote revealed</h3><p>You voted {formatAmount(juror.amount ?? "0", tokenDecimals)} {tokenSymbol}. The offer is the middle amount of all revealed votes.</p></section>;
  }

  const isVoting = claim.state === "Voting" && claim.jury?.phase === "Voting";
  const commitOpen = Boolean(isVoting && chainTimestamp !== null && (!claim.jury?.commitDeadline || chainTimestamp <= claim.jury.commitDeadline));
  const revealOpen = Boolean(claim.jury?.revealOpen && chainTimestamp !== null && (!claim.jury.revealDeadline || chainTimestamp <= claim.jury.revealDeadline));
  const deadlineCopy = remaining(juror.committed ? claim.jury?.revealDeadline ?? null : claim.jury?.commitDeadline ?? null, chainTimestamp);
  const disabled = !commitOpen || busy;
  return <section className="vote-panel">
    <div className="vote-panel-heading"><span className="eyebrow">YOUR JURY VOTE</span>{deadlineCopy && <span>{deadlineCopy}</span>}</div>
    {!juror.committed ? <>
      <h3>How much should this claim pay?</h3>
      <p>The claimant asked for {formatAmount(maxAmount, tokenDecimals)} {tokenSymbol}. Pay it all, part of it, or 0 to reject. The claim gets the middle amount of the jury's votes. Jurors within {formatAmount((maxAmount * 10n) / 100n, tokenDecimals)} {tokenSymbol} of it share a {formatAmount(claim.jury?.fee ?? "0", tokenDecimals)} {tokenSymbol} fee; not revealing costs part of your stake.</p>
      <div className="vote-choices">
        <button type="button" className={units === maxAmount ? "selected approve" : ""} disabled={disabled} onClick={() => setAmount(requested)}>Pay in full</button>
        <button type="button" className={units === 0n ? "selected reject" : ""} disabled={disabled} onClick={() => setAmount("0")}>Reject (0)</button>
      </div>
      <label htmlFor="vote-amount">Amount to pay</label>
      <div className="amount-input"><input id="vote-amount" type="number" min="0" max={requested} step="any" value={amount} disabled={disabled} onChange={(event) => setAmount(event.target.value)} /><span>{tokenSymbol}</span></div>
      <label htmlFor="vote-note">Why? {paysLess ? <span className="muted">(required when paying less than asked)</span> : <span className="muted">(optional)</span>}</label>
      <textarea id="vote-note" rows={3} maxLength={MAX_JURY_NOTE_LENGTH} value={note} disabled={disabled} placeholder={units === 0n ? "e.g. The claim photos show a different phone from signup." : "e.g. Only the screen is damaged; a screen repair costs about 150."} onChange={(event) => setNote(event.target.value)} />
      <small>The claimant and the other jurors read this once votes are revealed.</small>
      {!evidenceVerified && <p className="notice warning">Open the evidence above and verify its on-chain hash to unlock voting.</p>}
      <button className="primary full" type="button" disabled={disabled || !evidenceVerified || typeof units === "string" || noteMissing} onClick={() => void commit()}>{busy ? "Sealing…" : "Seal my vote"}</button>
      {typeof units === "string" && amount !== "" && <p className="notice warning">{units}</p>}
      {chainTimestamp === null && <p className="notice warning">Synchronizing the latest blockchain time…</p>}
      {!commitOpen && <p className="notice warning">The voting window is closed.</p>}
    </> : <>
      <h3>{revealOpen ? "Reveal your vote" : "Vote sealed"}</h3>
      {storedSecret ? <p>You sealed {formatAmount(storedSecret.amount, tokenDecimals)} {tokenSymbol}{storedSecret.note ? <> with the note “{storedSecret.note}”</> : null}. This browser keeps an encrypted copy for the reveal.</p>
        : <>
          <p>This browser has no copy of your vote. Enter the amount you sealed, and your wallet will re-create the secret. Your note is recovered from the notes you saved before sealing.</p>
          <label htmlFor="vote-amount">Amount you sealed</label>
          <div className="amount-input"><input id="vote-amount" type="number" min="0" step="any" value={amount} disabled={busy} onChange={(event) => setAmount(event.target.value)} /><span>{tokenSymbol}</span></div>
        </>}
      {revealOpen ? <button className="primary full" type="button" disabled={busy} onClick={() => void reveal()}>{busy ? "Revealing…" : "Reveal my vote"}</button> : <p className="notice">Reveal opens once every juror has voted or the voting deadline passes.</p>}
    </>}
    {feedback && <p className="notice" role="status">{feedback}</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
  </section>;
}

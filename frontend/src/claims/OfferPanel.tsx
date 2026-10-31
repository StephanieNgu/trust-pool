import { formatUnits } from "ethers";
import { useEffect, useState } from "react";
import { getJuryVotes, type ClaimDetailView, type JuryVote } from "../api";
import { acceptOffer, withdrawClaim } from "../contracts/claims";
import { dateTime, shortHash } from "./presentation";

function errorText(error: unknown) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) {
    return "Request cancelled in your wallet.";
  }
  if (error && typeof error === "object" && "shortMessage" in error) return String(error.shortMessage);
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

interface Props {
  claim: ClaimDetailView;
  account: string;
  tokenDecimals: number;
  tokenSymbol: string;
  onAuthenticated?(): void;
}

/**
 * Each revealed juror's amount and reasoning. Shown to the claimant and the jurors only; the backend
 * refuses anyone else. Loads after a wallet signature, so it waits for the reader to ask.
 */
export function JuryReasoning({ claim, account, tokenDecimals, tokenSymbol, onAuthenticated }: Props) {
  const [votes, setVotes] = useState<JuryVote[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revealed = claim.jury?.jurors.filter((j) => j.revealed).length ?? 0;

  useEffect(() => {
    setVotes(null);
    setError("");
  }, [account, claim.id, revealed]);

  const isClaimant = claim.claimant.toLowerCase() === account.toLowerCase();
  const isJuror = claim.jury?.jurors.some((j) => j.address.toLowerCase() === account.toLowerCase()) ?? false;
  if ((!isClaimant && !isJuror) || revealed === 0) return null;

  async function load() {
    setBusy(true);
    setError("");
    try {
      setVotes(await getJuryVotes(account, claim.id));
      onAuthenticated?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const money = (value: string) => `${formatUnits(value, tokenDecimals)} ${tokenSymbol}`;
  return <div className="jury-reasoning">
    <div className="detail-section-heading"><div><span className="eyebrow">JURORS' REASONING</span><h3>What each juror would pay, and why</h3></div></div>
    {votes === null ? <button className="text-button" type="button" disabled={busy} onClick={() => void load()}>{busy ? "Loading…" : `Show ${revealed} revealed vote${revealed === 1 ? "" : "s"}`}</button>
      : <ul className="reasoning-list">{[...votes].sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1)).map((vote) => <li key={vote.juror}>
        <span className="reasoning-amount">{vote.amount === "0" ? "Reject" : money(vote.amount)}</span>
        <span className="reasoning-note">{vote.note ?? <em className="muted">{vote.amount === claim.amount ? "Paid in full, no note." : "No note."}</em>}</span>
        <code title={vote.juror}>{shortHash(vote.juror)}</code>
      </li>)}</ul>}
    {error && <p className="notice warning" role="alert">{error}</p>}
  </div>;
}

interface OfferPanelProps extends Props {
  chainTimestamp: number | null;
  onChanged(): void;
}

/**
 * The claimant's answer to the jury's offer: accept it (paid automatically), or withdraw the claim.
 * There is no counteroffer. Saying nothing until the deadline counts as accepting.
 */
export function OfferPanel({ claim, account, chainTimestamp, tokenDecimals, tokenSymbol, onAuthenticated, onChanged }: OfferPanelProps) {
  const [busy, setBusy] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  if (claim.state !== "Offered" || claim.claimant.toLowerCase() !== account.toLowerCase()) return null;

  const offer = `${formatUnits(claim.payoutAmount, tokenDecimals)} ${tokenSymbol}`;
  const asked = `${formatUnits(claim.amount, tokenDecimals)} ${tokenSymbol}`;
  // The pool's per-claim cap (or the coverage limit) can make the offer smaller than the jury's median.
  const award = claim.jury?.award ?? claim.payoutAmount;
  const capped = BigInt(award) > BigInt(claim.payoutAmount);
  const open = chainTimestamp === null || !claim.offerDeadline || chainTimestamp <= claim.offerDeadline;

  async function respond(action: "accept" | "withdraw") {
    setBusy(true);
    setError("");
    try {
      if (action === "accept") await acceptOffer(account, claim.id, setFeedback);
      else await withdrawClaim(account, claim.id, setFeedback);
      setFeedback(action === "accept" ? "Offer accepted. Upload your repair or replacement receipt to be paid." : "Claim withdrawn. Nothing was paid.");
      setConfirmWithdraw(false);
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
      setFeedback("");
    } finally {
      setBusy(false);
    }
  }

  return <section className="vote-panel offer-panel" aria-label="Jury offer">
    <span className="eyebrow">THE JURY'S OFFER</span>
    <h3>{offer}{claim.payoutAmount !== claim.amount && <small> of the {asked} you asked for</small>}</h3>
    <p>{capped
      ? <>The middle amount of the jurors' votes was {formatUnits(award, tokenDecimals)} {tokenSymbol}, but one claim can take at most a fifth of the pool, so the offer is {offer}.</>
      : <>This is the middle amount of the jurors' votes.</>} Read their reasoning below, then accept it or withdraw your claim. The pool pays it back against the receipt for the repair or replacement, up to this amount. {claim.offerDeadline && <>If you do nothing, it is accepted for you after {dateTime(claim.offerDeadline)}.</>}
      {claim.bond.returned !== null && claim.bond.returned !== "0" && <> {formatUnits(claim.bond.returned, tokenDecimals)} {tokenSymbol} of your bond is already back in your wallet, whichever you choose.</>}</p>
    <JuryReasoning claim={claim} account={account} tokenDecimals={tokenDecimals} tokenSymbol={tokenSymbol} onAuthenticated={onAuthenticated} />
    {open ? <div className="offer-actions">
      <button className="primary" type="button" disabled={busy} onClick={() => void respond("accept")}>Accept {offer}</button>
      {confirmWithdraw ? <>
        <p className="notice warning">Withdrawing closes the claim and pays nothing. You can file a new claim afterwards.</p>
        <button className="danger-button" type="button" disabled={busy} onClick={() => void respond("withdraw")}>Yes, withdraw my claim</button>
        <button className="text-button" type="button" disabled={busy} onClick={() => setConfirmWithdraw(false)}>Keep the offer</button>
      </> : <button className="text-button" type="button" disabled={busy} onClick={() => setConfirmWithdraw(true)}>Withdraw claim</button>}
    </div> : <p className="notice">The time to respond has passed, so the offer is being accepted and paid.</p>}
    {feedback && <p className="notice" role="status">{feedback}</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
  </section>;
}

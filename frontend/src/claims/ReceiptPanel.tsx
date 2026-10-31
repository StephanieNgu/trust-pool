import { parseUnits } from "ethers";
import { useEffect, useRef, useState } from "react";
import { ALLOWED_EVIDENCE_TYPES, MAX_SHOP_LENGTH, uploadReceipt, type ClaimDetailView } from "../api";
import { submitReceipt } from "../contracts/claims";
import { dateTime, shortHash, formatAmount } from "./presentation";
import { contractErrorMessage } from "../contracts/errors";

interface ReceiptPanelProps {
  claim: ClaimDetailView;
  account: string;
  chainTimestamp: number | null;
  tokenDecimals: number;
  tokenSymbol: string;
  onAuthenticated?(): void;
  onChanged(): void;
}

function errorText(error: unknown) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) {
    return "Request cancelled in your wallet. You can try again.";
  }
  const reverted = contractErrorMessage(error);
  if (reverted) return reverted;
  if (error && typeof error === "object" && "shortMessage" in error) return String(error.shortMessage);
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

/**
 * After accepting the jury's offer, the claimant uploads the receipt for the repair or replacement.
 * The claim pays the smaller of the offer and the receipt's total, and the keeper sends it.
 */
export function ReceiptPanel({ claim, account, chainTimestamp, tokenDecimals, tokenSymbol, onAuthenticated, onChanged }: ReceiptPanelProps) {
  const [shop, setShop] = useState("");
  const [total, setTotal] = useState("");
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setFeedback("");
    setError("");
  }, [account, claim.id]);

  if (claim.state !== "Approved" || claim.receipt.hash || claim.claimant.toLowerCase() !== account.toLowerCase()) return null;

  const offer = BigInt(claim.payoutAmount);
  const money = (value: bigint) => `${formatAmount(value, tokenDecimals)} ${tokenSymbol}`;
  let units: bigint | null = null;
  try {
    units = total ? parseUnits(total, tokenDecimals) : null;
  } catch {
    units = null;
  }
  const open = chainTimestamp === null || !claim.receipt.deadline || chainTimestamp <= claim.receipt.deadline;
  const ready = Boolean(shop.trim() && units && units > 0n && date && files.length);

  async function submit() {
    if (!units) return;
    setBusy(true);
    setError("");
    try {
      setFeedback("Uploading the receipt privately…");
      const summary = await uploadReceipt(account, claim.id, { shop, total: units, date, description }, files);
      onAuthenticated?.();
      await submitReceipt(account, claim.id, summary.evidenceHash, units, setFeedback);
      setFeedback(`Receipt ${shortHash(summary.evidenceHash)} recorded. ${money(units < offer ? units : offer)} is on its way.`);
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
      setFeedback("");
    } finally {
      setBusy(false);
    }
  }

  return <section className="vote-panel receipt-panel" aria-label="Receipt">
    <span className="eyebrow">GET PAID</span>
    <h3>Upload your repair or replacement receipt</h3>
    <p>The pool pays back what the repair or replacement cost, up to the {money(offer)} offer. {claim.receipt.deadline && <>Upload it by {dateTime(claim.receipt.deadline)}, or the claim closes unpaid.</>} Jurors on this claim can see it.</p>
    {open ? <>
      <label htmlFor="receipt-shop">Shop or seller</label>
      <input id="receipt-shop" value={shop} maxLength={MAX_SHOP_LENGTH} disabled={busy} placeholder="e.g. Fix-It Phones" onChange={(event) => setShop(event.target.value)} />
      <div className="receipt-row">
        <div>
          <label htmlFor="receipt-total">Total paid</label>
          <div className="amount-input"><input id="receipt-total" type="number" min="0" step="any" value={total} disabled={busy} onChange={(event) => setTotal(event.target.value)} /><span>{tokenSymbol}</span></div>
        </div>
        <div>
          <label htmlFor="receipt-date">Date on the receipt</label>
          <input id="receipt-date" type="date" value={date} disabled={busy} onChange={(event) => setDate(event.target.value)} />
        </div>
      </div>
      {units !== null && units > 0n && <small>{units < offer ? `You'll be paid ${money(units)}, what the receipt shows.` : `You'll be paid ${money(offer)}, the jury's offer.`}</small>}
      <label htmlFor="receipt-description">What was done <span className="muted">(optional)</span></label>
      <input id="receipt-description" value={description} maxLength={500} disabled={busy} placeholder="e.g. New screen and labour" onChange={(event) => setDescription(event.target.value)} />
      <label>Receipt or invoice</label>
      <button className="text-button" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>{files.length ? `${files.length} file${files.length === 1 ? "" : "s"} added. Add more` : "Add a photo or PDF of the receipt"}</button>
      <input ref={fileInput} className="visually-hidden" type="file" accept={ALLOWED_EVIDENCE_TYPES.join(",")} multiple disabled={busy} onChange={(event) => { const picked = Array.from(event.target.files ?? []); setFiles((current) => [...current, ...picked]); event.target.value = ""; }} />
      {files.length > 0 && <ul className="file-list">{files.map((file, index) => <li key={`${file.name}-${index}`}><span><strong>{file.name}</strong></span><button type="button" disabled={busy} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}>Remove</button></li>)}</ul>}
      <button className="primary full" type="button" disabled={!ready || busy} onClick={() => void submit()}>{busy ? "Submitting…" : "Upload receipt & get paid"}</button>
    </> : <p className="notice warning">The time to upload a receipt has passed, so the claim is being closed without a payout.</p>}
    {feedback && <p className="notice" role="status">{feedback}</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
  </section>;
}

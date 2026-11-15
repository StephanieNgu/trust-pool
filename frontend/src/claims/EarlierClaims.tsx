import { useState } from "react";
import type { ClaimDetailView, EarlierClaim } from "../api";
import { EvidenceViewer } from "./EvidenceViewer";
import { CLAIM_STATE_COPY, dateTime, formatAmount } from "./presentation";

interface EarlierClaimsProps {
  account: string;
  claim: ClaimDetailView;
  tokenDecimals: number;
  tokenSymbol: string;
  onAuthenticated?(): void;
}

/**
 * Earlier claims on the same device, so jurors can tell whether the damage was claimed before. While
 * the claim is in Voting, its jurors can open each earlier claim's evidence next to the new photos.
 */
export function EarlierClaims({ account, claim, tokenDecimals, tokenSymbol, onAuthenticated }: EarlierClaimsProps) {
  const [open, setOpen] = useState<string | null>(null);
  const earlier = claim.earlierClaims ?? [];
  const isJuror = claim.jury?.jurors.some((juror) => juror.address.toLowerCase() === account.toLowerCase()) ?? false;
  const canOpen = isJuror && claim.state === "Voting";

  return <section className="earlier-claims" aria-label="Earlier claims on this device">
    <div className="detail-section-heading"><div><span className="eyebrow">CLAIM HISTORY</span><h3>Earlier claims on this device</h3></div><span>{earlier.length === 0 ? "None" : `${earlier.length} earlier`}</span></div>
    {earlier.length === 0
      ? <p className="muted">This is the first claim filed for this device.</p>
      : <>
        <p className="muted">{canOpen
          ? "Check that this claim is not for damage that was already claimed. You can open each earlier claim's photos while voting is open."
          : "Coverage is a lifetime total for the device, so earlier payouts reduce what this claim can be paid. Jurors can open these claims' photos while voting is open."}</p>
        <ul className="earlier-claim-list">{earlier.map((e: EarlierClaim) => <li key={e.id} className="earlier-claim">
          <div className="earlier-claim-row">
            <strong>Claim #{e.id}</strong>
            <span>{dateTime(e.submittedAt)}</span>
            <span>{CLAIM_STATE_COPY[e.state] ?? e.state}</span>
            <span>Asked {formatAmount(e.amount, tokenDecimals)} {tokenSymbol}</span>
            <span>Paid {formatAmount(e.paidAmount, tokenDecimals)} {tokenSymbol}</span>
            {e.claimant.toLowerCase() !== claim.claimant.toLowerCase() && <span className="earlier-claim-owner">Filed by a previous owner</span>}
            {canOpen && e.evidence.available && <button className="text-button" type="button" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? "Hide photos" : "Show photos"}</button>}
          </div>
          {open === e.id && <EvidenceViewer
            account={account}
            // The earlier claim's bundle, read under this claim's jury while it is in Voting.
            claim={{ ...claim, id: e.id, claimant: e.claimant, evidenceHash: e.evidenceHash, evidence: e.evidence }}
            onAuthenticated={onAuthenticated}
          />}
        </li>)}</ul>
      </>}
  </section>;
}

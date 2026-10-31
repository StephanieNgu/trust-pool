// The policy terms: what is covered, what isn't, and how premiums and claims work. Every number is
// read from the deployed contracts' parameters, so the page can't drift from what the pool enforces.
import { useEffect, useState } from "react";
import { getProtocolConfig, type ApiConfig } from "../api";
import { COVERED_EVENTS, NOT_COVERED } from "../claims/coverageTerms";
import { formatAmount } from "../claims/presentation";

interface Props {
  onFileClaim?(): void;
  onGetCoverage?(): void;
}

const DAY = 24 * 60 * 60;

function days(seconds: string | undefined) {
  const n = Math.round(Number(seconds ?? 0) / DAY);
  return n === 0 ? "None" : `${n} day${n === 1 ? "" : "s"}`;
}

const percent = (bps: string | undefined) => `${Number(bps ?? 0) / 100}%`;

export function PolicyTerms({ onFileClaim, onGetCoverage }: Props) {
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    getProtocolConfig()
      .then((value) => { if (active) setConfig(value); })
      .catch(() => { if (active) setError("The backend is not answering, so the numbers below are missing."); });
    return () => { active = false; };
  }, []);

  const p = config?.params ?? {};
  const decimals = config?.token.decimals ?? 6;
  const symbol = config?.token.symbol ?? "mUSDC";
  const money = (units: string | undefined) => units === undefined ? "—" : `${formatAmount(units, decimals)} ${symbol}`;
  const examplePremium = p.premiumBps ? (1000 * Number(p.premiumBps)) / 10_000 : null;

  return <div className="terms-page">
    {error && <p className="notice warning" role="alert">{error}</p>}

    <section className="terms-card terms-glance" aria-label="At a glance">
      <span className="eyebrow">AT A GLANCE</span>
      <dl className="terms-facts">
        <div><dt>Monthly premium</dt><dd>{percent(p.premiumBps)} of your cover</dd><small>{examplePremium !== null ? `${examplePremium.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${symbol} a month on 1,000 of cover` : ""}</small></div>
        <div><dt>Most cover per device</dt><dd>{money(p.maxCoverageLimit)}</dd><small>You choose the amount at signup</small></div>
        <div><dt>Waiting period</dt><dd>{days(p.waitingPeriod)}</dd><small>From signup until you can claim</small></div>
        <div><dt>Grace period</dt><dd>{days(p.gracePeriod)}</dd><small>To pay a missed premium and stay covered</small></div>
        <div><dt>Most one claim can take</dt><dd>{percent(p.maxPayoutBps)} of the pool</dd><small>So one claim can't empty it</small></div>
        <div><dt>Claim bond</dt><dd>{percent(p.claimBondBps)} of the ask</dd><small>At least {money(p.minClaimBond)}, returned as described below</small></div>
      </dl>
    </section>

    <section className="terms-card" aria-label="What's covered">
      <span className="eyebrow">WHAT'S COVERED</span>
      <h2>The device you enrolled, against these events</h2>
      <div className="terms-events">
        {COVERED_EVENTS.map((event) => <article key={event.id} className="terms-event">
          <h3>{event.label}</h3>
          <p>{event.covers}</p>
          <p className="terms-evidence"><strong>Send with the claim:</strong> {event.evidence}</p>
        </article>)}
      </div>
    </section>

    <section className="terms-card" aria-label="What's not covered">
      <span className="eyebrow">WHAT'S NOT COVERED</span>
      <h2>Jurors should vote 0 on these</h2>
      <ul className="terms-list">{NOT_COVERED.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>

    <section className="terms-card" aria-label="How a claim is paid">
      <span className="eyebrow">HOW A CLAIM IS PAID</span>
      <h2>Five members decide, and you're paid against a receipt</h2>
      <ol className="terms-steps">
        <li><strong>File.</strong> Pick what happened, take photos showing a one-time code, say how much you need and why, and post the claim bond.</li>
        <li><strong>The jury votes.</strong> {p.jurySize ?? "Five"} members with cover and a juror stake are picked at random. Each privately votes how much to pay, from nothing up to your ask, over {days(p.commitPeriod)}, then reveals the vote over {days(p.revealPeriod)}. At least {p.quorum ?? "three"} must reveal.</li>
        <li><strong>The offer.</strong> The middle vote is the offer, up to the pool cap. You have {days(p.responsePeriod)} to accept it or withdraw; if you do nothing, it counts as accepted.</li>
        <li><strong>Get paid.</strong> Repair or replace the device and upload the receipt within {days(p.receiptPeriod)}. You're paid the offer or the receipt total, whichever is less. No receipt in time means no payout.</li>
        <li><strong>Your bond.</strong> It comes back in proportion to what the jury agreed: all of it if they offered your full ask, half if they offered half, none if they rejected the claim.</li>
      </ol>
      <p className="muted">Jurors whose vote lands close to the offer share a fee of {percent(p.jurorFeeBps)} of the claim (at least {money(p.minJurorFee)}). A juror who doesn't reveal their vote loses {money(p.noShowPenalty)} of their stake.</p>
    </section>

    <section className="terms-card" aria-label="Premiums and ending cover">
      <span className="eyebrow">PREMIUMS AND ENDING COVER</span>
      <h2>Monthly, from your dashboard</h2>
      <ul className="terms-list">
        <li>Signing up pays the first month. Each later premium is due every {days(p.premiumPeriod)}, and you can pay up to one month early.</li>
        <li>Miss a premium and you stay covered for the {days(p.gracePeriod)} grace period. After that the policy ends, and coming back means signing up again with new photos.</li>
        <li>You can cancel at any time when no claim is open. Premiums already paid stay in the pool.</li>
        <li>One open claim per policy at a time.</li>
      </ul>
    </section>

    <p className="terms-footnote">TrustPool is a prototype running on a local test network with test tokens. These terms describe how the contracts behave; they are not an insurance contract.</p>
    {(onFileClaim || onGetCoverage) && <div className="terms-actions">
      {onGetCoverage && <button className="primary" type="button" onClick={onGetCoverage}>Get device coverage</button>}
      {onFileClaim && <button className="text-button" type="button" onClick={onFileClaim}>File a claim</button>}
    </div>}
  </div>;
}

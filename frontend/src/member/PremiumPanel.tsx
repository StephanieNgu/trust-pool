import { useEffect, useState } from "react";
import type { PremiumOverview } from "../api";
import { payPremium } from "../contracts/member";

interface PremiumPanelProps {
  account: string;
  ready: boolean;
  premium: PremiumOverview;
  tokenSymbol: string;
  onPaid(hash: string, amount: string): void;
}

const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const money = (value: string) => Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 });

function errorText(error: unknown) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) {
    return "Request cancelled in your wallet. Your premium was not paid.";
  }
  if (error && typeof error === "object" && "shortMessage" in error) return String(error.shortMessage);
  return error instanceof Error ? error.message : "The premium payment could not be completed.";
}

/** What the member needs to know about their premium, in one line, and how urgent it is. */
export function premiumMessage(premium: PremiumOverview, tokenSymbol: string): { tone: "ok" | "due" | "warning"; text: string } {
  const amount = `${money(premium.amount)} ${tokenSymbol}`;
  switch (premium.status) {
    case "Paid":
      return premium.dueSoon
        ? { tone: "due", text: `Your next premium of ${amount} is due ${day(premium.paidThrough)}.` }
        : { tone: "ok", text: `Paid through ${day(premium.paidThrough)}. Next premium ${amount} every ${premium.periodDays} days.` };
    case "Grace":
      return { tone: "warning", text: `Your premium of ${amount} was due ${day(premium.paidThrough)}. Pay by ${day(premium.graceEndsAt)} to keep your coverage.` };
    case "Overdue":
      return { tone: "warning", text: `Coverage ended ${day(premium.graceEndsAt)} because the premium was not paid. Buy new coverage to protect your device again.` };
    case "Lapsed":
      return { tone: "warning", text: "This coverage has ended." };
  }
}

export function PremiumPanel({ account, ready, premium, tokenSymbol, onPaid }: PremiumPanelProps) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setFeedback("");
    setError("");
  }, [account, premium.paidThrough]);

  async function pay() {
    if (!ready || !premium.canPay) return;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      const hash = await payPremium(account, setFeedback);
      setFeedback("Premium paid. Thank you!");
      onPaid(hash, premium.amount);
    } catch (cause) {
      setError(errorText(cause));
      setFeedback("");
    } finally {
      setBusy(false);
    }
  }

  const { tone, text } = premiumMessage(premium, tokenSymbol);
  const payable = premium.status === "Paid" || premium.status === "Grace";
  return <div className={`premium-panel ${tone}`} role="group" aria-label="Monthly premium">
    <p>{text}</p>
    {payable && <button className={tone === "ok" ? "text-button" : "primary"} type="button" disabled={!ready || busy || !premium.canPay} title={premium.canPay ? undefined : "Already paid a full month ahead"} onClick={() => void pay()}>
      {busy ? "Paying…" : premium.canPay ? `Pay ${money(premium.amount)} ${tokenSymbol}${tone === "ok" ? " early" : ""}` : "Paid ahead"}
    </button>}
    {feedback && <p className="notice" role="status">{feedback}</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
  </div>;
}

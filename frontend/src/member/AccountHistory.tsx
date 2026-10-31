import { useEffect, useState } from "react";
import { getMemberHistory, type HistoryEntry } from "../api";
import { formatAmount } from "../claims/presentation";

interface AccountHistoryProps {
  account: string | null;
  ready: boolean;
  /** Bumped by the dashboard after a transaction, to read the history again. */
  refresh: number;
  tokenDecimals: number;
  tokenSymbol: string;
  onOpenClaim(claimId: string): void;
}

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const when = (at: number) => new Date(at * 1000).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
const PAGE = 8;

/** Everything this wallet paid into the pool and got back, from the chain. Survives reloads. */
export function AccountHistory({ account, ready, refresh, tokenDecimals, tokenSymbol, onOpenClaim }: AccountHistoryProps) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setEntries([]);
    setShowAll(false);
  }, [account]);

  useEffect(() => {
    let active = true;
    if (!account || !ready) return () => { active = false; };
    setLoading(true);
    setError("");
    void getMemberHistory(account)
      .then((items) => { if (active) setEntries(items); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load your history."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [account, ready, refresh]);

  const shown = showAll ? entries : entries.slice(0, PAGE);
  return <section className="activity-card" aria-label="Account history">
    <div className="activity-header"><span>Activity</span><span>Amount</span><span>Transaction</span><span>Date</span></div>
    {error && <p className="notice warning" role="alert">{error}</p>}
    {shown.length ? shown.map((item) => <div className="activity-row" key={item.id}>
      <div><strong>{item.title}</strong>{item.claimId && <button className="text-button history-claim" type="button" onClick={() => onOpenClaim(item.claimId!)}>View claim →</button>}</div>
      <span className={item.direction === "in" ? "amount-in" : item.direction === "out" ? "amount-out" : ""}>{item.amount === null ? "—" : `${item.direction === "in" ? "+" : item.direction === "out" ? "−" : ""}${formatAmount(item.amount, tokenDecimals)} ${tokenSymbol}`}</span>
      <code title={item.txHash}>{short(item.txHash)}</code>
      <span>{when(item.at)}</span>
    </div>) : !loading && <div className="empty-activity"><div><strong>Nothing here yet</strong><p>Premiums, contributions, claims, payouts and juror fees will be listed here.</p></div></div>}
    {loading && entries.length === 0 && <p className="muted history-loading" role="status">Loading your history from the chain…</p>}
    {entries.length > PAGE && <button className="text-button history-more" type="button" onClick={() => setShowAll((value) => !value)}>{showAll ? "Show fewer" : `Show all ${entries.length}`}</button>}
  </section>;
}

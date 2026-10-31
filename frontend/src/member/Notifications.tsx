import { useCallback, useEffect, useRef, useState } from "react";
import {
  getNotifications,
  markNotificationsSeen,
  readSeenNotifications,
  timeLeft,
  unreadCount,
  type MemberNotification,
  type NotificationFeed,
} from "../api";
import { dateTime } from "../claims/presentation";

const POLL_MS = 15_000;

export interface NotificationState {
  feed: NotificationFeed | null;
  seen: ReadonlySet<string>;
  unread: number;
  /** Chain time now, estimated from the last feed plus the time since it arrived. */
  now: number;
  markAllSeen(): void;
  refresh(): void;
}

/**
 * Polls the wallet's notifications while the tab is visible, and remembers in this browser which ones
 * it has seen. `refreshKey` forces a fetch, e.g. right after the wallet sends a transaction.
 */
export function useNotifications(account: string | null, enabled: boolean, refreshKey = 0): NotificationState {
  const [feed, setFeed] = useState<NotificationFeed | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const [fetchedAt, setFetchedAt] = useState(0);
  const [, setTick] = useState(0);
  const [manual, setManual] = useState(0);
  const latest = useRef<string | null>(account);
  latest.current = account;

  useEffect(() => {
    setFeed(null);
    setSeen(account ? readSeenNotifications(account) : new Set());
  }, [account]);

  useEffect(() => {
    if (!account || !enabled) return;
    let active = true;
    const load = () => {
      if (document.hidden) return;
      void getNotifications(account)
        .then((data) => {
          if (!active || latest.current !== account) return;
          setFeed(data);
          setFetchedAt(Date.now());
        })
        .catch(() => { /* Keep the last good feed; the dashboard already reports backend errors. */ });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [account, enabled, refreshKey, manual]);

  // Re-render every 30s so countdowns stay current between polls.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const markAllSeen = useCallback(() => {
    if (!account || !feed) return;
    setSeen(markNotificationsSeen(account, feed.notifications.map((n) => n.id), feed.notifications));
  }, [account, feed]);

  const now = feed ? feed.now + Math.floor((Date.now() - fetchedAt) / 1000) : Math.floor(Date.now() / 1000);
  return {
    feed,
    seen,
    unread: feed ? unreadCount(feed.notifications, seen) : 0,
    now,
    markAllSeen,
    refresh: () => setManual((value) => value + 1),
  };
}

function BellIcon() {
  return <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z M10 20a2 2 0 0 0 4 0" /></svg>;
}

const SEVERITY_LABEL: Record<MemberNotification["severity"], string> = {
  action: "Action needed",
  warning: "Heads up",
  success: "Good news",
  info: "Update",
};

function actionLabel(n: MemberNotification) {
  if (n.kind === "jury" && n.claimId) return n.severity === "action" ? "Vote now →" : "Open claim →";
  if (n.kind === "claim" && n.claimId) return n.severity === "action" ? "Review offer →" : "View claim →";
  if (n.kind === "premium") return n.severity === "action" ? "Pay premium →" : "Go to dashboard →";
  return null;
}

function NotificationItem({ n, now, unread, onSelect }: { n: MemberNotification; now: number; unread: boolean; onSelect(n: MemberNotification): void }) {
  const label = actionLabel(n);
  const urgent = n.severity === "action" && n.deadline !== null && n.deadline - now <= 24 * 60 * 60;
  return <li className={`notification-item severity-${n.severity}${unread ? " unread" : ""}`}>
    <span className="notification-dot" aria-hidden="true" />
    <div>
      <span className="notification-meta">{SEVERITY_LABEL[n.severity]}{unread && <span className="sr-only"> (new)</span>}</span>
      <strong>{n.title}</strong>
      <p>{n.body}</p>
      {n.deadline !== null && <small className={urgent ? "notification-deadline urgent" : "notification-deadline"} title={dateTime(n.deadline)}>
        {n.deadline > now ? `${n.severity === "action" ? "Due" : "Ends"} ${timeLeft(n.deadline, now)} · ${dateTime(n.deadline)}` : `Closed ${dateTime(n.deadline)}`}
      </small>}
      {label && <button className="text-button" type="button" onClick={() => onSelect(n)}>{label}</button>}
    </div>
  </li>;
}

interface BellProps {
  state: NotificationState;
  onSelect(n: MemberNotification): void;
}

/** Topbar bell with an unread badge. Opening it marks everything shown as seen. */
export function NotificationBell({ state, onSelect }: BellProps) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const items = state.feed?.notifications ?? [];
  // Snapshot of what was unread when the panel opened, so items stay highlighted while it is open.
  const [unreadAtOpen, setUnreadAtOpen] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);

  function toggle() {
    if (!open) {
      setUnreadAtOpen(new Set(items.filter((n) => !state.seen.has(n.id)).map((n) => n.id)));
      state.markAllSeen();
    }
    setOpen(!open);
  }

  return <div className="notification-bell" ref={wrapper}>
    <button className="wallet-button bell-button" type="button" aria-haspopup="true" aria-expanded={open} aria-label={state.unread ? `Notifications, ${state.unread} new` : "Notifications"} onClick={toggle}>
      <BellIcon />{state.unread > 0 && <span className="bell-badge" aria-hidden="true">{state.unread > 9 ? "9+" : state.unread}</span>}
    </button>
    {open && <div className="notification-panel" role="dialog" aria-label="Notifications">
      <div className="notification-panel-heading"><strong>Notifications</strong><button className="text-button" type="button" onClick={() => state.refresh()}>Refresh</button></div>
      {items.length ? <ul className="notification-list">{items.map((n) => <NotificationItem key={n.id} n={n} now={state.now} unread={unreadAtOpen.has(n.id)} onSelect={(item) => { setOpen(false); onSelect(item); }} />)}</ul>
        : <p className="muted notification-empty">{state.feed ? "You're all caught up. Jury duty, claim updates and reminders will show up here." : "Loading notifications…"}</p>}
    </div>}
  </div>;
}

/**
 * Dashboard section: everything that needs the member to act, plus anything they have not seen yet.
 * Hidden when there is nothing to show, so the dashboard stays calm.
 */
export function AttentionList({ state, onSelect }: BellProps) {
  const items = (state.feed?.notifications ?? []).filter((n) => n.severity === "action" || !state.seen.has(n.id)).slice(0, 5);
  if (!items.length) return null;
  const actions = items.filter((n) => n.severity === "action").length;
  return <>
    <div className="section-heading"><h2>Needs your attention</h2><span>{actions ? `${actions} to do` : "New updates"}</span></div>
    <section className="attention-card" aria-label="Needs your attention">
      <ul className="notification-list">{items.map((n) => <NotificationItem key={n.id} n={n} now={state.now} unread={!state.seen.has(n.id)} onSelect={onSelect} />)}</ul>
      <div className="attention-footer"><button className="text-button" type="button" onClick={state.markAllSeen} disabled={state.unread === 0}>Mark all as read</button></div>
    </section>
  </>;
}

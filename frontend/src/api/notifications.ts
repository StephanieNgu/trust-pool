import { getProfileIfSignedIn, updateProfileIfSignedIn } from "./profile";
import { getAddress } from "ethers";
import { apiRequest } from "./client";

export type NotificationKind = "jury" | "claim" | "policy" | "premium";
export type NotificationSeverity = "action" | "warning" | "success" | "info";

/** One dashboard notification, built by the backend from chain state. See backend/src/notifications.ts. */
export interface MemberNotification {
  /** Stable while the state it describes holds, so a new step of the same claim gets a new id. */
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  /** Chain time (seconds) the state began. */
  at: number;
  /** Chain time (seconds) to act by, if any. */
  deadline: number | null;
  claimId: string | null;
}

export interface NotificationFeed {
  /** Chain time of the latest block, to count down deadlines the way the contracts judge them. */
  now: number;
  notifications: MemberNotification[];
}

export function getNotifications(address: string): Promise<NotificationFeed> {
  return apiRequest<NotificationFeed>(`/api/members/${getAddress(address)}/notifications`);
}

const seenKey = (address: string) => `trustpool:notifications:seen:${address.toLowerCase()}`;

/** Ids this wallet has already seen in this browser. Empty if storage is unavailable. */
export function readSeenNotifications(address: string): Set<string> {
  try {
    const raw = localStorage.getItem(seenKey(address));
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Remembers `ids` as seen. Only ids still in `current` are kept, so the list does not grow forever:
 * a notification that is gone (its state moved on) never comes back under the same id.
 */
export function markNotificationsSeen(address: string, ids: Iterable<string>, current: readonly MemberNotification[]): Set<string> {
  const live = new Set(current.map((n) => n.id));
  const seen = new Set([...readSeenNotifications(address), ...ids].filter((id) => live.has(id)));
  writeSeen(address, seen);
  // Signed in: keep the profile's copy too, so other browsers agree. Best effort.
  void updateProfileIfSignedIn(address, { readNotifications: [...seen] }).catch(() => undefined);
  return seen;
}

function writeSeen(address: string, seen: ReadonlySet<string>) {
  try {
    localStorage.setItem(seenKey(address), JSON.stringify([...seen]));
  } catch {
    // Private mode or blocked storage: the badge just resets on reload.
  }
}

/**
 * Merges what the profile says was read (in another browser, say) into this browser's list. Returns
 * the merged set, or null when not signed in.
 */
export async function syncSeenNotifications(address: string): Promise<Set<string> | null> {
  const profile = await getProfileIfSignedIn(address);
  if (!profile) return null;
  const seen = new Set([...readSeenNotifications(address), ...profile.readNotifications]);
  writeSeen(address, seen);
  return seen;
}

/** How many of `notifications` this wallet has not seen yet. */
export function unreadCount(notifications: readonly MemberNotification[], seen: ReadonlySet<string>): number {
  return notifications.filter((n) => !seen.has(n.id)).length;
}

/** "in 3h 20m", "in 12m", or "closed", for a deadline relative to chain time `now`. */
export function timeLeft(deadline: number, now: number): string {
  const seconds = deadline - now;
  if (seconds <= 0) return "closed";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.max(1, Math.floor((seconds % 3_600) / 60));
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

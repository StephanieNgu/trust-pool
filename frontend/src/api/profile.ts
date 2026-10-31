// The member's profile on the backend: the name they're greeted by, a device nickname and which
// notifications they've read. Needs a sign-in; callers keep a copy in this browser for when they
// aren't signed in.
import { getWalletAuthHeaders, readCachedWalletAuth } from "./auth";
import { apiRequest } from "./client";

export interface MemberProfile {
  displayName: string;
  deviceNickname: string;
  readNotifications: string[];
  updatedAt: number;
}

export type ProfileUpdate = Partial<Pick<MemberProfile, "displayName" | "deviceNickname" | "readNotifications">>;

/** The profile, or null when this wallet isn't signed in here (no signature prompt). */
export async function getProfileIfSignedIn(address: string): Promise<MemberProfile | null> {
  if (!readCachedWalletAuth(address)) return null;
  return apiRequest<MemberProfile>("/api/profile", { headers: await getWalletAuthHeaders(address) });
}

/** Saves the given fields when signed in; returns null (and saves nothing) otherwise. */
export async function updateProfileIfSignedIn(address: string, update: ProfileUpdate): Promise<MemberProfile | null> {
  if (!readCachedWalletAuth(address)) return null;
  return apiRequest<MemberProfile>("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await getWalletAuthHeaders(address)) },
    body: JSON.stringify(update),
  });
}

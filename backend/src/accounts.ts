// Sign-in sessions and member profiles. A wallet is still the account: a member signs one message to
// open a session, and the profile only holds conveniences that would otherwise live in one browser
// (the name they're greeted by, a device nickname, which notifications they've read). Nothing here
// affects money or claims; that all stays on-chain.
//
// Kept as two small JSON files, written atomically, so a backend restart doesn't sign anyone out.
// Pass no directory for an in-memory store (tests).
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress } from "ethers";

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_DISPLAY_NAME_LENGTH = 40;
export const MAX_DEVICE_NICKNAME_LENGTH = 60;
export const MAX_READ_NOTIFICATIONS = 300;

export interface Session {
  address: string;
  expiresAt: number;
}

export interface Profile {
  /** The name the member is greeted by; "" when not set. */
  displayName: string;
  /** What the member calls the insured device; "" to use its make and model. */
  deviceNickname: string;
  /** Ids of notifications the member has read (newest kept). */
  readNotifications: string[];
  /** Unix seconds; 0 for a profile never saved. */
  updatedAt: number;
}

export class ProfileError extends Error {
  readonly status = 400;
}

const EMPTY_PROFILE: Profile = { displayName: "", deviceNickname: "", readNotifications: [], updatedAt: 0 };

/** Sessions are stored by the token's hash, so the file alone can't be used to sign in. */
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new ProfileError(`${field} must be a string.`);
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length > max) throw new ProfileError(`${field} must be at most ${max} characters.`);
  return trimmed;
}

export class AccountStore {
  private sessions = new Map<string, Session>();
  private profiles = new Map<string, Profile>();
  private loaded: Promise<void>;

  constructor(private readonly dir: string | null = null) {
    this.loaded = this.load();
  }

  private async load() {
    if (!this.dir) return;
    await mkdir(this.dir, { recursive: true });
    const readJson = async <T>(name: string): Promise<Record<string, T>> => {
      try {
        return JSON.parse(await readFile(join(this.dir!, name), "utf8")) as Record<string, T>;
      } catch {
        return {};
      }
    };
    const now = Math.floor(Date.now() / 1000);
    for (const [hash, session] of Object.entries(await readJson<Session>("sessions.json"))) {
      if (session.expiresAt > now) this.sessions.set(hash, session);
    }
    for (const [address, profile] of Object.entries(await readJson<Profile>("profiles.json"))) {
      this.profiles.set(address, { ...EMPTY_PROFILE, ...profile });
    }
  }

  private async save(name: "sessions.json" | "profiles.json") {
    if (!this.dir) return;
    const map = name === "sessions.json" ? this.sessions : this.profiles;
    const path = join(this.dir, name);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(map), null, 2));
    await rename(tmp, path);
  }

  /** Opens a session for a wallet that just proved it holds its key. */
  async createSession(address: string, now = Math.floor(Date.now() / 1000)): Promise<Session & { token: string }> {
    await this.loaded;
    const token = randomBytes(32).toString("base64url");
    const session = { address: getAddress(address), expiresAt: now + SESSION_TTL_SECONDS };
    // Drop expired sessions while we're writing anyway.
    for (const [hash, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(hash);
    this.sessions.set(tokenHash(token), session);
    await this.save("sessions.json");
    return { token, ...session };
  }

  /** The wallet a session token belongs to, or null if it is unknown or expired. */
  async resolveSession(token: string, now = Math.floor(Date.now() / 1000)): Promise<Session | null> {
    await this.loaded;
    const session = this.sessions.get(tokenHash(token));
    return session && session.expiresAt > now ? session : null;
  }

  async endSession(token: string): Promise<void> {
    await this.loaded;
    if (this.sessions.delete(tokenHash(token))) await this.save("sessions.json");
  }

  async getProfile(address: string): Promise<Profile> {
    await this.loaded;
    return { ...(this.profiles.get(getAddress(address)) ?? EMPTY_PROFILE) };
  }

  /** Merges the given fields into the profile; fields left out are kept. */
  async updateProfile(address: string, patch: unknown, now = Math.floor(Date.now() / 1000)): Promise<Profile> {
    await this.loaded;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ProfileError("Body must be a JSON object.");
    const { displayName, deviceNickname, readNotifications } = patch as Record<string, unknown>;
    const next = await this.getProfile(address);
    if (displayName !== undefined) next.displayName = cleanText(displayName, "displayName", MAX_DISPLAY_NAME_LENGTH);
    if (deviceNickname !== undefined) next.deviceNickname = cleanText(deviceNickname, "deviceNickname", MAX_DEVICE_NICKNAME_LENGTH);
    if (readNotifications !== undefined) {
      if (!Array.isArray(readNotifications) || readNotifications.some((id) => typeof id !== "string" || id.length === 0 || id.length > 120)) {
        throw new ProfileError("readNotifications must be a list of notification ids.");
      }
      next.readNotifications = [...new Set(readNotifications as string[])].slice(-MAX_READ_NOTIFICATIONS);
    }
    next.updatedAt = now;
    this.profiles.set(getAddress(address), next);
    await this.save("profiles.json");
    return { ...next };
  }
}

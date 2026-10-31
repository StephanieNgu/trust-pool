import { getAddress } from "ethers";
import { getBrowserProvider } from "../wallet";
import { apiRequest, setUnauthorizedHandler } from "./client";

/**
 * A sign-in session: the wallet signs one message, the backend returns a token, and the token is sent
 * as `Authorization: Bearer …` until it expires (7 days) or the member signs out. Kept in this
 * browser's localStorage, so it survives reloads and new tabs.
 */
export interface WalletAuth {
  address: string;
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

interface AuthChallenge {
  message: string;
  issuedAt: number;
  expiresAt: number;
  headers: {
    address: string;
    issuedAt: string;
    signature: string;
  };
}

const CACHE_PREFIX = "trustpool:session:";
const EXPIRY_BUFFER_SECONDS = 60;

function cacheKey(address: string) {
  return `${CACHE_PREFIX}${getAddress(address).toLowerCase()}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Fired on `window` with the address once a wallet signs in. */
export const WALLET_AUTH_EVENT = "trustpool:wallet-auth";
/** Fired on `window` with the address once its session ends (sign-out, or the backend refused it). */
export const WALLET_SIGNED_OUT_EVENT = "trustpool:wallet-signed-out";

function emit(name: string, address: string) {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(name, { detail: address }));
  }
}

export function readCachedWalletAuth(address: string, now = Math.floor(Date.now() / 1000)): WalletAuth | null {
  const store = storage();
  if (!store) return null;
  const key = cacheKey(address);
  const raw = store.getItem(key);
  if (!raw) return null;
  try {
    const auth = JSON.parse(raw) as WalletAuth;
    if (auth.address !== getAddress(address) || !auth.token || !(auth.expiresAt > now + EXPIRY_BUFFER_SECONDS)) {
      store.removeItem(key);
      return null;
    }
    return auth;
  } catch {
    store.removeItem(key);
    return null;
  }
}

/** Forgets this browser's session for `address` (the backend keeps it until it expires). */
export function clearWalletAuth(address: string) {
  storage()?.removeItem(cacheKey(address));
  emit(WALLET_SIGNED_OUT_EVENT, getAddress(address));
}

/** Signs out: ends the session on the backend too, so the token stops working everywhere. */
export async function signOutWallet(address: string): Promise<void> {
  const auth = readCachedWalletAuth(address);
  clearWalletAuth(address);
  if (!auth) return;
  await apiRequest("/api/auth/session/end", { method: "POST", headers: { Authorization: `Bearer ${auth.token}` } }).catch(() => {
    /* already gone, or the backend is down; the token expires on its own */
  });
}

// A token the backend no longer accepts (expired, signed out elsewhere, data reset) is dropped, so
// the next action asks for a fresh signature instead of failing again.
setUnauthorizedHandler((token) => {
  const store = storage();
  if (!store) return;
  for (let i = store.length - 1; i >= 0; i--) {
    const key = store.key(i);
    if (!key?.startsWith(CACHE_PREFIX)) continue;
    try {
      const auth = JSON.parse(store.getItem(key) ?? "") as WalletAuth;
      if (auth.token === token) clearWalletAuth(auth.address);
    } catch {
      store.removeItem(key);
    }
  }
});

export async function authenticateWallet(address: string): Promise<WalletAuth> {
  const account = getAddress(address);
  const cached = readCachedWalletAuth(account);
  if (cached) return cached;

  const challenge = await apiRequest<AuthChallenge>(`/api/auth/message?address=${encodeURIComponent(account)}`);
  const signer = await getBrowserProvider().getSigner(account);
  const signature = await signer.signMessage(challenge.message);
  const session = await apiRequest<WalletAuth>("/api/auth/session", {
    method: "POST",
    headers: {
      [challenge.headers.address]: account,
      [challenge.headers.issuedAt]: String(challenge.issuedAt),
      [challenge.headers.signature]: signature,
    },
  });
  const auth: WalletAuth = { address: account, token: session.token, expiresAt: session.expiresAt };
  storage()?.setItem(cacheKey(account), JSON.stringify(auth));
  // Lets every panel that waits on a sign-in (evidence, receipts, the profile) load at once.
  emit(WALLET_AUTH_EVENT, account);
  return auth;
}

export async function getWalletAuthHeaders(address: string): Promise<Record<string, string>> {
  const auth = await authenticateWallet(address);
  return { Authorization: `Bearer ${auth.token}` };
}

import { getAddress } from "ethers";
import { getBrowserProvider } from "../wallet";
import { apiRequest } from "./client";

export interface WalletAuth {
  address: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
  headers: AuthChallenge["headers"];
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

const CACHE_PREFIX = "trustpool:wallet-auth:";
const EXPIRY_BUFFER_SECONDS = 5;

function cacheKey(address: string) {
  return `${CACHE_PREFIX}${getAddress(address).toLowerCase()}`;
}

export function readCachedWalletAuth(address: string, now = Math.floor(Date.now() / 1000)): WalletAuth | null {
  const key = cacheKey(address);
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  try {
    const auth = JSON.parse(raw) as WalletAuth;
    if (
      auth.address !== getAddress(address) ||
      auth.expiresAt <= now + EXPIRY_BUFFER_SECONDS ||
      !auth.signature ||
      !auth.headers?.address ||
      !auth.headers?.issuedAt ||
      !auth.headers?.signature
    ) {
      sessionStorage.removeItem(key);
      return null;
    }
    return auth;
  } catch {
    sessionStorage.removeItem(key);
    return null;
  }
}

export function clearWalletAuth(address: string) {
  sessionStorage.removeItem(cacheKey(address));
}

export async function authenticateWallet(address: string): Promise<WalletAuth> {
  const account = getAddress(address);
  const cached = readCachedWalletAuth(account);
  if (cached) return cached;

  const challenge = await apiRequest<AuthChallenge>(`/api/auth/message?address=${encodeURIComponent(account)}`);
  const signer = await getBrowserProvider().getSigner(account);
  const signature = await signer.signMessage(challenge.message);
  const auth = {
    address: account,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    signature,
    headers: challenge.headers,
  };
  sessionStorage.setItem(cacheKey(account), JSON.stringify(auth));
  return auth;
}

export async function getWalletAuthHeaders(address: string): Promise<Record<string, string>> {
  const auth = await authenticateWallet(address);
  return {
    [auth.headers.address]: auth.address,
    [auth.headers.issuedAt]: String(auth.issuedAt),
    [auth.headers.signature]: auth.signature,
  };
}

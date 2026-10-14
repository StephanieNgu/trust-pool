// Wallet authentication for evidence routes. The caller signs a short, timestamped message with their
// wallet (personal_sign / EIP-191) and sends the address, timestamp and signature as headers. No
// session state: a signature is reusable until it expires, so the frontend signs once per
// AUTH_MAX_AGE_SECONDS rather than once per request.
import { getAddress, isAddress, verifyMessage } from "ethers";

export const AUTH_MAX_AGE_SECONDS = 10 * 60;
/** How far in the future a timestamp may be, to tolerate clock skew. */
const MAX_CLOCK_SKEW_SECONDS = 60;

export const AUTH_HEADERS = {
  address: "x-trustpool-address",
  issuedAt: "x-trustpool-issued-at",
  signature: "x-trustpool-signature",
} as const;

export class AuthError extends Error {
  readonly status = 401;
}

/** The exact text a wallet signs. */
export function authMessage(address: string, chainId: string, issuedAt: number): string {
  return [
    "TrustPool evidence access",
    `Wallet: ${getAddress(address)}`,
    `Chain ID: ${chainId}`,
    `Issued at: ${issuedAt}`,
  ].join("\n");
}

type HeaderGetter = (name: string) => string | undefined;

/** Returns the checksummed wallet address that signed the request, or throws AuthError. */
export function authenticate(header: HeaderGetter, chainId: string, now = Math.floor(Date.now() / 1000)): string {
  const address = header(AUTH_HEADERS.address);
  const issuedAtRaw = header(AUTH_HEADERS.issuedAt);
  const signature = header(AUTH_HEADERS.signature);
  if (!address || !issuedAtRaw || !signature) {
    throw new AuthError(
      `Sign in with your wallet: send ${Object.values(AUTH_HEADERS).join(", ")} (see GET /api/auth/message).`,
    );
  }
  if (!isAddress(address)) throw new AuthError(`${AUTH_HEADERS.address} is not an address.`);

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isSafeInteger(issuedAt)) throw new AuthError(`${AUTH_HEADERS.issuedAt} must be a unix timestamp.`);
  if (issuedAt > now + MAX_CLOCK_SKEW_SECONDS || now - issuedAt > AUTH_MAX_AGE_SECONDS) {
    throw new AuthError("Wallet signature has expired; sign a new message.");
  }

  let signer: string;
  try {
    signer = verifyMessage(authMessage(address, chainId, issuedAt), signature);
  } catch {
    throw new AuthError("Wallet signature is malformed.");
  }
  if (signer !== getAddress(address)) throw new AuthError("Wallet signature does not match the address.");
  return signer;
}

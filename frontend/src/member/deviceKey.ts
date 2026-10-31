/**
 * A key that stays in this browser on this device. Signing up from the device itself makes one and
 * sends its public half with the enrollment; a claim filed later from the same browser signs its
 * capture code with it, which jurors see as "filed from the insured device". The private key is
 * created non-extractable, so it cannot be copied off the device, even by this app.
 *
 * Optional throughout: devices without a browser are enrolled from another device and get no key.
 */
const DATABASE_NAME = "trustpool-device-keys";
const KEY_STORE = "keys";

/** The public half of a device key, as the backend expects it. */
export interface DeviceKeyJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** What the device key signs when a claim is filed: the claimant's wallet and the claim's capture code. */
export function deviceProofMessage(wallet: string, captureCode: string): string {
  return `TrustPool device proof\nwallet: ${wallet.toLowerCase()}\ncode: ${captureCode}`;
}

function storageKey(account: string) {
  return account.toLowerCase();
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(KEY_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open device key storage."));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(database.transaction(KEY_STORE, mode).objectStore(KEY_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Device key storage failed."));
    });
  } finally {
    database.close();
  }
}

/** True when this browser can make and keep a device key. */
export function deviceKeysSupported(): boolean {
  return typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && Boolean(crypto.subtle);
}

/**
 * Makes a new device key for `account` in this browser, replacing any earlier one, and returns its
 * public half to send with the enrollment.
 */
export async function createDeviceKey(account: string): Promise<DeviceKeyJwk> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  await withStore("readwrite", (store) => store.put(pair, storageKey(account)));
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kty: kty as "EC", crv: crv as "P-256", x: x as string, y: y as string };
}

/** Whether this browser holds a device key for `account`. */
export async function hasDeviceKey(account: string): Promise<boolean> {
  if (!deviceKeysSupported()) return false;
  try {
    return Boolean(await withStore<CryptoKeyPair | undefined>("readonly", (store) => store.get(storageKey(account))));
  } catch {
    return false;
  }
}

/**
 * Signs a claim's capture code with this browser's device key for `account`, as base64 (r||s, the form
 * WebCrypto produces). Returns null when this browser has no key for the account.
 */
export async function signWithDeviceKey(account: string, captureCode: string): Promise<string | null> {
  if (!deviceKeysSupported()) return null;
  const pair = await withStore<CryptoKeyPair | undefined>("readonly", (store) => store.get(storageKey(account)));
  if (!pair) return null;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(deviceProofMessage(account, captureCode))),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary);
}

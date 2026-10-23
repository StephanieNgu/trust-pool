const RECOVERY_PREFIX = "trustpool:jury-recovery:v3:";
const DATABASE_NAME = "trustpool-jury-secrets";
const KEY_STORE = "keys";
const KEY_ID = "vote-recovery-v1";

/** What a juror needs to reveal their sealed vote. */
export interface VoteSecret {
  /** The amount voted, in token base units, as a decimal string. */
  amount: string;
  /** keccak256 of the juror's note, or the zero hash for no note. */
  noteHash: string;
  /** The juror's note, so it can be shown back to them before reveal. */
  note: string;
  salt: string;
  commitment: string;
}

interface EncryptedRecord {
  version: 2;
  iv: string;
  ciphertext: string;
}

function recoveryKey(account: string, claimId: string) {
  return `${RECOVERY_PREFIX}${account.toLowerCase()}:${claimId}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(KEY_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open secure vote storage."));
  });
}

async function browserKey(): Promise<CryptoKey> {
  const database = await openDatabase();
  try {
    const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return await new Promise<CryptoKey>((resolve, reject) => {
      const transaction = database.transaction(KEY_STORE, "readwrite");
      const store = transaction.objectStore(KEY_STORE);
      let selected = candidate;
      const request = store.get(KEY_ID);
      request.onsuccess = () => {
        const existing = request.result as CryptoKey | undefined;
        if (existing) selected = existing;
        else store.put(candidate, KEY_ID);
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(selected);
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save the vote recovery key."));
    });
  } finally {
    database.close();
  }
}

function validSecret(value: unknown): value is VoteSecret {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.amount === "string"
    && /^\d+$/.test(record.amount)
    && typeof record.note === "string"
    && isBytes32(record.noteHash)
    && isBytes32(record.salt)
    && isBytes32(record.commitment);
}

/** Persist an exact recovery copy encrypted by a non-exportable browser key. */
export async function saveVoteSecret(account: string, claimId: string, secret: VoteSecret): Promise<void> {
  const keyName = recoveryKey(account, claimId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(secret));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(keyName) },
    await browserKey(),
    plaintext,
  );
  const record: EncryptedRecord = {
    version: 2,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
  localStorage.setItem(keyName, JSON.stringify(record));
}

export async function loadVoteSecret(account: string, claimId: string): Promise<VoteSecret | null> {
  const keyName = recoveryKey(account, claimId);
  const raw = localStorage.getItem(keyName);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as EncryptedRecord;
    if (record.version !== 2 || typeof record.iv !== "string" || typeof record.ciphertext !== "string") return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(record.iv), additionalData: new TextEncoder().encode(keyName) },
      await browserKey(),
      base64ToBytes(record.ciphertext),
    );
    const secret: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    return validSecret(secret) ? secret : null;
  } catch {
    return null;
  }
}

export function removeVoteSecret(account: string, claimId: string): void {
  localStorage.removeItem(recoveryKey(account, claimId));
}

function isBytes32(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

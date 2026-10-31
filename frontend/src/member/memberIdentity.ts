import { useEffect, useState } from "react";
import { getEvidence, readCachedWalletAuth, WALLET_AUTH_EVENT, type DeviceDetails } from "../api";

// Per-wallet conveniences kept in this browser only: the insured device's name (its details are
// stored encrypted on the backend) and the name the member chose to be greeted by.
const deviceKey = (account: string, enrollmentHash: string) => `trustpool:device:${account.toLowerCase()}:${enrollmentHash.toLowerCase()}`;
const nameKey = (account: string) => `trustpool:name:${account.toLowerCase()}`;
const LAST_DEVICE_KEY = (account: string) => `trustpool:device-pending:${account.toLowerCase()}`;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

/** "Apple iPhone 13 (Blue)", or the device type when no make or model was given. */
export function deviceLabel(device: DeviceDetails | null | undefined): string | null {
  if (!device) return null;
  const name = [device.make, device.model].map((part) => part?.trim()).filter(Boolean).join(" ");
  const label = name || (device.type ? device.type[0].toUpperCase() + device.type.slice(1) : "");
  if (!label) return null;
  return device.color?.trim() ? `${label} (${device.color.trim()})` : label;
}

/** Remembers the device just signed up, until the dashboard learns the new policy's enrollment hash. */
export function rememberSignupDevice(account: string, device: DeviceDetails) {
  const label = deviceLabel(device);
  if (label) write(LAST_DEVICE_KEY(account), label);
}

/**
 * The insured device's name for the dashboard. Comes from this browser if the member signed up here,
 * else from the signup bundle once the wallet is signed in (only its owner and jurors can read it).
 */
export function useDeviceLabel(account: string | null, enrollmentHash: string | null): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLabel(null);
    if (!account || !enrollmentHash || /^0x0+$/.test(enrollmentHash)) return () => { active = false; };
    const stored = read(deviceKey(account, enrollmentHash));
    if (stored) { setLabel(stored); return () => { active = false; }; }
    const pending = read(LAST_DEVICE_KEY(account));
    if (pending) {
      write(deviceKey(account, enrollmentHash), pending);
      write(LAST_DEVICE_KEY(account), null);
      setLabel(pending);
      return () => { active = false; };
    }
    const fetchLabel = () => {
      if (!readCachedWalletAuth(account)) return;
      void getEvidence(account, enrollmentHash).then((evidence) => {
        const found = deviceLabel(evidence.device);
        if (!found || !active) return;
        write(deviceKey(account, enrollmentHash), found);
        setLabel(found);
      }).catch(() => { /* stays unnamed */ });
    };
    fetchLabel();
    const onAuth = () => fetchLabel();
    window.addEventListener(WALLET_AUTH_EVENT, onAuth);
    return () => { active = false; window.removeEventListener(WALLET_AUTH_EVENT, onAuth); };
  }, [account, enrollmentHash]);
  return label;
}

/** The name this browser greets the member by, and a setter (empty clears it). */
export function useDisplayName(account: string | null): [string | null, (name: string) => void] {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => { setName(account ? read(nameKey(account)) : null); }, [account]);
  const update = (value: string) => {
    if (!account) return;
    const trimmed = value.trim().slice(0, 40);
    write(nameKey(account), trimmed || null);
    setName(trimmed || null);
  };
  return [name, update];
}

export function initials(name: string | null): string {
  if (!name) return "TP";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "TP";
}

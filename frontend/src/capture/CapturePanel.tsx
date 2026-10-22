import { useEffect, useState } from "react";
import { requestCaptureCode, type CaptureCode } from "../api";

function errorText(error: unknown) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) {
    return "Wallet signature cancelled. Sign in to get a capture code.";
  }
  return error instanceof Error ? error.message : "Could not get a capture code.";
}

const clock = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

interface CaptureCodePanelProps {
  account: string | null;
  code: CaptureCode | null;
  disabled?: boolean;
  onCode(code: CaptureCode | null): void;
  onAuthenticated?(): void;
}

/**
 * Step one of taking photos: get a one-time code and make it visible in the first photo. The backend
 * records when the code was issued and used, so jurors can tell the photos were taken just now.
 */
export function CaptureCodePanel({ account, code, disabled = false, onCode, onAuthenticated }: CaptureCodePanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!code) return;
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => window.clearInterval(timer);
  }, [code]);

  async function getCode() {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      onCode(await requestCaptureCode(account));
      setNow(Math.floor(Date.now() / 1000));
      onAuthenticated?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const expired = code !== null && now > code.expiresAt;
  return <div className="capture-code">
    {code && !expired ? <>
      <span className="eyebrow">YOUR CAPTURE CODE</span>
      <strong className="capture-code-value">{code.code}</strong>
      <p>Write this code on paper and hold it next to the device in the first photo, or show it on another screen. It works for one upload until {clock(code.expiresAt)}.</p>
      <button className="text-button" type="button" disabled={disabled || busy} onClick={() => void getCode()}>Get a new code</button>
    </> : <>
      <span className="eyebrow">STEP 1</span>
      <p>{expired ? "Your code has expired. Get a new one and retake the photos with it." : "Get a one-time code to show in your photos. It proves they were taken just now."}</p>
      <button className="primary" type="button" disabled={!account || disabled || busy} onClick={() => void getCode()}>{busy ? "Getting code…" : "Get capture code"}</button>
    </>}
    {error && <p className="notice warning" role="alert">{error}</p>}
  </div>;
}

interface PhotoSlotProps {
  id: string;
  label: string;
  hint: string;
  file: File | null;
  disabled?: boolean;
  onChange(file: File | null): void;
}

/**
 * One photo to take. On a phone, `capture` opens the camera directly instead of the photo library.
 * Desktop browsers show a file picker; the capture code is what shows the photo is new.
 */
export function PhotoSlot({ id, label, hint, file, disabled = false, onChange }: PhotoSlotProps) {
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return <div className="photo-slot">
    <label htmlFor={id}>{label}</label>
    <small>{hint}</small>
    {preview && <img src={preview} alt={label} />}
    <input id={id} className="file-input" type="file" accept="image/jpeg,image/png,image/webp,image/heic" capture="environment" disabled={disabled} onChange={(event) => onChange(event.target.files?.[0] ?? null)} />
  </div>;
}

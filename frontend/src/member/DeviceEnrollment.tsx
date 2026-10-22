import type { CaptureCode, DeviceDetails } from "../api";
import { CaptureCodePanel, PhotoSlot } from "../capture/CapturePanel";

export type EnrollmentPhoto = "front" | "back" | "about";

export interface EnrollmentDraft {
  device: Required<DeviceDetails>;
  captureCode: CaptureCode | null;
  photos: Record<EnrollmentPhoto, File | null>;
}

export const EMPTY_ENROLLMENT: EnrollmentDraft = {
  device: { imei: "", serial: "", make: "", model: "", color: "" },
  captureCode: null,
  photos: { front: null, back: null, about: null },
};

const PHOTOS: { key: EnrollmentPhoto; label: string; hint: string }[] = [
  { key: "front", label: "Front, screen on", hint: "Show your capture code in this photo, on paper or another screen." },
  { key: "back", label: "Back", hint: "The whole back of the phone, so its colour and any marks are visible." },
  { key: "about", label: "Settings › About", hint: "Photo or screenshot showing the IMEI and serial number." },
];

const FIELDS: { key: keyof DeviceDetails; label: string; placeholder: string; inputMode?: "numeric" }[] = [
  { key: "imei", label: "IMEI", placeholder: "15 digits: dial *#06#", inputMode: "numeric" },
  { key: "serial", label: "Serial number", placeholder: "Settings › About" },
  { key: "make", label: "Make", placeholder: "e.g. Apple" },
  { key: "model", label: "Model", placeholder: "e.g. iPhone 13" },
  { key: "color", label: "Colour", placeholder: "e.g. Blue" },
];

/** True once every field and photo is filled in and a capture code has been issued. */
export function enrollmentComplete(draft: EnrollmentDraft): boolean {
  return Boolean(
    draft.captureCode && Object.values(draft.device).every((v) => v.trim()) && Object.values(draft.photos).every(Boolean),
  );
}

/** The photos in upload order, named so jurors can tell which is which. */
export function enrollmentFiles(draft: EnrollmentDraft): File[] {
  return PHOTOS.flatMap(({ key }) => {
    const file = draft.photos[key];
    if (!file) return [];
    const extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
    return [new File([file], `${key}${extension}`, { type: file.type, lastModified: file.lastModified })];
  });
}

interface DeviceEnrollmentProps {
  account: string | null;
  draft: EnrollmentDraft;
  disabled?: boolean;
  onChange(draft: EnrollmentDraft): void;
  onAuthenticated?(): void;
}

/**
 * The device registered with a policy. Its details and photos are what every later claim is checked
 * against: jurors see these signup photos next to the claim photos.
 */
export function DeviceEnrollment({ account, draft, disabled = false, onChange, onAuthenticated }: DeviceEnrollmentProps) {
  return <div className="device-enrollment">
    <div className="device-fields">
      {FIELDS.map(({ key, label, placeholder, inputMode }) => <div key={key}>
        <label htmlFor={`device-${key}`}>{label}</label>
        <input id={`device-${key}`} value={draft.device[key]} inputMode={inputMode} placeholder={placeholder} maxLength={key === "imei" ? 20 : 64} required disabled={disabled} onChange={(event) => onChange({ ...draft, device: { ...draft.device, [key]: event.target.value } })} />
      </div>)}
    </div>
    <small>Only a hash of the IMEI goes on-chain. The details and photos are stored encrypted and shown only to the jurors of a claim you file.</small>
    <CaptureCodePanel account={account} code={draft.captureCode} disabled={disabled} onCode={(captureCode) => onChange({ ...draft, captureCode })} onAuthenticated={onAuthenticated} />
    {draft.captureCode && <div className="photo-slots">
      {PHOTOS.map(({ key, label, hint }) => <PhotoSlot key={key} id={`enroll-${key}`} label={label} hint={hint} file={draft.photos[key]} disabled={disabled} onChange={(file) => onChange({ ...draft, photos: { ...draft.photos, [key]: file } })} />)}
    </div>}
  </div>;
}

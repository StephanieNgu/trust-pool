import { DEVICE_TYPES, type CaptureCode, type DeviceDetails, type DeviceType } from "../api";
import { CaptureCodePanel, PhotoSlot } from "../capture/CapturePanel";

export type EnrollmentPhoto = "front" | "back" | "serial";

export interface EnrollmentDraft {
  device: Required<DeviceDetails>;
  captureCode: CaptureCode | null;
  photos: Record<EnrollmentPhoto, File | null>;
}

export const EMPTY_ENROLLMENT: EnrollmentDraft = {
  device: { type: "phone", imei: "", serial: "", make: "", model: "", color: "" },
  captureCode: null,
  photos: { front: null, back: null, serial: null },
};

const TYPE_LABELS: Record<DeviceType, string> = {
  phone: "Phone",
  tablet: "Tablet",
  laptop: "Laptop",
  camera: "Camera",
  other: "Other device",
};

/** Phones and tablets show the IMEI and serial in Settings; other devices print the serial on a label. */
function photosFor(type: DeviceType): { key: EnrollmentPhoto; label: string; hint: string }[] {
  const hasScreen = type === "phone" || type === "tablet" || type === "laptop";
  const serial =
    type === "phone" || type === "tablet"
      ? { label: "Settings › About", hint: "Photo or screenshot showing the IMEI and serial number." }
      : type === "laptop"
        ? { label: "Serial number", hint: "The label underneath, or the system information screen." }
        : { label: "Serial number label", hint: "Where the maker prints it: usually underneath, or inside the battery door." };
  return [
    {
      key: "front",
      label: hasScreen ? "Front, screen on" : "Front",
      hint: "Show your capture code in this photo, on paper or another screen.",
    },
    { key: "back", label: "Back", hint: "The whole back of the device, so its colour and any marks are visible." },
    { key: "serial", ...serial },
  ];
}

const FIELDS: { key: Exclude<keyof DeviceDetails, "type">; label: string; placeholder: string; inputMode?: "numeric" }[] = [
  { key: "imei", label: "IMEI", placeholder: "15 digits: dial *#06#", inputMode: "numeric" },
  { key: "serial", label: "Serial number", placeholder: "On the label or in Settings" },
  { key: "make", label: "Make", placeholder: "e.g. Apple" },
  { key: "model", label: "Model", placeholder: "e.g. iPhone 13" },
  { key: "color", label: "Colour", placeholder: "e.g. Blue" },
];

/** Phones must give an IMEI; tablets may (cellular ones have one); other devices have none. */
const imeiField = (type: DeviceType) => (type === "phone" ? "required" : type === "tablet" ? "optional" : "hidden");

/** True once every needed field and photo is filled in and a capture code has been issued. */
export function enrollmentComplete(draft: EnrollmentDraft): boolean {
  const { type, imei, ...rest } = draft.device;
  return Boolean(
    draft.captureCode &&
      (imeiField(type) !== "required" || imei.trim()) &&
      Object.values(rest).every((v) => v.trim()) &&
      Object.values(draft.photos).every(Boolean),
  );
}

/** The details to send: the IMEI is left out for devices that have none. */
export function enrollmentDevice(draft: EnrollmentDraft): DeviceDetails {
  const { imei, ...rest } = draft.device;
  return imeiField(draft.device.type) === "hidden" || !imei.trim() ? rest : draft.device;
}

/** The photos in upload order, named so jurors can tell which is which. */
export function enrollmentFiles(draft: EnrollmentDraft): File[] {
  return photosFor(draft.device.type).flatMap(({ key }) => {
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
  const imei = imeiField(draft.device.type);
  const fields = FIELDS.filter(({ key }) => key !== "imei" || imei !== "hidden");
  return <div className="device-enrollment">
    <label htmlFor="device-type">Device type</label>
    <select id="device-type" value={draft.device.type} disabled={disabled} onChange={(event) => onChange({ ...draft, device: { ...draft.device, type: event.target.value as DeviceType } })}>
      {DEVICE_TYPES.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
    </select>
    <div className="device-fields">
      {fields.map(({ key, label, placeholder, inputMode }) => <div key={key}>
        <label htmlFor={`device-${key}`}>{label}{key === "imei" && imei === "optional" && <span className="muted"> (if it has one)</span>}</label>
        <input id={`device-${key}`} value={draft.device[key]} inputMode={inputMode} placeholder={placeholder} maxLength={key === "imei" ? 20 : 64} required={key !== "imei" || imei === "required"} disabled={disabled} onChange={(event) => onChange({ ...draft, device: { ...draft.device, [key]: event.target.value } })} />
      </div>)}
    </div>
    <small>Only a hash of the {imei === "hidden" ? "make and serial number" : "IMEI (or serial number)"} goes on-chain. The details and photos are stored encrypted and shown only to the jurors of a claim you file.</small>
    <CaptureCodePanel account={account} code={draft.captureCode} disabled={disabled} onCode={(captureCode) => onChange({ ...draft, captureCode })} onAuthenticated={onAuthenticated} />
    {draft.captureCode && <div className="photo-slots">
      {photosFor(draft.device.type).map(({ key, label, hint }) => <PhotoSlot key={key} id={`enroll-${key}`} label={label} hint={hint} file={draft.photos[key]} disabled={disabled} onChange={(file) => onChange({ ...draft, photos: { ...draft.photos, [key]: file } })} />)}
    </div>}
  </div>;
}

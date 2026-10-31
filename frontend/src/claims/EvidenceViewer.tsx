import { formatUnits, keccak256 } from "ethers";
import { useEffect, useRef, useState } from "react";
import {
  ALLOWED_EVIDENCE_TYPES,
  getEvidence,
  getEvidenceResource,
  type CaptureStamp,
  type ClaimDetailView,
  type DeviceDetails,
  type EvidenceKind,
  type ReceiptDetails,
} from "../api";
import { dateTime, shortHash } from "./presentation";

interface EvidenceViewerProps {
  account: string;
  claim: ClaimDetailView;
  /** Which bundle to show: the claim's photos, the photos taken when the device was enrolled, or the receipt. */
  source?: EvidenceKind;
  /** For showing a receipt's total. */
  tokenDecimals?: number;
  tokenSymbol?: string;
  onAuthenticated?(): void;
  onVerificationChange?(verified: boolean): void;
}

interface EvidencePreview {
  index: number;
  name: string;
  contentType: string;
  size: number;
  objectUrl: string;
}

interface StoredEvidenceFile {
  name: string;
  contentType: string;
  size: number;
  data: string;
}

interface StoredEvidenceBundle {
  version: number;
  kind?: EvidenceKind;
  description: string;
  amountReason?: string;
  device?: DeviceDetails | null;
  receipt?: ReceiptDetails;
  purchaseProof?: number[];
  capture?: CaptureStamp | null;
  files: StoredEvidenceFile[];
}

function errorText(error: unknown) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) {
    return "Wallet signature cancelled. Sign in to review the evidence.";
  }
  return error instanceof Error ? error.message : "Could not load the evidence.";
}

function fileSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parseVerifiedBundle(raw: Uint8Array): StoredEvidenceBundle {
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Partial<StoredEvidenceBundle>;
  if ((parsed.version !== 1 && parsed.version !== 2) || typeof parsed.description !== "string" || !Array.isArray(parsed.files) || parsed.files.length === 0 || parsed.files.length > 10) {
    throw new Error("The verified evidence bundle has an invalid format.");
  }
  for (const file of parsed.files) {
    if (
      !file ||
      typeof file.name !== "string" ||
      typeof file.contentType !== "string" ||
      !(ALLOWED_EVIDENCE_TYPES as readonly string[]).includes(file.contentType) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > 5 * 1024 * 1024 ||
      typeof file.data !== "string"
    ) throw new Error("The verified evidence bundle contains an invalid file.");
  }
  return parsed as StoredEvidenceBundle;
}

function decodeFile(data: string, expectedSize: number): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = window.atob(data);
  } catch {
    throw new Error("The verified evidence bundle contains invalid file data.");
  }
  if (binary.length !== expectedSize) throw new Error("An evidence file size does not match the verified bundle.");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const COPY = {
  claim: { eyebrow: "PRIVATE EVIDENCE", title: "Claim photos" },
  enrollment: { eyebrow: "REGISTERED AT SIGNUP", title: "Signup photos" },
  receipt: { eyebrow: "WHAT THE PAYOUT IS FOR", title: "Repair or replacement receipt" },
} as const;

function sourceHash(claim: ClaimDetailView, source: EvidenceKind): string {
  if (source === "claim") return claim.evidenceHash;
  return (source === "enrollment" ? claim.enrollmentHash : claim.receipt.hash) ?? "";
}

function sourceAvailable(claim: ClaimDetailView, source: EvidenceKind): boolean {
  if (source === "claim") return claim.evidence.available;
  return source === "enrollment" ? claim.enrollment.available : claim.receiptFile.available;
}

export function EvidenceViewer({ account, claim, source = "claim", tokenDecimals = 6, tokenSymbol = "mUSDC", onAuthenticated, onVerificationChange }: EvidenceViewerProps) {
  const evidenceHash = sourceHash(claim, source);
  const available = sourceAvailable(claim, source);
  const [receipt, setReceipt] = useState<ReceiptDetails | null>(null);
  const [purchaseProof, setPurchaseProof] = useState<number[]>([]);
  const [description, setDescription] = useState("");
  const [amountReason, setAmountReason] = useState("");
  const [device, setDevice] = useState<DeviceDetails | null>(null);
  const [capture, setCapture] = useState<CaptureStamp | null>(null);
  const [kindMismatch, setKindMismatch] = useState(false);
  const [files, setFiles] = useState<EvidencePreview[]>([]);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const objectUrls = useRef<string[]>([]);
  const requestId = useRef(0);

  function releasePreviews() {
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.current = [];
  }

  useEffect(() => {
    requestId.current += 1;
    releasePreviews();
    setDescription("");
    setDevice(null);
    setReceipt(null);
    setCapture(null);
    setKindMismatch(false);
    setFiles([]);
    setVerified(null);
    setError("");
    setLoading(false);
    onVerificationChange?.(false);
  }, [account, evidenceHash, onVerificationChange]);

  useEffect(() => () => {
    requestId.current += 1;
    releasePreviews();
  }, []);

  async function loadEvidence() {
    const activeRequest = requestId.current + 1;
    requestId.current = activeRequest;
    releasePreviews();
    setFiles([]);
    setLoading(true);
    setError("");
    setVerified(null);
    onVerificationChange?.(false);

    const createdUrls: string[] = [];
    try {
      const evidence = await getEvidence(account, evidenceHash);
      onAuthenticated?.();
      if (evidence.evidenceHash.toLowerCase() !== evidenceHash.toLowerCase()) {
        throw new Error("The backend returned evidence for a different on-chain hash.");
      }
      const raw = await getEvidenceResource(account, evidence.rawUrl);
      const matchesChain = keccak256(raw).toLowerCase() === evidenceHash.toLowerCase();
      setVerified(matchesChain);
      if (!matchesChain) throw new Error("The evidence bundle does not match the hash recorded on-chain.");

      const bundle = parseVerifiedBundle(raw);
      const previews = bundle.files.map((file, index) => {
        const bytes = decodeFile(file.data, file.size);
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: file.contentType }));
        createdUrls.push(objectUrl);
        return { index, name: file.name, contentType: file.contentType, size: file.size, objectUrl };
      });

      if (requestId.current !== activeRequest) {
        createdUrls.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      objectUrls.current = createdUrls;
      setDescription(bundle.description);
      setAmountReason(typeof bundle.amountReason === "string" ? bundle.amountReason : "");
      setDevice(bundle.device ?? null);
      setReceipt(bundle.receipt ?? null);
      setPurchaseProof(Array.isArray(bundle.purchaseProof) ? bundle.purchaseProof : []);
      setCapture(bundle.capture ?? null);
      // A claim filed with the signup bundle as its evidence shows no new photos at all.
      const mismatch = (bundle.kind ?? "claim") !== source;
      setKindMismatch(mismatch);
      setFiles(previews);
      onVerificationChange?.(!mismatch);
    } catch (cause) {
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
      if (requestId.current === activeRequest) setError(errorText(cause));
    } finally {
      if (requestId.current === activeRequest) setLoading(false);
    }
  }

  const claimant = claim.claimant.toLowerCase() === account.toLowerCase();
  const selectedJuror = claim.jury?.jurors.some((juror) => juror.address.toLowerCase() === account.toLowerCase()) ?? false;
  // A claim's jurors can open its receipt at any time, and its photos only while voting.
  const canRead = claimant || (selectedJuror && (source === "receipt" || claim.state === "Voting"));
  const copy = COPY[source];

  if (source === "enrollment" && !claim.enrollmentHash) {
    return <section className="evidence-viewer" aria-label={copy.title}><div className="detail-section-heading evidence-heading"><div><span className="eyebrow">{copy.eyebrow}</span><h3>{copy.title}</h3></div></div><p className="notice warning">This policy has no signup photos on record, so the device cannot be compared.</p></section>;
  }

  return <section className="evidence-viewer" aria-label={copy.title}>
    <div className="detail-section-heading evidence-heading"><div><span className="eyebrow">{copy.eyebrow}</span><h3>{copy.title}</h3></div>{verified !== null && <span className={verified ? "evidence-verified" : "evidence-mismatch"}>{verified ? "✓ Hash verified" : "⚠ Hash mismatch"}</span>}</div>
    {!available ? <p className="notice warning">The evidence bundle is not available in this backend.</p> : !canRead ? <p className="muted">Evidence files are private. Only the claimant and selected jurors during active voting can open them.</p> : <>
      {files.length === 0 && !loading && <div className="evidence-locked"><div><strong>Wallet verification required</strong><p>The backend checks that this wallet is the claimant or a selected juror before decrypting the original files.</p></div><button className="primary" type="button" onClick={() => void loadEvidence()}>Sign in & view evidence</button></div>}
      {loading && <p className="muted" role="status">Authenticating wallet, verifying the bundle, and loading evidence…</p>}
      {error && <p className="notice warning" role="alert">{error}<button className="text-button" type="button" onClick={() => void loadEvidence()}>Try again</button></p>}
      {files.length > 0 && <>
        {kindMismatch && <p className="notice warning" role="alert">{source === "claim" ? "This claim was filed with the signup photos instead of new photos of the damage. Do not approve it." : `This is not a${source === "receipt" ? " receipt" : "n enrollment bundle"}.`}</p>}
        {source === "claim" && <div className="evidence-description"><span>CLAIMANT STATEMENT</span><p>{description || "No written description was provided."}</p></div>}
        {source === "claim" && <div className="evidence-description"><span>WHY THIS AMOUNT</span><p>{amountReason || "The claimant did not explain the amount."}</p></div>}
        {device && <dl className="detail-grid compact">{(["type", "make", "model", "color", "serial", "imei"] as const).filter((key) => device[key]).map((key) => <div key={key}><dt>{key === "imei" ? "IMEI" : key[0].toUpperCase() + key.slice(1)}</dt><dd>{device[key]}</dd></div>)}</dl>}
        {receipt && <dl className="detail-grid compact"><div><dt>Shop</dt><dd>{receipt.shop}</dd></div><div><dt>Date</dt><dd>{receipt.date}</dd></div><div><dt>Total</dt><dd>{formatUnits(receipt.total, tokenDecimals)} {tokenSymbol}</dd></div>{description && <div className="detail-wide"><dt>Work done</dt><dd>{description}</dd></div>}</dl>}
        {source === "receipt" ? null : capture ? <p className="evidence-stamp">The first photo should show the code <code>{capture.code}</code>. Code issued {dateTime(capture.issuedAt)}, photos received {dateTime(capture.receivedAt)}.</p> : <p className="notice warning">These photos were uploaded without a capture code, so nothing shows when they were taken.</p>}
        {!verified && <p className="notice warning" role="alert">Do not vote on this evidence. Its content hash does not match the hash recorded on-chain.</p>}
        <div className="evidence-files">{files.map((file) => <article className="evidence-file" key={file.index}>
          {file.contentType.startsWith("image/") && file.contentType !== "image/heic" ? <a href={file.objectUrl} target="_blank" rel="noreferrer" title={`Open ${file.name}`}><img src={file.objectUrl} alt={`Evidence: ${file.name}`} /></a> : <div className="evidence-document"><strong>{file.contentType === "image/heic" ? "HEIC" : "PDF"}</strong><span>{file.contentType === "image/heic" ? "Open the original in a compatible viewer" : "Document evidence"}</span></div>}
          <div className="evidence-file-meta"><div><strong title={file.name}>{purchaseProof.includes(file.index) ? `Proof of purchase · ${file.name}` : file.name}</strong><span>{file.contentType} · {fileSize(file.size)}</span></div><a href={file.objectUrl} target="_blank" rel="noreferrer">Open original ↗</a></div>
        </article>)}</div>
        <div className="evidence-integrity"><span>On-chain fingerprint</span><code title={evidenceHash}>{shortHash(evidenceHash)}</code><button className="text-button" type="button" onClick={() => void loadEvidence()}>Verify again</button></div>
      </>}
    </>}
  </section>;
}

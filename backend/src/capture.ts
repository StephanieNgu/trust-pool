// One-time capture codes. Before taking photos, the app asks for a short code (e.g. "TP-7K4Q2M") and
// the user makes it visible in the first photo: written on paper beside the phone, or shown on another
// screen. A code is issued to one wallet, expires after CAPTURE_CODE_TTL_SECONDS and can be used for
// one upload. The backend stamps the bundle with the code and the times it was issued and received, so
// jurors can check the photos were taken just now and not found online or reused from another claim.
//
// Codes live in memory: restarting the backend invalidates outstanding codes, which only means the
// user asks for a new one.
import { randomInt } from "node:crypto";

export const CAPTURE_CODE_TTL_SECONDS = 15 * 60;
/** Unambiguous characters only: no 0/O or 1/I/L, so a handwritten code reads back reliably. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;
export const CAPTURE_CODE_PATTERN = new RegExp(`^TP-[${ALPHABET}]{${CODE_LENGTH}}$`);

export interface CaptureChallenge {
  code: string;
  issuedAt: number;
  expiresAt: number;
}

/** What goes into the evidence bundle: the code the photos must show, and when it was used. */
export interface CaptureStamp {
  code: string;
  issuedAt: number;
  receivedAt: number;
}

export class CaptureError extends Error {
  readonly status = 400;
}

export class CaptureChallenges {
  private readonly issued = new Map<string, CaptureChallenge & { wallet: string }>();

  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  issue(wallet: string): CaptureChallenge {
    this.prune();
    let code: string;
    do {
      code = "TP-" + Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    } while (this.issued.has(code));
    const issuedAt = this.now();
    const challenge = { code, issuedAt, expiresAt: issuedAt + CAPTURE_CODE_TTL_SECONDS };
    this.issued.set(code, { ...challenge, wallet: wallet.toLowerCase() });
    return challenge;
  }

  /** Uses up `code` for `wallet` and returns the stamp for the bundle, or throws CaptureError. */
  consume(wallet: string, code: unknown): CaptureStamp {
    if (typeof code !== "string" || !CAPTURE_CODE_PATTERN.test(code)) {
      throw new CaptureError("captureCode is required: request one from POST /api/capture/code before taking photos.");
    }
    const challenge = this.issued.get(code);
    const now = this.now();
    if (!challenge || challenge.wallet !== wallet.toLowerCase()) {
      throw new CaptureError("This capture code was not issued to this wallet, or has already been used.");
    }
    if (now > challenge.expiresAt) {
      this.issued.delete(code);
      throw new CaptureError("This capture code has expired. Request a new one and retake the photos.");
    }
    this.issued.delete(code);
    return { code, issuedAt: challenge.issuedAt, receivedAt: now };
  }

  private prune() {
    const now = this.now();
    for (const [code, challenge] of this.issued) {
      if (now > challenge.expiresAt) this.issued.delete(code);
    }
  }
}

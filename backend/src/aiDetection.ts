// AI-generated image screening for evidence uploads. A claim, signup or receipt photo that was made
// by an image generator instead of a camera is refused before it is stored, so it never reaches the
// jury or goes on-chain.
//
// Two detectors are available:
//   - MetadataAiDetector (always on, offline): looks for the marks generators and editing tools leave
//     in a file. These are the IPTC "digital source type" values that C2PA / Content Credentials use
//     to label generated media (OpenAI, Adobe Firefly, Google and others write them), the generation
//     settings Stable Diffusion front ends save in PNG text chunks, and generator names in the
//     EXIF/XMP software fields. It is precise but easy to evade: re-encoding or screenshotting an
//     image strips its metadata. A clean result means "no marks found", not "real photo".
//   - HttpAiDetector (optional): sends each image to a classifier service that judges the pixels
//     themselves and answers with a probability. Turned on with AI_DETECTOR_URL (see config.ts).
//
// Only images are screened. PDFs (invoices, carrier bills) are documents, and their text may
// legitimately mention any of these names.
import { inflateSync } from "node:zlib";

export interface ScreenedFile {
  name: string;
  contentType: string;
  data: Buffer;
}

/** A detector's finding that a file is AI-generated, with a reason a person can read. */
export interface AiFinding {
  detector: string;
  reason: string;
}

export interface AiImageDetector {
  readonly name: string;
  /** Resolves to a finding if the file looks AI-generated, or null if this detector found nothing. */
  inspect(file: ScreenedFile): Promise<AiFinding | null>;
}

export function isScreenedType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

/**
 * IPTC digital source types that mean "made, in whole or in part, by a generative model". C2PA
 * manifests and XMP `Iptc4xmpExt:DigitalSourceType` both use these URIs (or their bare names).
 * Matched case-insensitively, as lower-case strings.
 */
const AI_SOURCE_TYPES = ["trainedalgorithmicmedia", "compositewithtrainedalgorithmicmedia"];

/**
 * Names of image generators as they appear in EXIF Software, XMP CreatorTool, C2PA claim generators
 * and PNG text chunks. Kept to strings long and specific enough not to turn up by chance in camera
 * metadata or compressed pixel data.
 */
const AI_GENERATOR_MARKERS: { marker: string; label: string }[] = [
  { marker: "midjourney", label: "Midjourney" },
  { marker: "dall-e", label: "DALL-E" },
  { marker: "dall·e", label: "DALL-E" },
  { marker: "stable diffusion", label: "Stable Diffusion" },
  { marker: "stablediffusion", label: "Stable Diffusion" },
  { marker: "stability.ai", label: "Stability AI" },
  { marker: "adobe firefly", label: "Adobe Firefly" },
  { marker: "novelai", label: "NovelAI" },
  { marker: "comfyui", label: "ComfyUI" },
  { marker: "automatic1111", label: "Stable Diffusion (AUTOMATIC1111)" },
  { marker: "invokeai", label: "InvokeAI" },
  { marker: "leonardo.ai", label: "Leonardo.Ai" },
  { marker: "ideogram", label: "Ideogram" },
  { marker: "black forest labs", label: "FLUX (Black Forest Labs)" },
];

/**
 * PNG text-chunk keywords that Stable Diffusion front ends use to save the prompt and settings:
 * AUTOMATIC1111/Forge "parameters", ComfyUI "prompt" and "workflow", InvokeAI "invokeai_metadata"
 * and "sd-metadata", NovelAI "Comment" alongside Software "NovelAI" (caught by name above).
 */
const AI_PNG_KEYWORDS = new Set(["parameters", "prompt", "workflow", "invokeai_metadata", "sd-metadata", "dream"]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngText {
  keyword: string;
  text: string;
}

/** The tEXt, zTXt and iTXt chunks of a PNG, decompressed. Stops quietly at a malformed chunk. */
export function readPngText(data: Buffer): PngText[] {
  if (data.length < PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return [];
  const out: PngText[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > data.length) break;
    const body = data.subarray(start, end);
    try {
      const nul = body.indexOf(0);
      if (nul > 0 && (type === "tEXt" || type === "zTXt" || type === "iTXt")) {
        const keyword = body.toString("latin1", 0, nul);
        if (type === "tEXt") {
          out.push({ keyword, text: body.toString("latin1", nul + 1) });
        } else if (type === "zTXt") {
          out.push({ keyword, text: inflateSync(body.subarray(nul + 2)).toString("latin1") });
        } else {
          // iTXt: keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text
          const compressed = body[nul + 1] === 1;
          const langEnd = body.indexOf(0, nul + 3);
          const transEnd = langEnd < 0 ? -1 : body.indexOf(0, langEnd + 1);
          if (transEnd >= 0) {
            const raw = body.subarray(transEnd + 1);
            out.push({ keyword, text: (compressed ? inflateSync(raw) : raw).toString("utf8") });
          }
        }
      }
    } catch {
      // A chunk that does not decompress carries nothing we can read; keep going.
    }
    if (type === "IEND") break;
    offset = end + 4;
  }
  return out;
}

/** Looks for AI-generation marks in an image's metadata. See the comment at the top of this file. */
export class MetadataAiDetector implements AiImageDetector {
  readonly name = "metadata";

  async inspect(file: ScreenedFile): Promise<AiFinding | null> {
    return this.inspectSync(file);
  }

  inspectSync(file: ScreenedFile): AiFinding | null {
    if (!isScreenedType(file.contentType)) return null;
    const pngText = readPngText(file.data);
    for (const { keyword } of pngText) {
      if (AI_PNG_KEYWORDS.has(keyword.toLowerCase())) {
        return this.finding(`it carries image-generator settings (PNG "${keyword}" text)`);
      }
    }
    // XMP, EXIF and C2PA data sit in the file as plain bytes (latin1 keeps one char per byte);
    // compressed PNG text was unpacked above.
    const haystack = (file.data.toString("latin1") + "\n" + pngText.map((t) => `${t.keyword} ${t.text}`).join("\n")).toLowerCase();
    for (const type of AI_SOURCE_TYPES) {
      if (haystack.includes(type)) {
        return this.finding("its Content Credentials / IPTC metadata label it as made by a generative AI model");
      }
    }
    for (const { marker, label } of AI_GENERATOR_MARKERS) {
      if (haystack.includes(marker)) return this.finding(`its metadata names an AI image generator (${label})`);
    }
    return null;
  }

  private finding(reason: string): AiFinding {
    return { detector: this.name, reason };
  }
}

export interface HttpAiDetectorOptions {
  url: string;
  /** Probability at or above which an image is treated as AI-generated. Default 0.8. */
  threshold?: number;
  /** Sent as `Authorization: Bearer <apiKey>` when set. */
  apiKey?: string | null;
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

/**
 * Asks a classifier service whether an image is AI-generated. The service gets the image bytes as
 * the request body (with its content type) and must answer with JSON `{ "aiProbability": 0..1 }`.
 * If the service is down or answers badly the upload is let through and a warning is logged, so an
 * outage does not block every claim; the metadata check still runs.
 */
export class HttpAiDetector implements AiImageDetector {
  readonly name = "classifier";
  private readonly threshold: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpAiDetectorOptions) {
    this.threshold = options.threshold ?? 0.8;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetch ?? fetch;
    if (!(this.threshold > 0 && this.threshold <= 1)) throw new Error("AI detector threshold must be in (0, 1].");
  }

  async inspect(file: ScreenedFile): Promise<AiFinding | null> {
    if (!isScreenedType(file.contentType)) return null;
    let probability: unknown;
    try {
      const res = await this.fetchFn(this.options.url, {
        method: "POST",
        headers: {
          "content-type": file.contentType,
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: new Uint8Array(file.data),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      probability = ((await res.json()) as { aiProbability?: unknown }).aiProbability;
      if (typeof probability !== "number" || !(probability >= 0 && probability <= 1)) {
        throw new Error("response has no aiProbability between 0 and 1");
      }
    } catch (err) {
      console.warn(`AI image classifier unavailable, skipping it for ${file.name}: ${(err as Error).message}`);
      return null;
    }
    if (probability < this.threshold) return null;
    return {
      detector: this.name,
      reason: `an AI-image classifier rates it ${Math.round(probability * 100)}% likely to be AI-generated`,
    };
  }
}

/** Runs each detector in turn on each image and returns the first finding, with the file's index. */
export async function findAiGeneratedImage(
  files: ScreenedFile[],
  detectors: readonly AiImageDetector[],
): Promise<{ index: number; finding: AiFinding } | null> {
  for (const [index, file] of files.entries()) {
    if (!isScreenedType(file.contentType)) continue;
    for (const detector of detectors) {
      const finding = await detector.inspect(file);
      if (finding) return { index, finding };
    }
  }
  return null;
}

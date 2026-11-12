// Small, structurally valid image files for the AI-detection tests: real JPEG/PNG framing with only
// the metadata that matters, so tests stay fast and need no binary fixtures in the repo.
import { deflateSync } from "node:zlib";

/** CRC-32 as PNG chunks use it. */
function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** A 1x1 grey PNG with the given tEXt chunks (keyword, text). */
export function png(text: [string, string][]): Buffer {
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]); // 1x1, 8-bit greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...text.map(([keyword, value]) => pngChunk("tEXt", Buffer.from(`${keyword}\0${value}`, "latin1"))),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0x80]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function jpeg(app1: Buffer, salt: string): Buffer {
  // SOI, APP1, a comment (so each fixture has unique bytes), stand-in scan data, EOI.
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe1, app1),
    jpegSegment(0xfe, Buffer.from(salt)),
    Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

let counter = 0;

/** A JPEG with the EXIF make, model and software a phone camera writes. */
export function cameraJpeg(salt = `camera-${counter++}`): Buffer {
  return jpeg(Buffer.from("Exif\0\0MM\0*Apple\0iPhone 15 Pro\0iOS 18.1\0", "latin1"), salt);
}

/**
 * A JPEG whose XMP says it came from a generative model, as Content Credentials-aware generators
 * (OpenAI, Adobe Firefly, Google) label their output.
 */
export function aiJpeg(sourceType = "trainedAlgorithmicMedia", salt = `ai-${counter++}`): Buffer {
  const xmp =
    "http://ns.adobe.com/xap/1.0/\0" +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ' +
    `Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/${sourceType}"/>` +
    "</rdf:RDF></x:xmpmeta>";
  return jpeg(Buffer.from(xmp, "utf8"), salt);
}

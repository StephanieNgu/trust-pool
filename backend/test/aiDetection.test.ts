import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  findAiGeneratedImage,
  HttpAiDetector,
  MetadataAiDetector,
  readPngText,
  type AiImageDetector,
  type ScreenedFile,
} from "../src/aiDetection";
import { aiJpeg, cameraJpeg, png, pngChunk } from "./imageFixtures";

const metadata = new MetadataAiDetector();
const jpeg = (data: Buffer, name = "photo.jpg"): ScreenedFile => ({ name, contentType: "image/jpeg", data });
const pngFile = (data: Buffer, name = "photo.png"): ScreenedFile => ({ name, contentType: "image/png", data });

describe("MetadataAiDetector", () => {
  it("passes an ordinary camera photo", async () => {
    assert.equal(await metadata.inspect(jpeg(cameraJpeg())), null);
    assert.equal(await metadata.inspect(pngFile(png([["Software", "Apple iPhone 15 Pro"]]))), null);
  });

  it("flags a photo whose Content Credentials label it as AI-generated", async () => {
    for (const sourceType of ["trainedAlgorithmicMedia", "compositeWithTrainedAlgorithmicMedia"]) {
      const finding = await metadata.inspect(jpeg(aiJpeg(sourceType)));
      assert.ok(finding, sourceType);
      assert.match(finding.reason, /generative AI/);
    }
  });

  it("flags images that name an AI generator in their metadata", async () => {
    for (const [software, label] of [
      ["Midjourney v7", /Midjourney/],
      ["DALL·E 3", /DALL-E/],
      ["Adobe Firefly Image 3", /Firefly/],
      ["NovelAI", /NovelAI/],
    ] as const) {
      const finding = await metadata.inspect(pngFile(png([["Software", software]])));
      assert.ok(finding, software);
      assert.match(finding.reason, label);
    }
  });

  it("flags Stable Diffusion settings saved in PNG text chunks, even compressed", async () => {
    const a1111 = png([["parameters", "a cracked iphone screen, photorealistic\nSteps: 30, Sampler: Euler a"]]);
    assert.match((await metadata.inspect(pngFile(a1111)))!.reason, /"parameters"/);

    const comfy = Buffer.concat([
      png([]).subarray(0, -12),
      pngChunk("zTXt", Buffer.concat([Buffer.from("workflow\0\0"), deflateSync('{"nodes":[]}')])),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    assert.deepEqual(readPngText(comfy), [{ keyword: "workflow", text: '{"nodes":[]}' }]);
    assert.ok(await metadata.inspect(pngFile(comfy)));
  });

  it("does not screen PDFs, whose text may mention generators legitimately", async () => {
    const pdf = Buffer.from("%PDF-1.4\n(Invoice: Midjourney subscription, trainedAlgorithmicMedia)\n%%EOF");
    assert.equal(await metadata.inspect({ name: "invoice.pdf", contentType: "application/pdf", data: pdf }), null);
  });

  it("copes with truncated or malformed PNGs", async () => {
    const broken = png([["parameters", "x"]]).subarray(0, 30);
    assert.deepEqual(readPngText(broken), []);
    assert.equal(await metadata.inspect(pngFile(broken)), null);
  });
});

describe("HttpAiDetector", () => {
  const respond = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it("flags an image the classifier rates at or above the threshold", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const detector = new HttpAiDetector({
      url: "https://detector.test/v1/check",
      apiKey: "k",
      threshold: 0.7,
      fetch: (async (url: string, init: RequestInit) => {
        sent = { url, init };
        return new Response(JSON.stringify({ aiProbability: 0.93 }));
      }) as typeof fetch,
    });
    const finding = await detector.inspect(jpeg(cameraJpeg()));
    assert.match(finding!.reason, /93% likely/);
    assert.equal(sent!.url, "https://detector.test/v1/check");
    assert.deepEqual(sent!.init.headers, { "content-type": "image/jpeg", authorization: "Bearer k" });

    const low = new HttpAiDetector({ url: "https://detector.test", threshold: 0.7, fetch: respond({ aiProbability: 0.69 }) });
    assert.equal(await low.inspect(jpeg(cameraJpeg())), null);
  });

  it("lets the upload through if the classifier is down or answers badly", async (t) => {
    t.mock.method(console, "warn", () => {});
    for (const fetchFn of [
      respond({ error: "busy" }, 503),
      respond({ aiProbability: "high" }),
      respond({ aiProbability: 1.5 }),
      (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    ]) {
      assert.equal(await new HttpAiDetector({ url: "https://detector.test", fetch: fetchFn }).inspect(jpeg(cameraJpeg())), null);
    }
  });

  it("does not send PDFs to the classifier", async () => {
    let calls = 0;
    const detector = new HttpAiDetector({
      url: "https://detector.test",
      fetch: (async () => (calls++, new Response('{"aiProbability":1}'))) as typeof fetch,
    });
    assert.equal(await detector.inspect({ name: "i.pdf", contentType: "application/pdf", data: Buffer.from("%PDF") }), null);
    assert.equal(calls, 0);
  });

  it("refuses a nonsensical threshold", () => {
    assert.throws(() => new HttpAiDetector({ url: "https://detector.test", threshold: 0 }));
    assert.throws(() => new HttpAiDetector({ url: "https://detector.test", threshold: 1.2 }));
  });
});

describe("findAiGeneratedImage", () => {
  it("reports the first AI image and which detector caught it", async () => {
    const files = [jpeg(cameraJpeg(), "front.jpg"), jpeg(aiJpeg(), "back.jpg")];
    const hit = await findAiGeneratedImage(files, [metadata]);
    assert.equal(hit?.index, 1);
    assert.equal(hit?.finding.detector, "metadata");
    assert.equal(await findAiGeneratedImage([files[0]], [metadata]), null);
  });

  it("runs every detector, so a stripped AI image can still be caught by the classifier", async () => {
    const classifier: AiImageDetector = {
      name: "classifier",
      inspect: async (f) => (f.name === "stripped.jpg" ? { detector: "classifier", reason: "pixels" } : null),
    };
    const hit = await findAiGeneratedImage([jpeg(cameraJpeg(), "stripped.jpg")], [metadata, classifier]);
    assert.deepEqual(hit, { index: 0, finding: { detector: "classifier", reason: "pixels" } });
  });
});

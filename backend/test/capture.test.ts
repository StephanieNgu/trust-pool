import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CAPTURE_CODE_TTL_SECONDS, CaptureChallenges, CaptureError } from "../src/capture";
import { isValidImei } from "../src/evidence";

const ALICE = "0x00000000000000000000000000000000000000A1";
const BOB = "0x00000000000000000000000000000000000000B0";

describe("CaptureChallenges", () => {
  it("stamps an upload with the code and when it was issued and used", () => {
    let now = 1_000;
    const captures = new CaptureChallenges(() => now);
    const { code, issuedAt, expiresAt } = captures.issue(ALICE);
    assert.equal(expiresAt - issuedAt, CAPTURE_CODE_TTL_SECONDS);
    now += 60;
    assert.deepEqual(captures.consume(ALICE.toLowerCase(), code), { code, issuedAt: 1_000, receivedAt: 1_060 });
  });

  it("refuses expired, reused, malformed and other wallets' codes", () => {
    let now = 1_000;
    const captures = new CaptureChallenges(() => now);
    const rejects = (wallet: string, code: unknown) => assert.throws(() => captures.consume(wallet, code), CaptureError);

    const late = captures.issue(ALICE).code;
    now += CAPTURE_CODE_TTL_SECONDS + 1;
    rejects(ALICE, late);

    const once = captures.issue(ALICE).code;
    rejects(BOB, once);
    captures.consume(ALICE, once);
    rejects(ALICE, once);

    for (const bad of [undefined, 42, "", "tp-abcdef", "TP-0OIL11"]) rejects(ALICE, bad);
  });

  it("issues distinct codes", () => {
    const captures = new CaptureChallenges();
    const codes = new Set(Array.from({ length: 200 }, () => captures.issue(ALICE).code));
    assert.equal(codes.size, 200);
  });
});

describe("isValidImei", () => {
  it("accepts 15 digits with a correct Luhn check digit", () => {
    assert.equal(isValidImei("490154203237518"), true);
    assert.equal(isValidImei("490154203237517"), false, "wrong check digit");
    assert.equal(isValidImei("49015420323751"), false, "14 digits");
    assert.equal(isValidImei("49015420323751a"), false);
  });
});

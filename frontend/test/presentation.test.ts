// The claim list filter and juror labels.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ClaimState } from "../src/api";
import { jurorLabel, matchesClaimFilter } from "../src/claims/presentation";

describe("claim list filter", () => {
  const open: ClaimState[] = ["Submitted", "JuryPending", "Voting", "Offered", "Approved"];
  const closed: ClaimState[] = ["Rejected", "Paid", "Cancelled", "Withdrawn", "Expired"];

  it("puts live claims under Open and finished ones under Closed", () => {
    for (const state of open) {
      assert.ok(matchesClaimFilter(state, "Open"), state);
      assert.ok(!matchesClaimFilter(state, "Closed"), state);
    }
    for (const state of closed) {
      assert.ok(matchesClaimFilter(state, "Closed"), state);
      assert.ok(!matchesClaimFilter(state, "Open"), state);
    }
  });

  it("shows every claim under All", () => {
    for (const state of [...open, ...closed]) assert.ok(matchesClaimFilter(state, "All"), state);
  });
});

describe("juror labels", () => {
  it("names jurors by seat, not wallet", () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(jurorLabel), ["Juror A", "Juror B", "Juror C", "Juror D", "Juror E"]);
    assert.equal(jurorLabel(-1), "Juror");
  });
});

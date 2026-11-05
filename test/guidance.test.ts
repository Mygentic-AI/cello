// Which sentences a read carries. The live tests show they reach a real result; this covers the combinations a mistake could hide in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OVER_GUIDANCE, POLICY_GUIDANCE, STANDBY_GUIDANCE, WRAP_GUIDANCE, replyLagGuidance, refusedGuidance, sessionGuidance } from "../src/guidance.ts";

const quiet = { lastSignal: null, laterToCome: false, finished: false, hasPolicy: false, blocked: 0 };

test("each signal tells the reader its own next step", () => {
  assert.deepEqual(sessionGuidance({ ...quiet, lastSignal: "wrap" }), [WRAP_GUIDANCE]);
  assert.deepEqual(sessionGuidance({ ...quiet, lastSignal: "over" }), [OVER_GUIDANCE]);
  assert.deepEqual(sessionGuidance({ ...quiet, lastSignal: "standby" }), [STANDBY_GUIDANCE]);
  assert.deepEqual(sessionGuidance(quiet), []);
});

test("a signal doesn't say whose move it is when more is coming, or when the session is over for you", () => {
  assert.deepEqual(sessionGuidance({ ...quiet, lastSignal: "over", laterToCome: true }), []);
  assert.deepEqual(sessionGuidance({ ...quiet, lastSignal: "wrap", finished: true }), []);
});

test("guidance stacks: every sentence that applies is there", () => {
  const all = sessionGuidance({ lastSignal: "wrap", laterToCome: false, finished: false, hasPolicy: true, blocked: 2, lag: { replies: 1, unseenPosition: 4 } });
  assert.deepEqual(all, [replyLagGuidance(1, 4), refusedGuidance(2), POLICY_GUIDANCE, WRAP_GUIDANCE]);
});

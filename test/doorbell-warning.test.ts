import assert from "node:assert/strict";
import { test } from "node:test";
import { doorbellWarning } from "../src/daemon/doorbell-warning.ts";

test("a session that will be woken hears nothing extra", () => {
  assert.equal(doorbellWarning([{ caller: "mcp:me" }], "mcp:me", "Ann"), undefined);
});

test("a session no doorbell reaches is told, and told who will hear instead", () => {
  assert.match(doorbellWarning([], "mcp:me", "Ann") ?? "", /^This session isn't set to be woken for Ann/);
  assert.match(doorbellWarning([{ caller: "mcp:other" }], "mcp:me", "Ann") ?? "", /^Another session is set to be woken for Ann/);
  // A wait in progress for this session ends at the first doorbell, so it doesn't count as being woken.
  assert.match(doorbellWarning([{ caller: "mcp:me", onBell: () => undefined }], "mcp:me", "Ann") ?? "", /isn't set to be woken/);
});

test("the command line and programs that wait for themselves are never told", () => {
  assert.equal(doorbellWarning([], "cli", "Ann"), undefined);
  assert.equal(doorbellWarning([], "hermes", "Ann"), undefined);
});

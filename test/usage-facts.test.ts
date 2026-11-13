// The usage statement's own checks. A server bug that sent a malformed count would otherwise only show as an issuer refusing it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type UsageFactsFields, usageFactsStructure } from "../src/protocol/structures.ts";

const id = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const good = (over: Partial<UsageFactsFields> = {}): UsageFactsFields => ({
  serverId: id(0xaa), agentId: id(0xbb), asOf: 1794556800, firstActive: 1785628800, conversations: 2, messagesSent: 5, messagesReceived: 6,
  medianMessages: 5, months: "2026-08:1,2026-11:1", counterparties: new Uint8Array([...id(1), ...id(2)]), ...over,
});

test("a well-formed statement round-trips", () => {
  const fields = good();
  assert.deepEqual(usageFactsStructure.decode(usageFactsStructure.encode(fields)), fields);
});

test("nothing counted is a valid statement", () => {
  const empty = good({ firstActive: null, conversations: 0, messagesSent: 0, messagesReceived: 0, medianMessages: 0, months: "", counterparties: new Uint8Array() });
  assert.deepEqual(usageFactsStructure.decode(usageFactsStructure.encode(empty)), empty);
});

test("counterparties must be whole ids, distinct and ascending", () => {
  assert.throws(() => usageFactsStructure.encode(good({ counterparties: new Uint8Array(33) })), /whole 32-byte ids/);
  assert.throws(() => usageFactsStructure.encode(good({ counterparties: new Uint8Array([...id(2), ...id(1)]) })), /ascending/);
  assert.throws(() => usageFactsStructure.encode(good({ counterparties: new Uint8Array([...id(1), ...id(1)]) })), /distinct/);
});

test("more counterparties than conversations is refused", () => {
  assert.throws(() => usageFactsStructure.encode(good({ conversations: 1, months: "2026-08:1" })), /more counterparties than conversations/);
});

test("months must be YYYY-MM:count pairs", () => {
  for (const months of ["2026-13:1", "2026-08:0", "2026-08", "2026-08:1,", "Aug:1"]) {
    assert.throws(() => usageFactsStructure.encode(good({ months })), /usage months/, months);
  }
});

test("firstActive is null exactly when nothing counts", () => {
  assert.throws(() => usageFactsStructure.encode(good({ firstActive: null })), /firstActive/);
  assert.throws(() => usageFactsStructure.encode(good({ conversations: 0, counterparties: new Uint8Array() })), /firstActive/);
});

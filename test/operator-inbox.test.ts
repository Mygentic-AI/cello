// The operator's replies are instructions, so the two mistakes that matter are one reaching the agent twice and one being
// lost. Neither shows by itself: the first needs a crash between two writes.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperatorInbox } from "../src/daemon/operator-inbox.ts";
import { Store } from "../src/daemon/store.ts";

const ANN = new Uint8Array(32).fill(7);
const BEA = new Uint8Array(32).fill(8);

function inbox(): OperatorInbox {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-operator-")), "cello.db"));
  store.insertAgent(ANN, "Ann", new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
  store.insertAgent(BEA, "Bea", new Uint8Array(32).fill(3), new Uint8Array(32).fill(4));
  return new OperatorInbox(store);
}

test("the same reply is stored once, even after the agent has read it", () => {
  const box = inbox();
  assert.equal(box.add(ANN, null, "agree to Thursday", "telegram", "telegram:1:10"), true);
  assert.equal(box.add(ANN, null, "agree to Thursday", "telegram", "telegram:1:10"), false);
  const unread = box.unread(ANN);
  assert.equal(unread.length, 1);

  // The agent reads, and then the daemon fetches the same update again because its place wasn't saved before a crash.
  box.markRead(ANN, unread.map((row) => row.id));
  assert.deepEqual(box.unread(ANN), []);
  assert.equal(box.add(ANN, null, "agree to Thursday", "telegram", "telegram:1:10"), false, "a read reply must not come back as a new instruction");
  assert.deepEqual(box.unread(ANN), []);
});

test("a reply is one agent's, in order, and reading some leaves the rest", () => {
  const box = inbox();
  const session = new Uint8Array(16).fill(5);
  box.add(ANN, session, "first", "telegram", "telegram:1:1");
  box.add(BEA, null, "for Bea", "telegram", "telegram:1:2");
  box.add(ANN, null, "second", "work", "telegram:2:1");
  const ann = box.unread(ANN);
  assert.deepEqual(ann.map((row) => [row.text, row.via]), [["first", "telegram"], ["second", "work"]]);
  assert.deepEqual([...(ann[0]?.session_id ?? [])], [...session]);
  assert.equal(ann[1]?.session_id, null);

  // Bea can't clear Ann's, and a read of the first leaves the second waiting.
  box.markRead(BEA, ann.map((row) => row.id));
  assert.equal(box.unread(ANN).length, 2);
  box.markRead(ANN, [ann[0]?.id as number]);
  assert.deepEqual(box.unread(ANN).map((row) => row.text), ["second"]);
  assert.deepEqual(box.unread(BEA).map((row) => row.text), ["for Bea"]);
});

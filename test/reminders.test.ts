// When a Reminder is shown. A wrong rule here shows nothing when the agent most needs it, shows the same thing on every
// read, or wakes an idle agent every few minutes for good, and none of those shows by itself. The clock is passed in.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalError } from "../src/daemon/errors.ts";
import { MAX_REMINDERS, Reminders } from "../src/daemon/reminders.ts";
import { Store } from "../src/daemon/store.ts";

const ANN = "07".repeat(32);
const BEA = "08".repeat(32);
const PEER = "aa".repeat(32);
const OTHER = "bb".repeat(32);
const S1 = "11".repeat(16);
const S2 = "22".repeat(16);
const MINUTE = 60_000;

function setup(): { reminders: Reminders; open: Set<string>; clock: { now: number }; store: Store } {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-reminders-")), "cello.db"));
  store.insertAgent(new Uint8Array(Buffer.from(ANN, "hex")), "Ann", new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
  store.insertAgent(new Uint8Array(Buffer.from(BEA, "hex")), "Bea", new Uint8Array(32).fill(3), new Uint8Array(32).fill(4));
  const open = new Set([S1, S2]);
  const clock = { now: 1_000_000 };
  const reminders = new Reminders(store, { agentName: (agent) => (agent === ANN ? "Ann" : "Bea"), sessionOpen: (_agent, session) => open.has(session) }, () => clock.now);
  return { reminders, open, clock, store };
}

// One read: what's due, and whether the answer reached the agent.
function read(reminders: Reminders, session: string, delivered: number, reached = true, peer = PEER): string[] {
  const got = reminders.due(ANN, session, peer, delivered);
  if (reached) got.commit();
  return got.due.map((d) => d.why);
}

const refusal = (code: string) => (err: unknown): boolean => {
  assert.ok(err instanceof LocalError, `expected a named refusal, got ${String(err)}`);
  assert.equal(err.code, code);
  return true;
};

test("at the start: once per session, with the call's answer or the first message, and never again", () => {
  const { reminders } = setup();
  const set = reminders.set(ANN, { text: "  Ask me before agreeing a price.  " }) as { text: string; fires: string };
  assert.equal(set.text, "Ask me before agreeing a price.");
  assert.equal(set.fires, "at the start of a session", "with nothing said about when, it's shown as each session starts");

  // The one who placed the call sends before it ever reads, so its answer carries the Reminder.
  const placed = reminders.due(ANN, S1, PEER, 0, true);
  placed.commit();
  assert.deepEqual(placed.due.map((d) => d.text), ["Ask me before agreeing a price."]);
  assert.deepEqual(read(reminders, S1, 3), [], "shown with the call's answer, so not again on the first read");

  // The one called: nothing on an empty read, then with the first message, then never again.
  assert.deepEqual(read(reminders, S2, 0), []);
  assert.deepEqual(read(reminders, S2, 1), ["the start of this session"]);
  assert.deepEqual(read(reminders, S2, 5), []);
});

test("a read that never reached the agent counts nothing and shows it again", () => {
  const { reminders } = setup();
  reminders.set(ANN, { text: "check scope", at_start: true, every_messages: 3 });
  assert.deepEqual(read(reminders, S1, 2, false), ["the start of this session"]);
  assert.deepEqual(read(reminders, S1, 2, false), ["the start of this session"], "an answer that didn't arrive must not use the showing up");
  assert.deepEqual(read(reminders, S1, 2), ["the start of this session"]);
  // Those two lost reads didn't count their messages either: three more are needed, not one.
  assert.deepEqual(read(reminders, S1, 2, false), []);
  assert.deepEqual(read(reminders, S1, 2), []);
  assert.deepEqual(read(reminders, S1, 1), ["every 3 messages"]);
});

test("every N messages: counted per session, and any showing starts the count again", () => {
  const { reminders } = setup();
  reminders.set(ANN, { text: "still within what I asked?", every_messages: 5 });
  assert.deepEqual(read(reminders, S1, 4), []);
  assert.deepEqual(read(reminders, S2, 4), [], "another session has its own count");
  assert.deepEqual(read(reminders, S1, 1), ["every 5 messages"]);
  assert.deepEqual(read(reminders, S1, 4), []);
  assert.deepEqual(read(reminders, S1, 7), ["every 5 messages"]);
  assert.deepEqual(read(reminders, S2, 1), ["every 5 messages"]);
});

test("every N minutes: shown on a read once due, and an idle session is woken once per quiet spell, not for good", () => {
  const { reminders, clock } = setup();
  reminders.set(ANN, { text: "anything to ask me?", every_minutes: 10 });
  assert.deepEqual(read(reminders, S1, 1), [], "the timer runs from when the session was first seen");
  assert.equal(reminders.shouldWake(ANN, S1, PEER), false);

  clock.now += 10 * MINUTE;
  assert.equal(reminders.shouldWake(ANN, S1, PEER), true, "due and nothing arriving: wake the agent");
  assert.equal(reminders.shouldWake(ANN, S1, PEER), false, "one bell, not one every check");
  assert.deepEqual(read(reminders, S1, 0), ["every 10 minutes"], "the read the bell asked for returns it with no message");

  // Still quiet an hour later: it was woken once for this spell, and isn't again.
  clock.now += 60 * MINUTE;
  assert.equal(reminders.shouldWake(ANN, S1, PEER), false, "an idle session must not cost a model turn every ten minutes for good");

  // A message arrives, which ends the quiet spell. The Reminder is due, so it rides on that read, and the timer may wake again later.
  assert.deepEqual(read(reminders, S1, 1), ["every 10 minutes"]);
  clock.now += 9 * MINUTE;
  assert.equal(reminders.shouldWake(ANN, S1, PEER), false);
  clock.now += MINUTE;
  assert.equal(reminders.shouldWake(ANN, S1, PEER), true);
});

test("a Reminder applies where it was pointed: one contact, one session, one agent", () => {
  const { reminders, open } = setup();
  reminders.set(ANN, { text: "for one contact", with: PEER });
  reminders.set(ANN, { text: "for now", session: S2, every_messages: 1 });
  assert.deepEqual(reminders.due(ANN, S1, PEER, 1).due.map((d) => d.text), ["for one contact"]);
  assert.deepEqual(reminders.due(ANN, S1, OTHER, 1).due.map((d) => d.text), []);
  assert.deepEqual(reminders.due(ANN, S2, OTHER, 1).due.map((d) => d.text), ["for now"]);
  assert.deepEqual(reminders.due(BEA, S1, PEER, 1).due, [], "one agent's Reminders are never another's");

  // The session closes and its Reminder goes with it.
  open.delete(S2);
  assert.deepEqual((reminders.list(ANN) as { reminders: { text: string }[] }).reminders.map((r) => r.text), ["for one contact"]);
});

test("a Reminder that was set for a while ends by itself", () => {
  const { reminders, clock } = setup();
  reminders.set(ANN, { text: "for an hour", every_messages: 1, for_minutes: 60 });
  assert.deepEqual(read(reminders, S1, 1), ["every message"]);
  clock.now += 60 * MINUTE;
  assert.deepEqual(read(reminders, S1, 1), []);
  assert.deepEqual((reminders.list(ANN) as { reminders: unknown[] }).reminders, []);
});

test("setting, listing and removing: every refusal has a name, and removal is by number", () => {
  const { reminders } = setup();
  assert.throws(() => reminders.set(ANN, { text: "   " }), refusal("bad_argument"));
  assert.throws(() => reminders.set(ANN, { text: "x".repeat(2001) }), refusal("too_long"));
  assert.throws(() => reminders.set(ANN, { text: "x", every_messages: 0 }), refusal("bad_argument"));
  assert.throws(() => reminders.set(ANN, { text: "x", every_minutes: 1.5 }), refusal("bad_argument"));
  assert.throws(() => reminders.set(ANN, { text: "x", with: "Bob" }), refusal("bad_argument"));
  assert.throws(() => reminders.set(ANN, { text: "x", session: "33".repeat(16) }), refusal("no_such_session"));

  const first = reminders.set(ANN, { text: "one", at_start: true, every_messages: 5, every_minutes: 10, with: PEER, for_minutes: 30 }) as { reminder: number; fires: string; applies_to: string; ends_at: string };
  assert.equal(first.fires, "at the start of a session, every 5 messages, every 10 minutes");
  assert.equal(first.applies_to, `sessions with ${PEER}`);
  assert.ok(first.ends_at);
  assert.throws(() => reminders.remove(ANN, 999), refusal("no_such_reminder"));
  assert.throws(() => reminders.remove(BEA, first.reminder), refusal("no_such_reminder"));
  reminders.remove(ANN, first.reminder);
  assert.deepEqual((reminders.list(ANN) as { reminders: unknown[] }).reminders, []);

  for (let i = 0; i < MAX_REMINDERS; i++) reminders.set(ANN, { text: `number ${i}` });
  assert.throws(() => reminders.set(ANN, { text: "one too many" }), refusal("too_many_reminders"));
  reminders.forget(ANN);
  assert.deepEqual((reminders.list(ANN) as { reminders: unknown[] }).reminders, []);
});

// What a note keeps, who may write it, and when it's shown or dropped. A wrong rule here loses a past version, lets one
// agent write another's notes, stamps the wrong writer, or shows a note twice or never, and none of those shows by
// itself: the note still reads back fine.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalError } from "../src/daemon/errors.ts";
import { Governance } from "../src/daemon/governance.ts";
import { Notes } from "../src/daemon/notes.ts";
import { Reach } from "../src/daemon/reach.ts";
import { Store } from "../src/daemon/store.ts";

const ANN = "07".repeat(32);
const BEA = "08".repeat(32);
const CAL = "09".repeat(32);
const PEER = "aa".repeat(32);
const SESSION = "11".repeat(16);
const S2 = "22".repeat(16);
const OTHER = "bb".repeat(32);
const CHANNEL = "cc".repeat(32);
const NAMES: Record<string, string> = { [ANN]: "Ann", [BEA]: "Bea", [CAL]: "Cal" };
const bytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));

interface Note { id: string; agent_id: string; written_by: string; updated_at: string; created_at: string; kind: string | null; status: string | null; body: string | null; source: string | null; keep_history: number; show_at_start: boolean; check_by: string | null; expires_at: string | null; with_id: string | null }
interface Change { changed_at: string; written_by: string; source: string | null; before: Note }

function setup(): { notes: Notes; reach: Reach; store: Store; clock: { now: number }; open: Set<string>; contacts: Set<string>; set(key: string, value: string, agent?: string): void } {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-notes-")), "cello.db"));
  const reach = new Reach(store);
  [ANN, BEA, CAL].forEach((agent, i) => {
    store.insertAgent(bytes(agent), NAMES[agent] as string, new Uint8Array(32).fill(i + 1), new Uint8Array(32).fill(i + 11));
    reach.writeDefaults(bytes(agent));
  });
  const clock = { now: Date.parse("2026-11-25T10:00:00Z") };
  const open = new Set([SESSION, S2]);
  const contacts = new Set<string>();
  const notes = new Notes(store, reach, {
    agentName: (agent) => NAMES[agent] as string,
    // Ann holds one message and one post. Nobody else holds anything.
    holdsMessage: (agent, session, position) => agent === ANN && session === SESSION && position === 4,
    holdsPost: (agent, channel, position) => agent === ANN && channel === CHANNEL && position === 2,
    sessionOpen: (_agent, session) => open.has(session),
    isContact: (_agent, contact) => contacts.has(contact),
  }, () => clock.now);
  return { notes, reach, store, clock, open, contacts, set: (key, value, agent = ANN) => reach.plan(bytes(agent), key, value).apply() };
}

const refusal = (code: string, says?: RegExp) => (err: unknown): boolean => {
  assert.ok(err instanceof LocalError, `expected a named refusal, got ${String(err)}`);
  assert.equal(err.code, code);
  if (says) assert.match(err.message, says);
  return true;
};

const historyOf = (notes: Notes, id: string, agent = ANN): Change[] => (notes.get(agent, id, true) as { history: Change[] }).history;

test("every field is optional: a note can be only a body or only a label, and an empty one is refused", () => {
  const { notes } = setup();
  const bodyOnly = notes.set(ANN, ANN, { body: "Ana prefers mornings." }) as Note;
  assert.equal(bodyOnly.body, "Ana prefers mornings.");
  assert.equal(bodyOnly.kind, null);
  assert.equal(bodyOnly.keep_history, 0);
  assert.equal(bodyOnly.show_at_start, false);
  const labelOnly = notes.set(ANN, ANN, { kind: "client", entity: "acme" }) as Note;
  assert.equal(labelOnly.body, null);
  assert.match(labelOnly.id, /^[0-9a-f]{16}$/);
  assert.throws(() => notes.set(ANN, ANN, {}), refusal("bad_argument"));
  assert.throws(() => notes.set(ANN, ANN, { body: "" }), refusal("bad_argument"));
  assert.throws(() => notes.set(ANN, ANN, { with: "Bob" }), refusal("bad_argument"));
  assert.throws(() => notes.set(ANN, ANN, { body: "x", check_by: "next Tuesday" }), refusal("bad_argument"));
  assert.throws(() => notes.set(ANN, ANN, { body: "x", check_by: 1764579600 }), refusal("bad_argument"), "a time that isn't text is refused by name, not by a crash");
  assert.throws(() => notes.set(ANN, ANN, { body: "x", expires: true }), refusal("bad_argument"));
});

test("a change touches only the fields it names, clear empties one, and times with no zone are UTC", () => {
  const { notes, clock } = setup();
  assert.throws(() => notes.set(ANN, ANN, { body: "x", expires: "2026-02-31" }), refusal("bad_argument"), "a day that doesn't exist must not roll into March");
  const made = notes.set(ANN, ANN, { body: "Quote sent.", kind: "deal", status: "waiting on Ana", with: PEER, check_by: "2026-12-01T09:00", expires: "2027-01-01", show_at_start: true }) as Note;
  assert.equal(made.check_by, "2026-12-01T09:00:00.000Z");
  assert.equal(made.expires_at, "2027-01-01T00:00:00.000Z");

  clock.now += 1000;
  const changed = notes.set(ANN, ANN, { note: made.id, status: "signed" }) as Note;
  assert.equal(changed.status, "signed");
  assert.equal(changed.body, "Quote sent.", "a field that wasn't named is left alone");
  assert.equal(changed.with_id, PEER);
  assert.equal(changed.created_at, made.created_at);
  assert.notEqual(changed.updated_at, made.updated_at);

  const cleared = notes.set(ANN, ANN, { note: made.id, clear: "status, check_by,show_at_start,body" }) as Note;
  assert.equal(cleared.status, null);
  assert.equal(cleared.check_by, null);
  assert.equal(cleared.show_at_start, false);
  assert.equal(cleared.body, null);
  assert.equal(cleared.kind, "deal", "clearing one field leaves the rest");
  assert.equal(cleared.expires_at, "2027-01-01T00:00:00.000Z");

  assert.throws(() => notes.set(ANN, ANN, { note: made.id, status: "x", clear: "status" }), refusal("bad_argument", /both given and cleared/));
  assert.throws(() => notes.set(ANN, ANN, { note: made.id, clear: "title" }), refusal("bad_argument"));
  assert.throws(() => notes.set(ANN, ANN, { note: made.id }), refusal("bad_argument", /Nothing to change/));
  assert.throws(() => notes.set(ANN, ANN, { body: "new", clear: "status" }), refusal("bad_argument"));
  assert.throws(() => notes.set(ANN, ANN, { note: "00".repeat(8), status: "x" }), refusal("no_such_note"));
});

test("history: off by default, then each change keeps the version before it, trimmed to the number asked", () => {
  const { notes, clock } = setup();
  const plain = notes.set(ANN, ANN, { body: "v0" }) as Note;
  notes.set(ANN, ANN, { note: plain.id, body: "v1" });
  assert.deepEqual(historyOf(notes, plain.id), [], "a note that didn't ask keeps nothing");

  const kept = notes.set(ANN, ANN, { body: "v0", keep_history: 2 }) as Note;
  for (const body of ["v1", "v2", "v3", "v4"]) {
    clock.now += 1000;
    notes.set(ANN, ANN, { note: kept.id, body });
  }
  const history = historyOf(notes, kept.id);
  assert.deepEqual(history.map((change) => change.before.body), ["v3", "v2"], "the two newest past versions, newest first");
  assert.equal(history[0]?.changed_at, new Date(clock.now).toISOString());
  assert.equal(history[0]?.before.updated_at, new Date(clock.now - 1000).toISOString(), "a past version carries its own stamp");
  assert.equal((notes.get(ANN, kept.id, false) as { history?: unknown }).history, undefined, "history comes only when asked for");

  // Lowering the number trims at once, and 0 drops what was kept.
  notes.set(ANN, ANN, { note: kept.id, keep_history: 1 });
  assert.deepEqual(historyOf(notes, kept.id).map((change) => change.before.body), ["v4"]);
  notes.set(ANN, ANN, { note: kept.id, clear: "keep_history" });
  assert.deepEqual(historyOf(notes, kept.id), []);
  assert.throws(() => notes.set(ANN, ANN, { body: "x", keep_history: 101 }), refusal("bad_argument"));
  assert.throws(() => notes.set(ANN, ANN, { body: "x", keep_history: 1.5 }), refusal("bad_argument"));
});

test("a kind that must keep history: the default number at least, never fewer, and it reaches notes made before the kind was listed", () => {
  const { notes, set } = setup();
  const before = notes.set(ANN, ANN, { body: "p0", kind: "promise" }) as Note;
  assert.equal(before.keep_history, 0);
  set("notes.history_default", "3");
  set("notes.history_kinds", "price, promise");

  const made = notes.set(ANN, ANN, { body: "q0", kind: "promise" }) as Note;
  assert.equal(made.keep_history, 3, "a new note of a listed kind keeps the default without asking");
  assert.throws(() => notes.set(ANN, ANN, { body: "x", kind: "promise", keep_history: 2 }), refusal("history_required", /notes\.history_kinds/));
  assert.throws(() => notes.set(ANN, ANN, { note: made.id, keep_history: 0 }), refusal("history_required"));
  assert.equal((notes.set(ANN, ANN, { body: "x", kind: "promise", keep_history: 5 }) as Note).keep_history, 5, "more than the default is fine");
  assert.equal((notes.set(ANN, ANN, { note: made.id, clear: "keep_history" }) as Note).keep_history, 3, "clearing goes back to what the kind requires, not to none");

  // The note made before the kind was listed keeps history from its next change on.
  const after = notes.set(ANN, ANN, { note: before.id, body: "p1" }) as Note;
  assert.equal(after.keep_history, 3);
  assert.deepEqual(historyOf(notes, before.id).map((change) => change.before.body), ["p0"]);

  // A note that takes on a listed kind is held to it from that change.
  const other = notes.set(ANN, ANN, { body: "r0", kind: "client" }) as Note;
  assert.throws(() => notes.set(ANN, ANN, { note: other.id, kind: "price", keep_history: 1 }), refusal("history_required"));
  assert.equal((notes.set(ANN, ANN, { note: other.id, kind: "price" }) as Note).keep_history, 3);
  assert.equal((notes.set(BEA, BEA, { body: "x", kind: "promise" }) as Note).keep_history, 0, "one agent's list is never another's");

  // Another kind is no way out: not in one call, not by clearing the kind, and not in a second call while a listed version is kept.
  const bodies = (id: string): (string | null)[] => historyOf(notes, id).map((change) => change.before.body);
  assert.deepEqual(bodies(before.id), ["p0"]);
  assert.throws(() => notes.set(ANN, ANN, { note: before.id, kind: "other", keep_history: 0 }), refusal("history_required"));
  assert.throws(() => notes.set(ANN, ANN, { note: before.id, clear: "kind,keep_history", keep_history: 0 }), refusal("bad_argument"));
  assert.throws(() => notes.set(ANN, ANN, { note: before.id, clear: "kind", keep_history: 0 }), refusal("history_required"));
  const moved = notes.set(ANN, ANN, { note: before.id, kind: "other" }) as Note;
  assert.equal(moved.keep_history, 3, "the change of kind is itself kept");
  assert.deepEqual(bodies(before.id), ["p1", "p0"]);
  assert.throws(() => notes.set(ANN, ANN, { note: before.id, keep_history: 0 }), refusal("history_required"), "its kept versions are still of the listed kind");
  assert.deepEqual(bodies(before.id), ["p1", "p0"], "nothing was trimmed by the refused calls");
});

test("the cap refuses by name and drops nothing, and a body is measured in bytes", () => {
  const { notes, set } = setup();
  set("notes.max", "3");
  const ids = ["a", "b", "c"].map((body) => (notes.set(ANN, ANN, { body }) as Note).id);
  assert.throws(() => notes.set(ANN, ANN, { body: "d" }), refusal("too_many_notes", /notes\.max/));
  assert.deepEqual((notes.list(ANN, {}) as { notes: Note[] }).notes.map((note) => note.id).sort(), [...ids].sort(), "nothing was dropped to make room");
  notes.set(ANN, ANN, { note: ids[0], body: "changed" });
  notes.set(BEA, BEA, { body: "another agent has its own count" });
  notes.remove(ANN, ANN, ids[1]);
  notes.set(ANN, ANN, { body: "d" });

  set("notes.body_max_bytes", "10");
  notes.set(ANN, ANN, { note: ids[0], body: "0123456789" });
  // Four characters, twelve bytes.
  assert.throws(() => notes.set(ANN, ANN, { note: ids[0], body: "€€€€" }), refusal("too_long", /10 bytes.*this is 12/));
  assert.throws(() => notes.set(ANN, ANN, { note: ids[0], kind: "k".repeat(201) }), refusal("too_long"));
});

test("writing another agent's notes takes the writer's setting, and the stamp is always the writer", () => {
  const { notes, set } = setup();
  const own = notes.set(BEA, BEA, { body: "Bea's own" }) as Note;
  assert.throws(() => notes.set(ANN, BEA, { body: "from Ann" }), refusal("not_allowed_to_write", /notes\.write/));
  assert.throws(() => notes.set(ANN, BEA, { note: own.id, body: "overwritten" }), refusal("not_allowed_to_write"));
  assert.throws(() => notes.remove(ANN, BEA, own.id), refusal("not_allowed_to_write"));
  assert.equal((notes.get(BEA, own.id, false) as Note).body, "Bea's own");

  // Bea's setting says nothing about what Ann may do: it is the writer's that counts.
  set("notes.write", "all", BEA);
  assert.throws(() => notes.set(ANN, BEA, { body: "from Ann" }), refusal("not_allowed_to_write"));

  set("notes.write", BEA);
  const forBea = notes.set(ANN, BEA, { body: "from Ann", keep_history: 1 }) as Note;
  assert.equal(forBea.agent_id, BEA, "it is Bea's note");
  assert.equal(forBea.written_by, ANN, "written by Ann");
  assert.throws(() => notes.set(ANN, CAL, { body: "x" }), refusal("not_allowed_to_write"), "a list names who, and nobody else");
  assert.throws(() => notes.get(ANN, forBea.id, false), refusal("no_such_note"), "it isn't among Ann's notes");

  const byBea = notes.set(BEA, BEA, { note: forBea.id, status: "seen" }) as Note;
  assert.equal(byBea.written_by, BEA, "the stamp follows the last writer");
  assert.equal(historyOf(notes, forBea.id, BEA)[0]?.before.written_by, ANN);
  assert.equal(historyOf(notes, forBea.id, BEA)[0]?.written_by, BEA);

  set("notes.write", "all");
  notes.set(ANN, CAL, { body: "x" });
  notes.remove(ANN, BEA, forBea.id);
  set("notes.write", "own");
  assert.throws(() => notes.set(ANN, CAL, { body: "x" }), refusal("not_allowed_to_write"));
});

test("widening who an agent may write for, raising a limit and unlisting a kind loosen; the other way tightens", () => {
  const { reach } = setup();
  const way = (key: string, steps: [string | null, string][]): void => {
    for (const [value, direction] of steps) {
      const change = reach.plan(bytes(ANN), key, value);
      assert.equal(change.direction, direction, `${key} from ${change.from} to ${change.to}`);
      change.apply();
    }
  };
  way("notes.write", [["own", "neutral"], [BEA, "loosen"], [`${CAL}, ${BEA}`, "loosen"], [`${BEA},${CAL}`, "neutral"], [CAL, "tighten"], [BEA, "loosen"], ["all", "loosen"], [BEA, "tighten"], ["own", "tighten"], ["all", "loosen"], [null, "tighten"]]);
  assert.throws(() => reach.plan(bytes(ANN), "notes.write", "Bea"), refusal("bad_setting"));
  assert.throws(() => reach.plan(bytes(ANN), "notes.write", `all,${BEA}`), refusal("bad_setting"));
  assert.throws(() => reach.plan(bytes(ANN), "notes.write", ""), refusal("bad_setting"));
  way("notes.history_kinds", [["promise", "tighten"], ["price,promise", "tighten"], [" promise , price ", "neutral"], ["price", "loosen"], ["promise", "loosen"], [null, "loosen"], ["", "neutral"]]);
  way("notes.max", [["10", "tighten"], ["11", "loosen"]]);
  way("notes.body_max_bytes", [["100", "tighten"], ["101", "loosen"]]);
  way("notes.history_default", [["5", "tighten"], ["6", "loosen"]]);
  // With a kind listed, fewer versions weakens what it must keep, so both ways take a person.
  way("notes.history_kinds", [["promise", "tighten"]]);
  way("notes.history_default", [["4", "loosen"], ["4", "neutral"], ["7", "loosen"]]);
});

test("widening notes.write warns only when the agent is open to strangers, and narrowing never does", () => {
  const { store } = setup();
  const governance = new Governance(store, { notify: () => undefined, isLocalAgent: () => true });
  governance.writeDefaults(bytes(ANN));
  const set = (name: string, value: string): { warning?: string } => governance.settingsSet(bytes(ANN), ANN, { name, value, caller: "cli", person_confirmed: true }) as { warning?: string };
  assert.match(set("notes.write", BEA).warning ?? "", /accepts sessions from strangers/);
  assert.equal(set("notes.write", "own").warning, undefined, "narrowing says nothing");
  assert.equal(set("notes.max", "20000").warning, undefined, "another setting says nothing");
  set("bounds.unknown.not_accepting", "true");
  assert.equal(set("notes.write", "all").warning, undefined, "shut to strangers, there is nothing to warn of");
});

test("a source must be a message or a post the writer holds, and each change's stamp replaces the last", () => {
  const { notes } = setup();
  const made = notes.set(ANN, ANN, { body: "They asked for net 60.", source: `${SESSION}:4`, keep_history: 5 }) as Note;
  assert.equal(made.source, `${SESSION}:4`);
  assert.equal((notes.set(ANN, ANN, { note: made.id, source: `${CHANNEL}:2` }) as Note).source, `${CHANNEL}:2`);
  assert.throws(() => notes.set(ANN, ANN, { body: "x", source: `${SESSION}:5` }), refusal("no_such_source"));
  assert.throws(() => notes.set(ANN, ANN, { body: "x", source: `${CHANNEL}:3` }), refusal("no_such_source"));
  assert.throws(() => notes.set(ANN, ANN, { body: "x", source: "the call on Tuesday" }), refusal("bad_argument"));
  assert.throws(() => notes.set(BEA, BEA, { body: "x", source: `${SESSION}:4` }), refusal("no_such_source"), "another agent's message isn't in this one's store");

  // A change with no source leaves none on the note: the old one belonged to the old change, and history has it.
  const next = notes.set(ANN, ANN, { note: made.id, status: "agreed" }) as Note;
  assert.equal(next.source, null);
  const history = historyOf(notes, made.id);
  assert.deepEqual(history.map((change) => [change.source, change.before.source]), [[null, `${CHANNEL}:2`], [`${CHANNEL}:2`, `${SESSION}:4`]]);

  // Clearing the source alone is a change of its own.
  notes.set(ANN, ANN, { note: made.id, source: `${SESSION}:4` });
  assert.equal((notes.set(ANN, ANN, { note: made.id, clear: "source" }) as Note).source, null);
  assert.equal(historyOf(notes, made.id)[0]?.before.source, `${SESSION}:4`);
  assert.throws(() => notes.set(ANN, ANN, { note: made.id, clear: "source", source: `${SESSION}:4` }), refusal("bad_argument", /both given and cleared/));
});

test("listing filters by each label and scope, newest change first, and cuts long bodies", () => {
  const { notes, clock } = setup();
  const step = (params: Record<string, unknown>): string => {
    clock.now += 1000;
    return (notes.set(ANN, ANN, params) as Note).id;
  };
  const a = step({ body: "a", kind: "client", entity: "acme", with: PEER });
  const b = step({ body: "b".repeat(300), kind: "client", status: "waiting on Ana", session: SESSION });
  const c = step({ body: "c", kind: "promise", channel: CHANNEL });
  notes.set(BEA, BEA, { body: "Bea's", kind: "client" });
  const ids = (params: Record<string, unknown>): string[] => (notes.list(ANN, params) as { notes: Note[] }).notes.map((note) => note.id);
  assert.deepEqual(ids({}), [c, b, a]);
  assert.deepEqual(ids({ kind: "client" }), [b, a]);
  assert.deepEqual(ids({ kind: "client", entity: "acme" }), [a]);
  assert.deepEqual(ids({ status: "waiting on Ana" }), [b]);
  assert.deepEqual(ids({ with: PEER }), [a]);
  assert.deepEqual(ids({ session: SESSION }), [b]);
  assert.deepEqual(ids({ channel: CHANNEL }), [c]);
  clock.now += 1000;
  notes.set(ANN, ANN, { note: a, status: "touched" });
  assert.deepEqual(ids({}), [a, c, b], "a change moves a note to the front");

  const short = notes.list(ANN, { limit: 2 }) as { notes: (Note & { body_cut?: boolean })[]; total: number; more: number };
  assert.equal(short.total, 3);
  assert.equal(short.more, 1);
  const whole = (notes.list(ANN, { kind: "client" }) as { notes: (Note & { body_cut?: boolean })[] }).notes[0];
  assert.equal(whole?.body_cut, undefined);
  const long = (notes.list(ANN, { session: SESSION }) as { notes: (Note & { body_cut?: boolean })[] }).notes[0];
  assert.equal(long?.body?.length, 200);
  assert.equal(long?.body_cut, true);
  assert.equal((notes.get(ANN, b, false) as Note).body?.length, 300);
});

test("removing a note takes its history, and a removed agent takes all of its notes and theirs", () => {
  const { notes, store } = setup();
  const count = (table: string): number => (store.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
  const one = notes.set(ANN, ANN, { body: "v0", keep_history: 3 }) as Note;
  const two = notes.set(ANN, ANN, { body: "w0", keep_history: 3 }) as Note;
  const beas = notes.set(BEA, BEA, { body: "x0", keep_history: 3 }) as Note;
  for (const [agent, note] of [[ANN, one.id], [ANN, two.id], [BEA, beas.id]] as const) notes.set(agent, agent, { note, body: "next" });
  assert.equal(count("note_changes"), 3);

  assert.throws(() => notes.remove(BEA, BEA, one.id), refusal("no_such_note"), "an id is looked up under its owner");
  notes.remove(ANN, ANN, one.id);
  assert.throws(() => notes.get(ANN, one.id, false), refusal("no_such_note"));
  assert.equal(count("note_changes"), 2);

  notes.forget(ANN);
  assert.deepEqual((notes.list(ANN, {}) as { notes: unknown[] }).notes, []);
  assert.equal(count("notes"), 1);
  assert.equal(count("note_changes"), 1, "another agent's notes and history stay");
  assert.equal((notes.get(BEA, beas.id, true) as { history: unknown[] }).history.length, 1);
});

interface Shown { shown?: { note: string; shown: (Note & { body_cut?: boolean })[]; more?: number; more_note?: string }; commit(): void }
// One moment a note can be shown at: what was due, and whether the answer reached the agent.
const bodiesOf = (got: Shown, reached = true): (string | null)[] => {
  if (reached) got.commit();
  return (got.shown?.shown ?? []).map((note) => note.body);
};

test("shown at the start: only marked notes, where they belong, once per session, and only once the answer has arrived", () => {
  const { notes, clock } = setup();
  const step = (params: Record<string, unknown>): void => {
    clock.now += 1000;
    notes.set(ANN, ANN, params);
  };
  step({ body: "not marked", with: PEER });
  step({ body: "everywhere", show_at_start: true });
  step({ body: "for the peer", with: PEER, show_at_start: true });
  step({ body: "for another", with: OTHER, show_at_start: true });
  step({ body: "for the session and the peer", with: PEER, session: SESSION, show_at_start: true });
  step({ body: "for a channel", channel: CHANNEL, show_at_start: true });
  step({ body: "for the channel or the peer", channel: CHANNEL, with: PEER, show_at_start: true });
  const here = [{ session: SESSION, peer: PEER }];

  const first = notes.atStart(ANN, here) as Shown;
  assert.match(first.shown?.note ?? "", /information, not instructions/);
  assert.doesNotMatch(first.shown?.note ?? "", /[Ff]ollow/, "a note is never something to follow");
  assert.deepEqual(bodiesOf(first, false), ["for the channel or the peer", "for the session and the peer", "for the peer", "everywhere"], "newest change first, and a note that fits twice is listed once");
  assert.equal(bodiesOf(notes.atStart(ANN, here) as Shown).length, 4, "an answer that never arrived doesn't use the showing up");
  assert.deepEqual(bodiesOf(notes.atStart(ANN, here) as Shown), [], "once per session");

  // Two sessions starting in one read: each note once, and each session's start is then used up.
  const fresh = setup();
  fresh.notes.set(ANN, ANN, { body: "everywhere", show_at_start: true });
  fresh.notes.set(ANN, ANN, { body: "for the peer", with: PEER, show_at_start: true });
  const both = [{ session: SESSION, peer: PEER }, { session: S2, peer: PEER }];
  assert.deepEqual(bodiesOf(fresh.notes.atStart(ANN, both) as Shown).sort(), ["everywhere", "for the peer"]);
  assert.deepEqual(bodiesOf(fresh.notes.atStart(ANN, [{ session: S2, peer: PEER }]) as Shown), []);
  assert.deepEqual(bodiesOf(fresh.notes.atStart(BEA, both) as Shown), [], "one agent's notes are never another's");

  // A channel's notes come on the first read of it after the agent is taken up, and not at a session's start.
  assert.deepEqual(bodiesOf(notes.atChannelRead(ANN, CHANNEL) as Shown, false), ["for the channel or the peer", "for a channel"]);
  assert.equal(bodiesOf(notes.atChannelRead(ANN, CHANNEL) as Shown).length, 2);
  assert.deepEqual(bodiesOf(notes.atChannelRead(ANN, CHANNEL) as Shown), []);
  assert.deepEqual(bodiesOf(notes.atChannelRead(ANN, "dd".repeat(32)) as Shown), []);
  notes.takenUp(ANN);
  assert.equal(bodiesOf(notes.atChannelRead(ANN, CHANNEL) as Shown).length, 2);
});

test("at most notes.start_max are shown at once, newest change first, with long bodies cut and the rest counted", () => {
  const { notes, clock, set } = setup();
  set("notes.start_max", "2");
  for (const body of ["oldest", "middle", "n".repeat(300)]) {
    clock.now += 1000;
    notes.set(ANN, ANN, { body, show_at_start: true });
  }
  const got = notes.atStart(ANN, [{ session: SESSION, peer: PEER }]) as Shown;
  assert.deepEqual(got.shown?.shown.map((note) => [note.body?.length, note.body_cut]), [[200, true], [6, undefined]]);
  assert.equal(got.shown?.more, 1);
  assert.match(got.shown?.more_note ?? "", /note-list/);
  assert.equal((notes.list(ANN, { show_at_start: true }) as { total: number }).total, 3);
  assert.equal((notes.list(ANN, {}) as { total: number }).total, 3);
});

test("a note about a removed contact is kept, marked and not shown, a stranger's is shown, and adding the contact back restores it", () => {
  const { notes, contacts } = setup();
  const made = notes.set(ANN, ANN, { body: "who they are", with: PEER, show_at_start: true }) as Note & { contact_removed?: boolean };
  const start = (session: string): (string | null)[] => bodiesOf(notes.atStart(ANN, [{ session, peer: PEER }]) as Shown, false);
  const marked = (): boolean | undefined => (notes.get(ANN, made.id, false) as { contact_removed?: boolean }).contact_removed;
  assert.deepEqual(start(SESSION), ["who they are"], "never added is a stranger, not a removed contact");
  assert.equal(marked(), undefined);

  contacts.add(PEER);
  contacts.delete(PEER);
  notes.contactRemoved(ANN, PEER);
  assert.deepEqual(start(SESSION), []);
  assert.equal(marked(), true);
  assert.equal((notes.list(ANN, {}) as { notes: { contact_removed?: boolean }[] }).notes[0]?.contact_removed, true);
  assert.equal((notes.get(BEA, (notes.set(BEA, BEA, { body: "x", with: PEER }) as Note).id, false) as { contact_removed?: boolean }).contact_removed, undefined, "one agent removing a contact says nothing of another's");

  contacts.add(PEER);
  assert.deepEqual(start(SESSION), ["who they are"]);
  assert.equal(marked(), undefined);
});

test("a note past its time goes with its history, and a session's note goes when the session closes", () => {
  const { notes, clock, open, store } = setup();
  const count = (table: string): number => (store.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
  const timed = notes.set(ANN, ANN, { body: "until noon", expires: "2026-11-25T12:00", keep_history: 2, show_at_start: true }) as Note;
  notes.set(ANN, ANN, { note: timed.id, status: "changed" });
  const forNow = notes.set(ANN, ANN, { body: "for this talk", session: S2, keep_history: 2, show_at_start: true }) as Note;
  notes.set(ANN, ANN, { note: forNow.id, status: "changed" });
  const stays = notes.set(ANN, ANN, { body: "stays" }) as Note;
  assert.throws(() => notes.set(ANN, ANN, { body: "x", session: "33".repeat(16) }), refusal("no_such_session"));
  assert.equal(count("note_changes"), 2);

  clock.now = Date.parse("2026-11-25T11:59:59Z");
  assert.equal((notes.list(ANN, {}) as { total: number }).total, 3);
  clock.now = Date.parse("2026-11-25T12:00:00Z");
  assert.deepEqual(bodiesOf(notes.atStart(ANN, [{ session: S2, peer: PEER }]) as Shown, false), ["for this talk"], "a note past its time isn't shown either");
  assert.throws(() => notes.get(ANN, timed.id, false), refusal("no_such_note"));
  assert.equal(count("note_changes"), 1);

  open.delete(S2);
  assert.deepEqual((notes.list(ANN, {}) as { notes: Note[] }).notes.map((note) => note.id), [stays.id]);
  assert.equal(count("note_changes"), 0);
  assert.throws(() => notes.set(ANN, ANN, { note: forNow.id, status: "late" }), refusal("no_such_note"));
});

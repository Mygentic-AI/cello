// note-query: what a query may run, what it sees, and how it ends. A query that writes, sees another agent's notes, runs
// for ever or comes back empty after its process died still looks like an answer, so none of those shows by itself.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalError } from "../src/daemon/errors.ts";
import { assertSelect, MAX_QUERIES, NoteQueries } from "../src/daemon/note-query.ts";
import { NOTE_CHANGES_COLUMNS, NOTES_COLUMNS } from "../src/daemon/note-query-shape.ts";
import { type NoteHost, Notes } from "../src/daemon/notes.ts";
import { Reach } from "../src/daemon/reach.ts";
import { Store } from "../src/daemon/store.ts";

const ANN = "07".repeat(32);
const BEA = "08".repeat(32);
const CAL = "09".repeat(32);
const PEER = "aa".repeat(32);
const SESSION = "11".repeat(16);
const NAMES: Record<string, string> = { [ANN]: "Ann", [BEA]: "Bea", [CAL]: "Cal" };
const bytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
// Runs until it is killed, and yields no row on the way, so the row limit can't end it first.
const ENDLESS = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS n FROM c";

interface Answer { agent: string; rows: Record<string, unknown>[]; count: number; cut?: boolean; cut_note?: string }

function setup(): { notes: Notes; queries: NoteQueries; store: Store; dir: string; open: Set<string>; clock: { now: number }; set(key: string, value: string, agent?: string): void; ask(sql: string, agent?: string): Promise<Answer> } {
  const dir = mkdtempSync(join(tmpdir(), "cello-query-"));
  const store = new Store(join(dir, "cello.db"));
  const reach = new Reach(store);
  [ANN, BEA, CAL].forEach((agent, i) => {
    store.insertAgent(bytes(agent), NAMES[agent] as string, new Uint8Array(32).fill(i + 1), new Uint8Array(32).fill(i + 11));
    reach.writeDefaults(bytes(agent));
  });
  const clock = { now: Date.parse("2026-11-25T10:00:00Z") };
  const open = new Set([SESSION]);
  const host: NoteHost = {
    agentName: (agent) => NAMES[agent] as string,
    holdsMessage: () => false,
    holdsPost: () => false,
    sessionOpen: (_agent, session) => open.has(session),
    isContact: () => false,
    heard: () => true,
    bell: () => undefined,
    agents: () => [ANN, BEA, CAL],
  };
  const notes = new Notes(store, reach, host, () => clock.now);
  const queries = new NoteQueries();
  return {
    notes, queries, store, dir, open, clock,
    set: (key, value, agent = ANN) => reach.plan(bytes(agent), key, value).apply(),
    ask: async (sql, agent = ANN) => await notes.query(agent, sql, queries) as Answer,
  };
}

const refusal = (code: string, says?: RegExp) => (err: unknown): boolean => {
  assert.ok(err instanceof LocalError, `expected a named refusal, got ${String(err)}`);
  assert.equal(err.code, code, err.message);
  if (says) assert.match(err.message, says);
  return true;
};

test("only one statement starting with SELECT or WITH passes, after any space and comments", () => {
  for (const sql of ["SELECT 1", "  \n\tselect 1", "WiTh x AS (SELECT 1) SELECT * FROM x", "-- notes\nSELECT 1", "/* a */ /* b */\n-- c\n  select(1)", "select\n1"]) {
    assert.equal(assertSelect(sql), sql);
  }
  for (const sql of ["-- SELECT\nDELETE FROM notes", "/* SELECT */ DELETE FROM notes", "/* SELECT 1", "-- SELECT 1", "selection", "INSERT INTO notes (id) VALUES ('x')", "PRAGMA query_only = OFF", "VACUUM INTO 'x'", "ATTACH DATABASE 'x' AS y", "", " ", 42, undefined, "VALUES (1)", "EXPLAIN SELECT 1"]) {
    assert.throws(() => assertSelect(sql), refusal("query_not_select", /one statement that starts with SELECT or WITH/), String(sql));
  }
});

test("a query sees two tables in the documented shape: hex ids, ISO times, a body JSON reads inside, and no bookkeeping", async () => {
  const { notes, ask, clock } = setup();
  const deal = notes.set(ANN, ANN, { body: "{\"amount\": 1200, \"region\": \"north\"}", kind: "deal", entity: "acme", with: PEER, check_by: "2026-11-25T11:00", keep_history: 2 }) as { id: string };
  notes.set(ANN, ANN, { note: deal.id, status: "signed" });
  clock.now += 2 * 3600_000;
  notes.ringDue(ANN);
  notes.contactRemoved(ANN, PEER);

  const [row] = (await ask("SELECT * FROM notes")).rows;
  assert.deepEqual(Object.keys(row ?? {}), [...NOTES_COLUMNS]);
  assert.deepEqual(row, {
    id: deal.id, agent_id: ANN, written_by: ANN, created_at: "2026-11-25T10:00:00.000Z", updated_at: "2026-11-25T10:00:00.000Z",
    kind: "deal", status: "signed", entity: "acme", with_id: PEER, session_id: null, channel_id: null,
    check_by: "2026-11-25T11:00:00.000Z", rang_at: "2026-11-25T12:00:00.000Z", expires_at: null, show_at_start: 0, keep_history: 2, source: null,
    body: "{\"amount\": 1200, \"region\": \"north\"}", contact_removed: 1,
  });
  const [change] = (await ask("SELECT * FROM note_changes")).rows;
  assert.deepEqual(Object.keys(change ?? {}), [...NOTE_CHANGES_COLUMNS]);
  assert.deepEqual([change?.["note_id"], change?.["agent_id"], change?.["changed_at"], JSON.parse(change?.["before"] as string).status, change?.["removed"]], [deal.id, ANN, "2026-11-25T10:00:00.000Z", null, 0]);

  // What the shape promises an agent can do with it.
  const worked = (await ask("SELECT json_extract(body, '$.region') AS region, sum(json_extract(body, '$.amount')) AS total, date(check_by) AS day, check_by < datetime('2026-12-01') AS soon FROM notes GROUP BY region")).rows;
  assert.deepEqual(worked, [{ region: "north", total: 1200, day: "2026-11-25", soon: 1 }]);
  const internal = await ask("SELECT name FROM pragma_table_info('notes') WHERE name IN ('agent_rang_at', 'due_told_at')");
  assert.deepEqual(internal.rows, [], "the daemon's own marks stay out");
});

test("notes that have ended are gone before a query reads, as for every other reader", async () => {
  const { notes, ask, open, clock } = setup();
  notes.set(ANN, ANN, { body: "brief", expires: "2026-11-25T10:30" });
  notes.set(ANN, ANN, { body: "for the session", session: SESSION });
  notes.set(ANN, ANN, { body: "stays" });
  open.delete(SESSION);
  clock.now += 3600_000;
  assert.deepEqual((await ask("SELECT body FROM notes")).rows, [{ body: "stays" }]);
});

test("a body with line and paragraph separators, quotes and newlines comes back as it went in", async () => {
  const { notes, ask } = setup();
  const body = "one two three\n\"four\"\r\n\\five 🎻";
  notes.set(ANN, ANN, { body });
  assert.deepEqual((await ask("SELECT body FROM notes")).rows, [{ body }]);
});

test("a WITH that ends in a write is refused by the engine, and nothing is changed", async () => {
  const { notes, ask } = setup();
  notes.set(ANN, ANN, { body: "keep me" });
  for (const sql of ["WITH x AS (SELECT 1) DELETE FROM notes", "WITH x AS (SELECT 1) INSERT INTO notes (body) VALUES ('new')", "WITH x AS (SELECT 1) UPDATE notes SET body = 'changed'"]) {
    await assert.rejects(ask(sql), refusal("query_failed", /readonly/), sql);
  }
  assert.deepEqual((await ask("SELECT body FROM notes")).rows, [{ body: "keep me" }]);
  assert.deepEqual((notes.list(ANN, ANN, {}) as { notes: { body: string }[] }).notes.map((note) => note.body), ["keep me"]);
});

test("writes, ATTACH, VACUUM and PRAGMA are refused before anything runs, and leave no file behind", async () => {
  const { ask, dir } = setup();
  const file = join(dir, "escaped.db");
  for (const sql of [`ATTACH DATABASE '${file}' AS out`, `VACUUM INTO '${file}'`, "PRAGMA query_only = OFF", "INSERT INTO notes (body) VALUES ('x')", "DELETE FROM notes", "  /* x */ attach database ':memory:' AS m"]) {
    await assert.rejects(ask(sql), refusal("query_not_select"), sql);
  }
  // Hidden behind a SELECT, it is a second statement, which the library refuses.
  await assert.rejects(ask(`SELECT 1; ATTACH DATABASE '${file}' AS out`), refusal("query_failed", /more than one statement/));
  await assert.rejects(ask("SELECT 1; SELECT 2"), refusal("query_failed", /more than one statement/));
  assert.equal(existsSync(file), false);
});

test("SQLite's own words come back for SQL it refuses, and a trailing semicolon or open comment is fine", async () => {
  const { notes, ask, set } = setup();
  await assert.rejects(ask("SELECT nope FROM notes"), refusal("query_failed", /no such column: nope/));
  await assert.rejects(ask("SELECT * FROM agents"), refusal("query_failed", /no such table: agents/));
  for (let i = 0; i < 3; i++) notes.set(ANN, ANN, { body: `n${i}` });
  set("notes.query_rows", "2");
  assert.equal((await ask("SELECT body FROM notes;  \n")).count, 2);
  // An open comment at the end would swallow the row limit's wrapper if nothing closed it, and this would run for ever.
  set("notes.query_ms", "3000");
  const open = await ask("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c /* the rest");
  assert.deepEqual([open.rows, open.cut], [[{ x: 1 }, { x: 2 }], true]);
});

test("a result longer than notes.query_rows is cut there and says so, and one that fits isn't marked", async () => {
  const { notes, ask, set } = setup();
  for (let i = 0; i < 5; i++) notes.set(ANN, ANN, { body: `n${i}` });
  set("notes.query_rows", "3");
  const cut = await ask("SELECT body FROM notes ORDER BY body DESC");
  assert.deepEqual(cut.rows.map((row) => row["body"]), ["n4", "n3", "n2"], "the first rows, in the query's own order");
  assert.deepEqual([cut.count, cut.cut], [3, true]);
  assert.match(cut.cut_note ?? "", /first 3.*notes\.query_rows/s);
  // A join that would make 125 rows still stops at the limit.
  assert.equal((await ask("SELECT a.id FROM notes a, notes b, notes c")).count, 3);
  const fits = await ask("SELECT body FROM notes LIMIT 3");
  assert.deepEqual([fits.count, fits.cut, fits.cut_note], [3, undefined, undefined]);
});

test("an agent sees every agent's notes until notes.read narrows it, and every row says whose", async () => {
  const { notes, ask, set } = setup();
  for (const agent of [ANN, BEA, CAL]) {
    const made = notes.set(agent, agent, { body: NAMES[agent], keep_history: 1 }) as { id: string };
    notes.set(agent, agent, { note: made.id, status: "changed" });
  }
  const whose = async (table: string): Promise<string[]> => (await ask(`SELECT agent_id FROM ${table} ORDER BY agent_id`)).rows.map((row) => NAMES[row["agent_id"] as string] as string);
  assert.deepEqual([await whose("notes"), await whose("note_changes")], [["Ann", "Bea", "Cal"], ["Ann", "Bea", "Cal"]], "reading starts open");
  set("notes.read", "own");
  assert.deepEqual([await whose("notes"), await whose("note_changes")], [["Ann"], ["Ann"]]);
  set("notes.read", BEA);
  assert.deepEqual([await whose("notes"), await whose("note_changes")], [["Ann", "Bea"], ["Ann", "Bea"]]);
  // Ann's setting is Ann's alone: Bea, never changed, still sees everyone.
  assert.deepEqual((await ask("SELECT body FROM notes ORDER BY body", BEA)).rows, [{ body: "Ann" }, { body: "Bea" }, { body: "Cal" }]);
  // An agent named that isn't on this daemon adds nothing.
  set("notes.read", "ff".repeat(32));
  assert.deepEqual(await whose("notes"), ["Ann"]);
});

test("an endless query is killed at its limit, the daemon's side keeps answering, and it doesn't hold a place after", async () => {
  const { ask, set, queries } = setup();
  set("notes.query_ms", "400");
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 10);
  const began = Date.now();
  await assert.rejects(ask(ENDLESS), refusal("query_timed_out", /400 ms.*notes\.query_ms/s));
  clearInterval(ticker);
  const took = Date.now() - began;
  assert.ok(took >= 400 && took < 3000, `stopped after ${took} ms`);
  assert.ok(ticks >= 20, `the event loop turned ${ticks} times while the query ran`);
  assert.equal(queries.running, 0);
  assert.deepEqual((await ask("SELECT 1 AS one")).rows, [{ one: 1 }]);
});

test(`at most ${MAX_QUERIES} queries run at once, a third is refused by name, and the places come back`, async () => {
  const { ask, set, queries } = setup();
  set("notes.query_ms", "600");
  const running = Array.from({ length: MAX_QUERIES }, () => ask(ENDLESS));
  await assert.rejects(ask("SELECT 1"), refusal("too_many_queries", new RegExp(`${MAX_QUERIES} note queries`)));
  for (const one of await Promise.allSettled(running)) {
    assert.equal(one.status, "rejected");
    refusal("query_timed_out")((one as PromiseRejectedResult).reason);
  }
  assert.equal(queries.running, 0);
  assert.equal((await ask("SELECT 1 AS one")).count, 1);
});

test("a query whose process is killed from outside fails by name, never with an empty result", async () => {
  const { notes, set } = setup();
  set("notes.query_ms", "10000");
  notes.set(ANN, ANN, { body: "x" });
  const queries = new NoteQueries();
  const answer = queries.run(ENDLESS, notes.queryRows(ANN, false), { ms: 10_000, rows: 10, bytes: 16_777_216 }, (child) => { setTimeout(() => child.kill("SIGKILL"), 200); });
  await assert.rejects(answer, refusal("query_child_died", /signal SIGKILL/));
  assert.equal(queries.running, 0);
});

test("rows that can't be read for a query end it by name, and the process with it", async () => {
  const queries = new NoteQueries();
  let child: { exitCode: number | null; signalCode: string | null } | undefined;
  function* broken(): Generator<["n", ...unknown[]][]> {
    yield [];
    throw new Error("the store is closed");
  }
  await assert.rejects(queries.run("SELECT 1", broken(), { ms: 10_000, rows: 10, bytes: 16_777_216 }, (spawned) => { child = spawned; }), refusal("query_copy_failed", /the store is closed/));
  assert.equal(child?.signalCode, "SIGKILL");
});

test("a statement followed by a semicolon and a comment, or by a comment alone, still stops at the row limit", async () => {
  const { ask, set } = setup();
  set("notes.query_rows", "2");
  set("notes.query_ms", "3000");
  // Endless, so a statement run without the limit around it would only end at the time limit.
  const endless = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c";
  for (const tail of ["; --", "; -- x", "; /* x */", " -- a trailing comment", " /* x */ ;  ", ";\n;", " /* still open"]) {
    const began = Date.now();
    const got = await ask(endless + tail);
    assert.deepEqual([got.rows, got.cut], [[{ x: 1 }, { x: 2 }], true], JSON.stringify(tail));
    assert.ok(Date.now() - began < 2000, `${JSON.stringify(tail)} took ${Date.now() - began} ms`);
  }
  // A quoted "--" or ";" is text, not the end of the statement.
  assert.deepEqual((await ask("SELECT '--;' AS a, \"x\" AS b FROM (SELECT 'x' AS \"x\") -- end")).rows, [{ a: "--;", b: "x" }]);
});

test("an answer past notes.query_bytes is stopped and refused by name, the daemon side holding none of it, and one under it comes back", async () => {
  const { ask, set } = setup();
  const before = process.memoryUsage().rss;
  // 480 MB of text from no notes at all.
  await assert.rejects(ask("SELECT hex(randomblob(240000000)) AS x"), refusal("query_answer_too_large", /16777216 bytes.*fewer or smaller columns.*notes\.query_bytes/s));
  const grew = process.memoryUsage().rss - before;
  assert.ok(grew < 64 * 2 ** 20, `the daemon side grew by ${Math.round(grew / 2 ** 20)} MB`);

  set("notes.query_bytes", "1048576");
  assert.equal(String((await ask("SELECT hex(randomblob(400000)) AS x")).rows[0]?.["x"]).length, 800_000, "just under the limit");
  await assert.rejects(ask("SELECT hex(randomblob(600000)) AS x"), refusal("query_answer_too_large", /1048576 bytes/));
  // Quotes double in JSON, so this looks small until it is written out: the daemon's own count stops it.
  await assert.rejects(ask("SELECT replace(hex(zeroblob(300000)), '0', '\"') AS x"), refusal("query_answer_too_large", /1048576 bytes/));
  await assert.rejects(ask("SELECT randomblob(400000) AS a, randomblob(400000) AS b"), refusal("query_answer_too_large"), "a blob comes back as hex, twice its size");
});

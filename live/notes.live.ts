// Notes through the real command line, a real daemon and a real server: an agent's shell writes, changes, lists and removes
// its notes, names a real message as a note's source, and is refused by name where a setting says so. Run it with:
//   CELLO_LIVE_FILES=live/notes.live.ts scripts/live-test.sh
import { cliFor } from "./cli-path.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Database from "@signalapp/sqlcipher";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18090/v1";
const home = mkdtempSync(join(tmpdir(), "cello-notes-"));
// The channel Rae runs and Sol follows, made in the first test.
let news = "";

interface Run { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
interface Note { id: string; agent_id: string; written_by: string; kind: string | null; status: string | null; body: string | null; source: string | null; with_id: string | null; keep_history: number }

function cello(args: string[], caller?: string): Run {
  const run = spawnSync(process.execPath, [cliFor(args), ...args], { encoding: "utf8", env: { ...process.env, CELLO_HOME: home, ...(caller ? { CELLO_CALLER: caller } : {}) } });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(run.stdout || run.stderr) as Record<string, unknown>;
  } catch {
    // Login and logout answer in words.
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, json };
}

function ok(args: string[], caller?: string): Record<string, unknown> {
  const run = cello(args, caller);
  assert.equal(run.status, 0, `cello ${args.join(" ")} failed: ${run.stderr}`);
  return run.json;
}

function refused(args: string[], code: string, caller: string): string {
  const run = cello(args, caller);
  assert.deepEqual([run.status === 0, run.json["error"]], [false, code], `cello ${args.join(" ")} should be refused with ${code}: ${run.stdout}${run.stderr}`);
  return run.json["message"] as string;
}

// A real terminal, because a pipe isn't a person. It types the code the command shows.
const TERMINAL = `
import os, pty, re, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
out, sent, end = "", False, time.time() + 30
while time.time() < end:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        out += data.decode(errors="replace")
    asked = re.search(r"type ([0-9a-f]{6}):", out)
    if asked and not sent:
        sent = True
        os.write(fd, (asked.group(1) + "\\n").encode())
os.close(fd)
print(out)
`;
function person(args: string[]): string {
  const run = spawnSync("python3", ["-c", TERMINAL, process.execPath, cliFor(args), ...args], { encoding: "utf8", timeout: 40_000, env: { ...process.env, CELLO_HOME: home } });
  assert.equal(run.status, 0, `the terminal didn't run: ${run.stderr}`);
  return run.stdout;
}

async function until<T>(what: string, check: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

after(() => {
  cello(["logout"]);
});

test("an agent keeps notes by command line: write, change, history, source, list, remove, and each refusal by name", async () => {
  ok(["login", "--server", url]);
  const rae = ok(["create-agent", "Rae"])["agent_id"] as string;
  const sol = ok(["create-agent", "Sol"])["agent_id"] as string;
  ok(["settings-set", "away.answering", "false", "--agent", "Rae"]);
  ok(["settings-set", "away.answering", "false", "--agent", "Sol"]);
  await until("both agents online", () => (ok(["status"]) as { agents: { online: boolean }[] }).agents.every((a) => a.online));

  // A note that is only labels, then one with a JSON body that keeps history.
  const labels = ok(["note-set", "--kind", "client", "--entity", "acme", "--agent", "Rae"], "rae-shell") as unknown as Note;
  assert.match(labels.id, /^[0-9a-f]{16}$/);
  assert.equal(labels.body, null);
  const deal = ok(["note-set", "{\"amount\": 12000}", "--kind", "deal", "--status", "waiting on Ana", "--keep-history", "2", "--check-by", "2026-12-01T09:00", "--agent", "Rae"], "rae-shell") as unknown as Note & { check_by: string };
  assert.equal(deal.written_by, rae);
  assert.equal(deal.check_by, "2026-12-01T09:00:00.000Z");

  // Only the field given changes, and the version before is kept.
  const signed = ok(["note-set", "--note", deal.id, "--status", "signed", "--agent", "Rae"], "rae-shell") as unknown as Note;
  assert.deepEqual([signed.status, signed.body, signed.kind], ["signed", "{\"amount\": 12000}", "deal"]);
  const withHistory = ok(["note-get", deal.id, "--history", "--agent", "Rae"], "rae-shell") as unknown as Note & { history: { before: Note }[] };
  assert.deepEqual(withHistory.history.map((change) => change.before.status), ["waiting on Ana"]);
  assert.equal((ok(["note-set", "--note", deal.id, "--clear", "status,check_by", "--agent", "Rae"], "rae-shell") as unknown as Note).status, null);
  assert.deepEqual((ok(["note-list", "--kind", "deal", "--agent", "Rae"], "rae-shell") as unknown as { notes: Note[] }).notes.map((note) => note.id), [deal.id]);
  assert.equal((ok(["note-list", "--agent", "Rae"], "rae-shell") as { total: number }).total, 2);

  // A source is a real message in the writer's own store. Sol received position 1, and nothing at 99.
  const session = ok(["initiate-session", sol, "--agent", "Rae"], "rae-shell")["session_id"] as string;
  ok(["send", session, "Can you do net 60?", "--over", "--agent", "Rae"], "rae-shell");
  await until("Sol's message", () => ((ok(["receive", "--agent", "Sol"], "sol-shell") as { messages?: unknown[] }).messages?.length ?? 0) > 0);
  const asked = ok(["note-set", "Rae asked for net 60.", "--with", rae, "--source", `${session}:1`, "--agent", "Sol"], "sol-shell") as unknown as Note;
  assert.deepEqual([asked.source, asked.with_id, asked.written_by], [`${session}:1`, rae, sol]);
  assert.match(refused(["note-set", "made up", "--source", `${session}:99`, "--agent", "Sol"], "no_such_source", "sol-shell"), /holds no message/);
  assert.deepEqual((ok(["note-list", "--with", rae, "--agent", "Sol"], "sol-shell") as unknown as { notes: Note[] }).notes.map((note) => note.id), [asked.id]);
  ok(["close-session", session, "--agent", "Rae"], "rae-shell");
  ok(["close-session", session, "--agent", "Sol"], "sol-shell");

  // A channel post is a source too: for the one who posted it, and for a reader once it has arrived.
  news = ok(["channel-create", "Rae's news", "--type", "public", "--posting", "admin", "--agent", "Rae"], "rae-shell")["channel_id"] as string;
  ok(["channel-join", news, "--agent", "Sol"], "sol-shell");
  const posted = ok(["channel-post", news, "Prices rise in January.", "--title", "Prices", "--agent", "Rae"], "rae-shell")["position"] as number;
  assert.equal((ok(["note-set", "Told the channel about January.", "--source", `${news}:${posted}`, "--agent", "Rae"], "rae-shell") as unknown as Note).source, `${news}:${posted}`);
  const fromPost = await until("the post to reach Sol", () => {
    const run = cello(["note-set", "Rae's prices rise in January.", "--channel", news, "--source", `${news}:${posted}`, "--agent", "Sol"], "sol-shell");
    return run.status === 0 ? run.json as unknown as Note : undefined;
  });
  assert.equal(fromPost.source, `${news}:${posted}`);
  assert.match(refused(["note-set", "made up", "--source", `${news}:${posted + 50}`, "--agent", "Sol"], "no_such_source", "sol-shell"), /holds no post/);
  ok(["note-remove", fromPost.id, "--agent", "Sol"], "sol-shell");

  // Sol can't write Rae's notes, or let itself. A person can, and is told Sol is open to strangers.
  assert.match(refused(["note-set", "from Sol", "--owner", "Rae", "--agent", "Sol"], "not_allowed_to_write", "sol-shell"), /notes\.write/);
  refused(["settings-set", "notes.write", rae, "--agent", "Sol"], "person_required", "sol-shell");
  const widened = person(["settings-set", "notes.write", rae, "--agent", "Sol"]);
  assert.match(widened, /"warning":\s*"This agent accepts sessions from strangers/, widened);
  const forRae = ok(["note-set", "from Sol", "--owner", "Rae", "--agent", "Sol"], "sol-shell") as unknown as Note;
  assert.deepEqual([forRae.agent_id, forRae.written_by], [rae, sol], "Rae's note, stamped as written by Sol");
  assert.equal((ok(["note-get", forRae.id, "--agent", "Rae"], "rae-shell") as unknown as Note).body, "from Sol");
  // Narrowing needs nobody, and warns of nothing.
  assert.equal(ok(["settings-set", "notes.write", "own", "--agent", "Sol"], "sol-shell")["warning"], undefined);
  refused(["note-remove", forRae.id, "--owner", "Rae", "--agent", "Sol"], "not_allowed_to_write", "sol-shell");
  // Shut to strangers, widening has nothing to warn of.
  ok(["settings-set", "bounds.unknown.not_accepting", "true", "--agent", "Sol"], "sol-shell");
  const quiet = person(["settings-set", "notes.write", rae, "--agent", "Sol"]);
  assert.match(quiet, /"was":\s*"own"/, quiet);
  assert.doesNotMatch(quiet, /"warning"/, quiet);
  ok(["settings-set", "notes.write", "own", "--agent", "Sol"], "sol-shell");
  // Sol reads every agent's notes from the start, so re-opening him to strangers is what warns.
  const reopened = person(["settings-set", "bounds.unknown.not_accepting", "false", "--agent", "Sol"]);
  assert.match(reopened, new RegExp(`"warning":\\s*"Unknown agents can now reach Sol, and it can read your other agents' notes\\. To stop that: cello settings-set notes\\.read own --agent ${sol}"`), reopened);

  // The cap refuses and drops nothing. Raising it takes a person.
  ok(["settings-set", "notes.max", "1", "--agent", "Sol"], "sol-shell");
  assert.match(refused(["note-set", "one too many", "--agent", "Sol"], "too_many_notes", "sol-shell"), /notes\.max/);
  refused(["settings-set", "notes.max", "2", "--agent", "Sol"], "person_required", "sol-shell");
  assert.equal((ok(["note-list", "--agent", "Sol"], "sol-shell") as { total: number }).total, 1);

  // A kind that must keep history: anyone can list it, and only a person can take it off.
  ok(["settings-set", "notes.history_kinds", "promise", "--agent", "Rae"], "rae-shell");
  const promise = ok(["note-set", "Send the draft by Friday.", "--kind", "promise", "--agent", "Rae"], "rae-shell") as unknown as Note;
  assert.equal(promise.keep_history, 10);
  refused(["note-set", "x", "--kind", "promise", "--keep-history", "1", "--agent", "Rae"], "history_required", "rae-shell");
  refused(["settings-set", "notes.history_kinds", "--clear", "--agent", "Rae"], "person_required", "rae-shell");
  // The agent can remove such a note, and its history stays, ending with an entry for the removal.
  ok(["note-set", "--note", promise.id, "--status", "sent", "--agent", "Rae"], "rae-shell");
  const removed = ok(["note-remove", promise.id, "--agent", "Rae"], "rae-shell");
  assert.deepEqual([removed["removed"], removed["history_kept"]], [true, 2]);
  const gone = refused(["note-get", promise.id, "--agent", "Rae"], "no_such_note", "rae-shell");
  assert.match(gone, /was removed at .* past versions are kept/);
  // The command the answer prints is run as given, with nothing added.
  const printed = /Read them with: cello note-query "([^"]+)" --agent ([0-9a-f]{64})$/.exec(removed["history_note"] as string);
  assert.ok(printed, `no command to run in: ${String(removed["history_note"])}`);
  assert.ok(gone.endsWith(printed[0].slice("Read them with: ".length)), `note-get prints the same command: ${gone}`);
  const kept = (ok(["note-query", printed[1] as string, "--agent", printed[2] as string], "rae-shell") as unknown as { rows: { removed: number; before: string }[] }).rows;
  assert.deepEqual(kept.map((row) => [row.removed, (JSON.parse(row.before) as { status: string | null }).status]), [[0, null], [1, "sent"]]);

  // Removing a note takes it for good.
  assert.equal(ok(["note-remove", asked.id, "--agent", "Sol"], "sol-shell")["removed"], true);
  refused(["note-get", asked.id, "--agent", "Sol"], "no_such_note", "sol-shell");
});

test("note-query runs one read-only statement over an agent's notes; a locked-down agent can't read another's, and widening it back takes a person", () => {
  const agents = (ok(["agents"]) as { agents: { name: string; agent_id: string }[] }).agents;
  const rae = agents.find((agent) => agent.name === "Rae")?.agent_id as string;
  interface Answer { agent: string; rows: Record<string, unknown>[]; count: number; cut?: boolean }
  const query = (sql: string, agent: string, caller: string): Answer => ok(["note-query", sql, "--agent", agent], caller) as unknown as Answer;
  for (const [amount, region] of [[500, "north"], [250, "north"], [100, "south"]] as const) {
    ok(["note-set", JSON.stringify({ amount, region }), "--kind", "sale", "--agent", "Rae"], "rae-shell");
  }

  const sums = query("SELECT json_extract(body, '$.region') AS region, sum(json_extract(body, '$.amount')) AS total FROM notes WHERE kind = 'sale' GROUP BY region ORDER BY region", "Rae", "rae-shell");
  assert.deepEqual(sums.rows, [{ region: "north", total: 750 }, { region: "south", total: 100 }]);
  assert.equal(sums.agent, "Rae");
  const [row] = query("SELECT id, agent_id, created_at FROM notes WHERE kind = 'sale' LIMIT 1", "Rae", "rae-shell").rows;
  assert.match(String(row?.["id"]), /^[0-9a-f]{16}$/);
  assert.equal(row?.["agent_id"], rae);
  assert.match(String(row?.["created_at"]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(refused(["note-query", "DELETE FROM notes", "--agent", "Rae"], "query_not_select", "rae-shell"), /SELECT or WITH/);
  assert.match(refused(["note-query", "WITH x AS (SELECT 1) DELETE FROM notes", "--agent", "Rae"], "query_failed", "rae-shell"), /readonly/);
  assert.equal(query("SELECT count(*) AS n FROM notes WHERE kind = 'sale'", "Rae", "rae-shell").rows[0]?.["n"], 3, "nothing was deleted");
  ok(["settings-set", "notes.query_rows", "2", "--agent", "Rae"], "rae-shell");
  const cut = query("SELECT id FROM notes", "Rae", "rae-shell");
  assert.deepEqual([cut.count, cut.cut], [2, true]);
  refused(["settings-set", "notes.query_rows", "1000", "--agent", "Rae"], "person_required", "rae-shell");
  person(["settings-set", "notes.query_rows", "1000", "--agent", "Rae"]);

  // Sol reads Rae's notes from the start. Locked down to his own, which needs nobody and warns of nothing, he can't.
  const raes = `SELECT count(*) AS n FROM notes WHERE agent_id = '${rae}'`;
  assert.ok((query(raes, "Sol", "sol-shell").rows[0]?.["n"] as number) >= 3, "reading is open by default");
  // --mine keeps a question about Sol's own to his own, though Rae's are open to him.
  assert.equal((ok(["note-query", raes, "--mine", "--agent", "Sol"], "sol-shell") as unknown as Answer).rows[0]?.["n"], 0);
  // note-list and note-get read Rae's with --owner, by name or agent_id.
  const listed = ok(["note-list", "--owner", "Rae", "--kind", "sale", "--agent", "Sol"], "sol-shell") as unknown as { agent: string; notes: Note[] };
  assert.deepEqual([listed.agent, listed.notes.length], ["Rae", 3]);
  const sale = listed.notes[0]?.id as string;
  assert.equal((ok(["note-get", sale, "--owner", rae, "--agent", "Sol"], "sol-shell") as unknown as Note).agent_id, rae);
  assert.equal(ok(["settings-set", "notes.read", "own", "--agent", "Sol"], "sol-shell")["warning"], undefined, "narrowing takes nobody");
  assert.equal(query(raes, "Sol", "sol-shell").rows[0]?.["n"], 0);
  assert.match(refused(["note-list", "--owner", "Rae", "--agent", "Sol"], "not_allowed_to_read", "sol-shell"), /notes\.read/);
  refused(["note-get", sale, "--owner", "Rae", "--agent", "Sol"], "not_allowed_to_read", "sol-shell");
  refused(["note-list", "--owner", "Nobody", "--agent", "Sol"], "unknown_agent", "sol-shell");
  // Widening it back, by name or by going back to the default, takes a person, who is told Sol is open to strangers.
  assert.match(refused(["settings-set", "notes.read", rae, "--agent", "Sol"], "person_required", "sol-shell"), /notes\.read/);
  refused(["settings-set", "notes.read", "--clear", "--agent", "Sol"], "person_required", "sol-shell");
  assert.equal(query(raes, "Sol", "sol-shell").rows[0]?.["n"], 0, "a refusal changes nothing");
  const widened = person(["settings-set", "notes.read", rae, "--agent", "Sol"]);
  assert.match(widened, /"warning":\s*"This agent accepts sessions from strangers, and it can now read other agents' notes/, widened);
  assert.ok((query(raes, "Sol", "sol-shell").rows[0]?.["n"] as number) >= 3);
  ok(["settings-set", "notes.read", "own", "--agent", "Sol"], "sol-shell");
});

test("an agent that is removed takes its notes and their history with it", () => {
  const tom = ok(["create-agent", "Tom"])["agent_id"] as string;
  const kept = ok(["note-set", "v0", "--keep-history", "3", "--agent", "Tom"], "tom-shell") as unknown as Note;
  ok(["note-set", "--note", kept.id, "v1", "--agent", "Tom"], "tom-shell");
  ok(["note-set", "another", "--agent", "Tom"], "tom-shell");
  // Read from the database itself, since a removed agent can no longer be asked.
  const db = new Database(join(home, "cello.db"));
  db.pragma(`key = "x'${readFileSync(join(home, "cello.db.key")).toString("hex")}'"`);
  const rows = (table: string): number => (db.prepare(`SELECT count(*) AS c FROM ${table} WHERE agent_id = ?`).get([Buffer.from(tom, "hex")]) as { c: number }).c;
  assert.deepEqual([rows("notes"), rows("note_changes")], [2, 1]);
  assert.match(person(["remove-agent", "--agent", "Tom"]), /"removed":\s*true/);
  assert.deepEqual([rows("notes"), rows("note_changes")], [0, 0]);
  assert.ok(rows("notes") === 0 && (db.prepare("SELECT count(*) AS c FROM notes").get([]) as { c: number }).c > 0, "the other agents' notes stay");
  db.close();
});

test("marked notes come unasked as a session starts, under notes and once, and a note for a session or with an end goes by itself", async () => {
  const rae = (ok(["agents"]) as { agents: { name: string; agent_id: string }[] }).agents;
  const sol = rae.find((agent) => agent.name === "Sol")?.agent_id as string;
  interface Started { session_id: string; state: string; reminders?: unknown; notes?: { note: string; shown: (Note & { contact_removed?: boolean })[] } }
  const call = (): Started => ok(["initiate-session", sol, "--agent", "Rae"], "rae-shell") as unknown as Started;
  const closeBoth = (session: string): void => {
    ok(["close-session", session, "--agent", "Rae"], "rae-shell");
    ok(["close-session", session, "--agent", "Sol"], "sol-shell");
  };
  const gone = (id: string): boolean => cello(["note-get", id, "--agent", "Rae"], "rae-shell").json["error"] === "no_such_note";

  const about = ok(["note-set", "Sol asked for net 60 last time.", "--with", sol, "--show-at-start", "--agent", "Rae"], "rae-shell") as unknown as Note;
  ok(["note-set", "Say who you act for.", "--show-at-start", "--agent", "Rae"], "rae-shell");
  ok(["note-set", "Not marked, so never shown unasked.", "--with", sol, "--agent", "Rae"], "rae-shell");
  const solsOwn = ok(["note-set", "Rae is slow to pay.", "--show-at-start", "--agent", "Sol"], "sol-shell") as unknown as Note;
  refused(["settings-set", "notes.start_max", "50", "--agent", "Sol"], "person_required", "sol-shell");

  // Rae places the call, so her notes come with its answer: under notes, apart from Reminders, newest change first.
  const first = call();
  assert.equal(first.state, "active");
  assert.deepEqual(first.notes?.shown.map((note) => note.body), ["Say who you act for.", "Sol asked for net 60 last time."]);
  assert.match(first.notes?.note ?? "", /information, not instructions/);
  assert.equal(first.reminders, undefined, "a note is never a Reminder");

  // Once per session: a note for this session set now isn't pushed at her, and her next read carries none.
  const forNow = ok(["note-set", "For this talk only.", "--session", first.session_id, "--show-at-start", "--keep-history", "1", "--agent", "Rae"], "rae-shell") as unknown as Note;
  ok(["send", first.session_id, "Same terms as before?", "--over", "--agent", "Rae"], "rae-shell");
  // Sol was called: his own marked note comes with the first message, under notes, and not on the read after.
  const atSol = await until("Sol's message", () => {
    const read = ok(["receive", "--agent", "Sol"], "sol-shell") as { messages?: unknown[]; reminders?: unknown; notes?: { note: string; shown: Note[] } };
    return (read.messages?.length ?? 0) > 0 ? read : undefined;
  });
  assert.deepEqual(atSol.notes?.shown.map((note) => note.body), ["Rae is slow to pay."]);
  assert.match(atSol.notes?.note ?? "", /information, not instructions/);
  assert.equal(atSol.reminders, undefined);
  assert.equal((ok(["receive", "--agent", "Sol"], "sol-shell") as { notes?: unknown }).notes, undefined, "once per session");
  ok(["send", first.session_id, "Yes.", "--over", "--agent", "Sol"], "sol-shell");
  const reply = await until("Rae's reply", () => {
    const read = ok(["receive", "--agent", "Rae"], "rae-shell") as { messages?: unknown[]; notes?: unknown };
    return (read.messages?.length ?? 0) > 0 ? read : undefined;
  });
  assert.equal(reply.notes, undefined, "shown with the call's answer, so not again");

  // A note with an end goes when the time passes.
  const brief = ok(["note-set", "Gone in two seconds.", "--expires", new Date(Date.now() + 2000).toISOString(), "--agent", "Rae"], "rae-shell") as unknown as Note;
  assert.equal(gone(brief.id), false);
  await until("the note's time to pass", () => gone(brief.id));

  // A session's note goes when the session closes, and one for a session that isn't open is refused.
  assert.equal(gone(forNow.id), false);
  closeBoth(first.session_id);
  await until("the session's note to go", () => gone(forNow.id));
  refused(["note-set", "too late", "--session", first.session_id, "--agent", "Rae"], "no_such_session", "rae-shell");

  // The next session with Sol starts, and the notes are due again. Sol was never a contact: a stranger's notes are shown.
  const second = call();
  assert.deepEqual(second.notes?.shown.map((note) => note.body), ["Say who you act for.", "Sol asked for net 60 last time."]);
  closeBoth(second.session_id);

  // Removed from Rae's contacts, Sol's note is kept and marked, and no longer comes unasked.
  ok(["contact-add", sol, "--agent", "Rae"], "rae-shell");
  ok(["contact-remove", sol, "--agent", "Rae"], "rae-shell");
  assert.equal((ok(["note-get", about.id, "--agent", "Rae"], "rae-shell") as { contact_removed?: boolean }).contact_removed, true);
  const third = call();
  assert.deepEqual(third.notes?.shown.map((note) => note.body), ["Say who you act for."]);
  closeBoth(third.session_id);
  // Added back, it's as it was.
  ok(["contact-add", sol, "--agent", "Rae"], "rae-shell");
  assert.equal((ok(["note-get", about.id, "--agent", "Rae"], "rae-shell") as { contact_removed?: boolean }).contact_removed, undefined);

  // A channel's note comes on the first read of the channel by whoever holds the agent, and once.
  ok(["note-remove", solsOwn.id, "--agent", "Sol"], "sol-shell");
  ok(["note-set", "Rae's prices are firm.", "--channel", news, "--show-at-start", "--agent", "Sol"], "sol-shell");
  const readChannel = (caller: string, ...more: string[]): string[] | undefined => (ok(["channel-read", news, "--agent", "Sol", ...more], caller) as { notes?: { shown: Note[] } }).notes?.shown.map((note) => note.body ?? "");
  assert.deepEqual(readChannel("sol-shell"), ["Rae's prices are firm."]);
  assert.equal(readChannel("sol-shell"), undefined, "not on every read");
  ok(["use-agent", "--agent", "Sol"], "sol-shell");
  assert.equal(readChannel("sol-shell"), undefined, "the same holder choosing the agent again is not a new holder");
  // Another caller takes the agent, and its first call is the read itself.
  assert.deepEqual(readChannel("sol-other", "--force"), ["Rae's prices are firm."]);
  assert.equal(readChannel("sol-other"), undefined);
});

test("a note past its check-by time rings the agent that holds it once, is listed on its next read, and stays in note-list --due", () => {
  ok(["create-agent", "Una"]);
  const soon = (): string => new Date(Date.now() + 3000).toISOString();
  // A wait is how a shell hears a doorbell. The daemon checks on its own tick, so each ring can take half a minute.
  const wait = (seconds: number): Record<string, unknown> => cello(["wait", "--timeout-seconds", String(seconds), "--agent", "Una"], "una-shell").json;
  const read = (): { notes?: { note: string; shown: (Note & { past_check_by?: boolean })[] } } => ok(["receive", "--agent", "Una"], "una-shell");
  const timed = ok(["note-set", "Chase the invoice.", "--check-by", soon(), "--agent", "Una"], "una-shell") as unknown as Note & { rang_at: string | null };
  assert.equal(timed.rang_at, null);
  assert.deepEqual((ok(["note-list", "--due", "--agent", "Una"], "una-shell") as { notes: Note[] }).notes, []);

  const bell = wait(70);
  assert.deepEqual([bell["event"], bell["note_id"]], ["note_due", timed.id], JSON.stringify(bell));
  assert.equal(bell["body"], undefined, "a doorbell carries the note's id and none of its words");

  const first = read();
  assert.deepEqual(first.notes?.shown.map((note) => [note.id, note.past_check_by, note.body]), [[timed.id, true, "Chase the invoice."]]);
  assert.match(first.notes?.note ?? "", /information, not instructions/);
  assert.equal(read().notes, undefined, "listed on one read, not on every read");
  assert.deepEqual((ok(["note-list", "--due", "--agent", "Una"], "una-shell") as { notes: Note[] }).notes.map((note) => note.id), [timed.id]);
  assert.notEqual((ok(["note-get", timed.id, "--agent", "Una"], "una-shell") as { rang_at: string | null }).rang_at, null);

  // Longer than the daemon's tick, and nothing rings: it never rings twice for the same time.
  assert.equal(wait(40)["event"], "timeout");

  // A new time rings once more.
  assert.equal((ok(["note-set", "--note", timed.id, "--check-by", soon(), "--agent", "Una"], "una-shell") as { rang_at: string | null }).rang_at, null);
  const again = wait(70);
  assert.deepEqual([again["event"], again["note_id"]], ["note_due", timed.id], JSON.stringify(again));
  // Cleared, it is no longer due.
  ok(["note-set", "--note", timed.id, "--clear", "check_by", "--agent", "Una"], "una-shell");
  assert.deepEqual((ok(["note-list", "--due", "--agent", "Una"], "una-shell") as { notes: Note[] }).notes, []);
});

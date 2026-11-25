// Notes through the real command line, a real daemon and a real server: an agent's shell writes, changes, lists and removes
// its notes, names a real message as a note's source, and is refused by name where a setting says so. Run it with:
//   CELLO_LIVE_FILES=live/notes.live.ts scripts/live-test.sh
import { cliFor } from "./cli-path.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18090/v1";
const home = mkdtempSync(join(tmpdir(), "cello-notes-"));

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

  // Sol can't write Rae's notes, or let itself. A person can, and is told Sol is open to strangers.
  assert.match(refused(["note-set", "from Sol", "--owner", "Rae", "--agent", "Sol"], "not_allowed_to_write", "sol-shell"), /notes\.write/);
  refused(["settings-set", "notes.write", rae, "--agent", "Sol"], "person_required", "sol-shell");
  const widened = person(["settings-set", "notes.write", rae, "--agent", "Sol"]);
  assert.match(widened, /"warning":\s*"This agent accepts sessions from strangers/, widened);
  const forRae = ok(["note-set", "from Sol", "--owner", "Rae", "--agent", "Sol"], "sol-shell") as unknown as Note;
  assert.deepEqual([forRae.agent_id, forRae.written_by], [rae, sol], "Rae's note, stamped as written by Sol");
  assert.equal((ok(["note-get", forRae.id, "--agent", "Rae"], "rae-shell") as unknown as Note).body, "from Sol");
  // Narrowing needs nobody.
  ok(["settings-set", "notes.write", "own", "--agent", "Sol"], "sol-shell");
  refused(["note-remove", forRae.id, "--owner", "Rae", "--agent", "Sol"], "not_allowed_to_write", "sol-shell");

  // The cap refuses and drops nothing. Raising it takes a person.
  ok(["settings-set", "notes.max", "1", "--agent", "Sol"], "sol-shell");
  assert.match(refused(["note-set", "one too many", "--agent", "Sol"], "too_many_notes", "sol-shell"), /notes\.max/);
  refused(["settings-set", "notes.max", "2", "--agent", "Sol"], "person_required", "sol-shell");
  assert.equal((ok(["note-list", "--agent", "Sol"], "sol-shell") as { total: number }).total, 1);

  // A kind that must keep history: anyone can list it, and only a person can take it off.
  ok(["settings-set", "notes.history_kinds", "promise", "--agent", "Rae"], "rae-shell");
  assert.equal((ok(["note-set", "Send the draft by Friday.", "--kind", "promise", "--agent", "Rae"], "rae-shell") as unknown as Note).keep_history, 10);
  refused(["note-set", "x", "--kind", "promise", "--keep-history", "1", "--agent", "Rae"], "history_required", "rae-shell");
  refused(["settings-set", "notes.history_kinds", "--clear", "--agent", "Rae"], "person_required", "rae-shell");

  // Removing a note takes it for good.
  assert.equal(ok(["note-remove", asked.id, "--agent", "Sol"], "sol-shell")["removed"], true);
  refused(["note-get", asked.id, "--agent", "Sol"], "no_such_note", "sol-shell");
});

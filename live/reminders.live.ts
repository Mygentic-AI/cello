// Reminders through the real command line, a real daemon and a real server: one agent's shell sets a Reminder on another,
// and it turns up in the right answers, under its own name. Run it with:
//   CELLO_LIVE_FILES=live/reminders.live.ts scripts/live-test.sh
import { cliFor } from "./cli-path.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18090/v1";
const home = mkdtempSync(join(tmpdir(), "cello-reminders-"));

interface Run { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
interface Due { reminders?: { note: string; due: { text: string; why: string; session_id?: string }[] }; messages?: { text: string }[]; policies?: unknown }

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

async function until<T>(what: string, check: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Reads until a message has arrived, and gives that read's whole answer.
const readWhenArrived = (agent: string, caller: string): Promise<Due> => until(`${agent}'s message`, () => {
  const read = ok(["receive", "--agent", agent], caller) as Due;
  return (read.messages?.length ?? 0) > 0 ? read : undefined;
});

after(() => {
  cello(["logout"]);
});

test("a Reminder set from another agent's shell rides on the call's answer and on reads, apart from messages", async () => {
  ok(["login", "--server", url]);
  const rae = ok(["create-agent", "Rae"]);
  const sol = ok(["create-agent", "Sol"]);
  ok(["settings-set", "away.answering", "false", "--agent", "Rae"]);
  ok(["settings-set", "away.answering", "false", "--agent", "Sol"]);
  await until("both agents online", () => (ok(["status"]) as { agents: { online: boolean }[] }).agents.every((a) => a.online));

  // Sol's shell sets a Reminder on Rae: an agent's shell, another agent, and no person.
  const set = ok(["reminder-set", "Before agreeing a date, notify your operator and wait.", "--at-start", "--every-messages", "2", "--agent", "Rae"], "sol-shell");
  assert.equal(set["fires"], "at the start of a session, every 2 messages");
  ok(["reminder-set", "You were called. Say who you act for.", "--with", rae["agent_id"] as string, "--agent", "Sol"], "sol-shell");

  // Rae places the call, so her Reminder comes with the call's answer.
  const started = ok(["initiate-session", sol["agent_id"] as string, "--agent", "Rae"], "rae-shell") as unknown as Due & { session_id: string; state: string };
  assert.equal(started.state, "active");
  assert.deepEqual(started.reminders?.due.map((d) => [d.text, d.why]), [["Before agreeing a date, notify your operator and wait.", "the start of this session"]]);
  assert.match(started.reminders?.note ?? "", /rank below a policy/);
  const session = started.session_id;

  // Sol was called: his Reminder comes with the first message, beside it and not in it.
  ok(["send", session, "Can we meet Thursday?", "--over", "--agent", "Rae"], "rae-shell");
  const first = await readWhenArrived("Sol", "sol-shell");
  assert.deepEqual(first.messages?.map((m) => m.text), ["Can we meet Thursday?"]);
  assert.deepEqual(first.reminders?.due.map((d) => [d.text, d.session_id]), [["You were called. Say who you act for.", session]]);

  // Rae's comes back after two messages have reached her, and not after one.
  ok(["send", session, "Thursday is possible.", "--over", "--agent", "Sol"], "sol-shell");
  assert.equal((await readWhenArrived("Rae", "rae-shell")).reminders, undefined);
  ok(["send", session, "Morning or afternoon?", "--over", "--agent", "Rae"], "rae-shell");
  await readWhenArrived("Sol", "sol-shell");
  ok(["send", session, "Morning.", "--over", "--agent", "Sol"], "sol-shell");
  const again = await readWhenArrived("Rae", "rae-shell");
  assert.deepEqual(again.reminders?.due.map((d) => d.why), ["every 2 messages"]);

  // "For now": one for this session only, which goes when the session closes.
  ok(["reminder-set", "For this conversation only: don't share files.", "--session", session, "--every-messages", "1", "--agent", "Rae"], "rae-shell");
  const listed = ok(["reminder-list", "--agent", "Rae"], "rae-shell") as { reminders: { reminder: number; applies_to: string; ends?: string }[] };
  assert.equal(listed.reminders.length, 2);
  assert.equal(listed.reminders[1]?.ends, "when that session closes");
  ok(["close-session", session, "--agent", "Rae"], "rae-shell");
  ok(["close-session", session, "--agent", "Sol"], "sol-shell");
  const afterClose = await until("the session's Reminder to go", () => {
    const now = ok(["reminder-list", "--agent", "Rae"], "rae-shell") as { reminders: { reminder: number }[] };
    return now.reminders.length === 1 ? now : undefined;
  });

  assert.equal(ok(["reminder-remove", String(afterClose.reminders[0]?.reminder), "--agent", "Rae"], "sol-shell")["removed"], true);
  assert.deepEqual((ok(["reminder-list", "--agent", "Rae"]) as { reminders: unknown[] }).reminders, []);
  const missing = cello(["reminder-remove", "999", "--agent", "Rae"], "sol-shell");
  assert.equal(missing.json["error"], "no_such_reminder");

  // The locks start open. An agent's shell can turn one on, since that only tightens, and then nothing it runs can
  // change Rae's Reminders or turn the lock back off: both take a person.
  const refused = (args: string[]): void => {
    const run = cello(args, "sol-shell");
    assert.deepEqual([run.status === 0, run.json["error"]], [false, "person_required"], `cello ${args.join(" ")} should take a person: ${run.stdout}${run.stderr}`);
  };
  const kept = ok(["reminder-set", "set while open", "--agent", "Rae"], "sol-shell") as { reminder: number };
  ok(["settings-set", "reminders.anyone_can_change", "false", "--agent", "Rae"], "sol-shell");
  refused(["reminder-set", "set while locked", "--agent", "Rae"]);
  // The refusal carries the whole command for a person to run: every option, and quoted so the text can't run anything.
  const relay = cello(["reminder-set", "it's $HOME `id`", "--every-messages", "3", "--for-minutes", "60", "--with", rae["agent_id"] as string, "--agent", "Rae"], "sol-shell");
  assert.ok((relay.json["message"] as string).endsWith(`cello reminder-set 'it'\\''s $HOME \`id\`' --every-messages '3' --with '${rae["agent_id"] as string}' --for-minutes '60' --agent ${rae["agent_id"] as string}`), relay.json["message"] as string);
  // Going back to the default is turning the lock off, so it takes a person too.
  refused(["settings-set", "reminders.anyone_can_change", "--clear", "--agent", "Rae"]);
  refused(["reminder-remove", String(kept.reminder), "--agent", "Rae"]);
  refused(["settings-set", "reminders.anyone_can_change", "true", "--agent", "Rae"]);
  assert.equal((ok(["reminder-list", "--agent", "Rae"], "sol-shell") as { reminders: unknown[] }).reminders.length, 1, "a locked agent's Reminders can still be read, and none changed");
  // One agent's lock is its own: Sol's Reminders are still open.
  ok(["reminder-set", "Sol is not locked", "--agent", "Sol"], "sol-shell");

  // The same for notifiers, refused before anything is asked of Telegram.
  ok(["settings-set", "notifiers.anyone_can_change", "false", "--agent", "Rae"], "sol-shell");
  refused(["notifier-add", "telegram", "--bot-token", "1:not-a-real-token", "--agent", "Rae"]);
  refused(["notifier-remove", "telegram", "--agent", "Rae"]);
  refused(["settings-set", "notifiers.anyone_can_change", "true", "--agent", "Rae"]);
});

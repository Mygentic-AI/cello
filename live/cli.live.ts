// A whole conversation by command line alone, with no MCP anywhere: real processes, one call each.
// This is what any agent that can run a shell command gets. Run it with scripts/live-test.sh.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { IpcClient } from "../src/ipc/client.ts";
import { OPERATIONS } from "../src/ipc/operations.ts";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18090/v1";
const home = mkdtempSync(join(tmpdir(), "cello-v2-cli-"));
const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

interface Run { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }

function cello(args: string[], input?: string, caller?: string): Run {
  const run = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", input, env: { ...process.env, CELLO_V2_HOME: home, ...(caller ? { CELLO_CALLER: caller } : {}) } });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(run.stdout || run.stderr) as Record<string, unknown>;
  } catch {
    // Not every command answers in JSON: login and logout answer in words.
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, json };
}

function ok(args: string[], input?: string): Record<string, unknown> {
  const run = cello(args, input);
  assert.equal(run.status, 0, `cello-v2 ${args.join(" ")} failed: ${run.stderr}`);
  return run.json;
}

async function until<T>(what: string, check: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

after(() => {
  cello(["logout"]);
});

test("a whole conversation with no MCP: start, all three signals, a daemon kill, a close, and a checked record", async () => {
  ok(["login", "--server", url]);
  const gail = ok(["create-agent", "Gail"]);
  const hugo = ok(["create-agent", "Hugo"]);
  await until("both agents online", () => (ok(["status"]) as { agents: { online: boolean }[] }).agents.every((a) => a.online));

  // Nothing works unnamed until an agent is chosen, and then it's still in each call.
  const unnamed = cello(["receive"]);
  assert.deepEqual([unnamed.status, unnamed.json["error"]], [1, "no_current_agent"]);
  ok(["use-agent", "--agent", "Gail"]);
  assert.deepEqual(ok(["receive"]), { messages: [], notices: [] }, "use-agent is remembered for later commands");

  const started = ok(["initiate-session", hugo["agent_id"] as string, "--agent", "Gail"]);
  assert.equal(started["state"], "active");
  const session = started["session_id"] as string;

  // A mistyped option or a missing signal is refused rather than guessed at.
  assert.equal(cello(["send", session, "x", "--agent", "Gail"]).status, 2);
  assert.equal(cello(["send", session, "x", "--over", "--wrap", "--agent", "Gail"]).status, 2);
  assert.equal(cello(["send", session, "x", "--over", "--agnet", "Gail"]).status, 2);
  assert.equal(cello(["send", session, "x", "--standby", "--agent", "Gail"]).status, 2);

  // Help: one line per command at the top, and details per command, with no agent or daemon needed for either.
  const overview = cello(["-h"]);
  assert.equal(overview.status, 0);
  for (const op of OPERATIONS) {
    assert.ok(overview.stdout.includes(`  ${op.command}`), `${op.command} is missing from the help`);
    const own = cello([op.command, "--help"]);
    assert.equal(own.status, 0);
    assert.match(own.stdout, new RegExp(`^Usage: cello-v2 ${op.command}`));
  }
  assert.ok(overview.stdout.split("\n").every((line) => line.length <= 120), "the list stays short");

  // over, from standard input, with a text that starts with dashes.
  assert.deepEqual(ok(["send", session, "-", "--over", "--agent", "Gail"], "--hello from a pipe"), { sent: true, position: 1 });

  // wait is how an agent with no doorbell learns something arrived.
  const woke = ok(["wait", "--agent", "Hugo", "--timeout-seconds", "20"]);
  assert.equal(woke["event"], "unread");
  const read = ok(["receive", "--agent", "Hugo"]) as { messages: { text: string; signal: string; from_id: string }[] };
  assert.deepEqual(read.messages.map((m) => [m.text, m.signal, m.from_id]), [["--hello from a pipe", "over", gail["agent_id"]]]);

  // With nothing unread, wait blocks until something happens, and ends when asked.
  const quiet = cello(["wait", "--agent", "Hugo", "--timeout-seconds", "1"]);
  assert.deepEqual([quiet.status, quiet.json["event"]], [3, "timeout"]);

  // standby, with its time.
  ok(["send", session, "looking into it", "--standby", "2", "--agent", "Hugo"]);
  const blind = cello(["send", session, "a blind reply", "--over", "--agent", "Gail"]);
  await until("the message to reach Gail", () => (ok(["status"]) as { agents: { name: string; unread: number }[] }).agents.find((a) => a.name === "Gail")?.unread === 1);
  const refused = blind.status === 1 ? blind : cello(["send", session, "a blind reply", "--over", "--agent", "Gail"]);
  assert.equal(refused.json["error"], "session_not_current");
  const standby = ok(["receive", "--agent", "Gail"]) as { messages: { text: string; signal: string; est_minutes: number }[] };
  assert.deepEqual(standby.messages.map((m) => [m.text, m.signal, m.est_minutes]), [["looking into it", "standby", 2]]);

  // A kill mid-conversation. Each command is its own process, so there's nothing to reconnect.
  const pid = (ok(["status"]) as { pid: number }).pid;
  process.kill(pid, "SIGKILL");
  assert.equal(cello(["status"]).json["error"], "daemon_not_running");
  ok(["login", "--server", url]);
  await until("both agents back online", () => (ok(["status"]) as { agents: { online: boolean }[] }).agents.every((a) => a.online));
  assert.deepEqual(ok(["send", session, "still with you", "--over", "--agent", "Gail"]), { sent: true, position: 3 });
  ok(["wait", "--agent", "Hugo", "--timeout-seconds", "20"]);
  assert.deepEqual((ok(["receive", "--agent", "Hugo"]) as { messages: { text: string }[] }).messages.map((m) => m.text), ["still with you"]);

  // wrap, then a close from each side.
  ok(["send", session, "that's all from me", "--wrap", "--agent", "Hugo"]);
  ok(["wait", "--agent", "Gail", "--timeout-seconds", "20"]);
  assert.deepEqual((ok(["receive", "--agent", "Gail"]) as { messages: { signal: string }[] }).messages.map((m) => m.signal), ["wrap"]);
  assert.equal(ok(["close-session", session, "--agent", "Gail"])["closed"], true);
  ok(["wait", "--agent", "Hugo", "--timeout-seconds", "20"]);
  assert.deepEqual((ok(["receive", "--agent", "Hugo"]) as { messages: { closed_their_side: boolean }[] }).messages.map((m) => m.closed_their_side), [true]);
  assert.equal(ok(["close-session", session, "--agent", "Hugo"])["state"], "closed");

  const reportG = ok(["verify-session", session, "--agent", "Gail"]);
  const reportH = ok(["verify-session", session, "--agent", "Hugo"]);
  assert.deepEqual([reportG["ok"], reportG["position"]], [true, 6]);
  assert.equal(reportG["root"], reportH["root"]);
  assert.doesNotMatch(readFileSync(join(home, "daemon.log"), "utf8"), /still with you/);
});

test("the holder is a caller: the command line is refused an agent a session holds, unless it forces", async () => {
  ok(["create-agent", "Iris"]);
  await until("Iris online", () => (ok(["status"]) as { agents: { name: string; online: boolean }[] }).agents.find((a) => a.name === "Iris")?.online);
  const session = await IpcClient.connect(join(home, "daemon.sock"));
  const bells: string[] = [];
  session.onNotification = (frame) => bells.push(frame.notification);
  await session.call("subscribe", { agent: "Iris", caller: "some-session" });

  const refused = cello(["receive", "--agent", "Iris"]);
  assert.deepEqual([refused.status, refused.json["error"]], [1, "agent_held"]);
  assert.match(refused.json["message"] as string, /"some-session" holds Iris/);
  assert.equal(cello(["verify-session", "00000000000000000000000000000000", "--agent", "Iris"]).json["error"], "unknown_session", "reading a record isn't refused for being held");

  assert.deepEqual(ok(["receive", "--agent", "Iris", "--force"]), { messages: [], notices: [] });
  await until("the displaced session to be told", () => bells.includes("agent_displaced"));
  await assert.rejects(session.call("receive", { agent: "Iris", caller: "some-session" }), { code: "agent_held" });

  // Letting go hands it back with no force, and a session's hold ends when it can no longer be reached.
  ok(["stop-using-agent", "--agent", "Iris"]);
  await session.call("subscribe", { agent: "Iris", caller: "some-session" });
  session.close();
  await until("the hold to end with the session", () => cello(["receive", "--agent", "Iris"]).status === 0);

  // A session that dies while waiting must not leave the agent locked, even having selected it twice.
  ok(["stop-using-agent", "--agent", "Iris"]);
  const crashing = await IpcClient.connect(join(home, "daemon.sock"));
  await crashing.call("subscribe", { agent: "Iris", caller: "crashing-session" });
  await crashing.call("subscribe", { agent: "Iris", caller: "crashing-session" });
  const waiting = crashing.call("wait", { agent: "Iris", caller: "crashing-session", timeout_seconds: 60 }).catch(() => undefined);
  assert.equal(cello(["receive", "--agent", "Iris"]).json["error"], "agent_held");
  crashing.close();
  await waiting;
  await until("the dead session's hold to end", () => cello(["receive", "--agent", "Iris"]).status === 0);

  // Two shell agents with their own names are kept apart, just as sessions are. Each remembers its own choice.
  ok(["stop-using-agent", "--agent", "Iris"]);
  assert.equal(cello(["use-agent", "--agent", "Iris"], undefined, "shell-a").status, 0);
  const otherShell = cello(["receive", "--agent", "Iris"], undefined, "shell-b");
  assert.deepEqual([otherShell.status, otherShell.json["error"]], [1, "agent_held"]);
  assert.match(otherShell.json["message"] as string, /"shell-a" holds Iris/);
  assert.equal(cello(["receive"], undefined, "shell-a").status, 0, "shell-a remembers its choice");
  assert.equal(cello(["receive"], undefined, "shell-b").json["error"], "no_current_agent", "and shell-b doesn't inherit it");
  assert.equal(cello(["receive", "--agent", "Iris", "--force"], undefined, "shell-b").status, 0);
  assert.equal(cello(["receive"], undefined, "shell-a").json["error"], "agent_held", "shell-a has been displaced");
});

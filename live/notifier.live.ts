// A notifier through the real command line and a real daemon, against the real Telegram. It needs a bot nobody else uses:
//   CELLO_BOT_TOKEN=<token> CELLO_BOT_CHAT=<chat id> CELLO_LIVE_FILES=live/notifier.live.ts scripts/live-test.sh
// Without those two it's skipped, because nothing else can stand in for a person's phone.
import { REAL_CLI, cliFor } from "./cli-path.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { OPERATIONS } from "../src/ipc/operations.ts";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18090/v1";
const home = mkdtempSync(join(tmpdir(), "cello-notifier-"));
const token = process.env["CELLO_BOT_TOKEN"];
const chat = process.env["CELLO_BOT_CHAT"];

interface Run { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }

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
  assert.equal(run.status, 0, `cello ${args.filter((a) => a !== token).join(" ")} failed: ${run.stderr.replaceAll(token ?? "\0", "<bot token>")}`);
  return run.json;
}

after(() => {
  cello(["logout"]);
});

test("an agent's own shell sets up a notifier and reaches its operator, and the token never comes back", { skip: !token || !chat ? "no CELLO_BOT_TOKEN and CELLO_BOT_CHAT" : false }, () => {
  ok(["login", "--server", url]);
  ok(["create-agent", "Nell"]);
  assert.ok(REAL_CLI.length > 0);
  for (const command of ["notify", "notifier-add", "notifier-list", "notifier-remove", "notifier-test"]) {
    assert.ok(OPERATIONS.some((op) => op.command === command && !op.personOnly), `${command} is a command and a tool`);
  }

  // Before any notifier: a named refusal, and nothing claimed.
  const none = cello(["notify", "--agent", "Nell"], "nell-shell");
  assert.deepEqual([none.status === 0, none.json["error"]], [false, "no_notifier"]);

  // An agent's shell, with CELLO_CALLER set and no terminal: setting one up takes no person.
  const added = ok(["notifier-add", "telegram", "--bot-token", token as string, "--chat-id", chat as string, "--agent", "Nell"], "nell-shell");
  assert.equal(added["added"], true);
  assert.equal(added["chat_id"], chat);
  assert.ok(!JSON.stringify(added).includes(token as string));

  const listed = ok(["notifier-list", "--agent", "Nell"], "nell-shell");
  assert.equal((listed["notifiers"] as unknown[]).length, 1);
  assert.ok(!JSON.stringify(listed).includes(token as string));

  assert.equal(ok(["notifier-test", "--agent", "Nell"], "nell-shell")["sent"], true);
  const canned = ok(["notify", "--kind", "request", "--agent", "Nell"], "nell-shell");
  assert.deepEqual([canned["sent"], canned["included_text"]], [true, false]);
  const worded = ok(["notify", "This came through the real daemon and the cello command.", "--agent", "Nell"], "nell-shell");
  assert.deepEqual([worded["sent"], worded["included_text"]], [true, true]);

  // With CELLO_BOT_REPLY=1 a person answers in Telegram, and it has to arrive as the operator's words, apart from messages.
  if (process.env["CELLO_BOT_REPLY"]) {
    ok(["notify", "Live test: reply to this in Telegram within 3 minutes, with any words.", "--kind", "request", "--agent", "Nell"], "nell-shell");
    let reply: { text: string; via: string } | undefined;
    for (let i = 0; i < 90 && !reply; i++) {
      const read = ok(["receive", "--agent", "Nell"], "nell-shell");
      assert.deepEqual(read["messages"], [], "the operator's reply is never among the messages");
      reply = (read["from_your_operator"] as { replies: { text: string; via: string }[] } | undefined)?.replies[0];
      if (!reply) spawnSync("sleep", ["2"]);
    }
    assert.ok(reply, "no reply arrived from Telegram in 3 minutes");
    assert.equal(reply.via, "telegram");
    process.stderr.write(`The operator's reply arrived: ${JSON.stringify(reply.text)}\n`);
    assert.equal(ok(["receive", "--agent", "Nell"], "nell-shell")["from_your_operator"], undefined, "a read clears it");
  }

  // Nothing the daemon logged holds the token.
  assert.ok(!readFileSync(join(home, "daemon.log"), "utf8").includes(token as string), "the bot token is in daemon.log");

  assert.equal(ok(["notifier-remove", "telegram", "--agent", "Nell"], "nell-shell")["removed"], true);
  const gone = cello(["notify", "--agent", "Nell"], "nell-shell");
  assert.equal(gone.json["error"], "no_notifier");
});

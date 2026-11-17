// How the operator's chat looks when they answer, against the real Telegram, with a person on the phone. It needs a bot
// nobody else reads, and the person to have sent it /start:
//   CELLO_BOT_TOKEN=<token> CELLO_BOT_CHAT=<chat id> CELLO_LIVE_FILES=live/notifier-quiet.live.ts scripts/live-test.sh
// The person checks what only a phone shows: a 👍 on their own message and no "Passed to" message, and "You chose" arriving
// without a sound. This test checks each answer reaches the agent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cliFor } from "./cli-path.ts";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18090/v1";
const home = mkdtempSync(join(tmpdir(), "cello-quiet-"));
const token = process.env["CELLO_BOT_TOKEN"];
const chat = process.env["CELLO_BOT_CHAT"];

function ok(args: string[]): Record<string, unknown> {
  const run = spawnSync(process.execPath, [cliFor(args), ...args], { encoding: "utf8", env: { ...process.env, CELLO_HOME: home, CELLO_CALLER: "nell-shell" } });
  assert.equal(run.status, 0, `cello ${args[0] ?? ""} failed: ${run.stderr.replaceAll(token ?? "\0", "<bot token>")}`);
  try {
    return JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Waits up to five minutes for the person's answer.
function answer(): string {
  for (let i = 0; i < 150; i++) {
    const read = ok(["receive", "--agent", "Nell"]);
    const reply = (read["from_your_operator"] as { replies: { text: string }[] } | undefined)?.replies[0];
    if (reply) return reply.text;
    spawnSync("sleep", ["2"]);
  }
  assert.fail("no answer arrived from Telegram in five minutes");
}

after(() => { ok(["logout"]); });

test("each way of answering reaches the agent, and the chat stays quiet", { skip: !token || !chat ? "no CELLO_BOT_TOKEN and CELLO_BOT_CHAT" : false, timeout: 1_200_000 }, () => {
  ok(["login", "--server", url]);
  ok(["create-agent", "Nell"]);
  ok(["notifier-add", "telegram", "--bot-token", token as string, "--chat-id", chat as string, "--agent", "Nell"]);

  ok(["notify", "Test 1 of 3. Answer this message with Telegram's Reply (swipe left on it), any words. You should then see a 👍 on your answer, and no new message.", "--agent", "Nell"]);
  process.stderr.write(`1. Reply arrived: ${JSON.stringify(answer())}\n`);

  ok(["notify", "Test 2 of 3. Now just type anything, without Reply. Again you should see a 👍 and no new message.", "--agent", "Nell"]);
  process.stderr.write(`2. Plain message arrived: ${JSON.stringify(answer())}\n`);

  ok(["notify", "Test 3 of 3. Tap one. The buttons should go, and a 'You chose' line should arrive without your phone sounding.", "--choices", "Kiwi|Mango|Papaya", "--agent", "Nell"]);
  process.stderr.write(`3. Tap arrived: ${JSON.stringify(answer())}\n`);

  ok(["notify", "That's all three. Tell Claude what you saw.", "--agent", "Nell"]);
});

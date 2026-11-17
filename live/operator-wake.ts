// The one thing a scripted test can't show: a real Claude Code session, idle, being woken by its operator's answer in
// Telegram and by a timed Reminder. A person has to answer on their phone. Run it with scripts/operator-wake-test.sh,
// with CELLO_BOT_TOKEN and CELLO_BOT_CHAT set. Watch it with: tmux attach -r -t cello-wake
import { cliFor } from "./cli-path.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const url = process.env["CELLO_URL"] as string;
const token = process.env["CELLO_BOT_TOKEN"];
const chat = process.env["CELLO_BOT_CHAT"];
if (!url || !token || !chat) throw new Error("CELLO_URL, CELLO_BOT_TOKEN and CELLO_BOT_CHAT are required");
const model = process.env["CELLO_WAKE_MODEL"] ?? "claude-haiku-5-5";
const TMUX = "cello-wake";
const MCP = new URL("../src/mcp.ts", import.meta.url).pathname;
const base = realpathSync(mkdtempSync(join(tmpdir(), "cello-wake-")));
const home = join(base, "home");
const folder = join(base, "wren");
mkdirSync(home);
mkdirSync(folder);
const say = (text: string): void => { process.stderr.write(`${text}\n`); };

function cli(...args: string[]): Record<string, unknown> {
  const run = spawnSync(process.execPath, [cliFor(args), ...args], { encoding: "utf8", env: { ...process.env, CELLO_HOME: home } });
  if (run.status !== 0) throw new Error(`cello ${args.filter((a) => a !== token).join(" ")} failed: ${run.stderr.replaceAll(token as string, "<bot token>")}`);
  try {
    return JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const tmux = (...rest: string[]): string => execFileSync("tmux", rest, { encoding: "utf8" });
const screen = (): string => tmux("capture-pane", "-p", "-J", "-S", "-3000", "-t", `${TMUX}:0.0`);
const logged = (event: string): number => readFileSync(join(home, "daemon.log"), "utf8").split("\n").filter((line) => line.includes(`"event":"${event}"`)).length;

async function until(what: string, ms: number, check: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function choose(option: RegExp): boolean {
  const lines = screen().split("\n");
  if (!lines.some((line) => option.test(line))) return false;
  tmux("send-keys", "-t", `${TMUX}:0.0`, lines.some((line) => line.includes("❯") && option.test(line)) ? "Enter" : "Down");
  return true;
}

let passed = false;
try {
  cli("login", "--server", url);
  cli("create-agent", "Wren");
  const peer = cli("create-agent", "Peer");
  cli("settings-set", "away.answering", "false", "--agent", "Wren");
  cli("settings-set", "away.answering", "false", "--agent", "Peer");
  await until("both agents online", 60_000, () => ((cli("status")["agents"] ?? []) as { online: boolean }[]).every((a) => a.online));
  cli("notifier-add", "telegram", "--bot-token", token, "--chat-id", chat, "--agent", "Wren");
  cli("reminder-set", "Timed Reminder. Tell your operator the word pineapple.", "--every-minutes", "1", "--agent", "Wren");
  say("Wren has a notifier and a Reminder that fires every minute.");

  writeFileSync(join(folder, "mcp.json"), JSON.stringify({ mcpServers: { cello: { command: process.execPath, args: [MCP], env: { CELLO_HOME: home } } } }));
  writeFileSync(join(folder, "start.sh"), `#!/bin/sh\ncd '${folder}'\nexec claude --model ${model} --setting-sources project --strict-mcp-config --mcp-config mcp.json --dangerously-load-development-channels server:cello --effort low --allowedTools mcp__cello --disable-slash-commands\n`, { mode: 0o700 });
  tmux("new-session", "-d", "-s", TMUX, "-x", "200", "-y", "50", join(folder, "start.sh"));
  await until("the session to be ready", 120_000, () => {
    if (choose(/I am using this for local development/) || choose(/Yes, I trust this folder/)) return false;
    const now = screen();
    return /Claude Code v/.test(now) && /shift\+tab to cycle/.test(now);
  });

  const prompt = `Scripted test. Never poll, and compose nothing of your own. Do these in order, then end your turn: 1. Call cello_use_agent with agent Wren. 2. Call cello_initiate_session with agent Wren and target ${peer["agent_id"] as string}. 3. Call cello_notify with agent Wren, kind request, and text "Wake test. Reply here with any words." After that you only act when a doorbell wakes you. If a doorbell says your human operator has replied: call cello_receive with agent Wren, then call cello_notify with agent Wren and a text that is "Woken by your reply. You said: " followed by the exact words under from_your_operator, then end your turn. If a doorbell says a Reminder is due: call cello_receive with agent Wren, then call cello_notify with agent Wren and a text that is "Woken by a Reminder. It says: " followed by the Reminder's text, then end your turn.`;
  const file = join(folder, ".prompt");
  writeFileSync(file, prompt);
  tmux("load-buffer", "-b", "cello-wake-prompt", file);
  tmux("paste-buffer", "-p", "-d", "-b", "cello-wake-prompt", "-t", `${TMUX}:0.0`);
  rmSync(file);
  await sleep(2000);
  tmux("send-keys", "-t", `${TMUX}:0.0`, "Enter");

  await until("the session to ask its operator", 180_000, () => logged("notifier.sent") >= 1);
  say("The session has asked in Telegram and gone idle. Waiting up to 5 minutes for a reply typed there, and for the Reminder.");
  await until("the timed Reminder to wake the session", 300_000, () => logged("reminder.woke") >= 1);
  say("The daemon rang the session for the timed Reminder.");
  await until("the operator's reply to be stored", 300_000, () => logged("operator.reply_stored") >= 1);
  say("The reply reached the daemon.");
  // The first notify asked. One more follows each wake, and only a session that was woken and read sends it.
  await until("the session to answer both wakes", 180_000, () => logged("notifier.sent") >= 3);
  passed = true;
  say("PASSED: the idle session was woken by the reply and by the Reminder, read each, and told its operator.");
} finally {
  say(`\n--- the session's screen ---\n${screen().split("\n").filter((line) => line.trim()).slice(-45).join("\n")}`);
  spawnSync(process.execPath, [cliFor(["logout"]), "logout"], { env: { ...process.env, CELLO_HOME: home } });
  if (passed) spawnSync("tmux", ["kill-session", "-t", TMUX]);
  else say(`Left open to look at: tmux attach -t ${TMUX}. Folder: ${base}`);
}
process.exit(passed ? 0 : 1);

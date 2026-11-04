// Iteration 1's live test: two real Claude Code sessions, one daemon, the real server.
// They send fixed lines on the cheapest model, in empty folders. This script does all the checking.
//
//   node live/real-sessions.ts --server wss://host/v1 --instance <vm> --zone <zone> [--startup-only]
//
// Watch it with: tmux attach -r -t cello-live
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { toHex } from "../src/protocol/encode.ts";
import { signedEntry } from "../src/protocol/wire.ts";
import { Store } from "../src/daemon/store.ts";

const { values: args } = parseArgs({
  options: {
    server: { type: "string" },
    instance: { type: "string" },
    zone: { type: "string" },
    model: { type: "string", default: "claude-haiku-5-5" },
    "startup-only": { type: "boolean", default: false },
  },
});
if (!args.server || !args.instance || !args.zone) throw new Error("--server, --instance and --zone are required");

const TMUX = "cello-live";
const MCP = new URL("../src/mcp.ts", import.meta.url).pathname;
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const CONVERSATION_LIMIT_MS = 15 * 60 * 1000;
const KILL_AT_POSITION = 5;
const CHANNEL_TAG = /<channel source=\\?"[^"\\]*cello-v2/;

// A short path, because a Unix socket path can't be long.
const base = mkdtempSync("/tmp/cv2-");
const home = join(base, "home");
const env = { ...process.env, CELLO_V2_HOME: home };
const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
const evidence = join(homedir(), "cello-v2-live-runs", stamp);
mkdirSync(evidence, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const cli = (...rest: string[]): string => execFileSync(process.execPath, [CLI, ...rest], { encoding: "utf8", env });
const tmux = (...rest: string[]): string => execFileSync("tmux", rest, { encoding: "utf8" });
const pane = (n: number): string => tmux("capture-pane", "-p", "-J", "-S", "-5000", "-t", `${TMUX}:0.${n}`);
function say(line: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
}

interface AgentStatus { name: string; agent_id: string; online: boolean; sessions: { session_id: string; state: string; position: number; fault: string | null }[] }
interface Status { pid: number; connected: boolean; agents: AgentStatus[] }
const status = (): Status => JSON.parse(cli("status")) as Status;

async function until<T>(what: string, limitMs: number, check: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function prepareFolder(name: string): string {
  const folder = join(base, name);
  mkdirSync(folder);
  writeFileSync(join(folder, "mcp.json"), JSON.stringify({ mcpServers: { "cello-v2": { command: process.execPath, args: [MCP], env: { CELLO_V2_HOME: home } } } }));
  // Only project settings and only this one server, so no personal instructions, hooks or plugins load and spend tokens.
  writeFileSync(join(folder, "start.sh"), `#!/bin/sh\ncd '${folder}'\nexec claude --model ${args.model} --effort low --setting-sources project --strict-mcp-config --mcp-config mcp.json --dangerously-load-development-channels server:cello-v2 --allowedTools mcp__cello-v2 --disable-slash-commands\n`, { mode: 0o700 });
  return folder;
}

// Each session is told only what to send next. A doorbell has to be what moves it on.
const COMMON = "If a send is refused with session_not_current, call cello_receive and send the same line again. If a tool says daemon_not_running, end your turn; a doorbell says when the daemon is back, and then call cello_receive and send your next line unless a notice says it landed. Compose nothing of your own, and never poll.";
const alphaPrompt = (betaId: string): string =>
  `Scripted test. Call cello_use_agent with agent Alpha, then cello_initiate_session with target ${betaId}, then send line 1 and end your turn. After that, each time a doorbell says a message is waiting, call cello_receive. If the newest message you got has signal standby, just end your turn. If its signal is over, send your next line and end your turn. Lines: 1. "alpha one" signal over. 2. "alpha two" signal over. 3. "alpha three" signal over. 4. "alpha done" signal wrap. When a doorbell says the other side closed, call cello_receive, then cello_close_session, and say finished. ${COMMON}`;
const betaPrompt = "Scripted test. Call cello_use_agent with agent Beta and end your turn. Each time a doorbell says a message is waiting, call cello_receive, then act on what it said, and end your turn. If it said alpha one: send \"beta one\" signal standby est_minutes 1, then send \"beta two\" signal over. If it said alpha two: send \"beta three\" signal over. If it said alpha three: send \"beta four\" signal over. If it said alpha done: call cello_close_session. " + COMMON;

let tmuxIsOurs = false;

async function openSession(n: number, folder: string): Promise<void> {
  const command = join(folder, "start.sh");
  if (n === 0) {
    // new-session refuses an existing name, so a session this run didn't start is never touched.
    tmux("new-session", "-d", "-s", TMUX, "-x", "200", "-y", "50", command);
    tmuxIsOurs = true;
  }
  if (n === 1) tmux("split-window", "-h", "-t", `${TMUX}:0`, command);
}

// Claude Code asks before it loads a development channel, and before it trusts a new folder. Those can't be flags.
// These are this script's own folder and server. It moves to the named option first, because the default can be "exit".
function chooseOption(n: number, screen: string, option: RegExp): boolean {
  const lines = screen.split("\n");
  if (!lines.some((line) => option.test(line))) return false;
  const onIt = lines.some((line) => line.includes("❯") && option.test(line));
  tmux("send-keys", "-t", `${TMUX}:0.${n}`, onIt ? "Enter" : "Down");
  return true;
}

async function answerStartupDialogs(n: number): Promise<void> {
  await until(`session ${n} to be ready`, 90_000, () => {
    const screen = tmux("capture-pane", "-p", "-J", "-t", `${TMUX}:0.${n}`);
    if (chooseOption(n, screen, /I am using this for local development/) || chooseOption(n, screen, /Yes, I trust this folder/)) return false;
    // Claude Code may fold the channel notice away, so this only means the prompt is up. The wake itself is the proof.
    return /Claude Code v/.test(screen) && /shift\+tab to cycle/.test(screen);
  });
}

function prompt(n: number, text: string): void {
  tmux("send-keys", "-t", `${TMUX}:0.${n}`, "-l", text);
  execFileSync("sleep", ["1"]);
  tmux("send-keys", "-t", `${TMUX}:0.${n}`, "Enter");
}

function saveScreens(): void {
  writeFileSync(join(evidence, "alpha-screen.txt"), pane(0));
  writeFileSync(join(evidence, "beta-screen.txt"), pane(1));
}

function remoteSql(query: string): string {
  const command = `cd ~/cello-server && sudo docker compose -f docker-compose.yml -f deploy/docker-compose.tls.yml exec -T postgres psql -U cello_owner -d cello -tAc "${query}"`;
  return execFileSync("gcloud", ["compute", "ssh", args.instance as string, "--zone", args.zone as string, "--tunnel-through-iap", "--quiet", "--command", command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// Claude Code's own transcript of one session. It answers two questions a final state can't:
// did doorbells reach the session, and did it read only after one? A session that polled would reach the same end.
function sessionFacts(folder: string): { turns: number; models: string[]; input: number; output: number; doorbells: number; reads: number; readsWithoutDoorbell: number } {
  const slug = folder.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join(homedir(), ".claude", "projects", slug);
  const seen = new Set<string>();
  const seenCalls = new Set<string>();
  const models = new Set<string>();
  let input = 0;
  let output = 0;
  let doorbells = 0;
  let reads = 0;
  let readsWithoutDoorbell = 0;
  let doorbellSinceLastRead = false;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as {
        type?: string;
        operation?: string;
        content?: unknown;
        message?: { id?: string; model?: string; content?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
      };
      if (row.type === "queue-operation" && row.operation === "enqueue" && typeof row.content === "string" && CHANNEL_TAG.test(row.content)) {
        doorbells += 1;
        doorbellSinceLastRead = true;
      }
      if (row.type === "user" && CHANNEL_TAG.test(JSON.stringify(row.message?.content ?? ""))) doorbellSinceLastRead = true;
      if (row.type !== "assistant" || !row.message?.id) continue;
      if (!seen.has(row.message.id)) {
        seen.add(row.message.id);
        if (row.message.model) models.add(row.message.model);
        input += row.message.usage?.input_tokens ?? 0;
        output += row.message.usage?.output_tokens ?? 0;
      }
      for (const block of Array.isArray(row.message.content) ? row.message.content as { type?: string; id?: string; name?: string }[] : []) {
        if (block.type !== "tool_use" || !block.id || seenCalls.has(block.id) || !block.name?.endsWith("cello_receive")) continue;
        seenCalls.add(block.id);
        reads += 1;
        if (!doorbellSinceLastRead) readsWithoutDoorbell += 1;
        doorbellSinceLastRead = false;
      }
    }
  }
  return { turns: seen.size, models: [...models], input, output, doorbells, reads, readsWithoutDoorbell };
}

const report: Record<string, unknown> = { started: stamp, server: args.server, model: args.model };

async function run(): Promise<void> {
  cli("login", "--server", args.server as string);
  const alphaId = (JSON.parse(cli("agent", "create", "Alpha")) as { agent_id: string }).agent_id;
  const betaId = (JSON.parse(cli("agent", "create", "Beta")) as { agent_id: string }).agent_id;
  await until("both agents online", 60_000, () => status().agents.every((a) => a.online));
  say("daemon up, both agents registered and online");

  const alphaFolder = prepareFolder("alpha");
  const betaFolder = prepareFolder("beta");
  await openSession(0, alphaFolder);
  await openSession(1, betaFolder);
  say(`sessions opening. Watch with: tmux attach -r -t ${TMUX}`);
  await answerStartupDialogs(0);
  await answerStartupDialogs(1);
  say("both sessions ready");
  if (args["startup-only"]) {
    saveScreens();
    return;
  }

  prompt(1, betaPrompt);
  await sleep(15_000);
  prompt(0, alphaPrompt(betaId));
  say("prompts sent. Nothing else goes to either session from here");

  const session = (name: string): AgentStatus["sessions"][number] | undefined => status().agents.find((a) => a.name === name)?.sessions[0];
  await until(`position ${KILL_AT_POSITION}`, CONVERSATION_LIMIT_MS, () => (session("Alpha")?.position ?? 0) >= KILL_AT_POSITION);

  const pid = status().pid;
  const killedAt = session("Alpha")?.position as number;
  say(`position ${killedAt} reached: killing the daemon, process ${pid}`);
  process.kill(pid, "SIGKILL");
  await sleep(3000);
  cli("login", "--server", args.server as string);
  report["killed_at_position"] = killedAt;
  report["killed_pid"] = pid;
  say(`daemon restarted, process ${status().pid}`);

  await until("both sides to close", CONVERSATION_LIMIT_MS, () => {
    const alpha = session("Alpha");
    const beta = session("Beta");
    return alpha?.state === "closed" && beta?.state === "closed";
  });
  say("both sides closed");

  const sessionId = session("Alpha")?.session_id as string;
  const reportA = JSON.parse(cli("verify", "Alpha", sessionId)) as { ok: boolean; position: number; root: string };
  const reportB = JSON.parse(cli("verify", "Beta", sessionId)) as { ok: boolean; position: number; root: string };
  assert.ok(reportA.ok && reportB.ok, "each side's own record must check out");
  assert.equal(reportA.root, reportB.root, "the two records must agree");
  report["chain"] = { position: reportA.position, root: reportA.root, alpha_ok: reportA.ok, beta_ok: reportB.ok };
  say(`the chain checks out on both sides, through position ${reportA.position}, and the roots match`);

  const held = await until("the server to drop the encrypted text", 60_000, () => {
    const count = remoteSql(`SELECT count(*) FROM entries WHERE session_id = '\\x${sessionId}' AND ciphertext IS NOT NULL`);
    return count === "0" ? count : undefined;
  });
  const onServer = remoteSql(`SELECT count(*) FROM entries WHERE session_id = '\\x${sessionId}'`);
  const serverState = remoteSql(`SELECT state FROM sessions WHERE session_id = '\\x${sessionId}'`);
  assert.equal(serverState, "closed");
  assert.equal(Number(onServer), reportA.position);
  report["server"] = { entries_kept: Number(onServer), entries_with_encrypted_text: Number(held), state: serverState };
  say(`on the server: ${onServer} entries kept, ${held} with encrypted text`);

  saveScreens();
  const facts = { alpha: sessionFacts(alphaFolder), beta: sessionFacts(betaFolder) };
  report["sessions"] = facts;
  for (const [name, fact] of Object.entries(facts)) {
    assert.ok(fact.doorbells > 0, `${name} must have received doorbells`);
    assert.ok(fact.reads > 0, `${name} must have read messages`);
    assert.equal(fact.readsWithoutDoorbell, 0, `${name} read without a doorbell, so it may have polled rather than being woken`);
  }
  say(`woken by doorbells: Alpha ${facts.alpha.doorbells}, Beta ${facts.beta.doorbells}, with no read before a doorbell`);

  cli("logout");
  const store = new Store(join(home, "cello.db"));
  const alpha = store.agents().find((a) => a.name === "Alpha");
  assert.ok(alpha);
  const rows = store.sessionsOf(alpha.agent_id).flatMap((s) => store.verifiedEntries(alpha.agent_id, s.session_id, s.verified_position));
  const lines = rows.map((row) => {
    const fields = signedEntry.decode(JSON.parse(row.entry)).fields;
    const body = JSON.parse(new TextDecoder().decode(row.body)) as { text: string; signal: string | null; est_minutes: number | null };
    return { position: row.position, author: toHex(fields.authorId) === alphaId ? "Alpha" : "Beta", kind: fields.kind === 2 ? "close" : "message", text: body.text, signal: body.signal, est_minutes: body.est_minutes };
  });
  store.close();
  report["conversation"] = lines;

  const signals = new Set(lines.map((line) => line.signal));
  for (const signal of ["over", "standby", "wrap"]) assert.ok(signals.has(signal), `the conversation must use ${signal}`);
  const texts = lines.filter((line) => line.kind === "message").map((line) => line.text);
  assert.equal(new Set(texts).size, texts.length, `no line may land twice: ${texts.join(", ")}`);
  for (const line of ["alpha one", "alpha done", "beta one", "beta four"]) assert.ok(texts.includes(line), `${line} must have landed`);
  assert.ok(lines.filter((line) => line.kind === "close").length === 2, "both sides must have closed");
  assert.ok(reportA.position > killedAt, "the conversation must have carried on after the kill");
  report["passed"] = true;
  say("PASSED");
}

try {
  await run();
} catch (err: unknown) {
  report["passed"] = false;
  report["failure"] = err instanceof Error ? err.message : String(err);
  say(`FAILED: ${report["failure"] as string}`);
  try {
    saveScreens();
  } catch {
    // The sessions may already be gone.
  }
  process.exitCode = 1;
} finally {
  writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 2));
  say(`evidence: ${evidence}`);
  // Stop only what this run started. The tmux session is left for looking at if it failed.
  if (tmuxIsOurs && report["passed"] !== false) {
    try {
      tmux("kill-session", "-t", TMUX);
    } catch {
      // Already gone.
    }
  }
  try {
    cli("logout");
  } catch {
    // Already stopped.
  }
  // The throwaway agents' keys go too, unless a failure needs looking at.
  if (report["passed"] === true) rmSync(base, { recursive: true, force: true });
}

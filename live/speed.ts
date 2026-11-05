// The speed test: real processes, every action a CLI command, no model turns. It tests the plumbing only:
// v2 has no screener yet, so nothing here says how v1's 3 November screening failure would go.
//
//   node live/speed.ts --local [--server-dir ../cello-server] [--scenarios a,b] [--seconds 60] [--cpu-prof]
//   node live/speed.ts --server wss://host/v1 --gentle
//
// Raw numbers and the report go to ~/cello-v2-live-runs/speed-<time>/.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import { cpus, homedir, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ServerLink } from "../src/daemon/link.ts";
import { databasePath } from "../src/daemon/paths.ts";
import { Store } from "../src/daemon/store.ts";
import { sealSessionContent } from "../src/protocol/aead.ts";
import { generateIdentitySeeds, signerFromSeeds, verifySignature } from "../src/protocol/identity.ts";
import { saltedContentHash } from "../src/protocol/salt.ts";
import { agentAuthBytes, ciphertextHash } from "../src/protocol/structures.ts";
import { signatureCodec, toB64, type WitnessedOnWire } from "../src/protocol/wire.ts";

const { values: args } = parseArgs({
  options: {
    local: { type: "boolean", default: false },
    server: { type: "string" },
    gentle: { type: "boolean", default: false },
    "server-dir": { type: "string" },
    scenarios: { type: "string" },
    seconds: { type: "string", default: "30" },
    "cpu-prof": { type: "boolean", default: false },
    "deep-target": { type: "string", default: "560" },
    label: { type: "string", default: "" },
    project: { type: "string", default: "cello-v2-speed" },
    port: { type: "string", default: "18190" },
  },
});
if (args.local === Boolean(args.server)) throw new Error("say exactly one of --local or --server <url>");

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const BOT = new URL("./speed-bot.ts", import.meta.url).pathname;
const REPO = new URL("..", import.meta.url).pathname;
const SECONDS = Number(args.seconds);
const COMPOSE_PROJECT = args.project;
const LOCAL_PORT = Number(args.port);
const SHORT = 200;
const KB100 = 100_000;
const MB1 = 1_000_000;
// One command's limit. It must outlast the daemon's own 90-second answer limit, so a stuck call shows as that error.
const COMMAND_LIMIT_MS = 120_000;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = join(homedir(), "cello-v2-live-runs", `speed-${stamp}${args.label ? `-${args.label}` : ""}`);
mkdirSync(runDir, { recursive: true });

function say(line: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// This Mac froze for 5 minutes after full-CPU tests on 3 November, and someone is using it. So load is bounded three
// ways: few senders, short runs with gaps, and this guard, which stops the load if the machine looks strained.
const LOAD_LIMIT = cpus().length * 1.2;
const LAG_LIMIT_MS = 3000;
const guard = { tripped: "" as string, strikes: 0, last: performance.now() };
const guardTimer = setInterval(() => {
  const lag = performance.now() - guard.last - 1000;
  guard.last = performance.now();
  const load = loadavg()[0] ?? 0;
  guard.strikes = lag > LAG_LIMIT_MS || load > LOAD_LIMIT ? guard.strikes + 1 : 0;
  if (guard.strikes >= 3 && !guard.tripped) {
    guard.tripped = `machine strained: 1-minute load ${load.toFixed(1)} against a limit of ${LOAD_LIMIT.toFixed(1)}, this script's timer ${Math.round(lag)} ms late`;
    say(`GUARD: ${guard.tripped}. Stopping the load.`);
  }
}, 1000);
guardTimer.unref();

interface Spread { n: number; p50: number; p90: number; p99: number; max: number }

function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: Math.round(sorted.at(-1) ?? 0) };
}

// ---- Commands, each its own process ----

interface Run { status: number | null; json: Record<string, unknown>; ms: number; stderr: string }

const homes: Home[] = [];

class Home {
  readonly path = mkdtempSync(join(tmpdir(), "cello-v2-speed-"));
  pid: number | undefined;
  constructor() {
    homes.push(this);
  }

  // Text goes by standard input, because a 1 MB argument won't fit on a command line.
  run(argv: string[], caller: string | undefined, input?: string, extraEnv: Record<string, string> = {}): Promise<Run> {
    return new Promise((resolve) => {
      const started = performance.now();
      const child: ChildProcess = spawn(process.execPath, [CLI, ...argv], {
        env: { ...process.env, CELLO_HOME: this.path, ...(caller ? { CELLO_CALLER: caller } : {}), ...extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input ?? "");
      const limit = setTimeout(() => child.kill("SIGKILL"), COMMAND_LIMIT_MS);
      child.on("close", (status) => {
        clearTimeout(limit);
        const stdout = Buffer.concat(out).toString();
        const stderr = Buffer.concat(err).toString();
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(stdout || stderr) as Record<string, unknown>;
        } catch {
          // Not every command answers in JSON.
        }
        resolve({ status, json, ms: performance.now() - started, stderr });
      });
    });
  }

  async login(url: string, env: Record<string, string> = {}): Promise<void> {
    const run = await this.run(["login", "--server", url], undefined, undefined, env);
    if (run.status !== 0) throw new Error(`login failed: ${run.stderr}`);
    const status = await this.run(["status"], undefined);
    this.pid = status.json["pid"] as number;
  }

  async logout(): Promise<void> {
    if (this.pid === undefined) return;
    await this.run(["logout"], undefined);
    for (let i = 0; i < 100 && this.alive(); i++) await pause(100);
    if (this.alive()) process.kill(this.pid, "SIGKILL");
    this.pid = undefined;
  }

  alive(): boolean {
    if (this.pid === undefined) return false;
    try {
      process.kill(this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  dbBytes(): number {
    let total = 0;
    for (const name of readdirSync(this.path)) if (name.startsWith("cello.db") && !name.endsWith(".key")) total += statSync(join(this.path, name)).size;
    return total;
  }
}

interface Agent { name: string; id: string; home: Home; caller: string }

async function makeAgent(home: Home, name: string): Promise<Agent> {
  const made = await home.run(["create-agent", name], undefined);
  if (made.status !== 0) throw new Error(`create-agent ${name} failed: ${made.stderr}`);
  await home.run(["settings-set", "away.answering", "false", "--agent", name], undefined);
  return { name, id: made.json["agent_id"] as string, home, caller: `speed-${name}` };
}

function act(agent: Agent, argv: string[], input?: string): Promise<Run> {
  return agent.home.run([...argv, "--agent", agent.name], agent.caller, input);
}

async function startSession(from: Agent, to: Agent): Promise<string> {
  const started = await act(from, ["initiate-session", to.id]);
  if (started.status !== 0 || started.json["state"] !== "active") throw new Error(`session ${from.name} to ${to.name} didn't start: ${JSON.stringify(started.json)} ${started.stderr}`);
  return started.json["session_id"] as string;
}

// ---- Messages that can be recognised afterwards without keeping them in memory ----

function makeText(tag: string, seq: number, size: number): string {
  const head = `${tag}|${seq}|${size}|`;
  return head + (String.fromCharCode(97 + (seq % 26)).repeat(Math.max(0, size - head.length)));
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseTag(text: string): { tag: string; seq: number; size: number } | undefined {
  const [tag, seq, size] = text.slice(0, 80).split("|");
  return tag && seq && size ? { tag, seq: Number(seq), size: Number(size) } : undefined;
}

interface Sent { session: string; tag: string; seq: number; size: number; startedAt: number; ms: number; position?: number; outcome: string }

// Mostly short, some long: what a coding bot firing on hooks sends.
const MIXED = [SHORT, SHORT, SHORT, SHORT, KB100, SHORT, SHORT, SHORT, SHORT, KB100, SHORT, SHORT, SHORT, SHORT, KB100, MB1];

interface Flood { from: Agent; sessions: string[]; sizes: number[]; concurrency: number; seconds: number; limit?: number; gapMs?: number; tag: string; via?: "cli" | "socket" }

// Its own process, so the daemon still has to serve it over its real socket. It's told to stop if the guard trips.
async function floodBySocket(plan: Flood): Promise<Sent[]> {
  const out = join(plan.from.home.path, `flood-${plan.tag}.json`);
  const worker = spawn(process.execPath, [BOT, JSON.stringify({ home: plan.from.home.path, agent: plan.from.name, caller: plan.from.caller, sessions: plan.sessions, sizes: plan.sizes, concurrency: plan.concurrency, seconds: plan.seconds, tag: plan.tag, out, ...(plan.limit === undefined ? {} : { limit: plan.limit }) })], { stdio: ["ignore", "inherit", "inherit"] });
  const watch = setInterval(() => { if (guard.tripped) worker.kill("SIGTERM"); }, 500);
  const status = await new Promise<number | null>((resolve) => worker.on("close", resolve));
  clearInterval(watch);
  if (status !== 0) throw new Error(`the bot process exited with ${status}`);
  return JSON.parse(readFileSync(out, "utf8")) as Sent[];
}

// Each worker sends the next message as soon as its last one returns, in notice mode, across its sessions in turn.
async function flood(plan: Flood): Promise<Sent[]> {
  if (plan.via !== "cli") return floodBySocket(plan);
  const sent: Sent[] = [];
  const deadline = performance.now() + plan.seconds * 1000;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!guard.tripped && performance.now() < deadline && (plan.limit === undefined || next < plan.limit)) {
      const seq = next++;
      const session = plan.sessions[seq % plan.sessions.length] as string;
      const size = plan.sizes[seq % plan.sizes.length] as number;
      const started = performance.now();
      const run = await act(plan.from, ["send", session, "-", "--notice", "--over"], makeText(plan.tag, seq, size));
      const outcome = run.status === 0 ? (run.json["sent"] === true ? "sent" : String(run.json["status"])) : String(run.json["error"] ?? `exit_${run.status}: ${run.stderr.slice(0, 200)}`);
      sent.push({ session, tag: plan.tag, seq, size, startedAt: started, ms: run.ms, outcome, ...(typeof run.json["position"] === "number" ? { position: run.json["position"] } : {}) });
      if (plan.gapMs) await pause(plan.gapMs);
    }
  };
  await Promise.all(Array.from({ length: plan.concurrency }, worker));
  return sent;
}

function floodSummary(sent: Sent[], seconds: number): Record<string, unknown> {
  const outcomes: Record<string, number> = {};
  for (const s of sent) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
  const bySize: Record<string, unknown> = {};
  for (const size of new Set(sent.map((s) => s.size))) {
    const ofSize = sent.filter((s) => s.size === size);
    bySize[String(size)] = { sent: ofSize.length, perSecond: Number((ofSize.length / seconds).toFixed(2)), sendMs: spread(ofSize.map((s) => s.ms)) };
  }
  const bytes = sent.reduce((sum, s) => sum + s.size, 0);
  return { messages: sent.length, perSecond: Number((sent.length / seconds).toFixed(2)), megabytesPerSecond: Number((bytes / 1e6 / seconds).toFixed(2)), outcomes, bySize };
}

// ---- The normal conversation, timed from before the send until the other side has read it ----

interface Turn { turn: number; sendMs: number; readMs: number; at: number; ok: boolean; problem?: string }

interface Conversation { a: Agent; b: Agent; session: string; turns?: number; thinkMs: number; tag: string; stop?: () => boolean }

// The turns so far, so that a burst can be timed while the conversation is still going.
let liveTurns: Turn[] = [];
const talkingTurns = (): Turn[] => liveTurns;

async function converse(plan: Conversation): Promise<{ turns: Turn[]; texts: string[] }> {
  const turns: Turn[] = [];
  liveTurns = turns;
  const texts: string[] = [];
  for (let turn = 0; plan.turns === undefined ? !plan.stop?.() : turn < plan.turns; turn++) {
    const writer = turn % 2 === 0 ? plan.a : plan.b;
    const reader = turn % 2 === 0 ? plan.b : plan.a;
    const text = makeText(plan.tag, turn, SHORT);
    const at = performance.now();
    const sending = act(writer, ["send", plan.session, "-", "--over"], text);
    let got = false;
    let problem: string | undefined;
    const deadline = at + 100_000;
    // The wait goes up beside the send, and either order works: it returns at once if the message is already unread.
    while (!got && performance.now() < deadline) {
      const waited = await act(reader, ["wait", "--timeout-seconds", "30"]);
      if (waited.status !== 0 && waited.status !== 3) problem = `wait: ${waited.stderr.slice(0, 200)}`;
      const read = await act(reader, ["receive", "--session-id", plan.session]);
      if (read.status !== 0) {
        problem = `receive: ${read.stderr.slice(0, 200)}`;
        continue;
      }
      got = ((read.json["messages"] ?? []) as { text?: string }[]).some((m) => m.text === text);
    }
    const readMs = performance.now() - at;
    const sent = await sending;
    if (sent.status !== 0 || sent.json["sent"] !== true) problem = `send: ${JSON.stringify(sent.json).slice(0, 200)}`;
    if (!got) problem ??= "the message never arrived";
    if (got && !problem) texts.push(text);
    turns.push({ turn, sendMs: sent.ms, readMs, at, ok: got && !problem, ...(problem ? { problem } : {}) });
    await pause(plan.thinkMs);
  }
  return { turns, texts };
}

function conversationSummary(turns: Turn[]): Record<string, unknown> {
  const good = turns.filter((t) => t.ok);
  return { turns: turns.length, failed: turns.length - good.length, readMs: spread(good.map((t) => t.readMs)), sendMs: spread(good.map((t) => t.sendMs)), problems: [...new Set(turns.flatMap((t) => (t.problem ? [t.problem] : [])))].slice(0, 5) };
}

// ---- The local server, from nothing, on its own project name and port ----

const serverDir = args["server-dir"] ?? process.env["CELLO_SERVER_DIR"] ?? join(REPO, "..", "cello-server");
const overridePath = join(runDir, "compose-override.yml");
const serverProfileDir = join(runDir, "server-prof");
let composeUp = false;

function compose(...argv: string[]): string {
  return execFileSync("docker", ["compose", "-p", COMPOSE_PROJECT, "-f", join(serverDir, "docker-compose.yml"), "-f", join(serverDir, "live/docker-compose.test.yml"), "-f", overridePath, "--project-directory", serverDir, ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CELLO_TEST_VOUCH: "1", CELLO_PORT: String(LOCAL_PORT), POSTGRES_PASSWORD: localPasswords.postgres, CELLO_APP_PASSWORD: localPasswords.app },
  });
}
const localPasswords = { postgres: randomBytes(16).toString("hex"), app: randomBytes(16).toString("hex") };

function sql(query: string): string {
  return compose("exec", "-T", "postgres", "psql", "-U", "cello_owner", "-d", "cello", "-At", "-c", query).trim();
}

function startLocalServer(): string {
  mkdirSync(serverProfileDir, { recursive: true, mode: 0o777 });
  // pg_stat_statements says where the database's time goes. It changes nothing the server does.
  const profile = args["cpu-prof"]
    ? `    environment:\n      NODE_OPTIONS: "--cpu-prof --cpu-prof-dir=/prof"\n    volumes:\n      - ${serverProfileDir}:/prof\n`
    : "";
  writeFileSync(overridePath, `services:\n  postgres:\n    command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements", "-c", "pg_stat_statements.track_utility=on", "-c", "track_wal_io_timing=on"]\n${profile ? `  server:\n${profile}` : ""}`);
  execFileSync("chmod", ["777", serverProfileDir]);
  say("starting a local server from nothing");
  compose("up", "-d", "--build", "--wait", "server");
  composeUp = true;
  sql("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
  return `ws://127.0.0.1:${LOCAL_PORT}/v1`;
}

function stopLocalServer(): void {
  if (!composeUp) return;
  composeUp = false;
  // Stopped on its own first, so a CPU profile gets written before the volumes go.
  try {
    compose("stop", "-t", "20", "server");
    writeFileSync(join(runDir, "server.log"), compose("logs", "--no-color", "server"));
  } catch (err: unknown) {
    say(`stopping the server: ${err instanceof Error ? err.message : String(err)}`);
  }
  compose("down", "-v", "--remove-orphans");
}

// Per statement, for the time since the last reset. COMMIT is where the disk flush shows.
function databaseTime(): { query: string; calls: number; meanMs: number; totalMs: number }[] {
  if (!args.local) return [];
  const rows = sql("SELECT calls, round(mean_exec_time::numeric, 3), round(total_exec_time::numeric, 1), left(regexp_replace(query, E'\\\\s+', ' ', 'g'), 70) FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat%' ORDER BY total_exec_time DESC LIMIT 16");
  // A COMMIT shows as no time there, because the flush to disk it waits for is counted here instead.
  const [flushes, flushMs] = sql("SELECT wal_sync, round(wal_sync_time::numeric, 1) FROM pg_stat_wal").split("|");
  const flush = { calls: Number(flushes), meanMs: Number((Number(flushMs) / Math.max(1, Number(flushes))).toFixed(3)), totalMs: Number(flushMs), query: "(flushing the database log to disk)" };
  return [flush, ...rows.split("\n").filter(Boolean).map((line) => {
    const [calls, meanMs, totalMs, query] = line.split("|");
    return { calls: Number(calls), meanMs: Number(meanMs), totalMs: Number(totalMs), query: query ?? "" };
  })];
}

function resetDatabaseTime(): void {
  if (args.local) sql("SELECT pg_stat_statements_reset(), pg_stat_reset_shared('wal')");
}

function heldOnServer(): { rows: number; bytes: number; tableBytes: number } | undefined {
  if (!args.local) return undefined;
  const [rows, bytes, tableBytes] = sql("SELECT count(*), coalesce(sum(octet_length(ciphertext)), 0), pg_total_relation_size('entries') FROM entries WHERE ciphertext IS NOT NULL").split("|");
  return { rows: Number(rows), bytes: Number(bytes), tableBytes: Number(tableBytes) };
}

// ---- What runs out first: sampled from outside, so the sampling can't be the thing it measures ----

interface Sample { t: number; who: string; cpuPercent: number; rssMb: number }

class Sampler {
  readonly samples: Sample[] = [];
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #last = new Map<string, { at: number; cpu: number }>();
  #stopped = false;
  #dockerLoop: Promise<void> = Promise.resolve();

  start(daemons: Record<string, Home>): void {
    this.#timers.push(setInterval(() => {
      for (const [who, home] of Object.entries(daemons)) {
        if (!home.alive()) continue;
        const child = spawn("ps", ["-o", "rss=,time=", "-p", String(home.pid)], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        child.on("close", () => this.#daemonLine(who, out));
      }
    }, 2000));
    if (args.local) this.#dockerLoop = this.#docker();
  }

  #daemonLine(who: string, line: string): void {
    const match = /(\d+)\s+(?:(\d+):)?(\d+):(\d+\.\d+)/.exec(line);
    if (!match) return;
    const cpu = Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]);
    const now = performance.now();
    const previous = this.#last.get(who);
    this.#last.set(who, { at: now, cpu });
    if (previous) this.samples.push({ t: now, who, cpuPercent: (100 * (cpu - previous.cpu)) / ((now - previous.at) / 1000), rssMb: Number(match[1]) / 1024 });
  }

  async #docker(): Promise<void> {
    while (!this.#stopped) {
      const out = await new Promise<string>((resolve) => {
        const child = spawn("docker", ["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}", `${COMPOSE_PROJECT}-server-1`, `${COMPOSE_PROJECT}-postgres-1`], { stdio: ["ignore", "pipe", "ignore"] });
        let text = "";
        child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
        child.on("close", () => resolve(text));
      });
      for (const line of out.split("\n").filter(Boolean)) {
        const [name, cpu, mem] = line.split("|");
        const size = /([\d.]+)(GiB|MiB|KiB)/.exec(mem ?? "");
        const rssMb = size ? Number(size[1]) * (size[2] === "GiB" ? 1024 : size[2] === "MiB" ? 1 : 1 / 1024) : 0;
        this.samples.push({ t: performance.now(), who: name?.includes("postgres") ? "postgres" : "server", cpuPercent: Number.parseFloat(cpu ?? "0"), rssMb });
      }
      await pause(2000);
    }
  }

  async stop(): Promise<Record<string, unknown>> {
    this.#stopped = true;
    for (const timer of this.#timers) clearInterval(timer);
    await this.#dockerLoop;
    const summary: Record<string, unknown> = {};
    for (const who of new Set(this.samples.map((s) => s.who))) {
      const own = this.samples.filter((s) => s.who === who);
      summary[who] = { samples: own.length, cpuPercent: spread(own.map((s) => s.cpuPercent)), rssMbMax: Math.round(Math.max(...own.map((s) => s.rssMb))), rssMbLast: Math.round(own.at(-1)?.rssMb ?? 0) };
    }
    return summary;
  }
}

// ---- Nothing lost, doubled or reordered ----

interface Check { name: string; ok: boolean; detail: string }

interface TranscriptEntry { position: number; own: boolean; text?: string | null; closed_their_side?: boolean }

async function waitForPosition(agent: Agent, session: string, position: number): Promise<number> {
  let seen = 0;
  for (let i = 0; i < 600; i++) {
    const listed = await agent.home.run(["sessions", "--all", "--agent", agent.name], agent.caller);
    seen = ((listed.json["sessions"] ?? []) as { session_id: string; position: number }[]).find((s) => s.session_id === session)?.position ?? 0;
    if (seen >= position) return seen;
    await pause(500);
  }
  return seen;
}

// How far a session with one sender ends up. "Not sent yet" is saved and lands later, and so holds a position too.
function expectedTop(sent: Sent[]): number {
  const saved = sent.filter((s) => s.outcome === "sent" || s.outcome === "not_sent_yet").length;
  return Math.max(saved, ...sent.flatMap((s) => (s.position === undefined ? [] : [s.position])));
}

// Closes the session from both sides, then compares the two records with each other and with what was sent.
async function checkSession(name: string, a: Agent, b: Agent, session: string, sent: Sent[], conversationTexts?: string[], readSeqs?: number[]): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (what: string, ok: boolean, detail = ""): void => { checks.push({ name: `${name}: ${what}`, ok, detail }); };
  for (const agent of [a, b]) {
    const closed = await act(agent, ["close-session", session]);
    add(`${agent.name} closes`, closed.status === 0, closed.stderr.slice(0, 200));
  }
  const landed = sent.filter((s) => s.position !== undefined);
  const top = expectedTop(sent) + 2;
  await waitForPosition(a, session, top);
  await waitForPosition(b, session, top);
  const [va, vb] = await Promise.all([a, b].map((agent) => act(agent, ["verify-session", session])));
  add("verify-session passes on both sides", va?.json["ok"] === true && vb?.json["ok"] === true, `${JSON.stringify(va?.json).slice(0, 200)} ${JSON.stringify(vb?.json).slice(0, 200)}`);
  add("both records have the same root and length", va?.json["root"] === vb?.json["root"] && va?.json["position"] === vb?.json["position"], `position ${String(va?.json["position"])} and ${String(vb?.json["position"])}`);

  const readAll = async (agent: Agent): Promise<TranscriptEntry[] | string> => {
    const entries: TranscriptEntry[] = [];
    for (;;) {
      const page = await agent.home.run(["transcript", session, "--agent", agent.name, ...(entries.length > 0 ? ["--after", String((entries.at(-1) as TranscriptEntry).position)] : [])], agent.caller);
      if (page.status !== 0) return `transcript failed: ${(JSON.stringify(page.json) + page.stderr).slice(0, 200)}`;
      entries.push(...(page.json["entries"] as TranscriptEntry[]));
      if (page.json["more"] !== true) return entries;
    }
  };
  const fromA = await readAll(a);
  const fromB = await readAll(b);
  if (typeof fromA === "string" || typeof fromB === "string") {
    add("both transcripts can be read", false, `${String(typeof fromA === "string" ? fromA : "")} ${String(typeof fromB === "string" ? fromB : "")}`);
    return checks;
  }
  add("no gaps in positions", fromA.every((e, i) => e.position === i + 1) && fromB.every((e, i) => e.position === i + 1), `${fromA.length} and ${fromB.length} entries`);
  const same = fromA.length === fromB.length && fromA.every((e, i) => {
    const other = fromB[i] as TranscriptEntry;
    return e.position === other.position && e.own !== other.own && e.text === other.text;
  });
  add("both sides hold the same text at every position", same);

  const byText = new Map<string, number>();
  for (const e of fromB) if (e.text) byText.set(textHash(e.text), (byText.get(textHash(e.text)) ?? 0) + 1);
  const atPosition = new Map(fromB.map((e) => [e.position, e]));
  let missing = 0;
  let doubled = 0;
  let misplaced = 0;
  for (const s of landed) {
    const hash = textHash(makeText(s.tag, s.seq, s.size));
    const count = byText.get(hash) ?? 0;
    if (count === 0) missing++;
    if (count > 1) doubled++;
    const at = atPosition.get(s.position as number)?.text;
    if (!at || textHash(at) !== hash) misplaced++;
  }
  add(`all ${landed.length} acknowledged messages are there once, at their acknowledged position`, missing + doubled + misplaced === 0, `missing ${missing}, doubled ${doubled}, misplaced ${misplaced}`);
  const unconfirmed = sent.filter((s) => s.position === undefined);
  if (unconfirmed.length > 0) {
    const arrived = unconfirmed.filter((s) => byText.has(textHash(makeText(s.tag, s.seq, s.size)))).length;
    add(`sends with no acknowledgement (${unconfirmed.length})`, unconfirmed.every((s) => s.outcome !== "sent"), `${arrived} of them landed anyway, outcomes: ${[...new Set(unconfirmed.map((s) => s.outcome))].join("; ").slice(0, 200)}`);
    const saved = unconfirmed.filter((s) => s.outcome === "not_sent_yet");
    const landedOnce = saved.filter((s) => byText.get(textHash(makeText(s.tag, s.seq, s.size))) === 1).length;
    add(`every message told "not sent yet" (${saved.length}) landed later, once`, landedOnce === saved.length, `${landedOnce} did`);
  }
  if (conversationTexts) {
    const inOrder = fromB.flatMap((e) => (e.text ? [e.text] : []));
    add("the conversation arrived whole and in order", conversationTexts.every((t, i) => inOrder[i] === t), `${conversationTexts.length} turns against ${inOrder.length} messages`);
  }
  if (readSeqs) {
    const dupes = readSeqs.length - new Set(readSeqs).size;
    // A send that timed out can still land, so what counts is what's on the record.
    const onRecord = sent.filter((s) => byText.has(textHash(makeText(s.tag, s.seq, s.size)))).length;
    add("the reader was handed each message once", dupes === 0 && new Set(readSeqs).size === onRecord, `read ${readSeqs.length}, ${dupes} twice, ${onRecord} on the record`);
  }
  return checks;
}

// A client's-eye proof, which also works on a server whose database this script mustn't touch:
// after its daemon stops, the reader asks for the session again and counts any encrypted text still offered.
async function ciphertextStillOffered(home: Home, url: string, agentName: string, sessions: string[]): Promise<number> {
  const store = new Store(databasePath(home.path));
  const row = store.agents().find((a) => a.name === agentName);
  if (!row) throw new Error(`no agent ${agentName} in ${home.path}`);
  const signer = await signerFromSeeds({ ed: row.ed_seed, pq: row.pq_seed });
  store.close();
  let answer: (server: { id: Uint8Array; nonce: Uint8Array }) => void = () => undefined;
  const connected = new Promise<{ id: Uint8Array; nonce: Uint8Array }>((resolve) => { answer = resolve; });
  const link = new ServerLink(url, { checkIdentity: () => null, connected: async (server) => { answer(server); }, disconnected: () => undefined, push: () => undefined });
  link.start();
  try {
    const server = await connected;
    const clientNonce = new Uint8Array(randomBytes(32));
    const proof = agentAuthBytes({ serverId: server.id, agentId: signer.id, serverNonce: server.nonce, clientNonce });
    await link.call("auth", { agentId: toB64(signer.id), clientNonce: toB64(clientNonce), signature: signatureCodec.encode(await signer.sign("cello-agent-auth", proof)) });
    let offered = 0;
    for (const hex of sessions) {
      let after = 0;
      for (;;) {
        const page = await link.call("entry.fetch", { agent: toB64(signer.id), sessionId: toB64(new Uint8Array(Buffer.from(hex, "hex"))), after, long: true }) as { items: (WitnessedOnWire & { ack: { fields: { position: number } } })[]; tip: number };
        if (page.items.length === 0) break;
        offered += page.items.filter((item) => item.ciphertext !== null).length;
        after += page.items.length;
        if (after >= page.tip) break;
      }
    }
    return offered;
  } finally {
    link.stop();
  }
}

// ---- Scenarios ----

const GAP_MS = 20_000;
// About what the cloud run measured from this Mac: 100 KB took 3.4 s more than a short message, and 1 MB took 11 to 21 s.
const SLOW_UP_BYTES_PER_SECOND = 80_000;
const SLOW_DOWN_BYTES_PER_SECOND = 300_000;
// About one packet. A short message mixes in between a long upload's packets, instead of waiting for all of them.
const SLOW_PIECE_BYTES = 1500;
const linkEvents: unknown[] = [];
let currentScenario = "";
const results: Record<string, unknown> = {};
const allChecks: Check[] = [];
let url = "";

const daemonProfileDir = join(runDir, "daemon-prof");

async function freshHome(): Promise<Home> {
  const home = new Home();
  // Only the login's environment, so the daemon it starts is profiled and later commands aren't.
  await home.login(url, args["cpu-prof"] ? { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${daemonProfileDir}` } : {});
  return home;
}

async function finishHomes(list: Home[]): Promise<void> {
  for (const home of list) await home.logout();
  for (const home of list) {
    // How often the daemon lost its server, which a green record check wouldn't show.
    const log = readFileSync(join(home.path, "daemon.log"), "utf8");
    const count = (event: string): number => log.split(`"event":"${event}"`).length - 1;
    linkEvents.push({ scenario: currentScenario, connected: count("server.connected"), longConnected: count("server_long.connected"), silent: count("server.silent") + count("server_long.silent"), socketErrors: count("server.socket_error") + count("server_long.socket_error"), unreachableDuring: count("server.unreachable_during"), backgroundFailed: count("background.failed") });
    results["link_events"] = linkEvents;
    if (onSlowLink) {
      const dropped = count("server.connected") - 1 + count("server_long.connected") - 1;
      allChecks.push({ name: `${currentScenario}: no connection dropped on the slow link`, ok: dropped === 0, detail: `${dropped} reconnects` });
    }
    rmSync(home.path, { recursive: true, force: true });
    homes.splice(homes.indexOf(home), 1);
  }
}

function during(turns: Turn[], from: number, to: number): Turn[] {
  return turns.filter((t) => t.at >= from && t.at < to);
}

function parseReads(run: Run, tag: string, into: number[]): number {
  const messages = (run.json["messages"] ?? []) as { text?: string }[];
  for (const m of messages) {
    const parsed = m.text ? parseTag(m.text) : undefined;
    if (parsed?.tag === tag) into.push(parsed.seq);
  }
  return messages.length;
}

async function baseline(label: string): Promise<void> {
  const home = await freshHome();
  const a = await makeAgent(home, "Ana");
  const b = await makeAgent(home, "Ben");
  const session = await startSession(a, b);
  const { turns, texts } = await converse({ a, b, session, turns: args.gentle ? 16 : 30, thinkMs: 200, tag: `base-${label}` });
  results[label] = { conversation: conversationSummary(turns) };
  if (label === "baseline_before") noBot = spread(turns.filter((t) => t.ok).map((t) => t.readMs));
  if (label === "slow_baseline") slowNoBot = spread(turns.filter((t) => t.ok).map((t) => t.readMs));
  allChecks.push(...await checkSession(label, a, b, session, [], texts));
  await finishHomes([home]);
}

// The rule: the other conversation must not visibly slow down. Measured against this same run's no-bot pair, because
// the machine's other work moved that figure from 245 to 299 ms between runs. Measured ratios: the fixed code's worst
// was 1.2 at the middle and 1.33 at p90. The old stall was 1.6 to 2.2 and 2.2 to 2.5, and it grew with the queue.
const MAX_SLOWDOWN_P50 = 1.4;
const MAX_SLOWDOWN_P90 = 1.7;
const MIN_TURNS = 5;
let noBot: Spread | undefined;
// On a shared slow link a long upload takes half the pipe, so a short message takes about twice as long, and that's all it should cost.
// Before the second connection, these turns took 6 times as long in the middle and 100 times at worst.
const SLOW_MAX_SLOWDOWN_P50 = 2.5;
const SLOW_MAX_SLOWDOWN_P90 = 3;
const SLOW_MAX_TURN_MS = 3000;
let slowNoBot: Spread | undefined;
let onSlowLink = false;

// A shared server's numbers measure the link, so these limits apply only to a server this run started.
async function needBaseline(): Promise<void> {
  if (!args.local) return;
  if (onSlowLink && !slowNoBot) await baseline("slow_baseline");
  if (!onSlowLink && !noBot) await baseline("baseline_before");
}

// mustHaveTurns is for a whole flood, where too few turns means the pair was stalled. A short window can't say.
function checkNotSlowed(name: string, turns: Turn[], mustHaveTurns: boolean): void {
  if (!args.local) return;
  const check = `${name}: the other conversation didn't slow down`;
  const reference = onSlowLink ? slowNoBot : noBot;
  if (!reference) {
    allChecks.push({ name: check, ok: false, detail: "this run has no no-bot baseline to compare with" });
    return;
  }
  const limitP50 = onSlowLink ? SLOW_MAX_SLOWDOWN_P50 : MAX_SLOWDOWN_P50;
  const limitP90 = onSlowLink ? SLOW_MAX_SLOWDOWN_P90 : MAX_SLOWDOWN_P90;
  const failed = turns.filter((t) => !t.ok).length;
  const seen = spread(turns.filter((t) => t.ok).map((t) => t.readMs));
  const measured = seen.n >= MIN_TURNS;
  const worstOk = !onSlowLink || seen.max <= SLOW_MAX_TURN_MS;
  const ok = failed === 0 && worstOk && (measured ? seen.p50 <= reference.p50 * limitP50 && seen.p90 <= reference.p90 * limitP90 : !mustHaveTurns);
  allChecks.push({ name: check, ok, detail: `middle ${seen.p50} ms, p90 ${seen.p90} ms, worst ${seen.max} ms, over ${seen.n} turns with ${failed} failed. No bot: ${reference.p50} and ${reference.p90}. Limits: ${limitP50} and ${limitP90} times${onSlowLink ? `, worst ${SLOW_MAX_TURN_MS} ms` : ""}.` });
}

interface BotPlan { via: "cli" | "socket"; label: string; reader: "keeps_up" | "stops"; separateDaemon: boolean; sizes: number[]; concurrency: number; seconds: number; limit?: number }

// The test that matters most: a bot floods while another pair talks, and the pair is timed.
async function withBot(plan: BotPlan): Promise<void> {
  await needBaseline();
  const home = await freshHome();
  const second = plan.separateDaemon ? await freshHome() : home;
  const a = await makeAgent(home, "Ana");
  const b = await makeAgent(home, "Ben");
  const bot = await makeAgent(second, "Bot");
  const reader = await makeAgent(second, "Rae");
  const talk = await startSession(a, b);
  const botSession = await startSession(bot, reader);
  const tag = `bot-${plan.label}`;
  const sampler = new Sampler();
  sampler.start(plan.separateDaemon ? { daemon: home, botDaemon: second } : { daemon: home });
  resetDatabaseTime();

  let conversing = true;
  const talking = converse({ a, b, session: talk, thinkMs: 200, tag: `talk-${plan.label}`, stop: () => !conversing || Boolean(guard.tripped) });
  const started = performance.now();
  let flooding = true;
  const reads: number[] = [];
  const receiveMs: number[] = [];
  const reading = (async () => {
    while (plan.reader === "keeps_up" && flooding) {
      await pause(2000);
      const read = await act(reader, ["receive", "--session-id", botSession]);
      receiveMs.push(read.ms);
      parseReads(read, tag, reads);
    }
  })();
  const queue: unknown[] = [];
  const watching = (async () => {
    while (plan.reader === "stops" && flooding) {
      await pause(5000);
      const inbox = await reader.home.run(["inbox", "--agent", reader.name], reader.caller);
      queue.push({ atSeconds: Math.round((performance.now() - started) / 1000), unread: ((inbox.json["waiting"] ?? []) as { unread: number }[])[0]?.unread ?? 0, inboxMs: Math.round(inbox.ms), databaseMb: Math.round(second.dbBytes() / 1e6), server: heldOnServer() });
    }
  })();
  const sent = await flood({ from: bot, sessions: [botSession], sizes: plan.sizes, concurrency: plan.concurrency, seconds: plan.seconds, tag, via: plan.via, ...(plan.limit === undefined ? {} : { limit: plan.limit }), ...(args.gentle ? { gapMs: 100 } : {}) });
  const floodEnded = performance.now();
  flooding = false;
  await Promise.all([reading, watching]);

  const top = expectedTop(sent);
  const settled = await waitForPosition(reader, botSession, top);
  const settleMs = performance.now() - floodEnded;

  // Now the reader catches up, with the pair still talking. One read of a long queue can hold everything else up.
  const drain: { messages: number; ms: number; error?: string }[] = [];
  const drainStarted = performance.now();
  for (let i = 0; i < 2000 && !guard.tripped; i++) {
    const read = await act(reader, ["receive", "--session-id", botSession]);
    if (read.status !== 0) {
      drain.push({ messages: 0, ms: Math.round(read.ms), error: (JSON.stringify(read.json) + read.stderr).slice(0, 300) });
      break;
    }
    const count = parseReads(read, tag, reads);
    drain.push({ messages: count, ms: Math.round(read.ms) });
    if (count === 0) break;
  }
  const drainEnded = performance.now();
  conversing = false;
  const { turns, texts } = await talking;
  const processes = await sampler.stop();
  const elapsed = (floodEnded - started) / 1000;
  results[plan.label] = {
    plan: { ...plan },
    bot: floodSummary(sent, elapsed),
    conversationWhileFlooding: conversationSummary(during(turns, started, floodEnded)),
    conversationWhileDraining: conversationSummary(during(turns, floodEnded, drainEnded)),
    receiverCaughtUp: { position: settled, top, settleMs: Math.round(settleMs) },
    drain: { reads: drain.length, messages: drain.reduce((sum, d) => sum + d.messages, 0), ms: Math.round(drainEnded - drainStarted), slowestReadMs: Math.max(0, ...drain.map((d) => d.ms)), firstRead: drain[0], error: drain.find((d) => d.error)?.error },
    receiveMs: spread(receiveMs),
    queue,
    processes,
    samples: sampler.samples.length,
    database: databaseTime(),
    guard: guard.tripped,
  };
  checkNotSlowed(`${plan.label} while flooding`, during(turns, started, floodEnded), true);
  checkNotSlowed(`${plan.label} while draining`, during(turns, floodEnded, drainEnded), false);
  writeFileSync(join(runDir, `samples-${plan.label}.json`), JSON.stringify({ samples: sampler.samples, sent, turns }));
  allChecks.push(...await checkSession(`${plan.label} bot`, bot, reader, botSession, sent, undefined, plan.reader === "keeps_up" || drain.every((d) => !d.error) ? reads : undefined));
  allChecks.push(...await checkSession(`${plan.label} pair`, a, b, talk, [], texts));
  await proveTextGone(plan.label, second, reader.name, [botSession]);
  await finishHomes(plan.separateDaemon ? [home, second] : [home]);
}

// Stops the daemon, so it runs last for that home. Its caller logs out again harmlessly.
async function proveTextGone(label: string, home: Home, agent: string, sessions: string[]): Promise<void> {
  const held = heldOnServer();
  if (held) allChecks.push({ name: `${label}: the server's database holds no encrypted text`, ok: held.rows === 0, detail: `${held.rows} rows, ${held.bytes} bytes` });
  await home.logout();
  const offered = await ciphertextStillOffered(home, url, agent, sessions);
  allChecks.push({ name: `${label}: the server offers the reader no encrypted text`, ok: offered === 0, detail: `${offered} rows` });
}

// Messages per second by size, for one session and for a batch. Nobody reads, so this is send and store, both sides.
async function throughput(): Promise<void> {
  const cells: Record<string, unknown> = {};
  const plan = args.gentle ? [] : [
    { size: SHORT, sessions: 1, daemons: 1, seconds: 15 }, { size: KB100, sessions: 1, daemons: 1, seconds: 15 }, { size: MB1, sessions: 1, daemons: 1, seconds: 15 },
    { size: SHORT, sessions: 8, daemons: 1, seconds: 15 }, { size: KB100, sessions: 8, daemons: 1, seconds: 15 }, { size: MB1, sessions: 8, daemons: 1, seconds: 15 },
    { size: SHORT, sessions: 1, daemons: 2, seconds: 15 }, { size: SHORT, sessions: 8, daemons: 2, seconds: 15 }, { size: MB1, sessions: 1, daemons: 2, seconds: 15 },
  ];
  for (const cell of plan) {
    if (guard.tripped) break;
    const key = `${cell.size}B x${cell.sessions} on ${cell.daemons} daemon(s)`;
    say(`throughput: ${key}`);
    const home = await freshHome();
    const other = cell.daemons === 2 ? await freshHome() : home;
    const bot = await makeAgent(home, "Bot");
    const readers: Agent[] = [];
    const sessions: string[] = [];
    for (let i = 0; i < cell.sessions; i++) {
      const reader = await makeAgent(other, `Rae${i}`);
      readers.push(reader);
      sessions.push(await startSession(bot, reader));
    }
    const sampler = new Sampler();
    sampler.start(cell.daemons === 2 ? { daemon: home, readerDaemon: other } : { daemon: home });
    resetDatabaseTime();
    const started = performance.now();
    const tag = `tp${cell.size}x${cell.sessions}d${cell.daemons}`;
    const sent = await flood({ from: bot, sessions, sizes: [cell.size], concurrency: cell.sessions === 1 ? 4 : 8, seconds: cell.seconds, tag });
    const elapsed = (performance.now() - started) / 1000;
    const endOfSends = performance.now();
    for (const [i, session] of sessions.entries()) {
      const top = Math.max(0, ...sent.filter((s) => s.session === session).flatMap((s) => (s.position === undefined ? [] : [s.position])));
      await waitForPosition(readers[i] as Agent, session, top);
    }
    cells[key] = { ...floodSummary(sent, elapsed), receiverLagAfterMs: Math.round(performance.now() - endOfSends), processes: await sampler.stop(), database: databaseTime() };
    for (const [i, session] of sessions.entries()) {
      allChecks.push(...await checkSession(key, bot, readers[i] as Agent, session, sent.filter((s) => s.session === session)));
    }
    await finishHomes(cell.daemons === 2 ? [home, other] : [home]);
    results["throughput"] = cells;
    await pause(GAP_MS / 2);
  }
}

// The reader's machine is off, so the queue is on the server, as encrypted text in its database.
async function readerOffline(seconds: number): Promise<void> {
  const home = await freshHome();
  const second = await freshHome();
  const a = await makeAgent(home, "Ana");
  const b = await makeAgent(home, "Ben");
  const bot = await makeAgent(home, "Bot");
  const reader = await makeAgent(second, "Rae");
  const talk = await startSession(a, b);
  const botSession = await startSession(bot, reader);
  await second.logout();
  const sampler = new Sampler();
  sampler.start({ daemon: home });
  let conversing = true;
  await needBaseline();
  const talking = converse({ a, b, session: talk, thinkMs: 200, tag: "talk-offline", stop: () => !conversing || Boolean(guard.tripped) });
  const started = performance.now();
  const sent = await flood({ from: bot, sessions: [botSession], sizes: MIXED, concurrency: 4, seconds, tag: "bot-offline" });
  const floodEnded = performance.now();
  const held = heldOnServer();
  const top = Math.max(0, ...sent.flatMap((s) => (s.position === undefined ? [] : [s.position])));
  await second.login(url);
  sampler.start({ readerDaemon: second });
  const position = await waitForPosition(reader, botSession, top);
  const drainMs = performance.now() - floodEnded;
  conversing = false;
  const { turns, texts } = await talking;
  results["reader_offline"] = {
    bot: floodSummary(sent, (floodEnded - started) / 1000),
    heldOnServerAtEndOfFlood: held,
    drain: { messages: position, ms: Math.round(drainMs), perSecond: Number((position / (drainMs / 1000)).toFixed(2)), megabytes: Math.round(sent.reduce((sum, s) => sum + s.size, 0) / 1e6) },
    conversationWhileFlooding: conversationSummary(during(turns, started, floodEnded)),
    conversationWhileDraining: conversationSummary(during(turns, floodEnded, performance.now())),
    processes: await sampler.stop(),
  };
  checkNotSlowed("reader_offline while flooding", during(turns, started, floodEnded), true);
  checkNotSlowed("reader_offline while draining", during(turns, floodEnded, performance.now()), false);
  allChecks.push(...await checkSession("reader_offline bot", bot, reader, botSession, sent));
  allChecks.push(...await checkSession("reader_offline pair", a, b, talk, [], texts));
  await proveTextGone("reader_offline", second, reader.name, [botSession]);
  await finishHomes([home, second]);
}

// One direction of a slow link. Every connection shares it, as they share a home uplink. A limit per connection would
// hand a second connection a link of its own and prove nothing. It serves them in turn, a packet at a time, which is
// the kindest a real link gets: one with a long queue of its own would hold a short message up for longer.
function sharedPipe(bytesPerSecond: number): (data: Buffer, to: Socket, done: () => void) => void {
  const turns: { data: Buffer; to: Socket; done: () => void }[] = [];
  let running = false;
  const next = (): void => {
    const turn = turns.shift();
    if (!turn) {
      running = false;
      return;
    }
    running = true;
    const piece = turn.data.subarray(0, SLOW_PIECE_BYTES);
    if (!turn.to.destroyed) turn.to.write(piece);
    if (piece.length < turn.data.length) turns.push({ ...turn, data: turn.data.subarray(piece.length) });
    else turn.done();
    setTimeout(next, (1000 * piece.length) / bytesPerSecond);
  };
  return (data, to, done) => {
    turns.push({ data, to, done });
    if (!running) next();
  };
}

// A far-away link, made here so that it can carry 1 MB messages without touching a shared server.
async function throughSlowLink<T>(work: () => Promise<T>): Promise<T> {
  const target = new URL(url);
  const up = sharedPipe(SLOW_UP_BYTES_PER_SECOND);
  const down = sharedPipe(SLOW_DOWN_BYTES_PER_SECOND);
  const throttle = (from: Socket, to: Socket, pipe: ReturnType<typeof sharedPipe>): void => {
    from.on("data", (chunk: Buffer) => {
      from.pause();
      pipe(chunk, to, () => from.resume());
    });
    from.on("close", () => setTimeout(() => to.destroy(), 2000));
    from.on("error", () => to.destroy());
  };
  const proxy = createServer((client) => {
    const upstream = createConnection({ host: target.hostname, port: Number(target.port) });
    throttle(client, upstream, up);
    throttle(upstream, client, down);
  });
  await new Promise<void>((resolve) => proxy.listen(LOCAL_PORT + 1, "127.0.0.1", resolve));
  const previous = url;
  url = `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}${target.pathname}`;
  onSlowLink = true;
  try {
    return await work();
  } finally {
    url = previous;
    onSlowLink = false;
    proxy.close();
  }
}

// Several long messages queued on one daemon's one socket, with a pair sharing that socket.
async function slowLinkBatch(): Promise<void> {
  await needBaseline();
  const home = await freshHome();
  const a = await makeAgent(home, "Ana");
  const b = await makeAgent(home, "Ben");
  const bot = await makeAgent(home, "Bot");
  const talk = await startSession(a, b);
  const readers: Agent[] = [];
  const sessions: string[] = [];
  for (let i = 0; i < 4; i++) {
    const reader = await makeAgent(home, `Rae${i}`);
    readers.push(reader);
    sessions.push(await startSession(bot, reader));
  }
  let conversing = true;
  const talking = converse({ a, b, session: talk, thinkMs: 200, tag: "talk-slow-batch", stop: () => !conversing || Boolean(guard.tripped) });
  const started = performance.now();
  const sent = await flood({ from: bot, sessions, sizes: [MB1], concurrency: 4, seconds: 30, tag: "slow-batch" });
  const floodEnded = performance.now();
  conversing = false;
  const { turns, texts } = await talking;
  results["slow_link_batch"] = { bot: floodSummary(sent, (floodEnded - started) / 1000), conversationWhileFlooding: conversationSummary(turns) };
  checkNotSlowed("slow_link_batch while flooding", turns, true);
  for (const [i, session] of sessions.entries()) allChecks.push(...await checkSession(`slow_link_batch ${i}`, bot, readers[i] as Agent, session, sent.filter((s) => s.session === session)));
  allChecks.push(...await checkSession("slow_link_batch pair", a, b, talk, [], texts));
  await finishHomes([home]);
}

// The reader falls so far behind that its queue is larger than one reply can hold, in bursts with gaps to spare the machine.
async function deepQueue(): Promise<void> {
  await needBaseline();
  const home = await freshHome();
  const a = await makeAgent(home, "Ana");
  const b = await makeAgent(home, "Ben");
  const bot = await makeAgent(home, "Bot");
  const reader = await makeAgent(home, "Rae");
  const talk = await startSession(a, b);
  const botSession = await startSession(bot, reader);
  const sampler = new Sampler();
  sampler.start({ daemon: home });
  const sent: Sent[] = [];
  const target = Number(args["deep-target"]);
  const bursts: unknown[] = [];
  const burstTurns: Turn[] = [];
  let conversing = true;
  const talking = converse({ a, b, session: talk, thinkMs: 200, tag: "talk-deep", stop: () => !conversing || Boolean(guard.tripped) });
  for (let burst = 0; burst < 8 && sent.length < target && !guard.tripped; burst++) {
    say(`deep queue: burst ${burst + 1}, ${sent.length} of ${target} messages so far`);
    const burstStarted = performance.now();
    const more = await flood({ from: bot, sessions: [botSession], sizes: [MB1], concurrency: 3, seconds: 30, limit: target - sent.length, tag: `deep${burst}` });
    sent.push(...more);
    const inBurst = during(talkingTurns(), burstStarted, performance.now());
    burstTurns.push(...inBurst);
    checkNotSlowed(`deep_queue burst ${burst + 1}, ${sent.length} MB queued`, inBurst, false);
    bursts.push({ burst, sent: more.length, perSecond: Number((more.length / ((performance.now() - burstStarted) / 1000)).toFixed(2)), queueMbAfter: sent.length, conversation: conversationSummary(inBurst) });
    results["deep_queue"] = { bursts };
    saveResults();
    await pause(10_000);
  }
  const top = Math.max(0, ...sent.flatMap((s) => (s.position === undefined ? [] : [s.position])));
  await waitForPosition(reader, botSession, top);
  const inbox = await reader.home.run(["inbox", "--agent", reader.name], reader.caller);
  const queued = { unread: ((inbox.json["waiting"] ?? []) as { unread: number }[])[0]?.unread ?? 0, inboxMs: Math.round(inbox.ms), databaseMb: Math.round(home.dbBytes() / 1e6) };

  const drainStarted = performance.now();
  const reads: { messages: number; ms: number; error?: string }[] = [];
  let total = 0;
  for (let i = 0; i < 2000; i++) {
    const read = await act(reader, ["receive", "--session-id", botSession]);
    if (read.status !== 0) {
      reads.push({ messages: 0, ms: Math.round(read.ms), error: (JSON.stringify(read.json) + read.stderr).slice(0, 300) });
      break;
    }
    const count = ((read.json["messages"] ?? []) as unknown[]).length;
    total += count;
    reads.push({ messages: count, ms: Math.round(read.ms) });
    if (count === 0) break;
  }
  const drainMs = performance.now() - drainStarted;
  conversing = false;
  const { turns, texts } = await talking;
  const processes = await sampler.stop();
  results["deep_queue"] = {
    bursts,
    sent: floodSummary(sent, 1),
    queued,
    drain: { messagesRead: total, ms: Math.round(drainMs), reads: reads.length, slowestReadMs: Math.max(0, ...reads.map((r) => r.ms)), error: reads.find((r) => r.error)?.error },
    conversationWhileDraining: conversationSummary(turns.filter((t) => t.at >= drainStarted && t.at < drainStarted + drainMs)),
    processes,
  };
  checkNotSlowed("deep_queue across all bursts", burstTurns, true);
  checkNotSlowed("deep_queue while draining", turns.filter((t) => t.at >= drainStarted && t.at < drainStarted + drainMs), false);
  const closed = reads.every((r) => !r.error);
  allChecks.push({ name: "deep_queue: the reader could read its whole queue", ok: closed && total === sent.filter((s) => s.position !== undefined).length, detail: `read ${total} of ${sent.length}: ${reads.find((r) => r.error)?.error ?? ""}` });
  if (closed) allChecks.push(...await checkSession("deep_queue bot", bot, reader, botSession, sent));
  allChecks.push(...await checkSession("deep_queue pair", a, b, talk, [], texts));
  await finishHomes([home]);
}

// Where the time in one message goes, on an idle system: the real primitives timed alone, then whole sends.
async function anatomy(): Promise<void> {
  const home = await freshHome();
  const bot = await makeAgent(home, "Bot");
  const reader = await makeAgent(home, "Rae");
  const session = await startSession(bot, reader);
  const processOnly: number[] = [];
  for (let i = 0; i < 10; i++) processOnly.push((await home.run(["agents"], undefined)).ms);
  const sends: Record<string, Spread> = {};
  const database: Record<string, unknown> = {};
  let seq = 0;
  for (const [size, count] of [[SHORT, 12], [KB100, 8], [MB1, args.gentle ? 3 : 5]] as const) {
    resetDatabaseTime();
    const times: number[] = [];
    for (let i = 0; i < count; i++) {
      times.push((await act(bot, ["send", session, "-", "--notice", "--over"], makeText("anat", seq++, size))).ms);
      await pause(150);
    }
    sends[String(size)] = spread(times);
    database[String(size)] = databaseTime();
  }
  await finishHomes([home]);

  // Each primitive alone. These run in this process, on purpose and only here: they say what a step costs, not how it behaves under load.
  const seeds = generateIdentitySeeds();
  const signer = await signerFromSeeds(seeds);
  const small = new Uint8Array(randomBytes(400));
  const timed = async (work: () => unknown, times = 20): Promise<number> => {
    const started = performance.now();
    for (let i = 0; i < times; i++) await work();
    return Number(((performance.now() - started) / times).toFixed(3));
  };
  const signature = await signer.sign("cello-entry", small);
  const primitives: Record<string, number> = {
    signTwiceMs: await timed(() => signer.sign("cello-entry", small)),
    verifyTwiceMs: await timed(() => verifySignature(signer.publicIdentity, "cello-entry", small, signature)),
  };
  const key = new Uint8Array(randomBytes(32));
  const salt = new Uint8Array(randomBytes(32));
  for (const size of [SHORT, KB100, MB1]) {
    const body = new Uint8Array(randomBytes(size));
    const sealed = sealSessionContent(key, body);
    primitives[`encrypt${size}Ms`] = await timed(() => sealSessionContent(key, body), 5);
    primitives[`hashBoth${size}Ms`] = await timed(() => { ciphertextHash(sealed); saltedContentHash(salt, body); }, 5);
    primitives[`jsonAndBase64${size}Ms`] = await timed(() => JSON.parse(JSON.stringify({ ciphertext: toB64(sealed) })), 5);
  }
  const dir = mkdtempSync(join(tmpdir(), "cello-v2-speed-store-"));
  const store = new Store(join(dir, "cello.db"));
  const agentId = signer.id;
  const sessionId = new Uint8Array(randomBytes(16));
  store.insertAgent(agentId, "x", seeds.ed, seeds.pq);
  store.insertSession({ agent_id: agentId, session_id: sessionId, role: "caller", counterparty_id: agentId, counterparty_name: "x", counterparty_keys: "{}", state: "active", offer: "{}" });
  for (const size of [SHORT, KB100, MB1]) {
    const body = new Uint8Array(randomBytes(size));
    primitives[`storeOneRow${size}Ms`] = await timed(() => store.insertEntry({ agent_id: agentId, session_id: sessionId, entry_hash: new Uint8Array(randomBytes(32)), state: "received", own: 0, entry: "{}", body }), 10);
  }
  store.close();
  rmSync(dir, { recursive: true, force: true });
  results["anatomy"] = { commandAloneMs: spread(processOnly), wholeSendMs: sends, primitives, database };
}

// ---- Report ----

function saveResults(): void {
  writeFileSync(join(runDir, "results.json"), JSON.stringify({ meta, results, checks: allChecks }, null, 2));
  appendFileSync(join(runDir, "checks.log"), "");
}

function headCommit(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// The hottest functions in a CPU profile, by time on the processor.
function summariseProfiles(dir: string): unknown[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".cpuprofile")).map((name) => {
    const profile = JSON.parse(readFileSync(join(dir, name), "utf8")) as { nodes: { id: number; callFrame: { functionName: string; url: string } }[]; samples: number[]; timeDeltas: number[] };
    const byId = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
    const self = new Map<string, number>();
    let totalUs = 0;
    profile.samples.forEach((id, i) => {
      const frame = byId.get(id);
      const delta = profile.timeDeltas[i] ?? 0;
      totalUs += delta;
      const key = `${frame?.functionName || "(anonymous)"} ${(frame?.url ?? "").split("/").slice(-2).join("/")}`;
      self.set(key, (self.get(key) ?? 0) + delta);
    });
    return { name, seconds: Math.round(totalUs / 1e6), top: [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([fn, us]) => ({ fn, percent: Number(((100 * us) / totalUs).toFixed(1)) })) };
  }).filter((profile) => profile.seconds >= 5); // The rest are the health check's short-lived processes.
}

const meta = {
  started: new Date().toISOString(),
  client: headCommit(REPO),
  server: args.local ? headCommit(serverDir) : "remote",
  target: args.server ?? "local",
  machine: `${cpus().length} cores`,
  loadAtStart: loadavg(),
  note: "Plumbing only. v2 has no screener yet, so this can't show the 3 November failure is solved.",
};

const SCENARIOS: Record<string, () => Promise<void>> = args.gentle
  ? {
      anatomy,
      baseline_before: () => baseline("baseline_before"),
      bot_gentle: () => withBot({ via: "cli", label: "bot_gentle", reader: "keeps_up", separateDaemon: false, sizes: [SHORT, SHORT, SHORT, SHORT, KB100], concurrency: 2, seconds: Math.min(SECONDS, 30), limit: 150 }),
      bot_gentle_long: () => withBot({ via: "cli", label: "bot_gentle_long", reader: "stops", separateDaemon: false, sizes: [MB1], concurrency: 1, seconds: 30, limit: 5 }),
      baseline_after: () => baseline("baseline_after"),
    }
  : {
      anatomy,
      baseline_before: () => baseline("baseline_before"),
      bot_cli_reader_keeps_up: () => withBot({ via: "cli", label: "bot_cli_reader_keeps_up", reader: "keeps_up", separateDaemon: false, sizes: MIXED, concurrency: 4, seconds: SECONDS }),
      bot_socket_reader_keeps_up: () => withBot({ via: "socket", label: "bot_socket_reader_keeps_up", reader: "keeps_up", separateDaemon: false, sizes: MIXED, concurrency: 4, seconds: SECONDS }),
      bot_socket_reader_stops: () => withBot({ via: "socket", label: "bot_socket_reader_stops", reader: "stops", separateDaemon: false, sizes: MIXED, concurrency: 4, seconds: SECONDS }),
      baseline_after: () => baseline("baseline_after"),
      bot_socket_other_daemon: () => withBot({ via: "socket", label: "bot_socket_other_daemon", reader: "keeps_up", separateDaemon: true, sizes: MIXED, concurrency: 4, seconds: SECONDS }),
      throughput,
      reader_offline: () => readerOffline(SECONDS),
      deep_queue: deepQueue,
      slow_baseline: () => throughSlowLink(() => baseline("slow_baseline")),
      slow_bot_short: () => throughSlowLink(() => withBot({ via: "socket", label: "slow_bot_short", reader: "keeps_up", separateDaemon: false, sizes: [SHORT], concurrency: 4, seconds: SECONDS })),
      slow_bot_mixed: () => throughSlowLink(() => withBot({ via: "socket", label: "slow_bot_mixed", reader: "keeps_up", separateDaemon: false, sizes: MIXED, concurrency: 4, seconds: SECONDS })),
      slow_bot_other_daemon: () => throughSlowLink(() => withBot({ via: "socket", label: "slow_bot_other_daemon", reader: "keeps_up", separateDaemon: true, sizes: MIXED, concurrency: 4, seconds: SECONDS })),
      slow_link_batch: () => throughSlowLink(slowLinkBatch),
    };

async function cleanUp(): Promise<void> {
  for (const home of homes) {
    try {
      await home.logout();
    } catch {
      if (home.alive() && home.pid !== undefined) process.kill(home.pid, "SIGKILL");
    }
  }
  stopLocalServer();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    say(`${signal}: stopping what this run started`);
    void cleanUp().finally(() => process.exit(130));
  });
}

let failed = false;
try {
  url = args.local ? startLocalServer() : (args.server as string);
  const wanted = args.scenarios?.split(",") ?? Object.keys(SCENARIOS);
  for (const name of wanted) {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(`no scenario ${name}`);
    if (guard.tripped) break;
    say(`scenario: ${name}`);
    currentScenario = name;
    const started = performance.now();
    try {
      await scenario();
    } catch (err: unknown) {
      failed = true;
      allChecks.push({ name: `${name}: ran to the end`, ok: false, detail: err instanceof Error ? err.stack ?? err.message : String(err) });
    }
    say(`  took ${Math.round((performance.now() - started) / 1000)} s, 1-minute load ${(loadavg()[0] ?? 0).toFixed(1)}`);
    saveResults();
    await pause(GAP_MS);
  }
} finally {
  await cleanUp();
  clearInterval(guardTimer);
}
if (args["cpu-prof"]) {
  results["serverProfile"] = summariseProfiles(serverProfileDir);
  results["daemonProfile"] = summariseProfiles(daemonProfileDir);
}
results["guard"] = guard.tripped;
saveResults();
const bad = allChecks.filter((c) => !c.ok);
for (const check of bad) say(`FAILED ${check.name}: ${check.detail}`);
say(`${allChecks.length - bad.length} of ${allChecks.length} checks passed. Numbers: ${runDir}`);
if (failed || bad.length > 0) process.exitCode = 1;

// Is a message crossing a server fast enough when the agents are far apart? No model turns: the real CLI on this
// machine and on a far VM, through a real server, in temporary homes.
//   node live/two-machines.ts --server wss://host/v1 --instance cello-v2-far --zone europe-west1-c
// Each machine stamps its own clock and runs its side of a conversation by itself, so the slow SSH link that
// carries orders is never inside a measurement. --worker is the half that runs on each machine.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdirSync, mkdtempSync, appendFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { cpus, homedir, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { socketPath } from "../src/daemon/paths.ts";
import { DaemonGone, DaemonRefused, IpcClient } from "../src/ipc/client.ts";
import { sealSessionContent } from "../src/protocol/aead.ts";
import { generateIdentitySeeds, signerFromSeeds, verifySignature } from "../src/protocol/identity.ts";
import { generateSaltContribution, saltedContentHash } from "../src/protocol/salt.ts";
import { ciphertextHash } from "../src/protocol/structures.ts";

type Json = Record<string, unknown>;
interface Run { start: number; end: number; status: number | null; json: Json; stderr: string }
interface Step { do: "send" | "expect"; id: string; bytes: number }

const NTP_HOST = "time.cloudflare.com";
const EXPECT_TIMEOUT_MS = 180_000;
const SIZES = [{ label: "short", bytes: 60 }, { label: "100 KB", bytes: 100_000 }, { label: "1 MB", bytes: 1_000_000 }];
const WIRE_PREFIX = "TM ";
const HOME_PREFIX = "c2m-";
const HEARTBEAT_MS = 15_000;
// An outage can leave SSH open with nobody on the far end, so stdin never closes. Silence is what shows the controller has gone.
const CONTROLLER_SILENCE_MS = Number(process.env["TWO_MACHINES_SILENCE_MS"] ?? 180_000);

const now = (): number => performance.timeOrigin + performance.now();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

function median(values: number[]): number {
  return percentile(values, 50);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
}

// A line carries its id and a hash of itself, so the far side can prove it arrived whole.
function makeLine(id: string, bytes: number): string {
  const filler = randomBytes(Math.ceil(bytes / 2)).toString("hex").slice(0, bytes);
  return `${id}|${sha(filler)}|${filler}`;
}

// A pid of 0 or less would signal a whole process group, and only a bad status could produce one.
function signalDaemon(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`refusing to signal process ${pid}: it isn't a daemon this run started`);
  process.kill(pid, signal);
}

function checkLine(text: string): { id: string; whole: boolean } {
  const [id = "", hash, ...rest] = text.split("|");
  return { id, whole: sha(rest.join("|")) === hash };
}

// ---- The half that runs on each machine ----

async function worker(caller: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), HOME_PREFIX));
  const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
  let server = "";
  let daemonPid = 0;
  const reads = new Map<string, number>();

  const say = (frame: Json): void => { process.stdout.write(`${WIRE_PREFIX}${JSON.stringify(frame)}\n`); };

  function cello(args: string[], input?: string, onStart?: (child: ChildProcess) => void): Promise<Run> {
    return new Promise((resolve, reject) => {
      const start = now();
      const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, CELLO_V2_HOME: home, CELLO_CALLER: caller }, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
      child.on("error", reject);
      onStart?.(child);
      child.on("close", (status) => {
        const end = now();
        const stdout = Buffer.concat(out).toString();
        const stderr = Buffer.concat(err).toString();
        let json: Json = {};
        try {
          json = JSON.parse(stdout || stderr) as Json;
        } catch {
          // login answers in words.
        }
        resolve({ start, end, status, json, stderr: stderr.slice(0, 400) });
      });
    });
  }

  async function must(args: string[], input?: string): Promise<Run> {
    const run = await cello(args, input);
    if (run.status !== 0) throw new Error(`cello-v2 ${args[0]} failed: ${run.stderr}`);
    return run;
  }

  async function login(): Promise<void> {
    await must(["login", "--server", server]);
    const status = (await must(["status"])).json as { pid: number; home: string };
    // The only process this script ever kills, and only once it has said it lives in this temporary home.
    if (status.home !== home) throw new Error(`the daemon answering is for ${status.home}, not ${home}`);
    if (!Number.isInteger(status.pid) || status.pid <= 0) throw new Error(`the daemon reported process ${status.pid}, which can't be a daemon`);
    daemonPid = status.pid;
  }

  async function allOnline(timeoutMs: number): Promise<number> {
    const start = now();
    while (now() - start < timeoutMs) {
      const run = await cello(["status"]);
      const agents = (run.json as { agents?: { online: boolean }[] }).agents;
      if (agents?.every((agent) => agent.online)) return now();
      await sleep(250);
    }
    throw new Error(`agents still offline after ${timeoutMs} ms`);
  }

  // Reads until the line arrives. A daemon that's gone is expected during a kill, so it's retried until the deadline.
  async function expect(agent: string, id: string, timeoutMs = EXPECT_TIMEOUT_MS): Promise<Json> {
    const deadline = now() + timeoutMs;
    const others: string[] = [];
    while (now() < deadline) {
      const seconds = Math.max(1, Math.ceil((deadline - now()) / 1000));
      const waited = await cello(["wait", "--agent", agent, "--timeout-seconds", String(seconds)]);
      if (waited.status === 3) continue;
      if (waited.status !== 0) {
        await sleep(200);
        continue;
      }
      const read = await cello(["receive", "--agent", agent]);
      if (read.status !== 0) {
        await sleep(200);
        continue;
      }
      const messages = (read.json as { messages?: { text?: string }[] }).messages ?? [];
      let found = false;
      let whole = false;
      for (const message of messages) {
        if (message.text === undefined || message.text === null) continue;
        const line = checkLine(message.text);
        reads.set(line.id, (reads.get(line.id) ?? 0) + 1);
        if (line.id === id) {
          found = true;
          whole = line.whole;
        } else others.push(line.id);
      }
      if (found) return { id, whole, wait_start: waited.start, wait_end: waited.end, wait_event: waited.json["event"], receive_start: read.start, receive_end: read.end, others };
    }
    throw new Error(`line ${id} didn't arrive within ${timeoutMs} ms`);
  }

  async function sendLine(agent: string, session: string, id: string, bytes: number, killAfterMs?: number): Promise<Json> {
    const text = makeLine(id, bytes);
    const victim = daemonPid;
    // Refused here rather than in the timer, where a throw would end this worker with no reply.
    if (killAfterMs !== undefined && !(victim > 0)) throw new Error(`refusing to signal process ${victim}: it isn't a daemon this run started`);
    let fired = false;
    let timer: NodeJS.Timeout | undefined;
    const run = await cello(["send", session, "-", "--over", "--agent", agent], text, () => {
      if (killAfterMs !== undefined) timer = setTimeout(() => { fired = true; signalDaemon(victim, "SIGKILL"); }, killAfterMs);
    });
    clearTimeout(timer);
    // The send beat the timer. The kill still happens, now, or it would land on the next daemon.
    const killedAfterSend = killAfterMs !== undefined && !fired;
    if (killedAfterSend) signalDaemon(victim, "SIGKILL");
    return { id, bytes, send_start: run.start, send_end: run.end, status: run.status, result: run.json, stderr: run.stderr, killed_after_send: killedAfterSend };
  }

  async function conversation(agent: string, session: string, plan: Step[]): Promise<Json[]> {
    const samples: Json[] = [];
    for (const step of plan) {
      if (step.do === "send") {
        const sent = await sendLine(agent, session, step.id, step.bytes);
        if (sent["status"] !== 0) throw new Error(`send of ${step.id} failed: ${String(sent["stderr"])}`);
        samples.push({ kind: "send", ...sent });
      } else {
        samples.push({ kind: "expect", ...(await expect(agent, step.id)) });
      }
    }
    return samples;
  }

  function sntpOnce(): Promise<{ offset: number; rtt: number }> {
    return new Promise((resolve, reject) => {
      const socket = createSocket("udp4");
      const packet = Buffer.alloc(48);
      packet[0] = 0x23;
      const timer = setTimeout(() => { socket.close(); reject(new Error("no answer")); }, 3000);
      const ntpMs = (data: Buffer, at: number): number => (data.readUInt32BE(at) - 2208988800) * 1000 + (data.readUInt32BE(at + 4) / 2 ** 32) * 1000;
      let sentAt = 0;
      socket.once("message", (data) => {
        const received = now();
        clearTimeout(timer);
        socket.close();
        const t2 = ntpMs(data, 32);
        const t3 = ntpMs(data, 40);
        resolve({ offset: ((t2 - sentAt) + (t3 - received)) / 2, rtt: (received - sentAt) - (t3 - t2) });
      });
      sentAt = now();
      socket.send(packet, 123, NTP_HOST);
    });
  }

  // The answer with the shortest round trip has the least room for error. Failing to get one is reported, never guessed.
  async function clock(): Promise<Json> {
    const answers: { offset: number; rtt: number }[] = [];
    for (let i = 0; i < 8; i++) {
      try {
        answers.push(await sntpOnce());
      } catch {
        // Counted below.
      }
      await sleep(100);
    }
    const best = answers.sort((a, b) => a.rtt - b.rtt)[0];
    // Load beside each reading, so that anything else busy on this machine during a phase is on the record.
    const load = { load_1min: loadavg()[0], cores: cpus().length };
    return best ? { host: NTP_HOST, answers: answers.length, offset: best.offset, rtt: best.rtt, ...load } : { host: NTP_HOST, answers: 0, failed: true, ...load };
  }

  function tcpConnect(host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const start = now();
      const socket = connect(443, host);
      socket.once("connect", () => { socket.destroy(); resolve(now() - start); });
      socket.once("error", reject);
    });
  }

  async function bench(): Promise<Json> {
    const url = new URL(server);
    const startup: number[] = [];
    for (let i = 0; i < 8; i++) {
      const run = await must(["--help"]);
      startup.push(run.end - run.start);
    }
    const statusCall: number[] = [];
    for (let i = 0; i < 8; i++) {
      const run = await must(["status"]);
      statusCall.push(run.end - run.start);
    }
    const signer = await signerFromSeeds(generateIdentitySeeds());
    const sample = new Uint8Array(randomBytes(300));
    const sign: number[] = [];
    const verify: number[] = [];
    for (let i = 0; i < 20; i++) {
      let start = now();
      const signature = await signer.sign("cello-entry", sample);
      sign.push(now() - start);
      start = now();
      if (!(await verifySignature(signer.publicIdentity, "cello-entry", sample, signature))) throw new Error("a signature didn't verify");
      verify.push(now() - start);
    }
    const seal: Record<string, number> = {};
    const key = new Uint8Array(randomBytes(32));
    const salt = generateSaltContribution();
    for (const size of SIZES) {
      const body = new Uint8Array(randomBytes(size.bytes));
      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const start = now();
        const sealed = sealSessionContent(key, body);
        ciphertextHash(sealed);
        saltedContentHash(salt, body);
        times.push(now() - start);
      }
      seal[size.label] = median(times);
    }
    const tcp: number[] = [];
    for (let i = 0; i < 10; i++) tcp.push(await tcpConnect(url.hostname));
    const health: number[] = [];
    const healthUrl = `https://${url.host}/healthz`;
    for (let i = 0; i < 16; i++) {
      const start = now();
      await (await fetch(healthUrl)).text();
      if (i > 0) health.push(now() - start);
    }
    return { process_start_ms: median(startup), status_call_ms: median(statusCall), sign_ms: median(sign), verify_ms: median(verify), seal_and_hash_ms: seal, tcp_connect_ms: median(tcp), tcp_connect_min_ms: Math.min(...tcp), healthz_ms: median(health), healthz_min_ms: Math.min(...health) };
  }

  async function record(agent: string, session: string): Promise<Json> {
    const transcript = (await must(["transcript", session, "--agent", agent])).json as { state: string; entries: { position: number; own: boolean; text?: string; closed_their_side?: boolean }[] };
    const check = (await cello(["verify-session", session, "--agent", agent])).json;
    const entries = transcript.entries.map((entry) => ({ position: entry.position, own: entry.own, closing: entry.closed_their_side === true, id: entry.text ? checkLine(entry.text).id : null, hash: sha(entry.text ?? "") }));
    return { state: transcript.state, entries, ok: check["ok"], root: check["root"], position: check["position"], fault: check["fault"] };
  }

  async function handle(command: Json): Promise<unknown> {
    const agent = command["agent"] as string;
    const session = command["session"] as string;
    switch (command["cmd"]) {
      case "login":
        server = command["server"] as string;
        await login();
        return { pid: daemonPid, home };
      case "create": {
        const created = (await must(["create-agent", command["name"] as string])).json;
        await must(["settings-set", "away.answering", "false", "--agent", command["name"] as string]);
        await allOnline(60_000);
        return created;
      }
      case "clock":
        return clock();
      case "bench":
        return bench();
      case "initiate": {
        const run = await must(["initiate-session", command["target"] as string, "--agent", agent]);
        return { start: run.start, end: run.end, ...run.json };
      }
      // Waits for a caller to arrive. Leftovers from earlier sessions are read so that they don't end the wait early.
      case "awaitSession": {
        for (;;) {
          const waited = await must(["wait", "--agent", agent, "--timeout-seconds", "60"]);
          if (waited.json["event"] === "session_started") return { end: waited.end, session_id: waited.json["session_id"] };
          if (waited.json["event"] === "timeout") throw new Error("no session arrived in 60 seconds");
          await must(["receive", "--agent", agent]);
        }
      }
      case "conversation":
        return conversation(agent, session, command["plan"] as Step[]);
      case "close":
        return (await must(["close-session", session, "--agent", agent])).json;
      case "settleClosed": {
        for (let i = 0; i < 120; i++) {
          const listed = (await must(["sessions", "--all", "--agent", agent])).json as { sessions: { session_id: string; state: string }[] };
          if (listed.sessions.find((s) => s.session_id === session)?.state === "closed") {
            await must(["receive", "--agent", agent]);
            return { closed: true };
          }
          await sleep(500);
        }
        throw new Error(`session ${session} didn't close`);
      }
      case "sendLine":
        return sendLine(agent, session, command["id"] as string, command["bytes"] as number, command["killAfterMs"] as number | undefined);
      case "expect":
        return expect(agent, command["id"] as string, command["timeoutMs"] as number | undefined);
      // Kills the daemon, starts another, and says how long until every agent was back online.
      case "killDaemon": {
        await sleep(command["afterMs"] as number);
        const killedAt = now();
        signalDaemon(daemonPid, "SIGKILL");
        await sleep(command["downMs"] as number);
        await login();
        return { killedAt, online: (await allOnline(120_000)) - killedAt };
      }
      case "relogin": {
        const start = now();
        await login();
        return { online: (await allOnline(120_000)) - start };
      }
      // Whether a send cut off by a kill landed. It looks without reading, so it can't disturb the conversation.
      case "fate": {
        const deadline = now() + (command["timeoutMs"] as number);
        while (now() < deadline) {
          const held = await record(agent, session);
          if ((held["entries"] as { id: string | null }[]).some((entry) => entry.id === command["id"])) return { landed: true };
          await sleep(1000);
        }
        return { landed: false };
      }
      case "record":
        return { ...(await record(agent, session)), reads: Object.fromEntries(reads) };
      default:
        throw new Error(`no such order: ${String(command["cmd"])}`);
    }
  }

  async function stopDaemon(): Promise<void> {
    if (daemonPid === 0) return;
    try {
      signalDaemon(daemonPid, "SIGTERM");
    } catch {
      // Already gone.
    }
    await sleep(500);
  }

  let heardController = now();
  setInterval(() => {
    if (now() - heardController > CONTROLLER_SILENCE_MS) void stopDaemon().then(() => process.exit(1));
  }, 5000);

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (raw) => {
    heardController = now();
    const command = JSON.parse(raw) as Json;
    if (command["cmd"] === "heartbeat") return;
    if (command["cmd"] === "finish") {
      void (async () => {
        await stopDaemon();
        let log = "";
        try {
          log = readFileSync(join(home, "daemon.log"), "utf8");
        } catch {
          // No daemon ever started.
        }
        if (command["keepHome"] !== true) rmSync(home, { recursive: true, force: true });
        say({ order: command["order"], ok: true, result: { log, home } });
        setTimeout(() => process.exit(0), 200);
      })();
      return;
    }
    const trace = (what: string): void => { process.stderr.write(`${new Date().toISOString()} ${String(command["order"])} ${String(command["cmd"])} ${what}\n`); };
    trace("start");
    handle(command).then(
      (result) => { trace("done"); say({ order: command["order"], ok: true, result }); },
      (err: unknown) => { trace(`failed: ${err instanceof Error ? err.message : String(err)}`); say({ order: command["order"], ok: false, error: err instanceof Error ? err.message : String(err) }); },
    );
  });
  // The orders stopped, so this run is over: nothing of it should keep running on this machine.
  lines.on("close", () => {
    void stopDaemon().then(() => process.exit(1));
  });
}

// ---- The half that gives the orders ----

class Side {
  readonly name: string;
  readonly #child: ChildProcess;
  readonly #waiting = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
  #next = 1;
  #closed = false;

  constructor(name: string, command: string, args: string[], stderrPath: string) {
    this.name = name;
    this.#child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.#child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      if (!line.startsWith(WIRE_PREFIX)) return;
      const frame = JSON.parse(line.slice(WIRE_PREFIX.length)) as { order: number; ok: boolean; result: unknown; error: string };
      const waiter = this.#waiting.get(frame.order);
      this.#waiting.delete(frame.order);
      if (frame.ok) waiter?.resolve(frame.result);
      else waiter?.reject(new Error(`${name}: ${frame.error}`));
    });
    this.#child.stderr?.on("data", (chunk: Buffer) => appendFileSync(stderrPath, chunk));
    this.#child.stdin?.on("error", () => undefined);
    const heartbeat = setInterval(() => { this.#child.stdin?.write(`${JSON.stringify({ cmd: "heartbeat" })}\n`); }, HEARTBEAT_MS);
    heartbeat.unref();
    this.#child.on("close", () => {
      clearInterval(heartbeat);
      this.#closed = true;
      for (const waiter of this.#waiting.values()) waiter.reject(new Error(`${name}: the link to this side closed`));
      this.#waiting.clear();
    });
  }

  call<T = Json>(cmd: string, args: Json = {}): Promise<T> {
    const id = this.#next++;
    const answer = new Promise<T>((resolve, reject) => {
      if (this.#closed) {
        reject(new Error(`${this.name}: the link to this side closed`));
        return;
      }
      this.#waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#child.stdin?.write(`${JSON.stringify({ order: id, cmd, ...args })}\n`);
    });
    // A phase that fails can leave an order nobody is awaiting any more. Its failure mustn't end the whole run.
    answer.catch(() => undefined);
    return answer;
  }
}

function summary(values: number[]): Json {
  return { n: values.length, median: Math.round(median(values)), p95: Math.round(percentile(values, 95)), worst: Math.round(Math.max(...values)) };
}

interface ClockFix { offset: number; rtt: number; load_1min: number; cores: number }

async function clocks(sides: Side[]): Promise<Map<string, ClockFix | null>> {
  const fixes = new Map<string, ClockFix | null>();
  for (const side of sides) {
    const answer = await side.call<{ offset?: number; rtt?: number; failed?: boolean; load_1min: number; cores: number }>("clock");
    fixes.set(side.name, answer.failed ? null : { offset: answer.offset as number, rtt: answer.rtt as number, load_1min: answer.load_1min, cores: answer.cores });
  }
  return fixes;
}

// The average of the readings around a phase, to allow for drift during it. Null if the clock couldn't be read.
function skew(fixes: Map<string, ClockFix | null>[], side: string): { offset: number; rtt: number } | null {
  const seen = fixes.map((fix) => fix.get(side)).filter((fix): fix is ClockFix => Boolean(fix));
  if (seen.length === 0) return null;
  return { offset: seen.reduce((sum, fix) => sum + fix.offset, 0) / seen.length, rtt: Math.min(...seen.map((fix) => fix.rtt)) };
}

function analyse(samples: Map<string, Json[]>, fixes: Map<string, ClockFix | null>[], from: Side, to: Side): Json {
  const fromClock = skew(fixes, from.name);
  const toClock = skew(fixes, to.name);
  const received = new Map((samples.get(to.name) ?? []).filter((s) => s["kind"] === "expect").map((s) => [s["id"], s]));
  const sends = (samples.get(from.name) ?? []).filter((s) => s["kind"] === "send");
  const e2e: number[] = [];
  const gap: number[] = [];
  const send: number[] = [];
  const read: number[] = [];
  for (const sent of sends) {
    const got = received.get(sent["id"]);
    if (!got) continue;
    send.push((sent["send_end"] as number) - (sent["send_start"] as number));
    read.push((got["receive_end"] as number) - (got["wait_end"] as number));
    if (fromClock && toClock) {
      const shift = toClock.offset - fromClock.offset;
      e2e.push((got["receive_end"] as number) + shift - (sent["send_start"] as number));
      gap.push((got["wait_end"] as number) + shift - (sent["send_end"] as number));
    }
  }
  // There and back on one clock, so no clock error can enter. Half of it is the average of the two directions.
  const steps = samples.get(from.name) ?? [];
  const rounds: number[] = [];
  steps.forEach((step, i) => {
    const reply = steps[i + 1];
    if (step["kind"] === "send" && reply?.["kind"] === "expect") rounds.push((reply["receive_end"] as number) - (step["send_start"] as number));
  });
  const fifth = Math.max(1, Math.floor(rounds.length / 5));
  return {
    end_to_end_ms: e2e.length > 0 ? summary(e2e) : "clock_unavailable",
    clock_error_bound_ms: fromClock && toClock ? Math.round((fromClock.rtt + toClock.rtt) / 2) : null,
    send_command_ms: summary(send),
    send_returned_to_doorbell_ms: gap.length > 0 ? summary(gap) : "clock_unavailable",
    doorbell_to_read_ms: summary(read),
    round_trip_ms: summary(rounds),
    round_trip_first_fifth_ms: Math.round(median(rounds.slice(0, fifth))),
    round_trip_last_fifth_ms: Math.round(median(rounds.slice(-fifth))),
  };
}

// Both sides must hold the same record, in the same order, each knowing which lines are its own.
function compareRecords(a: Json, b: Json, expected: string[]): string[] {
  const problems: string[] = [];
  type Entry = { position: number; own: boolean; closing: boolean; id: string | null; hash: string };
  const left = a["entries"] as Entry[];
  const right = b["entries"] as Entry[];
  if (a["ok"] !== true || b["ok"] !== true) problems.push(`a record failed its check: ${String(a["fault"])} / ${String(b["fault"])}`);
  if (a["root"] !== b["root"]) problems.push("the two sides hold different roots");
  if (left.length !== right.length) problems.push(`the records differ in length: ${left.length} and ${right.length}`);
  left.forEach((entry, i) => {
    const other = right[i];
    if (other?.position !== entry.position || other.hash !== entry.hash || other.own === entry.own) problems.push(`position ${entry.position} differs between the sides`);
  });
  const counts = new Map<string, number>();
  for (const entry of left) if (entry.id) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  for (const id of expected) if (!counts.has(id)) problems.push(`line ${id} is missing`);
  for (const [id, count] of counts) if (count > 1) problems.push(`line ${id} landed ${count} times`);
  return problems;
}

async function pair(a: Side, b: Side, tag: string): Promise<{ aId: string; bId: string; aName: string; bName: string }> {
  const aName = `${tag}-a`;
  const bName = `${tag}-b`;
  const [one, two] = await Promise.all([a.call("create", { name: aName }), b.call("create", { name: bName })]);
  return { aId: one["agent_id"] as string, bId: two["agent_id"] as string, aName, bName };
}

async function open(a: Side, b: Side, agents: { aName: string; bName: string; bId: string }): Promise<string> {
  const arrival = b.call("awaitSession", { agent: agents.bName });
  await sleep(1500);
  const started = await a.call("initiate", { agent: agents.aName, target: agents.bId });
  await arrival;
  return started["session_id"] as string;
}

async function shut(a: Side, b: Side, agents: { aName: string; bName: string }, session: string): Promise<void> {
  await a.call("close", { agent: agents.aName, session });
  await b.call("close", { agent: agents.bName, session });
  await Promise.all([a.call("settleClosed", { agent: agents.aName, session }), b.call("settleClosed", { agent: agents.bName, session })]);
}

async function converse(a: Side, b: Side, tag: string, bytes: number, rounds: number, raw: string): Promise<{ result: Json; problems: string[] }> {
  const agents = await pair(a, b, tag);
  const before = await clocks([a, b]);
  const session = await open(a, b, agents);
  const planA: Step[] = [];
  const planB: Step[] = [];
  const expected: string[] = [];
  for (let i = 0; i < rounds * 2; i++) {
    const id = `${tag}-${i}`;
    expected.push(id);
    (i % 2 === 0 ? planA : planB).push({ do: "send", id, bytes });
    (i % 2 === 0 ? planB : planA).push({ do: "expect", id, bytes });
  }
  const [samplesA, samplesB] = await Promise.all([
    a.call<Json[]>("conversation", { agent: agents.aName, session, plan: planA }),
    b.call<Json[]>("conversation", { agent: agents.bName, session, plan: planB }),
  ]);
  const after = await clocks([a, b]);
  await shut(a, b, agents, session);
  const [recordA, recordB] = await Promise.all([a.call("record", { agent: agents.aName, session }), b.call("record", { agent: agents.bName, session })]);
  appendFileSync(raw, `${JSON.stringify({ tag, bytes, session, clocks: [Object.fromEntries(before), Object.fromEntries(after)], samples: { [a.name]: samplesA, [b.name]: samplesB } })}\n`);
  const samples = new Map([[a.name, samplesA], [b.name, samplesB]]);
  const fixes = [before, after];
  const problems = compareRecords(recordA, recordB, expected);
  const whole = [...samplesA, ...samplesB].filter((s) => s["kind"] === "expect" && s["whole"] !== true).map((s) => `line ${String(s["id"])} arrived damaged`);
  const load = Object.fromEntries([a, b].map((side) => [side.name, fixes.map((fix) => fix.get(side.name)?.load_1min ?? null)]));
  return { result: { [`${a.name} to ${b.name}`]: analyse(samples, fixes, a, b), [`${b.name} to ${a.name}`]: analyse(samples, fixes, b, a), load_1min_before_and_after: load }, problems: [...problems, ...whole] };
}

async function sessionStarts(a: Side, b: Side, tag: string, count: number, raw: string): Promise<Json> {
  const agents = await pair(a, b, tag);
  const fixes = await clocks([a, b]);
  const shift = (skew([fixes], b.name)?.offset ?? Number.NaN) - (skew([fixes], a.name)?.offset ?? Number.NaN);
  const caller: number[] = [];
  const callee: number[] = [];
  for (let i = 0; i < count; i++) {
    const arrival = b.call<{ end: number }>("awaitSession", { agent: agents.bName });
    await sleep(1500);
    const started = await a.call("initiate", { agent: agents.aName, target: agents.bId });
    if (started["state"] !== "active") throw new Error(`a session started as ${String(started["state"])}`);
    const arrived = await arrival;
    caller.push((started["end"] as number) - (started["start"] as number));
    if (Number.isFinite(shift)) callee.push(arrived.end + shift - (started["start"] as number));
    await shut(a, b, agents, started["session_id"] as string);
  }
  appendFileSync(raw, `${JSON.stringify({ tag, caller, callee })}\n`);
  return { caller_has_active_session_ms: summary(caller), other_side_told_ms: callee.length > 0 ? summary(callee) : "clock_unavailable" };
}

// One machine's daemon is killed again and again, in the middle of real exchanges. The other side never restarts.
async function killTest(victim: Side, peer: Side, tag: string, kills: number, delays: { short: number; large: number; start: number }, raw: string): Promise<{ result: Json; problems: string[] }> {
  const agents = await pair(victim, peer, tag);
  const session = await open(victim, peer, agents);
  const expected: string[] = [];
  const events: Json[] = [];
  let n = 0;
  const line = (): string => {
    const id = `${tag}-${n++}`;
    expected.push(id);
    return id;
  };
  const whole = (got: Json): void => {
    if (got["whole"] !== true) throw new Error(`line ${String(got["id"])} arrived damaged`);
  };

  const killTheSender = async (bytes: number, sendMs: number): Promise<void> => {
    const id = line();
    const arrival = peer.call("expect", { agent: agents.bName, id });
    await sleep(1500);
    const killAfterMs = Math.round(delays.start + Math.random() * Math.max(50, sendMs - delays.start));
    const sent = await victim.call("sendLine", { agent: agents.aName, session, id, bytes, killAfterMs });
    const back = await victim.call("relogin");
    const event: Json = { scenario: "sender killed", bytes, killAfterMs, killed_after_send: sent["killed_after_send"], send_status: sent["status"], send_result: sent["result"], send_stderr: sent["stderr"], online_ms: Math.round(back["online"] as number) };
    // The sender can't tell from the failed command whether its line was saved. It looks before saying it again.
    if (sent["status"] !== 0) {
      const fate = await victim.call("fate", { agent: agents.aName, session, id, timeoutMs: 40_000 });
      event["landed_by_itself"] = fate["landed"];
      // "Not running" must mean nothing was sent. If such a line lands, a caller who believed it sends it twice.
      if (fate["landed"] === true && (sent["result"] as Json)["error"] === "daemon_not_running") throw new Error(`line ${id} landed after its sender was told the daemon wasn't running`);
      if (fate["landed"] !== true) {
        const again = await victim.call("sendLine", { agent: agents.aName, session, id, bytes });
        if (again["status"] !== 0) throw new Error(`the resend of ${id} failed: ${String(again["stderr"])}`);
      }
    }
    whole(await arrival);
    events.push(event);
    const reply = line();
    const replied = victim.call("expect", { agent: agents.aName, id: reply });
    await peer.call("sendLine", { agent: agents.bName, session, id: reply, bytes: 60 });
    whole(await replied);
  };

  const killTheReceiver = async (): Promise<void> => {
    const id = line();
    const arrival = victim.call("expect", { agent: agents.aName, id });
    await sleep(1500);
    const killed = victim.call("killDaemon", { afterMs: Math.round(Math.random() * delays.short * 0.5), downMs: 300 });
    const sent = await peer.call("sendLine", { agent: agents.bName, session, id, bytes: 60 });
    if (sent["status"] !== 0) throw new Error(`the peer's send of ${id} failed: ${String(sent["stderr"])}`);
    const back = await killed;
    const got = await arrival;
    whole(got);
    events.push({ scenario: "receiver killed", online_ms: Math.round(back["online"] as number), arrived_ms_after_kill: Math.round((got["receive_end"] as number) - (back["killedAt"] as number)) });
    const reply = line();
    const replied = peer.call("expect", { agent: agents.bName, id: reply });
    const answered = await victim.call("sendLine", { agent: agents.aName, session, id: reply, bytes: 60 });
    if (answered["status"] !== 0) throw new Error(`the reply ${reply} failed: ${String(answered["stderr"])}`);
    whole(await replied);
  };

  for (let i = 0; i < kills; i++) {
    await killTheSender(60, delays.short);
    await killTheReceiver();
  }
  await killTheSender(100_000, delays.large);
  await shut(victim, peer, agents, session);
  const [recordA, recordB] = await Promise.all([victim.call("record", { agent: agents.aName, session }), peer.call("record", { agent: agents.bName, session })]);
  appendFileSync(raw, `${JSON.stringify({ tag, session, events, recordA, recordB })}\n`);
  const problems = compareRecords(recordA, recordB, expected);
  const onlines = events.map((event) => event["online_ms"] as number);
  return { result: { kills: events.length, lines: expected.length, position: recordA["position"], root_matches: recordA["root"] === recordB["root"], back_online_ms: summary(onlines), events }, problems };
}

function reportText(results: Json, meta: Json, failures: string[]): string {
  const lines = [`# Two machines, ${String(meta["time"])}`, "", failures.length === 0 ? "No failures." : `**${failures.length} failures:**`, ...failures.map((failure) => `- ${failure}`), "", "```json", JSON.stringify({ meta, results }, null, 2), "```", ""];
  return lines.join("\n");
}

async function orchestrate(): Promise<void> {
  const { values: args } = parseArgs({ options: {
    server: { type: "string" }, instance: { type: "string" }, zone: { type: "string" }, project: { type: "string", default: "cello-infra" },
    short: { type: "string", default: "100" }, kb100: { type: "string", default: "40" }, mb1: { type: "string", default: "20" },
    starts: { type: "string", default: "15" }, kills: { type: "string", default: "3" }, "no-sync": { type: "boolean", default: false },
  } });
  if (!args.server || !args.instance || !args.zone) throw new Error("--server, --instance and --zone are required");
  const here = new URL("..", import.meta.url).pathname;
  const git = (...rest: string[]): string => execFileSync("git", ["-C", here, ...rest], { encoding: "utf8" }).trim();
  const dirty = git("status", "--short", "src", "live");
  if (dirty) throw new Error(`uncommitted changes in src or live, so the far machine wouldn't run this code:\n${dirty}`);
  const commit = git("rev-parse", "--short=8", "HEAD");
  const time = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(homedir(), "cello-v2-live-runs", `two-machines-${time}`);
  mkdirSync(dir, { recursive: true });
  const raw = join(dir, "raw.jsonl");
  const ssh = ["compute", "ssh", args.instance, "--project", args.project, "--zone", args.zone, "--tunnel-through-iap", "--quiet", "--ssh-flag=-oServerAliveInterval=15", "--command"];
  const say = (text: string): void => { process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${text}\n`); };

  if (!args["no-sync"]) {
    say(`copying ${commit} to ${args.instance}`);
    const archive = execFileSync("git", ["-C", here, "archive", "HEAD"], { maxBuffer: 1e9 });
    // The prepare script needs git, which the copy doesn't have, so scripts stay off and the one native package is built by name.
    execFileSync("gcloud", [...ssh, "rm -rf ~/cello-v2 && mkdir -p ~/cello-v2 && tar -x -C ~/cello-v2 && cd ~/cello-v2 && pnpm install --frozen-lockfile --ignore-scripts --reporter=silent && pnpm rebuild @signalapp/sqlcipher --reporter=silent"], { input: archive, stdio: ["pipe", "ignore", "pipe"], maxBuffer: 1e9 });
  }

  // Before any worker starts, because each machine's workers and homes belong to one run at a time.
  say(`leftovers here: ${execFileSync(process.execPath, [new URL(import.meta.url).pathname, "--clean-leftovers"], { encoding: "utf8" }).trim()}`);
  say(`leftovers on ${args.instance}: ${execFileSync("gcloud", [...ssh, "node ~/cello-v2/live/two-machines.ts --clean-leftovers"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()}`);

  const local = (name: string): Side => new Side(name, process.execPath, [new URL(import.meta.url).pathname, "--worker", "--caller", `two-machines-${name}`], join(dir, `stderr-${name}.log`));
  // The Mac's link drops now and then, and a dropped link before anything has started costs nothing but a retry.
  const far = async (name: string): Promise<Side> => {
    for (let attempt = 1; ; attempt++) {
      const side = new Side(name, "gcloud", [...ssh, `node ~/cello-v2/live/two-machines.ts --worker --caller two-machines-${name}`], join(dir, `stderr-${name}.log`));
      try {
        await side.call("login", { server: args.server });
        return side;
      } catch (err: unknown) {
        if (attempt === 4) throw err;
        say(`retrying the link to ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const mac = local("mac");
  await mac.call("login", { server: args.server });
  const vm = await far("vm");
  const control = await far("vm-control");
  const sides = [mac, vm, control];
  const results: Json = {};
  const failures: string[] = [];
  const meta: Json = { time, commit, server: args.server, instance: args.instance, zone: args.zone, node: process.versions.node };
  const save = (): void => {
    writeFileSync(join(dir, "numbers.json"), `${JSON.stringify({ meta, results, failures }, null, 2)}\n`);
    writeFileSync(join(dir, "report.md"), reportText(results, meta, failures));
  };
  const phase = async (name: string, work: () => Promise<void>): Promise<void> => {
    say(name);
    try {
      await work();
    } catch (err: unknown) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      say(`FAILED ${name}: ${failures.at(-1) as string}`);
    }
    save();
  };
  const tagBase = time.slice(11).replaceAll("-", "");

  try {
    const benches = await Promise.all(sides.slice(0, 2).map((side) => side.call("bench")));
    results["measured_alone"] = { mac: benches[0], vm: benches[1] };
    save();

    // A count of zero skips a phase, to rerun the others alone.
    if (Number(args.starts) > 0) await phase("session starts", async () => {
      results["session_start"] = {
        "mac calls vm": await sessionStarts(mac, vm, `st${tagBase}m`, Number(args.starts), raw),
        "vm calls mac": await sessionStarts(vm, mac, `st${tagBase}v`, Number(args.starts), raw),
      };
    });

    const rounds: Record<string, number> = { short: Number(args.short), "100 KB": Number(args.kb100), "1 MB": Number(args.mb1) };
    const conversations: Json = {};
    results["mac_and_vm"] = conversations;
    const control_: Json = {};
    results["vm_and_vm_control"] = control_;
    for (const size of SIZES.filter((candidate) => (rounds[candidate.label] as number) > 0)) {
      await phase(`mac and vm, ${size.label}`, async () => {
        const { result, problems } = await converse(mac, vm, `${size.bytes}m${tagBase}`, size.bytes, rounds[size.label] as number, raw);
        conversations[size.label] = result;
        failures.push(...problems.map((problem) => `mac and vm, ${size.label}: ${problem}`));
      });
      await phase(`vm and vm, ${size.label}`, async () => {
        const { result, problems } = await converse(vm, control, `${size.bytes}c${tagBase}`, size.bytes, Math.ceil((rounds[size.label] as number) / 2), raw);
        control_[size.label] = result;
        failures.push(...problems.map((problem) => `vm and vm, ${size.label}: ${problem}`));
      });
    }

    const typical = (side: string, size: string): number => {
      const row = (conversations[size] as Record<string, { send_command_ms: { median: number } }> | undefined)?.[side === "mac" ? "mac to vm" : "vm to mac"];
      // When this run skipped that size, the median measured by the last full run, so the kill still lands inside a send.
      const lastMeasured: Record<string, number> = { "mac short": 830, "vm short": 300, "mac 100 KB": 900, "vm 100 KB": 690 };
      return row?.send_command_ms.median ?? (lastMeasured[`${side} ${size}`] as number);
    };
    results["kills"] = {};
    for (const [victim, peer] of (Number(args.kills) > 0 ? [[mac, vm], [vm, mac]] : []) as [Side, Side][]) {
      await phase(`daemon kills on ${victim.name}`, async () => {
        const start = (benches[victim === mac ? 0 : 1]?.["process_start_ms"] as number) ?? 200;
        const { result, problems } = await killTest(victim, peer, `k${victim.name}${tagBase}`, Number(args.kills), { short: typical(victim.name, "short"), large: typical(victim.name, "100 KB"), start }, raw);
        (results["kills"] as Json)[victim.name] = result;
        failures.push(...problems.map((problem) => `daemon kills on ${victim.name}: ${problem}`));
      });
    }
  } catch (err: unknown) {
    failures.push(`setup: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    for (const side of sides) {
      const done = await side.call<{ log: string; home: string }>("finish", { keepHome: failures.length > 0 }).catch((err: unknown) => ({ log: String(err), home: "unknown" }));
      writeFileSync(join(dir, `daemon-${side.name}.log`), done.log);
    }
    save();
  }
  say(`${failures.length === 0 ? "PASSED" : `${failures.length} FAILURES`}: ${dir}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

// Only this test's own temporary homes. A daemon is asked to stop through its own socket, so nothing is found by name.
async function cleanLeftovers(): Promise<void> {
  const homes = readdirSync(tmpdir()).filter((name) => name.startsWith(HOME_PREFIX)).map((name) => join(tmpdir(), name));
  let stopped = 0;
  for (const home of homes) {
    try {
      const client = await IpcClient.connect(socketPath(home));
      await client.call("shutdown");
      client.close();
      stopped += 1;
    } catch (err: unknown) {
      if (!(err instanceof DaemonGone || err instanceof DaemonRefused)) throw err;
    }
    rmSync(home, { recursive: true, force: true });
  }
  process.stdout.write(`${homes.length} temporary homes removed, ${stopped} daemons stopped\n`);
}

const workerAt = process.argv.indexOf("--worker");
if (process.argv.includes("--clean-leftovers")) await cleanLeftovers();
else if (workerAt >= 0) await worker(process.argv[process.argv.indexOf("--caller") + 1] ?? "two-machines");
else await orchestrate();

#!/usr/bin/env node
// The CELLO Concierge: the first agent a new person dials. Set lines, no model, and only the real cello command.
// Where a conversation stands is read back from the daemon's own record each time, so a restart of either program loses nothing.
// A caller's text is never used: it decides nothing, is never logged and is never sent back. Only counts and signals are read.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const LINE_NAMES = ["first", "next_step", "last", "silent", "limit"] as const;
type LineName = (typeof LINE_NAMES)[number];
type Lines = Record<LineName, string>;

export function loadLines(path: string): Lines {
  const file = JSON.parse(readFileSync(path, "utf8")) as { status?: unknown; prefix?: unknown; lines?: Record<string, unknown> };
  if (file.status !== "draft" && file.status !== "approved") throw new Error(`${path}: status must be "draft" or "approved"`);
  if (file.status === "draft" && (typeof file.prefix !== "string" || file.prefix.trim() === "")) throw new Error(`${path}: a draft needs a prefix, so nobody takes it for final copy`);
  const prefix = file.status === "draft" ? file.prefix as string : "";
  const lines = {} as Lines;
  for (const name of LINE_NAMES) {
    const text = file.lines?.[name];
    if (typeof text !== "string" || text.trim() === "") throw new Error(`${path}: line "${name}" is missing`);
    lines[name] = prefix + text;
  }
  return lines;
}

interface Entry { own: boolean; signal?: string | null; closed_their_side?: boolean; screening?: { verdict?: string } }
export type Action = { do: "nothing" } | { do: "close" } | { do: "send"; line: "first" | "next_step" | "last" | "silent" };

// The whole conversation, as a decision on the record alone. Nothing here can see text.
export function decide(entries: readonly Entry[], peerClosed: boolean, silentTooLong: boolean): Action {
  const mine = entries.filter((e) => e.own && !e.closed_their_side);
  // A wrap with no close means a crash came between the two.
  if (peerClosed || mine.some((e) => e.signal === "wrap") || entries.some((e) => !e.own && e.signal === "wrap")) return { do: "close" };
  if (mine.length === 0) return { do: "send", line: "first" };
  const last = entries.at(-1);
  // Still being screened: it can't be answered yet, and it isn't silence either.
  if (last && !last.own && last.screening?.verdict === "not_screened_yet") return { do: "nothing" };
  if (last && !last.own) return { do: "send", line: mine.length === 1 ? "next_step" : "last" };
  return silentTooLong ? { do: "send", line: "silent" } : { do: "nothing" };
}

// heartbeat is a file this writes the time into as it works, for a supervisor that wants to know it isn't wedged.
interface Options { agent: string; lines: Lines; silentSeconds: number; waitSeconds: number; maxCallsPerCaller: number; parallel: number; heartbeat?: string }

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

class CommandFailed extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const COMMAND_LIMIT_MS = 60_000;
const running = new Set<ReturnType<typeof spawn>>();

// Exit code 3 from wait means its time ran out, which is an answer. Anything else nonzero is a refusal, by name.
function cello(args: readonly string[], input?: string, limitMs = COMMAND_LIMIT_MS): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("cello", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CELLO_CALLER: "cello-concierge" } });
    running.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), limitMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (cause) => {
      clearTimeout(timer);
      running.delete(child);
      reject(new CommandFailed("cello_not_runnable", cause.message));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      running.delete(child);
      const stdout = Buffer.concat(out).toString("utf8");
      if (status === 0 || status === 3) {
        try {
          resolve(JSON.parse(stdout) as Record<string, unknown>);
        } catch {
          reject(new CommandFailed("unreadable_answer", `${args[0] as string} didn't answer in JSON`));
        }
        return;
      }
      if (status === null) {
        reject(new CommandFailed("command_timed_out", `${args[0] as string} took longer than ${limitMs} ms`));
        return;
      }
      let refusal: { error?: string; message?: string } = {};
      try {
        refusal = JSON.parse(Buffer.concat(err).toString("utf8") || stdout) as typeof refusal;
      } catch {
        // Not JSON, so all that's known is the command's name and its exit code.
      }
      reject(new CommandFailed(refusal.error ?? `exit_${status}`, refusal.message ?? `${args[0] as string} exited with ${status}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

interface SessionRow { session_id: string; with_id: string; state: string; position: number; unread: number; own_closed: boolean; peer_closed: boolean }
interface Seen { position: number; changedAt: number; dirty: boolean; retryAt: number; failures: number }

const FIRST_RETRY_MS = 1_000;
const LONGEST_RETRY_MS = 30_000;
const SHORTEST_LOOP_MS = 200;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Concierge {
  readonly #o: Options;
  readonly #seen = new Map<string, Seen>();
  #stopping = false;

  constructor(options: Options) {
    this.#o = options;
  }

  stop(): void {
    this.#stopping = true;
    for (const child of running) child.kill("SIGKILL");
  }

  #agentArgs(): string[] {
    return ["--agent", this.#o.agent];
  }

  // Written at the top of every pass, after every conversation and through every wait, so a long sweep during a flood
  // and a long wait for a daemon both count as alive. Only a program that is stuck stops writing it.
  #beat(): void {
    if (this.#o.heartbeat) writeFileSync(this.#o.heartbeat, `${Date.now()}\n`, { mode: 0o600 });
  }

  async #nap(ms: number): Promise<void> {
    for (let left = ms; left > 0 && !this.#stopping; left -= 1000) {
      this.#beat();
      await sleep(Math.min(left, 1000));
    }
  }

  async #entries(sessionId: string): Promise<Entry[]> {
    const entries: (Entry & { position: number })[] = [];
    for (;;) {
      const after = entries.at(-1)?.position ?? 0;
      const page = await cello(["transcript", sessionId, "--after", String(after), ...this.#agentArgs()]) as { entries: (Entry & { position: number })[]; more?: boolean };
      // Kept to what a decision uses, so no caller's text is held any longer than the parse.
      for (const e of page.entries) entries.push({ position: e.position, own: e.own, signal: e.signal, closed_their_side: e.closed_their_side, screening: e.screening?.verdict ? { verdict: e.screening.verdict } : undefined });
      if (!page.more) return entries;
    }
  }

  async #drain(sessionId: string): Promise<void> {
    for (;;) {
      const read = await cello(["receive", "--session-id", sessionId, ...this.#agentArgs()]) as { more?: boolean };
      if (!read.more) return;
    }
  }

  async #send(row: SessionRow, line: LineName, signal: "over" | "wrap"): Promise<void> {
    await cello(["send", row.session_id, "-", `--${signal}`, ...this.#agentArgs()], this.#o.lines[line]);
    log("concierge.line.sent", { session: row.session_id, caller: row.with_id, line });
  }

  async #close(row: SessionRow): Promise<void> {
    await cello(["close-session", row.session_id, ...this.#agentArgs()]);
    log("concierge.session.closed", { session: row.session_id, caller: row.with_id });
  }

  async #callsFrom(caller: string): Promise<number> {
    const all = await cello(["sessions", "--all", ...this.#agentArgs()]) as { sessions: { with_id: string }[] };
    return all.sessions.filter((s) => s.with_id === caller).length;
  }

  async #handle(row: SessionRow, seen: Seen): Promise<void> {
    await this.#drain(row.session_id);
    const entries = await this.#entries(row.session_id);
    const silent = Date.now() - seen.changedAt >= this.#o.silentSeconds * 1000;
    const action = decide(entries, row.peer_closed, silent);
    if (action.do === "nothing") return;
    if (action.do === "close") return this.#close(row);
    if (action.line === "first" && await this.#callsFrom(row.with_id) > this.#o.maxCallsPerCaller) {
      await this.#send(row, "limit", "wrap");
      return this.#close(row);
    }
    const ends = action.line === "last" || action.line === "silent";
    await this.#send(row, action.line, ends ? "wrap" : "over");
    if (ends) await this.#close(row);
  }

  async #one(row: SessionRow, seen: Seen): Promise<void> {
    seen.dirty = false;
    try {
      await this.#handle(row, seen);
      seen.failures = 0;
      this.#beat();
    } catch (err: unknown) {
      // session_not_current just means they wrote while this was happening, so it's tried again straight away.
      const code = err instanceof CommandFailed ? err.code : "unexpected";
      seen.dirty = true;
      if (code === "session_not_current") return;
      if (code === "daemon_not_running" || code === "ipc_connection_lost") throw err;
      seen.failures += 1;
      seen.retryAt = Date.now() + Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** (seen.failures - 1));
      log("concierge.session.failed", { session: row.session_id, caller: row.with_id, error: code, failures: seen.failures });
    }
  }

  // Each session is looked at only when something about it changed, so a quiet one costs nothing.
  async #sweep(): Promise<void> {
    const { sessions } = await cello(["sessions", ...this.#agentArgs()]) as { sessions: SessionRow[] };
    const now = Date.now();
    const open = sessions.filter((s) => !s.own_closed && s.state !== "closed");
    const due: { row: SessionRow; seen: Seen }[] = [];
    for (const row of open) {
      let seen = this.#seen.get(row.session_id);
      if (!seen) {
        seen = { position: row.position, changedAt: now, dirty: true, retryAt: 0, failures: 0 };
        this.#seen.set(row.session_id, seen);
      } else if (seen.position !== row.position) {
        seen.position = row.position;
        seen.changedAt = now;
        seen.dirty = true;
      }
      const silent = now - seen.changedAt >= this.#o.silentSeconds * 1000;
      if ((seen.dirty || silent || row.unread > 0 || row.peer_closed) && now >= seen.retryAt) due.push({ row, seen });
    }
    const stillOpen = new Set(open.map((s) => s.session_id));
    for (const id of this.#seen.keys()) if (!stillOpen.has(id)) this.#seen.delete(id);

    // Workers, so one slow conversation can't hold up the callers behind it.
    let next = 0;
    const failures: unknown[] = [];
    const worker = async (): Promise<void> => {
      for (let job = due[next++]; job; job = due[next++]) await this.#one(job.row, job.seen).catch((err: unknown) => failures.push(err));
    };
    await Promise.all(Array.from({ length: Math.min(this.#o.parallel, due.length) }, worker));
    if (failures.length > 0) throw failures[0];
  }

  async run(): Promise<void> {
    let down = 0;
    while (!this.#stopping) {
      const started = Date.now();
      this.#beat();
      try {
        await this.#sweep();
        // Rings for a new caller who has said nothing, and returns at once for anything unread. The time limit covers a ring that came mid-sweep.
        await cello(["wait", "--timeout-seconds", String(this.#o.waitSeconds), ...this.#agentArgs()], undefined, (this.#o.waitSeconds + 15) * 1000);
        if (down > 0) log("concierge.daemon.back");
        down = 0;
      } catch (err: unknown) {
        if (this.#stopping) return;
        down += 1;
        const code = err instanceof CommandFailed ? err.code : "unexpected";
        // Said once per outage, or a long one fills the log. Bringing the daemon back is its supervisor's job.
        if (down === 1) log("concierge.loop.failed", { error: code, message: err instanceof Error ? err.message : String(err) });
        await this.#nap(Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(down - 1, 5)));
        continue;
      }
      const spent = Date.now() - started;
      if (spent < SHORTEST_LOOP_MS) await sleep(SHORTEST_LOOP_MS - spent);
    }
  }
}

const number = (raw: string, name: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a whole number of at least 1`);
  return value;
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      agent: { type: "string" },
      lines: { type: "string", default: new URL("./lines.draft.json", import.meta.url).pathname },
      "silent-seconds": { type: "string", default: "300" },
      "wait-seconds": { type: "string", default: "5" },
      "max-calls-per-caller": { type: "string", default: "5" },
      parallel: { type: "string", default: "8" },
      heartbeat: { type: "string" },
    },
  });
  if (!values.agent) throw new Error("--agent is required: the name or agent_id of the agent that answers");
  const concierge = new Concierge({
    agent: values.agent,
    lines: loadLines(values.lines),
    silentSeconds: number(values["silent-seconds"], "silent-seconds"),
    waitSeconds: number(values["wait-seconds"], "wait-seconds"),
    maxCallsPerCaller: number(values["max-calls-per-caller"], "max-calls-per-caller"),
    parallel: number(values.parallel, "parallel"),
    heartbeat: values.heartbeat,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => concierge.stop());
  log("concierge.started", { agent: values.agent, lines: values.lines });
  await concierge.run();
  log("concierge.stopped");
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

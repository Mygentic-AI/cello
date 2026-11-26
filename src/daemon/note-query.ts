// note-query: one read-only SQL statement over the notes an agent may read. The statement runs in a child process, on a
// copy of the rows, because the database library has no read-only open, no way to refuse one table, and no way to stop
// a query that is running. Two checks keep it to reading, and both are needed: the text must start with SELECT or WITH,
// since the engine lets ATTACH through even with writing off, and the engine refuses a write the text check can't see.
import { type ChildProcess, spawn } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalError } from "./errors.ts";
import { logEvent } from "./log.ts";

// Each query is a process holding a copy of every note its agent may read, up to about 160 MB at the largest settings,
// and a core while it runs. Two lets two agents work at once without a burst of calls filling the machine's memory.
export const MAX_QUERIES = 2;
const STDERR_KEPT = 2000;

const childPath = (): string => fileURLToPath(new URL(`./note-query-child${extname(new URL(import.meta.url).pathname)}`, import.meta.url));

// One statement that reads: SELECT or WITH, after any leading space and comments.
export function assertSelect(sql: unknown): string {
  const refuse = (): never => { throw new LocalError("query_not_select", "A note query is one statement that starts with SELECT or WITH. Nothing else is run: notes are changed with note-set and note-remove."); };
  if (typeof sql !== "string") return refuse();
  let rest = sql;
  for (;;) {
    const skipped = rest.replace(/^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)/, "");
    if (skipped === rest) break;
    rest = skipped;
  }
  if (!/^(select|with)\b/i.test(rest)) return refuse();
  return sql;
}

export interface QueryLimits { ms: number; rows: number }
export interface QueryAnswer { rows: Record<string, unknown>[]; cut: boolean }
// A row for the child: which table, then its columns in the shape's order.
export type QueryRow = ["n" | "c", ...unknown[]];
type ChildAnswer = { rows: Record<string, unknown>[]; cut: boolean; error?: undefined } | { error: string; message: string };

export class NoteQueries {
  #running = 0;

  get running(): number { return this.#running; }

  // batches is read a batch at a time, with the event loop given a turn between them, so copying a large store doesn't
  // stop the daemon answering anyone else. spawned is told the child's process, for a test that kills it.
  async run(sql: unknown, batches: Iterable<QueryRow[]>, limits: QueryLimits, spawned?: (child: ChildProcess) => void): Promise<QueryAnswer> {
    const statement = assertSelect(sql);
    if (this.#running >= MAX_QUERIES) throw new LocalError("too_many_queries", `${MAX_QUERIES} note queries are already running on this daemon, which is the most at once. Try again when one has finished: each ends within its time limit.`);
    this.#running += 1;
    try {
      return await this.#inChild(statement, batches, limits, spawned);
    } finally {
      this.#running -= 1;
    }
  }

  #inChild(sql: string, batches: Iterable<QueryRow[]>, limits: QueryLimits, spawned?: (child: ChildProcess) => void): Promise<QueryAnswer> {
    return new Promise((resolve, reject) => {
      // Nothing of the daemon's own surroundings goes with it: no home, no caller, nothing that names the database.
      const env = Object.fromEntries(["PATH", "SystemRoot"].flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])));
      const child = spawn(process.execPath, [childPath()], { stdio: ["pipe", "pipe", "pipe"], env });
      spawned?.(child);
      const chunks: Buffer[] = [];
      let err = "";
      // The first reason the query ended, if the daemon ended it. The child's own end is read only without one.
      let ended: LocalError | undefined;
      const stop = (why: LocalError): void => {
        ended ??= why;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => stop(new LocalError("query_timed_out", `The query ran past its limit of ${limits.ms} ms, copying the notes included, and was stopped. Narrow it, or have your operator raise the setting notes.query_ms.`)), limits.ms);
      child.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err = `${err}${chunk}`.slice(-STDERR_KEPT); });
      // A child that died stops taking rows. Its end says why, below.
      child.stdin.on("error", () => undefined);
      // A process that never started may not close, so this answers by itself.
      child.on("error", (failure) => {
        clearTimeout(timer);
        stop(new LocalError("query_child_failed", `The query's process couldn't be started: ${failure.message}`));
        reject(ended);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (ended) {
          reject(ended);
          return;
        }
        let answer: ChildAnswer | undefined;
        try {
          answer = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChildAnswer;
        } catch {
          answer = undefined;
        }
        if (answer === undefined || (answer.error === undefined && !Array.isArray(answer.rows))) {
          logEvent("note.query_child_died", { code, signal, stderr: err });
          reject(new LocalError("query_child_died", `The query's process ended without an answer (${signal ? `signal ${signal}` : `exit code ${String(code)}`}), so there is no result. Nothing was changed. Try it again, and if it ends the same way, narrow it.`));
        } else if (answer.error !== undefined) {
          reject(new LocalError("query_failed", `SQLite refused the query: ${answer.message}`));
        } else {
          resolve({ rows: answer.rows, cut: answer.cut });
        }
      });
      const write = (text: string): Promise<void> => new Promise((done) => {
        if (child.stdin.destroyed || !child.stdin.writable) {
          done();
          return;
        }
        if (child.stdin.write(text)) {
          setImmediate(done);
          return;
        }
        const settle = (): void => {
          child.stdin.off("drain", settle).off("close", settle);
          done();
        };
        child.stdin.on("drain", settle).on("close", settle);
      });
      void (async () => {
        try {
          await write(`${JSON.stringify({ sql, limit: limits.rows })}\n`);
          for (const batch of batches) {
            if (ended || child.exitCode !== null || child.signalCode !== null) break;
            await write(batch.map((row) => `${JSON.stringify(row)}\n`).join(""));
          }
          child.stdin.end();
        } catch (failure: unknown) {
          logEvent("note.query_copy_failed", { message: failure instanceof Error ? failure.message : String(failure) });
          stop(new LocalError("query_copy_failed", `The notes couldn't be read for the query: ${failure instanceof Error ? failure.message : String(failure)}. Nothing was changed.`));
        }
      })();
    });
  }
}

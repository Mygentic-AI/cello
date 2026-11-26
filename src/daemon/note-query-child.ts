// The process a note-query runs in. It is handed rows on standard input, loads them into a database held in memory, and
// runs one statement with writing switched off. It has no key and never opens the daemon's database file. The daemon
// kills it at the time limit: a query running inside the database library can't be stopped any other way.
import Database from "@signalapp/sqlcipher";
import { NOTE_CHANGES_COLUMNS, NOTES_COLUMNS, QUERY_TABLES, statementBounds } from "./note-query-shape.ts";

const db = new Database();
db.exec(QUERY_TABLES);
const insertNote = db.prepare(`INSERT INTO notes VALUES (${NOTES_COLUMNS.map(() => "?").join(", ")})`);
const insertChange = db.prepare(`INSERT INTO note_changes VALUES (${NOTE_CHANGES_COLUMNS.map(() => "?").join(", ")})`);

function answer(result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}

// A blob, which only a query can make, goes back as hex like every id.
const plain = (value: unknown): unknown => (value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value);

// A write that sits inside a WITH can't be wrapped in a SELECT. Its plan opens a write transaction, which is how it is
// told apart without running it.
function writes(sql: string): boolean {
  return (db.prepare(`EXPLAIN ${sql}`).all() as { opcode: string; p2: number }[]).some((op) => op.opcode === "Transaction" && op.p2 !== 0);
}

function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  answer({ error: /out of memory|SQLITE_NOMEM/i.test(message) ? "out_of_memory" : "query_failed", message });
}

// The statement only ever runs inside a SELECT with a LIMIT one past the row limit, so no result of any size is made,
// and one row too many says it was cut. The library has no way to step through rows one at a time, so this is the bound.
function run(sql: string, limit: number, bytes: number): void {
  db.pragma("query_only = ON");
  let rows: Record<string, unknown>[];
  try {
    // Prepared as written first: this is where two statements, or one that isn't SQL, are refused in SQLite's own words.
    const bare = db.prepare(sql);
    const { start, end } = statementBounds(sql);
    let bounded: ReturnType<typeof db.prepare>;
    try {
      bounded = db.prepare(`SELECT * FROM (\n${sql.slice(start, end)}\n) LIMIT ${limit + 1}`);
    } catch (wrapped: unknown) {
      if (!writes(sql)) throw wrapped;
      // Run as written so the engine refuses it in its own words: with query_only on, it stops before touching a row.
      bounded = bare;
    }
    rows = bounded.all() as Record<string, unknown>[];
  } catch (err: unknown) {
    fail(err);
    return;
  }
  const kept = rows.slice(0, limit);
  // Measured before any of it is turned into text, so a huge value is refused here rather than copied again. The daemon
  // counts what actually arrives, and that count is the limit; this only saves building what it would refuse.
  let size = 0;
  for (const row of kept) for (const value of Object.values(row)) size += typeof value === "string" ? value.length : value instanceof Uint8Array ? 2 * value.length : 8;
  if (size > bytes) {
    answer({ error: "too_large", message: `about ${size} bytes` });
    return;
  }
  answer({ rows: kept.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, plain(value)]))), cut: rows.length > limit });
}

// Split on newlines alone: JSON.stringify leaves U+2028 and U+2029 in a body as they are, and a line reader would break there.
let header: { sql: string; limit: number; bytes: number } | undefined;
let pending = "";
const take = (line: string): void => {
  if (line === "") return;
  const item = JSON.parse(line) as { sql: string; limit: number; bytes: number } | ["n" | "c", ...unknown[]];
  if (!Array.isArray(item)) header = item;
  else (item[0] === "n" ? insertNote : insertChange).run(item.slice(1) as never);
};
db.exec("BEGIN");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  const lines = (pending + chunk).split("\n");
  pending = lines.pop() as string;
  for (const line of lines) take(line);
});
process.stdin.on("end", () => {
  take(pending);
  db.exec("COMMIT");
  if (header === undefined) answer({ error: "query_failed", message: "no statement was given" });
  else run(header.sql, header.limit, header.bytes);
});

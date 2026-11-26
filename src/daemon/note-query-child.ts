// The process a note-query runs in. It is handed rows on standard input, loads them into a database held in memory, and
// runs one statement with writing switched off. It has no key and never opens the daemon's database file. The daemon
// kills it at the time limit: a query running inside the database library can't be stopped any other way.
import Database from "@signalapp/sqlcipher";
import { NOTE_CHANGES_COLUMNS, NOTES_COLUMNS, QUERY_TABLES } from "./note-query-shape.ts";

const db = new Database();
db.exec(QUERY_TABLES);
const insertNote = db.prepare(`INSERT INTO notes VALUES (${NOTES_COLUMNS.map(() => "?").join(", ")})`);
const insertChange = db.prepare(`INSERT INTO note_changes VALUES (${NOTE_CHANGES_COLUMNS.map(() => "?").join(", ")})`);

function answer(result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}

// A blob, which only a query can make, goes back as hex like every id.
const plain = (value: unknown): unknown => (value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value);

function run(sql: string, limit: number): void {
  db.pragma("query_only = ON");
  let rows: Record<string, unknown>[];
  try {
    // Prepared as written first: this is where two statements, or one that isn't SQL, are refused in SQLite's own words.
    const bare = db.prepare(sql);
    let bounded: ReturnType<typeof db.prepare> | undefined;
    try {
      // One row past the limit says the result was cut, without making a result of any size. The empty comment closes
      // one the statement left open, so the wrapper's own end is never swallowed.
      bounded = db.prepare(`SELECT * FROM (\n${sql.replace(/[;\s]+$/, "")}\n/**/) LIMIT ${limit + 1}`);
    } catch {
      // Not something that can sit inside another SELECT, such as a WITH that ends in a write. Run as written, so the
      // engine itself answers; a result is still cut below.
    }
    rows = (bounded ?? bare).all() as Record<string, unknown>[];
  } catch (err: unknown) {
    answer({ error: "query_failed", message: err instanceof Error ? err.message : String(err) });
    return;
  }
  answer({ rows: rows.slice(0, limit).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, plain(value)]))), cut: rows.length > limit });
}

// Split on newlines alone: JSON.stringify leaves U+2028 and U+2029 in a body as they are, and a line reader would break there.
let header: { sql: string; limit: number } | undefined;
let pending = "";
const take = (line: string): void => {
  if (line === "") return;
  const item = JSON.parse(line) as { sql: string; limit: number } | ["n" | "c", ...unknown[]];
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
  else run(header.sql, header.limit);
});

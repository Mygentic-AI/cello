// The daemon's durable state, in SQLCipher. Everything here is a fact: holders, sockets and doorbells live in memory.
// The session key is on disk until the session ends (ruled, so a restart doesn't end a conversation).
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "@signalapp/sqlcipher";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS agents (
  agent_id   BLOB PRIMARY KEY,
  name       TEXT NOT NULL,
  ed_seed    BLOB NOT NULL,
  pq_seed    BLOB NOT NULL,
  registered INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  agent_id          BLOB NOT NULL REFERENCES agents(agent_id),
  session_id        BLOB NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('caller', 'callee')),
  counterparty_id   BLOB NOT NULL,
  counterparty_name TEXT NOT NULL,
  counterparty_keys TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('offered', 'accepted', 'active', 'closed')),
  x25519_secret     BLOB,
  mlkem_seed        BLOB,
  session_key       BLOB,
  own_salt          BLOB,
  salt              BLOB,
  offer             TEXT NOT NULL,
  accept            TEXT,
  confirm           TEXT,
  assignment        TEXT,
  read_position     INTEGER NOT NULL DEFAULT 0,
  verified_position INTEGER NOT NULL DEFAULT 0,
  delivered_through INTEGER NOT NULL DEFAULT 0,
  own_closed        INTEGER NOT NULL DEFAULT 0,
  peer_closed       INTEGER NOT NULL DEFAULT 0,
  fault             TEXT,
  acked_screened    INTEGER NOT NULL DEFAULT 0,
  peer_screened_through INTEGER NOT NULL DEFAULT 0,
  peer_eta_told     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, session_id)
);

CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    BLOB NOT NULL,
  session_id  BLOB NOT NULL,
  entry_hash  BLOB NOT NULL,
  position    INTEGER,
  state       TEXT NOT NULL CHECK (state IN ('pending', 'landed', 'received', 'not_sent')),
  own         INTEGER NOT NULL,
  entry       TEXT NOT NULL,
  ack         TEXT,
  ciphertext  BLOB,
  body        BLOB NOT NULL,
  -- Null means not screened yet, and such a message is never delivered. It's set once, by the screen, never by arrival.
  verdict     TEXT CHECK (verdict IN ('allow', 'flagged', 'blocked')),
  verdict_detail TEXT,
  UNIQUE (agent_id, session_id, position),
  FOREIGN KEY (agent_id, session_id) REFERENCES sessions(agent_id, session_id)
);
DROP INDEX IF EXISTS entries_session;
CREATE INDEX IF NOT EXISTS entries_by_state ON entries(agent_id, session_id, state, position);
-- Every send asks for the author's last entry. Without this, that sorts the author's whole history, bodies included.
CREATE INDEX IF NOT EXISTS entries_own ON entries(agent_id, session_id, own, id);

CREATE TABLE IF NOT EXISTS notices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   BLOB NOT NULL REFERENCES agents(agent_id),
  session_id BLOB,
  text       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seals (
  agent_id         BLOB NOT NULL,
  seal_id          BLOB NOT NULL,
  session_id       BLOB NOT NULL,
  record           TEXT NOT NULL,
  PRIMARY KEY (agent_id, seal_id),
  FOREIGN KEY (agent_id, session_id) REFERENCES sessions(agent_id, session_id)
);

-- A seal asked for and not finished, so it survives a restart. Through 0 means everything held when it goes.
CREATE TABLE IF NOT EXISTS seal_wants (
  agent_id   BLOB NOT NULL,
  session_id BLOB NOT NULL,
  through    INTEGER NOT NULL,
  PRIMARY KEY (agent_id, session_id, through),
  FOREIGN KEY (agent_id, session_id) REFERENCES sessions(agent_id, session_id)
);

-- What a person chose for one sender. The subject is the sender's agent id. A tier rule would be scope 'tier', ranked below this.
CREATE TABLE IF NOT EXISTS screening_rules (
  agent_id BLOB NOT NULL REFERENCES agents(agent_id),
  scope    TEXT NOT NULL CHECK (scope IN ('sender', 'tier')),
  subject  TEXT NOT NULL,
  level    TEXT NOT NULL CHECK (level IN ('full', 'deterministic', 'off')),
  set_at   INTEGER NOT NULL,
  PRIMARY KEY (agent_id, scope, subject)
);

-- Every change, so a weakening shows afterwards, whoever made it.
CREATE TABLE IF NOT EXISTS screening_changes (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id BLOB NOT NULL REFERENCES agents(agent_id),
  subject  TEXT NOT NULL,
  level    TEXT NOT NULL,
  at       INTEGER NOT NULL
);

-- A standby whose lateness has been told, so a restart can neither repeat that nor lose it. Its position names the promise.
CREATE TABLE IF NOT EXISTS standby_told (
  agent_id   BLOB NOT NULL,
  session_id BLOB NOT NULL,
  position   INTEGER NOT NULL,
  PRIMARY KEY (agent_id, session_id, position),
  FOREIGN KEY (agent_id, session_id) REFERENCES sessions(agent_id, session_id)
);
`;

export interface AgentRow { agent_id: Uint8Array; name: string; ed_seed: Uint8Array; pq_seed: Uint8Array; registered: number }

export interface SessionRow {
  agent_id: Uint8Array;
  session_id: Uint8Array;
  role: "caller" | "callee";
  counterparty_id: Uint8Array;
  counterparty_name: string;
  counterparty_keys: string;
  state: "offered" | "accepted" | "active" | "closed";
  x25519_secret: Uint8Array | null;
  mlkem_seed: Uint8Array | null;
  session_key: Uint8Array | null;
  own_salt: Uint8Array | null;
  salt: Uint8Array | null;
  offer: string;
  accept: string | null;
  confirm: string | null;
  assignment: string | null;
  read_position: number;
  verified_position: number;
  delivered_through: number;
  own_closed: number;
  peer_closed: number;
  fault: string | null;
  acked_screened: number;
  peer_screened_through: number;
  peer_eta_told: number;
}

export interface EntryRow {
  id: number;
  agent_id: Uint8Array;
  session_id: Uint8Array;
  entry_hash: Uint8Array;
  position: number | null;
  state: "pending" | "landed" | "received" | "not_sent";
  own: number;
  entry: string;
  ack: string | null;
  ciphertext: Uint8Array | null;
  body: Uint8Array;
  verdict: "allow" | "flagged" | "blocked" | null;
  verdict_detail: string | null;
}

export type UnscreenedRow = Pick<EntryRow, "id" | "agent_id" | "session_id" | "position"> & { sender: Uint8Array; size: number };

export interface NoticeRow { id: number; session_id: Uint8Array | null; text: string }

export interface SealRow { seal_id: Uint8Array; session_id: Uint8Array; record: string }

export interface SealWantRow { session_id: Uint8Array; through: number }

type SessionUpdate = Partial<Omit<SessionRow, "agent_id" | "session_id">>;

function openKey(dbPath: string): string {
  const keyPath = `${dbPath}.key`;
  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath);
    if (key.length !== 32) throw new Error(`the database key file ${keyPath} is ${key.length} bytes, not 32. Restore it from backup.`);
    return key.toString("hex");
  }
  // Never make a new key for an existing database: that would look like data loss.
  if (existsSync(dbPath)) throw new Error(`the database ${dbPath} exists but its key file ${keyPath} is missing. Restore it from backup.`);
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600, flag: "wx" });
  return key.toString("hex");
}

export class Store {
  readonly #db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    const keyHex = openKey(dbPath);
    this.#db = new Database(dbPath);
    chmodSync(dbPath, 0o600);
    this.#db.pragma(`key = "x'${keyHex}'"`);
    this.#prep("SELECT count(*) AS c FROM sqlite_master").get([]);
    this.#db.pragma("journal_mode=WAL");
    this.#db.pragma("synchronous=FULL");
    this.#db.pragma("busy_timeout=5000");
    this.#db.pragma("foreign_keys=ON");
    this.#db.exec(SCHEMA);
    // A table made before these columns existed. Old rows come out unscreened, and the screen picks them up.
    this.#addColumn("entries", "verdict", "TEXT CHECK (verdict IN ('allow', 'flagged', 'blocked'))");
    this.#addColumn("entries", "verdict_detail", "TEXT");
    this.#addColumn("sessions", "acked_screened", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumn("sessions", "peer_screened_through", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumn("sessions", "peer_eta_told", "INTEGER NOT NULL DEFAULT 0");
    this.#db.exec("CREATE INDEX IF NOT EXISTS entries_unscreened ON entries(agent_id, session_id, position) WHERE state = 'received' AND verdict IS NULL");
  }

  #addColumn(table: string, column: string, definition: string): void {
    const columns = this.#prep(`PRAGMA table_info(${table})`).all([]) as { name: string }[];
    if (!columns.some((c) => c.name === column)) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  // The driver's types want one exact byte-array type. Our bytes are all plain Uint8Array.
  #prep(sql: string): { run(params: unknown[]): unknown; get(params: unknown[]): unknown; all(params: unknown[]): unknown[] } {
    return this.#db.prepare(sql) as never;
  }

  close(): void {
    this.#db.close();
  }

  transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  getConfig(key: string): string | undefined {
    return (this.#prep("SELECT value FROM config WHERE key = ?").get([key]) as { value: string } | undefined)?.value;
  }

  setConfig(key: string, value: string): void {
    this.#prep("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run([key, value]);
  }

  insertAgent(agentId: Uint8Array, name: string, edSeed: Uint8Array, pqSeed: Uint8Array): void {
    this.#prep("INSERT INTO agents (agent_id, name, ed_seed, pq_seed) VALUES (?, ?, ?, ?)").run([agentId, name, edSeed, pqSeed]);
  }

  markRegistered(agentId: Uint8Array): void {
    this.#prep("UPDATE agents SET registered = 1 WHERE agent_id = ?").run([agentId]);
  }

  agents(): AgentRow[] {
    return this.#prep("SELECT * FROM agents ORDER BY rowid").all([]) as unknown as AgentRow[];
  }

  insertSession(row: Pick<SessionRow, "agent_id" | "session_id" | "role" | "counterparty_id" | "counterparty_name" | "counterparty_keys" | "state" | "offer"> & SessionUpdate): void {
    const keys = Object.keys(row) as (keyof typeof row)[];
    const sql = `INSERT INTO sessions (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
    this.#prep(sql).run(keys.map((k) => row[k]));
  }

  updateSession(agentId: Uint8Array, sessionId: Uint8Array, update: SessionUpdate): void {
    const keys = Object.keys(update) as (keyof SessionUpdate)[];
    if (keys.length === 0) return;
    const sql = `UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE agent_id = ? AND session_id = ?`;
    this.#prep(sql).run([...keys.map((k) => update[k]), agentId, sessionId]);
  }

  session(agentId: Uint8Array, sessionId: Uint8Array): SessionRow | undefined {
    return this.#prep("SELECT * FROM sessions WHERE agent_id = ? AND session_id = ?").get([agentId, sessionId]) as SessionRow | undefined;
  }

  sessionsOf(agentId: Uint8Array): SessionRow[] {
    return this.#prep("SELECT * FROM sessions WHERE agent_id = ? ORDER BY rowid").all([agentId]) as unknown as SessionRow[];
  }

  insertEntry(row: Omit<EntryRow, "id" | "ciphertext" | "ack" | "position" | "verdict" | "verdict_detail"> & { position?: number | null; ack?: string | null; ciphertext?: Uint8Array | null }): void {
    this.#prep(
      "INSERT INTO entries (agent_id, session_id, entry_hash, position, state, own, entry, ack, ciphertext, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run([row.agent_id, row.session_id, row.entry_hash, row.position ?? null, row.state, row.own, row.entry, row.ack ?? null, row.ciphertext ?? null, row.body]);
  }

  ownEntryByHash(agentId: Uint8Array, sessionId: Uint8Array, hash: Uint8Array): EntryRow | undefined {
    return this.#prep("SELECT * FROM entries WHERE agent_id = ? AND session_id = ? AND entry_hash = ? AND own = 1").get([agentId, sessionId, hash]) as EntryRow | undefined;
  }

  markLanded(id: number, position: number, ack: string): void {
    this.#prep("UPDATE entries SET state = 'landed', position = ?, ack = ?, ciphertext = NULL WHERE id = ?").run([position, ack, id]);
  }

  markNotSent(id: number): void {
    this.#prep("UPDATE entries SET state = 'not_sent', ciphertext = NULL WHERE id = ?").run([id]);
  }

  pendingEntries(agentId: Uint8Array, sessionId: Uint8Array): EntryRow[] {
    return this.#prep("SELECT * FROM entries WHERE agent_id = ? AND session_id = ? AND state = 'pending' ORDER BY id").all([agentId, sessionId]) as unknown as EntryRow[];
  }

  // The last entry in this author's chain, landed or still trying to.
  lastOwnEntry(agentId: Uint8Array, sessionId: Uint8Array): EntryRow | undefined {
    return this.#prep("SELECT * FROM entries WHERE agent_id = ? AND session_id = ? AND own = 1 AND state IN ('pending', 'landed') ORDER BY id DESC LIMIT 1").get([agentId, sessionId]) as EntryRow | undefined;
  }

  lastPeerEntry(agentId: Uint8Array, sessionId: Uint8Array): EntryRow | undefined {
    return this.#prep("SELECT * FROM entries WHERE agent_id = ? AND session_id = ? AND own = 0 ORDER BY position DESC LIMIT 1").get([agentId, sessionId]) as EntryRow | undefined;
  }

  standbyTold(agentId: Uint8Array, sessionId: Uint8Array, position: number): boolean {
    return this.#prep("SELECT 1 FROM standby_told WHERE agent_id = ? AND session_id = ? AND position = ?").get([agentId, sessionId, position]) !== undefined;
  }

  markStandbyTold(agentId: Uint8Array, sessionId: Uint8Array, position: number): void {
    this.#prep("INSERT INTO standby_told (agent_id, session_id, position) VALUES (?, ?, ?)").run([agentId, sessionId, position]);
  }

  verifiedEntries(agentId: Uint8Array, sessionId: Uint8Array, throughPosition: number): EntryRow[] {
    return this.#prep("SELECT * FROM entries WHERE agent_id = ? AND session_id = ? AND position IS NOT NULL AND position <= ? ORDER BY position").all([agentId, sessionId, throughPosition]) as unknown as EntryRow[];
  }

  // The rest of these leave the message bodies on disk. They run for every message, and the reads are synchronous,
  // so loading a long history here stops every other agent on this daemon until it's done.
  unreadCount(agentId: Uint8Array, sessionId: Uint8Array, readPosition: number): number {
    return (this.#prep("SELECT count(*) AS c FROM entries WHERE agent_id = ? AND session_id = ? AND state = 'received' AND position > ?").get([agentId, sessionId, readPosition]) as { c: number }).c;
  }

  firstUnscreened(agentId: Uint8Array, sessionId: Uint8Array): number | undefined {
    return (this.#prep("SELECT min(position) AS first FROM entries WHERE agent_id = ? AND session_id = ? AND state = 'received' AND verdict IS NULL").get([agentId, sessionId]) as { first: number | null }).first ?? undefined;
  }

  deliverableCount(agentId: Uint8Array, sessionId: Uint8Array, readPosition: number): number {
    const stop = this.firstUnscreened(agentId, sessionId) ?? Number.MAX_SAFE_INTEGER;
    return (this.#prep("SELECT count(*) AS c FROM entries WHERE agent_id = ? AND session_id = ? AND state = 'received' AND position > ? AND position < ?").get([agentId, sessionId, readPosition, stop]) as { c: number }).c;
  }

  // Sizes and ids only: a queue can be long, and this runs on the thread every agent shares.
  unscreened(): UnscreenedRow[] {
    return this.#prep("SELECT e.id, e.agent_id, e.session_id, e.position, s.counterparty_id AS sender, length(e.body) AS size FROM entries e JOIN sessions s ON s.agent_id = e.agent_id AND s.session_id = e.session_id WHERE e.state = 'received' AND e.verdict IS NULL ORDER BY e.position").all([]) as unknown as UnscreenedRow[];
  }

  entryAt(agentId: Uint8Array, sessionId: Uint8Array, position: number): Pick<EntryRow, "entry" | "verdict"> | undefined {
    return this.#prep("SELECT entry, verdict FROM entries WHERE agent_id = ? AND session_id = ? AND position = ?").get([agentId, sessionId, position]) as Pick<EntryRow, "entry" | "verdict"> | undefined;
  }

  bodyOf(id: number): Uint8Array | undefined {
    return (this.#prep("SELECT body FROM entries WHERE id = ?").get([id]) as { body: Uint8Array } | undefined)?.body;
  }

  setVerdict(id: number, verdict: string, detail: string): void {
    this.#prep("UPDATE entries SET verdict = ?, verdict_detail = ? WHERE id = ? AND verdict IS NULL").run([verdict, detail, id]);
  }

  entryIdAt(agentId: Uint8Array, sessionId: Uint8Array, position: number): number | undefined {
    return (this.#prep("SELECT id FROM entries WHERE agent_id = ? AND session_id = ? AND position = ?").get([agentId, sessionId, position]) as { id: number } | undefined)?.id;
  }

  countOwnAfter(agentId: Uint8Array, sessionId: Uint8Array, position: number): number {
    return (this.#prep("SELECT count(*) AS c FROM entries WHERE agent_id = ? AND session_id = ? AND own = 1 AND state = 'landed' AND position > ?").get([agentId, sessionId, position]) as { c: number }).c;
  }

  screeningRule(agentId: Uint8Array, scope: "sender" | "tier", subject: string): string | undefined {
    return (this.#prep("SELECT level FROM screening_rules WHERE agent_id = ? AND scope = ? AND subject = ?").get([agentId, scope, subject]) as { level: string } | undefined)?.level;
  }

  setScreeningRule(agentId: Uint8Array, subject: string, level: string): void {
    const now = Date.now();
    this.transaction(() => {
      this.#prep("INSERT INTO screening_rules (agent_id, scope, subject, level, set_at) VALUES (?, 'sender', ?, ?, ?) ON CONFLICT (agent_id, scope, subject) DO UPDATE SET level = excluded.level, set_at = excluded.set_at").run([agentId, subject, level, now]);
      this.#prep("INSERT INTO screening_changes (agent_id, subject, level, at) VALUES (?, ?, ?, ?)").run([agentId, subject, level, now]);
    });
  }

  screeningRules(agentId: Uint8Array): { subject: string; level: string; set_at: number }[] {
    return this.#prep("SELECT subject, level, set_at FROM screening_rules WHERE agent_id = ? AND scope = 'sender' ORDER BY set_at").all([agentId]) as unknown as { subject: string; level: string; set_at: number }[];
  }

  unreadBounds(agentId: Uint8Array, sessionId: Uint8Array, readPosition: number): { first: number; last: number } | undefined {
    const row = this.#prep("SELECT min(position) AS first, max(position) AS last FROM entries WHERE agent_id = ? AND session_id = ? AND state = 'received' AND position > ?").get([agentId, sessionId, readPosition]) as { first: number | null; last: number | null };
    return row.first === null || row.last === null ? undefined : { first: row.first, last: row.last };
  }

  ackAt(agentId: Uint8Array, sessionId: Uint8Array, position: number): string | null | undefined {
    return (this.#prep("SELECT ack FROM entries WHERE agent_id = ? AND session_id = ? AND position = ?").get([agentId, sessionId, position]) as { ack: string | null } | undefined)?.ack;
  }

  signedRecord(agentId: Uint8Array, sessionId: Uint8Array, throughPosition: number): Pick<EntryRow, "entry" | "ack" | "position">[] {
    return this.#prep("SELECT entry, ack, position FROM entries WHERE agent_id = ? AND session_id = ? AND position IS NOT NULL AND position <= ? ORDER BY position").all([agentId, sessionId, throughPosition]) as unknown as Pick<EntryRow, "entry" | "ack" | "position">[];
  }

  // The last position that fits in maxBytes of bodies, and at least the first. Sizes come from the row header, not the body.
  #pageEnd(where: string, params: unknown[], maxBytes: number): { through: number; more: boolean } | undefined {
    const sizes = this.#prep(`SELECT position, length(body) AS size FROM entries WHERE ${where} ORDER BY position`).all(params) as { position: number; size: number }[];
    let used = 0;
    let through: number | undefined;
    for (const row of sizes) {
      used += row.size;
      if (through !== undefined && used > maxBytes) return { through, more: true };
      through = row.position;
    }
    return through === undefined ? undefined : { through, more: false };
  }

  // What can be delivered: everything unread with a verdict, up to the first without one. Nothing overtakes.
  unreadPage(agentId: Uint8Array, sessionId: Uint8Array, readPosition: number, maxBytes: number): { rows: EntryRow[]; more: boolean } {
    const stop = this.firstUnscreened(agentId, sessionId) ?? Number.MAX_SAFE_INTEGER;
    const end = this.#pageEnd("agent_id = ? AND session_id = ? AND state = 'received' AND position > ? AND position < ?", [agentId, sessionId, readPosition, stop], maxBytes);
    if (!end) return { rows: [], more: false };
    const rows = this.#prep("SELECT * FROM entries WHERE agent_id = ? AND session_id = ? AND state = 'received' AND position > ? AND position <= ? ORDER BY position").all([agentId, sessionId, readPosition, end.through]) as unknown as EntryRow[];
    return { rows, more: end.more };
  }

  recordPage(agentId: Uint8Array, sessionId: Uint8Array, after: number, throughPosition: number, maxBytes: number): { rows: EntryRow[]; more: boolean } {
    const end = this.#pageEnd("agent_id = ? AND session_id = ? AND position IS NOT NULL AND position > ? AND position <= ?", [agentId, sessionId, after, throughPosition], maxBytes);
    if (!end) return { rows: [], more: false };
    const rows = this.#prep("SELECT * FROM entries WHERE agent_id = ? AND session_id = ? AND position IS NOT NULL AND position > ? AND position <= ? ORDER BY position").all([agentId, sessionId, after, end.through]) as unknown as EntryRow[];
    return { rows, more: end.more };
  }

  addNotice(agentId: Uint8Array, sessionId: Uint8Array | null, text: string): void {
    this.#prep("INSERT INTO notices (agent_id, session_id, text) VALUES (?, ?, ?)").run([agentId, sessionId, text]);
  }

  notices(agentId: Uint8Array): NoticeRow[] {
    return this.#prep("SELECT id, session_id, text FROM notices WHERE agent_id = ? ORDER BY id").all([agentId]) as unknown as NoticeRow[];
  }

  clearNotices(agentId: Uint8Array, throughId: number): void {
    this.#prep("DELETE FROM notices WHERE agent_id = ? AND id <= ?").run([agentId, throughId]);
  }

  addSealWant(agentId: Uint8Array, sessionId: Uint8Array, through: number): void {
    this.#prep("INSERT OR IGNORE INTO seal_wants (agent_id, session_id, through) VALUES (?, ?, ?)").run([agentId, sessionId, through]);
  }

  removeSealWant(agentId: Uint8Array, sessionId: Uint8Array, through: number): void {
    this.#prep("DELETE FROM seal_wants WHERE agent_id = ? AND session_id = ? AND through = ?").run([agentId, sessionId, through]);
  }

  sealWants(agentId: Uint8Array, sessionId?: Uint8Array): SealWantRow[] {
    if (sessionId) return this.#prep("SELECT session_id, through FROM seal_wants WHERE agent_id = ? AND session_id = ? ORDER BY through").all([agentId, sessionId]) as unknown as SealWantRow[];
    return this.#prep("SELECT session_id, through FROM seal_wants WHERE agent_id = ? ORDER BY rowid").all([agentId]) as unknown as SealWantRow[];
  }

  // A repeat from the server is the same certificate, so storing it twice changes nothing.
  addSeal(agentId: Uint8Array, sealId: Uint8Array, sessionId: Uint8Array, record: string): void {
    this.#prep("INSERT OR IGNORE INTO seals (agent_id, seal_id, session_id, record) VALUES (?, ?, ?, ?)").run([agentId, sealId, sessionId, record]);
  }

  seals(agentId: Uint8Array, sessionId?: Uint8Array): SealRow[] {
    if (sessionId) return this.#prep("SELECT seal_id, session_id, record FROM seals WHERE agent_id = ? AND session_id = ? ORDER BY rowid").all([agentId, sessionId]) as unknown as SealRow[];
    return this.#prep("SELECT seal_id, session_id, record FROM seals WHERE agent_id = ? ORDER BY rowid").all([agentId]) as unknown as SealRow[];
  }

  seal(agentId: Uint8Array, sealId: Uint8Array): SealRow | undefined {
    return this.#prep("SELECT seal_id, session_id, record FROM seals WHERE agent_id = ? AND seal_id = ?").get([agentId, sealId]) as SealRow | undefined;
  }
}

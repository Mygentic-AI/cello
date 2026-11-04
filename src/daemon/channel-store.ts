// A channel's durable state on this machine, in the daemon's SQLCipher database. A reader's position lives here and
// nowhere else, and this is the only place a private post's plaintext exists once it's been read off the wire.
import type { Store } from "./store.ts";

const SCHEMA = `
-- What an admin alone holds. The seeds are the channel key: lose them and the channel can't change again.
CREATE TABLE IF NOT EXISTS channel_owned (
  channel_id    BLOB PRIMARY KEY,
  agent_id      BLOB NOT NULL REFERENCES agents(agent_id),
  ed_seed       BLOB NOT NULL,
  pq_seed       BLOB NOT NULL,
  x25519_secret BLOB NOT NULL,
  mlkem_seed    BLOB NOT NULL
);

-- position is the highest number with nothing unresolved at or below it. Only a post held, a signed first-held position,
-- or a post declared lost can move it. high is the highest number fetched, which can be above a gap.
CREATE TABLE IF NOT EXISTS channel_follows (
  agent_id        BLOB NOT NULL REFERENCES agents(agent_id),
  channel_id      BLOB NOT NULL,
  record          TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('active', 'pending', 'refused', 'ejected', 'left')),
  x25519_secret   BLOB,
  mlkem_seed      BLOB,
  x25519_public   BLOB,
  mlkem_public    BLOB,
  info            TEXT NOT NULL,
  info_revision   INTEGER NOT NULL,
  delivery        TEXT NOT NULL DEFAULT 'follow' CHECK (delivery IN ('follow', 'pull')),
  screen_bodies   TEXT NOT NULL DEFAULT 'read' CHECK (screen_bodies IN ('read', 'arrival')),
  position        INTEGER NOT NULL DEFAULT 0,
  high            INTEGER NOT NULL DEFAULT 0,
  first_held      INTEGER NOT NULL DEFAULT 1,
  tip             INTEGER NOT NULL DEFAULT 0,
  aged_out        INTEGER NOT NULL DEFAULT 0,
  readers         INTEGER,
  roster          TEXT,
  roster_revision INTEGER NOT NULL DEFAULT 0,
  roster_hash     BLOB,
  PRIMARY KEY (agent_id, channel_id)
);

CREATE TABLE IF NOT EXISTS channel_keys (
  agent_id   BLOB NOT NULL,
  channel_id BLOB NOT NULL,
  generation INTEGER NOT NULL,
  group_key  BLOB NOT NULL,
  PRIMARY KEY (agent_id, channel_id, generation)
);

-- Who the signed rosters listed under each generation, so a post is checked against the generation it was written in.
CREATE TABLE IF NOT EXISTS channel_roster_members (
  agent_id   BLOB NOT NULL,
  channel_id BLOB NOT NULL,
  generation INTEGER NOT NULL,
  member_id  BLOB NOT NULL,
  PRIMARY KEY (agent_id, channel_id, generation, member_id)
);

CREATE TABLE IF NOT EXISTS channel_posts (
  agent_id      BLOB NOT NULL,
  channel_id    BLOB NOT NULL,
  position      INTEGER NOT NULL,
  author_id     BLOB,
  author_name   TEXT,
  author_seq    INTEGER,
  generation    INTEGER,
  published_at  INTEGER,
  title         BLOB,
  body          BLOB,
  state         TEXT NOT NULL CHECK (state IN ('unread', 'read', 'blocked', 'unopenable', 'refused')),
  title_verdict TEXT NOT NULL DEFAULT 'pending' CHECK (title_verdict IN ('pending', 'clean', 'blocked')),
  body_verdict  TEXT NOT NULL DEFAULT 'pending' CHECK (body_verdict IN ('pending', 'clean', 'blocked')),
  PRIMARY KEY (agent_id, channel_id, position)
);
CREATE INDEX IF NOT EXISTS channel_posts_state ON channel_posts(agent_id, channel_id, state, position);
CREATE INDEX IF NOT EXISTS channel_posts_author ON channel_posts(agent_id, channel_id, author_id, author_seq);

CREATE TABLE IF NOT EXISTS channel_gaps (
  agent_id   BLOB NOT NULL,
  channel_id BLOB NOT NULL,
  position   INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('missing', 'lost')),
  PRIMARY KEY (agent_id, channel_id, position)
);

CREATE TABLE IF NOT EXISTS channel_notices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   BLOB NOT NULL,
  channel_id BLOB NOT NULL,
  text       TEXT NOT NULL
);

-- The publisher's own copy. It holds the plaintext, because a new key generation has to seal a waiting post again.
CREATE TABLE IF NOT EXISTS channel_log (
  agent_id   BLOB NOT NULL,
  channel_id BLOB NOT NULL,
  author_seq INTEGER NOT NULL,
  title      BLOB NOT NULL,
  body       BLOB NOT NULL,
  wire       TEXT NOT NULL,
  position   INTEGER,
  ack        TEXT,
  PRIMARY KEY (agent_id, channel_id, author_seq)
);

-- A report of a lost post that's already been passed on, so a restart doesn't tell it twice.
CREATE TABLE IF NOT EXISTS channel_lost_told (
  agent_id   BLOB NOT NULL,
  channel_id BLOB NOT NULL,
  position   INTEGER NOT NULL,
  PRIMARY KEY (agent_id, channel_id, position)
);
`;

export interface OwnedRow { channel_id: Uint8Array; agent_id: Uint8Array; ed_seed: Uint8Array; pq_seed: Uint8Array; x25519_secret: Uint8Array; mlkem_seed: Uint8Array }
export type FollowState = "active" | "pending" | "refused" | "ejected" | "left";
export interface FollowRow {
  agent_id: Uint8Array;
  channel_id: Uint8Array;
  record: string;
  state: FollowState;
  x25519_secret: Uint8Array | null;
  mlkem_seed: Uint8Array | null;
  x25519_public: Uint8Array | null;
  mlkem_public: Uint8Array | null;
  info: string;
  info_revision: number;
  delivery: "follow" | "pull";
  screen_bodies: "read" | "arrival";
  position: number;
  high: number;
  first_held: number;
  tip: number;
  aged_out: number;
  readers: number | null;
  roster: string | null;
  roster_revision: number;
  roster_hash: Uint8Array | null;
}
export type Verdict = "pending" | "clean" | "blocked";
export interface PostRow {
  position: number;
  author_id: Uint8Array | null;
  author_name: string | null;
  author_seq: number | null;
  generation: number | null;
  published_at: number | null;
  title: Uint8Array | null;
  body: Uint8Array | null;
  state: "unread" | "read" | "blocked" | "unopenable" | "refused";
  title_verdict: Verdict;
  body_verdict: Verdict;
}
export interface GapRow { position: number; first_seen: number; state: "missing" | "lost" }
export interface LogRow { author_seq: number; title: Uint8Array; body: Uint8Array; wire: string; position: number | null }

type FollowProgress = Partial<Pick<FollowRow, "position" | "high" | "first_held" | "tip" | "readers" | "state" | "info" | "info_revision" | "delivery" | "screen_bodies" | "roster" | "roster_revision" | "roster_hash">>;

export class ChannelStore {
  readonly #db: ReturnType<Store["raw"]>;

  constructor(store: Store) {
    this.#db = store.raw();
    this.#db.exec(SCHEMA);
  }

  transaction<T>(work: () => T): T {
    return this.#db.transaction(work);
  }

  insertOwned(row: OwnedRow): void {
    this.#db.run("INSERT INTO channel_owned (channel_id, agent_id, ed_seed, pq_seed, x25519_secret, mlkem_seed) VALUES (?, ?, ?, ?, ?, ?)", [row.channel_id, row.agent_id, row.ed_seed, row.pq_seed, row.x25519_secret, row.mlkem_seed]);
  }

  owned(channel: Uint8Array): OwnedRow | undefined {
    return this.#db.get("SELECT * FROM channel_owned WHERE channel_id = ?", [channel]) as OwnedRow | undefined;
  }

  // A create the server refused, so that nothing stays half-made here either.
  forgetCreated(agent: Uint8Array, channel: Uint8Array): void {
    this.#db.transaction(() => {
      this.#db.run("DELETE FROM channel_roster_members WHERE agent_id = ? AND channel_id = ?", [agent, channel]);
      this.#db.run("DELETE FROM channel_keys WHERE agent_id = ? AND channel_id = ?", [agent, channel]);
      this.#db.run("DELETE FROM channel_follows WHERE agent_id = ? AND channel_id = ?", [agent, channel]);
      this.#db.run("DELETE FROM channel_owned WHERE channel_id = ?", [channel]);
    });
  }

  follow(agent: Uint8Array, channel: Uint8Array): FollowRow | undefined {
    return this.#db.get("SELECT * FROM channel_follows WHERE agent_id = ? AND channel_id = ?", [agent, channel]) as FollowRow | undefined;
  }

  follows(agent: Uint8Array): FollowRow[] {
    return this.#db.all("SELECT * FROM channel_follows WHERE agent_id = ?", [agent]) as FollowRow[];
  }

  putFollow(row: Pick<FollowRow, "agent_id" | "channel_id" | "record" | "state" | "x25519_secret" | "mlkem_seed" | "x25519_public" | "mlkem_public" | "info" | "info_revision">): void {
    this.#db.run(
      `INSERT INTO channel_follows (agent_id, channel_id, record, state, x25519_secret, mlkem_seed, x25519_public, mlkem_public, info, info_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, channel_id) DO UPDATE SET state = excluded.state, x25519_secret = excluded.x25519_secret, mlkem_seed = excluded.mlkem_seed, x25519_public = excluded.x25519_public, mlkem_public = excluded.mlkem_public`,
      [row.agent_id, row.channel_id, row.record, row.state, row.x25519_secret, row.mlkem_seed, row.x25519_public, row.mlkem_public, row.info, row.info_revision],
    );
  }

  updateFollow(agent: Uint8Array, channel: Uint8Array, changes: FollowProgress): void {
    const columns = Object.keys(changes);
    if (columns.length === 0) return;
    this.#db.run(
      `UPDATE channel_follows SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE agent_id = ? AND channel_id = ?`,
      [...columns.map((column) => changes[column as keyof FollowProgress]), agent, channel],
    );
  }

  addAgedOut(agent: Uint8Array, channel: Uint8Array, count: number): void {
    this.#db.run("UPDATE channel_follows SET aged_out = aged_out + ? WHERE agent_id = ? AND channel_id = ?", [count, agent, channel]);
  }

  putKey(agent: Uint8Array, channel: Uint8Array, generation: number, key: Uint8Array): void {
    this.#db.run("INSERT INTO channel_keys (agent_id, channel_id, generation, group_key) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", [agent, channel, generation, key]);
  }

  key(agent: Uint8Array, channel: Uint8Array, generation: number): Uint8Array | undefined {
    const row = this.#db.get("SELECT group_key FROM channel_keys WHERE agent_id = ? AND channel_id = ? AND generation = ?", [agent, channel, generation]) as { group_key: Uint8Array } | undefined;
    return row?.group_key;
  }

  highestKey(agent: Uint8Array, channel: Uint8Array): number {
    const row = this.#db.get("SELECT max(generation) AS g FROM channel_keys WHERE agent_id = ? AND channel_id = ?", [agent, channel]) as { g: number | null };
    return row.g ?? 0;
  }

  addRosterMember(agent: Uint8Array, channel: Uint8Array, generation: number, member: Uint8Array): void {
    this.#db.run("INSERT INTO channel_roster_members (agent_id, channel_id, generation, member_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", [agent, channel, generation, member]);
  }

  wasOnRoster(agent: Uint8Array, channel: Uint8Array, generation: number, member: Uint8Array): boolean {
    return this.#db.get("SELECT 1 AS found FROM channel_roster_members WHERE agent_id = ? AND channel_id = ? AND generation = ? AND member_id = ?", [agent, channel, generation, member]) !== undefined;
  }

  hasPost(agent: Uint8Array, channel: Uint8Array, position: number): boolean {
    return this.#db.get("SELECT 1 AS found FROM channel_posts WHERE agent_id = ? AND channel_id = ? AND position = ?", [agent, channel, position]) !== undefined;
  }

  // What a replay would have to get past: this author's number, compared with the ones already held before this position.
  authorSeqTaken(agent: Uint8Array, channel: Uint8Array, author: Uint8Array, seq: number, position: number): boolean {
    const row = this.#db.get(
      "SELECT 1 AS found FROM channel_posts WHERE agent_id = ? AND channel_id = ? AND author_id = ? AND ((author_seq >= ? AND position < ?) OR author_seq = ?) LIMIT 1",
      [agent, channel, author, seq, position, seq],
    );
    return row !== undefined;
  }

  highestGenerationBefore(agent: Uint8Array, channel: Uint8Array, position: number): number {
    const row = this.#db.get("SELECT max(generation) AS g FROM channel_posts WHERE agent_id = ? AND channel_id = ? AND position < ?", [agent, channel, position]) as { g: number | null };
    return row.g ?? 0;
  }

  insertPost(agent: Uint8Array, channel: Uint8Array, post: Omit<PostRow, never>): void {
    this.#db.run(
      `INSERT INTO channel_posts (agent_id, channel_id, position, author_id, author_name, author_seq, generation, published_at, title, body, state, title_verdict, body_verdict)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [agent, channel, post.position, post.author_id, post.author_name, post.author_seq, post.generation, post.published_at, post.title, post.body, post.state, post.title_verdict, post.body_verdict],
    );
  }

  post(agent: Uint8Array, channel: Uint8Array, position: number): PostRow | undefined {
    return this.#db.get("SELECT * FROM channel_posts WHERE agent_id = ? AND channel_id = ? AND position = ?", [agent, channel, position]) as PostRow | undefined;
  }

  unread(agent: Uint8Array, channel: Uint8Array, limit: number): PostRow[] {
    return this.#db.all("SELECT * FROM channel_posts WHERE agent_id = ? AND channel_id = ? AND state IN ('unread', 'unopenable') ORDER BY position LIMIT ?", [agent, channel, limit]) as PostRow[];
  }

  history(agent: Uint8Array, channel: Uint8Array, after: number, limit: number): PostRow[] {
    return this.#db.all("SELECT * FROM channel_posts WHERE agent_id = ? AND channel_id = ? AND position > ? AND state IN ('unread', 'read', 'blocked') ORDER BY position LIMIT ?", [agent, channel, after, limit]) as PostRow[];
  }

  pendingVerdicts(agent: Uint8Array, channel: Uint8Array, limit: number): PostRow[] {
    return this.#db.all("SELECT * FROM channel_posts WHERE agent_id = ? AND channel_id = ? AND state = 'unread' AND title_verdict = 'pending' ORDER BY position LIMIT ?", [agent, channel, limit]) as PostRow[];
  }

  unreadCount(agent: Uint8Array, channel: Uint8Array): number {
    return (this.#db.get("SELECT count(*) AS c FROM channel_posts WHERE agent_id = ? AND channel_id = ? AND state = 'unread'", [agent, channel]) as { c: number }).c;
  }

  setVerdicts(agent: Uint8Array, channel: Uint8Array, position: number, title: Verdict, body: Verdict): void {
    this.#db.run("UPDATE channel_posts SET title_verdict = ?, body_verdict = ? WHERE agent_id = ? AND channel_id = ? AND position = ?", [title, body, agent, channel, position]);
  }

  // A blocked post's text has no further use on this machine, and it counts as delivered.
  blockPost(agent: Uint8Array, channel: Uint8Array, position: number, title: Verdict, body: Verdict): void {
    this.#db.run("UPDATE channel_posts SET state = 'blocked', title = NULL, body = NULL, title_verdict = ?, body_verdict = ? WHERE agent_id = ? AND channel_id = ? AND position = ?", [title, body, agent, channel, position]);
  }

  markRead(agent: Uint8Array, channel: Uint8Array, positions: readonly number[]): void {
    this.#db.transaction(() => {
      for (const position of positions) this.#db.run("UPDATE channel_posts SET state = 'read' WHERE agent_id = ? AND channel_id = ? AND position = ? AND state IN ('unread', 'unopenable')", [agent, channel, position]);
    });
  }

  gaps(agent: Uint8Array, channel: Uint8Array): GapRow[] {
    return this.#db.all("SELECT position, first_seen, state FROM channel_gaps WHERE agent_id = ? AND channel_id = ? ORDER BY position", [agent, channel]) as GapRow[];
  }

  putGap(agent: Uint8Array, channel: Uint8Array, position: number, firstSeen: number): void {
    this.#db.run("INSERT INTO channel_gaps (agent_id, channel_id, position, first_seen, state) VALUES (?, ?, ?, ?, 'missing') ON CONFLICT DO NOTHING", [agent, channel, position, firstSeen]);
  }

  markGapLost(agent: Uint8Array, channel: Uint8Array, position: number): void {
    this.#db.run("UPDATE channel_gaps SET state = 'lost' WHERE agent_id = ? AND channel_id = ? AND position = ?", [agent, channel, position]);
  }

  deleteGap(agent: Uint8Array, channel: Uint8Array, position: number): void {
    this.#db.run("DELETE FROM channel_gaps WHERE agent_id = ? AND channel_id = ? AND position = ?", [agent, channel, position]);
  }

  addNotice(agent: Uint8Array, channel: Uint8Array, text: string): void {
    this.#db.run("INSERT INTO channel_notices (agent_id, channel_id, text) VALUES (?, ?, ?)", [agent, channel, text]);
  }

  notices(agent: Uint8Array, channel: Uint8Array): { id: number; text: string }[] {
    return this.#db.all("SELECT id, text FROM channel_notices WHERE agent_id = ? AND channel_id = ? ORDER BY id", [agent, channel]) as { id: number; text: string }[];
  }

  deleteNotices(ids: readonly number[]): void {
    for (const id of ids) this.#db.run("DELETE FROM channel_notices WHERE id = ?", [id]);
  }

  nextAuthorSeq(agent: Uint8Array, channel: Uint8Array): number {
    const row = this.#db.get("SELECT max(author_seq) AS m FROM channel_log WHERE agent_id = ? AND channel_id = ?", [agent, channel]) as { m: number | null };
    return (row.m ?? 0) + 1;
  }

  addLog(agent: Uint8Array, channel: Uint8Array, seq: number, title: Uint8Array, body: Uint8Array, wire: string): void {
    this.#db.run("INSERT INTO channel_log (agent_id, channel_id, author_seq, title, body, wire) VALUES (?, ?, ?, ?, ?, ?)", [agent, channel, seq, title, body, wire]);
  }

  setLogWire(agent: Uint8Array, channel: Uint8Array, seq: number, wire: string): void {
    this.#db.run("UPDATE channel_log SET wire = ? WHERE agent_id = ? AND channel_id = ? AND author_seq = ?", [wire, agent, channel, seq]);
  }

  landLog(agent: Uint8Array, channel: Uint8Array, seq: number, position: number, ack: string): void {
    this.#db.run("UPDATE channel_log SET position = ?, ack = ? WHERE agent_id = ? AND channel_id = ? AND author_seq = ?", [position, ack, agent, channel, seq]);
  }

  // Refused for good, so its number can be used again and no reader sees a jump.
  deleteLog(agent: Uint8Array, channel: Uint8Array, seq: number): void {
    this.#db.run("DELETE FROM channel_log WHERE agent_id = ? AND channel_id = ? AND author_seq = ?", [agent, channel, seq]);
  }

  waitingLog(agent: Uint8Array, channel: Uint8Array): LogRow[] {
    return this.#db.all("SELECT author_seq, title, body, wire, position FROM channel_log WHERE agent_id = ? AND channel_id = ? AND position IS NULL ORDER BY author_seq", [agent, channel]) as LogRow[];
  }

  logOwnsPosition(agent: Uint8Array, channel: Uint8Array, position: number): boolean {
    return this.#db.get("SELECT 1 AS found FROM channel_log WHERE agent_id = ? AND channel_id = ? AND position = ?", [agent, channel, position]) !== undefined;
  }

  markLostTold(agent: Uint8Array, channel: Uint8Array, position: number): boolean {
    const row = this.#db.get("INSERT INTO channel_lost_told (agent_id, channel_id, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING position", [agent, channel, position]);
    return row !== undefined;
  }
}

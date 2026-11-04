// A channel's durable state on this machine, in the daemon's SQLCipher database. Positions live here and nowhere else:
// no store or server can move one. Plaintext of posts is here too, which is why it's never on a store.
import type { Store } from "./store.ts";

const SCHEMA = `
-- What an admin alone holds. The seeds are the channel key: lose them and the channel can't change again.
CREATE TABLE IF NOT EXISTS channel_owned (
  channel_id    BLOB PRIMARY KEY,
  agent_id      BLOB NOT NULL REFERENCES agents(agent_id),
  ed_seed       BLOB NOT NULL,
  pq_seed       BLOB NOT NULL,
  x25519_secret BLOB NOT NULL,
  mlkem_seed    BLOB NOT NULL,
  next_info_rev INTEGER NOT NULL DEFAULT 2
);

-- Newest revision per generation, so a wiped store can be refilled from here.
CREATE TABLE IF NOT EXISTS channel_bundles (
  channel_id BLOB NOT NULL,
  generation INTEGER NOT NULL,
  revision   INTEGER NOT NULL,
  file       TEXT NOT NULL,
  PRIMARY KEY (channel_id, generation)
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id    BLOB NOT NULL,
  member_id     BLOB NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'refused', 'ejected', 'left')),
  x25519_public BLOB NOT NULL,
  mlkem_public  BLOB NOT NULL,
  note          TEXT NOT NULL,
  requested_at  INTEGER NOT NULL,
  pass          TEXT,
  pass_expires  INTEGER,
  PRIMARY KEY (channel_id, member_id)
);

-- A named poster on a public channel needs no membership, so passes are kept apart from members.
CREATE TABLE IF NOT EXISTS channel_posters (
  channel_id   BLOB NOT NULL,
  poster_id    BLOB NOT NULL,
  pass         TEXT NOT NULL,
  pass_expires INTEGER NOT NULL,
  PRIMARY KEY (channel_id, poster_id)
);

CREATE TABLE IF NOT EXISTS channel_follows (
  agent_id      BLOB NOT NULL REFERENCES agents(agent_id),
  channel_id    BLOB NOT NULL,
  record        TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('reading', 'waiting', 'refused', 'ejected', 'left')),
  x25519_secret BLOB,
  mlkem_seed    BLOB,
  x25519_public BLOB,
  mlkem_public  BLOB,
  info          TEXT,
  info_revision INTEGER NOT NULL DEFAULT 0,
  pass          TEXT,
  next_poll     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, channel_id)
);

CREATE TABLE IF NOT EXISTS channel_keys (
  agent_id   BLOB NOT NULL,
  channel_id BLOB NOT NULL,
  generation INTEGER NOT NULL,
  group_key  BLOB NOT NULL,
  retired    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, channel_id, generation)
);

-- position is the highest number with nothing unresolved at or below it. Only a held post, a signed floor,
-- a head older than the hard cap, or a post declared lost can move it.
CREATE TABLE IF NOT EXISTS channel_lanes (
  agent_id   BLOB NOT NULL,
  channel_id BLOB NOT NULL,
  generation INTEGER NOT NULL,
  lane_id    BLOB NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  floor      INTEGER NOT NULL DEFAULT 1,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  signed_at  INTEGER NOT NULL DEFAULT 0,
  aged_out   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, channel_id, generation, lane_id)
);

CREATE TABLE IF NOT EXISTS channel_posts (
  agent_id     BLOB NOT NULL,
  channel_id   BLOB NOT NULL,
  generation   INTEGER NOT NULL,
  lane_id      BLOB NOT NULL,
  seq          INTEGER NOT NULL,
  post_hash    BLOB NOT NULL,
  published_at INTEGER NOT NULL,
  title        BLOB,
  body         BLOB,
  state        TEXT NOT NULL CHECK (state IN ('unread', 'read', 'blocked', 'unopenable')),
  PRIMARY KEY (agent_id, channel_id, generation, lane_id, seq)
);
CREATE INDEX IF NOT EXISTS channel_posts_unread ON channel_posts(agent_id, channel_id, state, published_at);

CREATE TABLE IF NOT EXISTS channel_gaps (
  agent_id   BLOB NOT NULL,
  channel_id BLOB NOT NULL,
  generation INTEGER NOT NULL,
  lane_id    BLOB NOT NULL,
  seq        INTEGER NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('missing', 'lost')),
  rung       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, channel_id, generation, lane_id, seq)
);

CREATE TABLE IF NOT EXISTS channel_notices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   BLOB NOT NULL,
  channel_id BLOB NOT NULL,
  text       TEXT NOT NULL
);

-- The publisher's own copy, which outlives any store. This is what a refill sends.
CREATE TABLE IF NOT EXISTS channel_log (
  agent_id     BLOB NOT NULL,
  channel_id   BLOB NOT NULL,
  generation   INTEGER NOT NULL,
  lane_id      BLOB NOT NULL,
  seq          INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  file         TEXT NOT NULL,
  PRIMARY KEY (agent_id, channel_id, generation, lane_id, seq)
);

CREATE TABLE IF NOT EXISTS channel_log_acks (
  agent_id   BLOB NOT NULL,
  channel_id BLOB NOT NULL,
  generation INTEGER NOT NULL,
  lane_id    BLOB NOT NULL,
  seq        INTEGER NOT NULL,
  store      TEXT NOT NULL,
  ack        TEXT NOT NULL,
  PRIMARY KEY (agent_id, channel_id, generation, lane_id, seq, store)
);

CREATE TABLE IF NOT EXISTS channel_own_heads (
  agent_id   BLOB NOT NULL,
  channel_id BLOB NOT NULL,
  generation INTEGER NOT NULL,
  lane_id    BLOB NOT NULL,
  floor      INTEGER NOT NULL,
  last_seq   INTEGER NOT NULL,
  signed_at  INTEGER NOT NULL,
  cap        BLOB NOT NULL,
  file       TEXT NOT NULL,
  PRIMARY KEY (agent_id, channel_id, generation, lane_id)
);
`;

export interface OwnedRow { channel_id: Uint8Array; agent_id: Uint8Array; ed_seed: Uint8Array; pq_seed: Uint8Array; x25519_secret: Uint8Array; mlkem_seed: Uint8Array; next_info_rev: number }
export interface MemberRow { channel_id: Uint8Array; member_id: Uint8Array; state: "pending" | "approved" | "refused" | "ejected" | "left"; x25519_public: Uint8Array; mlkem_public: Uint8Array; note: string; requested_at: number; pass: string | null; pass_expires: number | null }
export interface PosterRow { channel_id: Uint8Array; poster_id: Uint8Array; pass: string; pass_expires: number }
export interface FollowRow {
  agent_id: Uint8Array;
  channel_id: Uint8Array;
  record: string;
  state: "reading" | "waiting" | "refused" | "ejected" | "left";
  x25519_secret: Uint8Array | null;
  mlkem_seed: Uint8Array | null;
  x25519_public: Uint8Array | null;
  mlkem_public: Uint8Array | null;
  info: string | null;
  info_revision: number;
  pass: string | null;
  next_poll: number;
}
export interface KeyRow { generation: number; group_key: Uint8Array; retired: number }
export interface LaneRow { generation: number; lane_id: Uint8Array; position: number; floor: number; last_seq: number; signed_at: number; aged_out: number }
export interface PostRow { generation: number; lane_id: Uint8Array; seq: number; post_hash: Uint8Array; published_at: number; title: Uint8Array | null; body: Uint8Array | null; state: "unread" | "read" | "blocked" | "unopenable" }
export interface GapRow { seq: number; state: "missing" | "lost"; rung: number }
export interface LogRow { generation: number; lane_id: Uint8Array; seq: number; published_at: number; file: string }
export interface OwnHeadRow { generation: number; lane_id: Uint8Array; floor: number; last_seq: number; signed_at: number; cap: Uint8Array; file: string }

interface LaneKey { agent: Uint8Array; channel: Uint8Array; generation: number; lane: Uint8Array }

export class ChannelStore {
  readonly #db: ReturnType<Store["raw"]>;

  constructor(store: Store) {
    this.#db = store.raw();
    this.#db.exec(SCHEMA);
  }

  transaction<T>(work: () => T): T {
    return this.#db.transaction(work);
  }

  insertOwned(row: Omit<OwnedRow, "next_info_rev">): void {
    this.#db.run("INSERT INTO channel_owned (channel_id, agent_id, ed_seed, pq_seed, x25519_secret, mlkem_seed) VALUES (?, ?, ?, ?, ?, ?)", [row.channel_id, row.agent_id, row.ed_seed, row.pq_seed, row.x25519_secret, row.mlkem_seed]);
  }

  owned(channel: Uint8Array): OwnedRow | undefined {
    return this.#db.get("SELECT * FROM channel_owned WHERE channel_id = ?", [channel]) as OwnedRow | undefined;
  }

  allOwned(): OwnedRow[] {
    return this.#db.all("SELECT * FROM channel_owned", []) as OwnedRow[];
  }

  takeInfoRevision(channel: Uint8Array): number {
    const row = this.#db.get("UPDATE channel_owned SET next_info_rev = next_info_rev + 1 WHERE channel_id = ? RETURNING next_info_rev - 1 AS revision", [channel]) as { revision: number };
    return row.revision;
  }

  deleteChannelLocally(agent: Uint8Array, channel: Uint8Array): void {
    this.#db.run("DELETE FROM channel_keys WHERE agent_id = ? AND channel_id = ?", [agent, channel]);
    this.#db.run("DELETE FROM channel_follows WHERE agent_id = ? AND channel_id = ?", [agent, channel]);
    this.#db.run("DELETE FROM channel_bundles WHERE channel_id = ?", [channel]);
    this.#db.run("DELETE FROM channel_owned WHERE channel_id = ?", [channel]);
  }

  bundle(channel: Uint8Array, generation: number): { revision: number; file: string } | undefined {
    return this.#db.get("SELECT revision, file FROM channel_bundles WHERE channel_id = ? AND generation = ?", [channel, generation]) as { revision: number; file: string } | undefined;
  }

  bundles(channel: Uint8Array): { generation: number; revision: number; file: string }[] {
    return this.#db.all("SELECT generation, revision, file FROM channel_bundles WHERE channel_id = ? ORDER BY generation", [channel]) as { generation: number; revision: number; file: string }[];
  }

  putBundle(channel: Uint8Array, generation: number, revision: number, file: string): void {
    this.#db.run(
      "INSERT INTO channel_bundles (channel_id, generation, revision, file) VALUES (?, ?, ?, ?) ON CONFLICT (channel_id, generation) DO UPDATE SET revision = excluded.revision, file = excluded.file",
      [channel, generation, revision, file],
    );
  }

  member(channel: Uint8Array, member: Uint8Array): MemberRow | undefined {
    return this.#db.get("SELECT * FROM channel_members WHERE channel_id = ? AND member_id = ?", [channel, member]) as MemberRow | undefined;
  }

  members(channel: Uint8Array, state: MemberRow["state"]): MemberRow[] {
    return this.#db.all("SELECT * FROM channel_members WHERE channel_id = ? AND state = ? ORDER BY requested_at", [channel, state]) as MemberRow[];
  }

  putMember(row: Omit<MemberRow, "pass" | "pass_expires">): void {
    this.#db.run(
      `INSERT INTO channel_members (channel_id, member_id, state, x25519_public, mlkem_public, note, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel_id, member_id) DO UPDATE SET state = excluded.state, x25519_public = excluded.x25519_public, mlkem_public = excluded.mlkem_public, note = excluded.note, requested_at = excluded.requested_at`,
      [row.channel_id, row.member_id, row.state, row.x25519_public, row.mlkem_public, row.note, row.requested_at],
    );
  }

  setMemberState(channel: Uint8Array, member: Uint8Array, state: MemberRow["state"]): void {
    this.#db.run("UPDATE channel_members SET state = ? WHERE channel_id = ? AND member_id = ?", [state, channel, member]);
  }

  poster(channel: Uint8Array, poster: Uint8Array): PosterRow | undefined {
    return this.#db.get("SELECT * FROM channel_posters WHERE channel_id = ? AND poster_id = ?", [channel, poster]) as PosterRow | undefined;
  }

  posters(channel: Uint8Array): PosterRow[] {
    return this.#db.all("SELECT * FROM channel_posters WHERE channel_id = ?", [channel]) as PosterRow[];
  }

  putPoster(channel: Uint8Array, poster: Uint8Array, pass: string, expires: number): void {
    this.#db.run(
      "INSERT INTO channel_posters (channel_id, poster_id, pass, pass_expires) VALUES (?, ?, ?, ?) ON CONFLICT (channel_id, poster_id) DO UPDATE SET pass = excluded.pass, pass_expires = excluded.pass_expires",
      [channel, poster, pass, expires],
    );
  }

  deletePoster(channel: Uint8Array, poster: Uint8Array): void {
    this.#db.run("DELETE FROM channel_posters WHERE channel_id = ? AND poster_id = ?", [channel, poster]);
  }

  follow(agent: Uint8Array, channel: Uint8Array): FollowRow | undefined {
    return this.#db.get("SELECT * FROM channel_follows WHERE agent_id = ? AND channel_id = ?", [agent, channel]) as FollowRow | undefined;
  }

  follows(agent: Uint8Array): FollowRow[] {
    return this.#db.all("SELECT * FROM channel_follows WHERE agent_id = ?", [agent]) as FollowRow[];
  }

  allFollows(): FollowRow[] {
    return this.#db.all("SELECT * FROM channel_follows", []) as FollowRow[];
  }

  putFollow(row: Pick<FollowRow, "agent_id" | "channel_id" | "record" | "state" | "x25519_secret" | "mlkem_seed" | "x25519_public" | "mlkem_public">): void {
    this.#db.run(
      `INSERT INTO channel_follows (agent_id, channel_id, record, state, x25519_secret, mlkem_seed, x25519_public, mlkem_public) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, channel_id) DO UPDATE SET state = excluded.state, x25519_secret = excluded.x25519_secret, mlkem_seed = excluded.mlkem_seed, x25519_public = excluded.x25519_public, mlkem_public = excluded.mlkem_public`,
      [row.agent_id, row.channel_id, row.record, row.state, row.x25519_secret, row.mlkem_seed, row.x25519_public, row.mlkem_public],
    );
  }

  setFollowState(agent: Uint8Array, channel: Uint8Array, state: FollowRow["state"]): void {
    this.#db.run("UPDATE channel_follows SET state = ? WHERE agent_id = ? AND channel_id = ?", [state, agent, channel]);
  }

  setFollowInfo(agent: Uint8Array, channel: Uint8Array, info: string, revision: number): void {
    this.#db.run("UPDATE channel_follows SET info = ?, info_revision = ? WHERE agent_id = ? AND channel_id = ?", [info, revision, agent, channel]);
  }

  setFollowPass(agent: Uint8Array, channel: Uint8Array, pass: string): void {
    this.#db.run("UPDATE channel_follows SET pass = ? WHERE agent_id = ? AND channel_id = ?", [pass, agent, channel]);
  }

  setNextPoll(agent: Uint8Array, channel: Uint8Array, at: number): void {
    this.#db.run("UPDATE channel_follows SET next_poll = ? WHERE agent_id = ? AND channel_id = ?", [at, agent, channel]);
  }

  putKey(agent: Uint8Array, channel: Uint8Array, generation: number, key: Uint8Array): void {
    this.#db.run("INSERT INTO channel_keys (agent_id, channel_id, generation, group_key) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", [agent, channel, generation, key]);
  }

  keys(agent: Uint8Array, channel: Uint8Array): KeyRow[] {
    return this.#db.all("SELECT generation, group_key, retired FROM channel_keys WHERE agent_id = ? AND channel_id = ? ORDER BY generation", [agent, channel]) as KeyRow[];
  }

  retireKey(agent: Uint8Array, channel: Uint8Array, generation: number): void {
    this.#db.run("UPDATE channel_keys SET retired = 1 WHERE agent_id = ? AND channel_id = ? AND generation = ?", [agent, channel, generation]);
  }

  lanes(agent: Uint8Array, channel: Uint8Array, generation?: number): LaneRow[] {
    return (generation === undefined
      ? this.#db.all("SELECT generation, lane_id, position, floor, last_seq, signed_at, aged_out FROM channel_lanes WHERE agent_id = ? AND channel_id = ? ORDER BY generation", [agent, channel])
      : this.#db.all("SELECT generation, lane_id, position, floor, last_seq, signed_at, aged_out FROM channel_lanes WHERE agent_id = ? AND channel_id = ? AND generation = ?", [agent, channel, generation])) as LaneRow[];
  }

  // Newest signed head wins, per the same rule a store uses, and a position never goes back.
  putLaneHead(k: LaneKey, floor: number, lastSeq: number, signedAt: number): void {
    this.#db.run(
      `INSERT INTO channel_lanes (agent_id, channel_id, generation, lane_id, floor, last_seq, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, channel_id, generation, lane_id) DO UPDATE SET floor = excluded.floor, last_seq = excluded.last_seq, signed_at = excluded.signed_at`,
      [k.agent, k.channel, k.generation, k.lane, floor, lastSeq, signedAt],
    );
  }

  setLaneProgress(k: LaneKey, position: number, addAgedOut: number): void {
    this.#db.run(
      "UPDATE channel_lanes SET position = max(position, ?), aged_out = aged_out + ? WHERE agent_id = ? AND channel_id = ? AND generation = ? AND lane_id = ?",
      [position, addAgedOut, k.agent, k.channel, k.generation, k.lane],
    );
  }

  hasPost(k: LaneKey, seq: number): boolean {
    return this.#db.get("SELECT 1 AS found FROM channel_posts WHERE agent_id = ? AND channel_id = ? AND generation = ? AND lane_id = ? AND seq = ?", [k.agent, k.channel, k.generation, k.lane, seq]) !== undefined;
  }

  // The time of the next post held above a missing one. It decides when a missing post may be called lost.
  nextHeldAfter(k: LaneKey, seq: number): number | undefined {
    const row = this.#db.get(
      "SELECT published_at FROM channel_posts WHERE agent_id = ? AND channel_id = ? AND generation = ? AND lane_id = ? AND seq > ? ORDER BY seq LIMIT 1",
      [k.agent, k.channel, k.generation, k.lane, seq],
    ) as { published_at: number } | undefined;
    return row?.published_at;
  }

  insertPost(k: LaneKey, seq: number, hash: Uint8Array, publishedAt: number, title: Uint8Array | null, body: Uint8Array | null, state: PostRow["state"]): void {
    this.#db.run(
      `INSERT INTO channel_posts (agent_id, channel_id, generation, lane_id, seq, post_hash, published_at, title, body, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [k.agent, k.channel, k.generation, k.lane, seq, hash, publishedAt, title, body, state],
    );
  }

  unread(agent: Uint8Array, channel: Uint8Array, limit: number): PostRow[] {
    return this.#db.all(
      "SELECT generation, lane_id, seq, post_hash, published_at, title, body, state FROM channel_posts WHERE agent_id = ? AND channel_id = ? AND state IN ('unread', 'unopenable') ORDER BY published_at, lane_id, seq LIMIT ?",
      [agent, channel, limit],
    ) as PostRow[];
  }

  unreadCount(agent: Uint8Array, channel: Uint8Array): number {
    return (this.#db.get("SELECT count(*) AS c FROM channel_posts WHERE agent_id = ? AND channel_id = ? AND state = 'unread'", [agent, channel]) as { c: number }).c;
  }

  // Once told, an unopenable post needs no second mention. Reading it counts as delivered, so it can't stall anything.
  markPosts(agent: Uint8Array, channel: Uint8Array, rows: readonly { generation: number; lane_id: Uint8Array; seq: number; state: "read" | "blocked" }[]): void {
    this.#db.transaction(() => {
      for (const row of rows) {
        this.#db.run("UPDATE channel_posts SET state = ? WHERE agent_id = ? AND channel_id = ? AND generation = ? AND lane_id = ? AND seq = ?", [row.state, agent, channel, row.generation, row.lane_id, row.seq]);
      }
    });
  }

  gaps(k: LaneKey): GapRow[] {
    return this.#db.all("SELECT seq, state, rung FROM channel_gaps WHERE agent_id = ? AND channel_id = ? AND generation = ? AND lane_id = ? ORDER BY seq", [k.agent, k.channel, k.generation, k.lane]) as GapRow[];
  }

  putGap(k: LaneKey, seq: number, state: GapRow["state"]): void {
    this.#db.run(
      "INSERT INTO channel_gaps (agent_id, channel_id, generation, lane_id, seq, state) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (agent_id, channel_id, generation, lane_id, seq) DO UPDATE SET state = excluded.state",
      [k.agent, k.channel, k.generation, k.lane, seq, state],
    );
  }

  deleteGap(k: LaneKey, seq: number): void {
    this.#db.run("DELETE FROM channel_gaps WHERE agent_id = ? AND channel_id = ? AND generation = ? AND lane_id = ? AND seq = ?", [k.agent, k.channel, k.generation, k.lane, seq]);
  }

  markGapRung(k: LaneKey, seq: number): void {
    this.#db.run("UPDATE channel_gaps SET rung = 1 WHERE agent_id = ? AND channel_id = ? AND generation = ? AND lane_id = ? AND seq = ?", [k.agent, k.channel, k.generation, k.lane, seq]);
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

  nextLogSeq(agent: Uint8Array, channel: Uint8Array, generation: number, lane: Uint8Array): number {
    const row = this.#db.get("SELECT max(seq) AS m FROM channel_log WHERE agent_id = ? AND channel_id = ? AND generation = ? AND lane_id = ?", [agent, channel, generation, lane]) as { m: number | null };
    return (row.m ?? 0) + 1;
  }

  appendLog(k: LaneKey, seq: number, publishedAt: number, file: string): void {
    this.#db.run("INSERT INTO channel_log (agent_id, channel_id, generation, lane_id, seq, published_at, file) VALUES (?, ?, ?, ?, ?, ?, ?)", [k.agent, k.channel, k.generation, k.lane, seq, publishedAt, file]);
  }

  deleteLog(k: LaneKey, seq: number): void {
    this.#db.run("DELETE FROM channel_log WHERE agent_id = ? AND channel_id = ? AND generation = ? AND lane_id = ? AND seq = ?", [k.agent, k.channel, k.generation, k.lane, seq]);
  }

  log(k: LaneKey, fromSeq: number): LogRow[] {
    return this.#db.all("SELECT generation, lane_id, seq, published_at, file FROM channel_log WHERE agent_id = ? AND channel_id = ? AND generation = ? AND lane_id = ? AND seq >= ? ORDER BY seq", [k.agent, k.channel, k.generation, k.lane, fromSeq]) as LogRow[];
  }

  firstLogAfter(k: LaneKey, publishedAfter: number): number | undefined {
    const row = this.#db.get("SELECT min(seq) AS m FROM channel_log WHERE agent_id = ? AND channel_id = ? AND generation = ? AND lane_id = ? AND published_at >= ?", [k.agent, k.channel, k.generation, k.lane, publishedAfter]) as { m: number | null };
    return row.m ?? undefined;
  }

  putAck(k: LaneKey, seq: number, store: string, ack: string): void {
    this.#db.run("INSERT INTO channel_log_acks (agent_id, channel_id, generation, lane_id, seq, store, ack) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", [k.agent, k.channel, k.generation, k.lane, seq, store, ack]);
  }

  ownHead(k: LaneKey): OwnHeadRow | undefined {
    return this.#db.get("SELECT generation, lane_id, floor, last_seq, signed_at, cap, file FROM channel_own_heads WHERE agent_id = ? AND channel_id = ? AND generation = ? AND lane_id = ?", [k.agent, k.channel, k.generation, k.lane]) as OwnHeadRow | undefined;
  }

  ownHeads(agent: Uint8Array, channel: Uint8Array): OwnHeadRow[] {
    return this.#db.all("SELECT generation, lane_id, floor, last_seq, signed_at, cap, file FROM channel_own_heads WHERE agent_id = ? AND channel_id = ? ORDER BY generation", [agent, channel]) as OwnHeadRow[];
  }

  putOwnHead(k: LaneKey, floor: number, lastSeq: number, signedAt: number, cap: Uint8Array, file: string): void {
    this.#db.run(
      `INSERT INTO channel_own_heads (agent_id, channel_id, generation, lane_id, floor, last_seq, signed_at, cap, file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, channel_id, generation, lane_id) DO UPDATE SET floor = excluded.floor, last_seq = excluded.last_seq, signed_at = excluded.signed_at, file = excluded.file`,
      [k.agent, k.channel, k.generation, k.lane, floor, lastSeq, signedAt, cap, file],
    );
  }
}

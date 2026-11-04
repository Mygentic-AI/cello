// Channels with real processes: a real server, three daemons in their own homes, and a bare socket playing the attacker.
// The hostile cases work on the real database as its owner, and with the server's real signing key. Run it with scripts/live-channels.sh.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { type RosterFile, channelPostAckCodec, channelPostCodec, hashBlob, inRoster, postHash, readRoster, sealKeyEntry, signMemberKey, signRoster } from "../src/protocol/channel.ts";
import { type Signer, generateIdentitySeeds, signerFromSeeds } from "../src/protocol/identity.ts";
import { channelPostAckBytes, channelPostBytes, type ChannelPostFields, agentAuthBytes, registerBytes } from "../src/protocol/structures.ts";
import { PROTOCOL_VERSION, fromB64, identityCodec, signatureCodec, toB64 } from "../src/protocol/wire.ts";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18600/v1";
const serverDir = process.env["CELLO_SERVER_DIR"] ?? new URL("../../cello-server", import.meta.url).pathname;
const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const LOST_WAIT_MS = 8000;
const homes = { ada: mkdtempSync(join(tmpdir(), "cello-ch-ada-")), bea: mkdtempSync(join(tmpdir(), "cello-ch-bea-")), cyd: mkdtempSync(join(tmpdir(), "cello-ch-cyd-")) };
type Who = keyof typeof homes;
const names: Record<Who, string> = { ada: "Ada", bea: "Bea", cyd: "Cyd" };
const ids = {} as Record<Who, string>;

function run(who: Who, args: string[], input?: string): { status: number | null; json: Record<string, unknown>; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8", input, maxBuffer: 16_000_000,
    env: { ...process.env, CELLO_V2_HOME: homes[who] },
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(result.stdout || result.stderr) as Record<string, unknown>;
  } catch {
    // login and logout answer in words.
  }
  return { status: result.status, json, stderr: result.stderr };
}

function ok(who: Who, command: string, ...args: string[]): Record<string, unknown> {
  const result = run(who, [command, ...args, "--agent", names[who]]);
  assert.equal(result.status, 0, `${who} ${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.json;
}

function refused(who: Who, command: string, ...args: string[]): string {
  const result = run(who, [command, ...args, "--agent", names[who]]);
  assert.notEqual(result.status, 0, `${who} ${command} should have been refused`);
  return result.json["error"] as string;
}

interface Channel { channel_id: string; state: string; unread: number; position: number; latest: number; first_held: number; aged_out: number; missing: number[]; lost: number[]; notices: string[]; readers?: number; generation: number }

function view(who: Who, channel: string): Channel {
  const found = (ok(who, "channels") as unknown as { channels: Channel[] }).channels.find((row) => row.channel_id === channel);
  assert.ok(found, `${who} doesn't list ${channel}`);
  return found;
}

function collect(who: Who, channel: string): Channel {
  ok(who, "channel-collect", channel);
  return view(who, channel);
}

async function until<T>(what: string, check: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function compose(...args: string[]): string {
  return execFileSync("docker", ["compose", ...args], { cwd: serverDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64_000_000 });
}
function sql(query: string): string {
  return compose("exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "cello_owner", "-d", "cello", "-tAc", query).trim();
}
const bytea = (hex: string): string => `'\\x${hex}'::bytea`;

function create(who: Who, name: string, type: string, posting = "admin"): string {
  return ok(who, "channel-create", name, "--type", type, "--posting", posting)["channel_id"] as string;
}

function post(who: Who, channel: string, text: string, title = "t"): number {
  const answer = ok(who, "channel-post", channel, text, "--title", title);
  assert.equal(answer["posted"], true, `${who}'s post didn't land: ${JSON.stringify(answer)}`);
  return answer["position"] as number;
}

// A bare client: real socket, real keys, nothing from the daemon.
class Raw {
  readonly #socket: WebSocket;
  readonly #waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  #next = 1;
  nonce: Uint8Array = new Uint8Array(0);
  serverId: Uint8Array = new Uint8Array(0);
  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as { id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string } };
      if (frame.id === undefined) return;
      const waiter = this.#waiting.get(frame.id);
      this.#waiting.delete(frame.id);
      if (frame.ok) waiter?.resolve(frame.result);
      else waiter?.reject(Object.assign(new Error(frame.error?.message), { code: frame.error?.code }));
    });
  }
  static async open(): Promise<Raw> {
    const socket = new WebSocket(url, { maxPayload: 4_000_000 });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const raw = new Raw(socket);
    const hello = await raw.call("hello", { clientNonce: toB64(new Uint8Array(randomBytes(32))) }) as { server: unknown; serverNonce: string };
    raw.nonce = fromB64(hello.serverNonce, "nonce");
    const { identityId } = await import("../src/protocol/identity.ts");
    raw.serverId = identityId(identityCodec.decode(hello.server));
    return raw;
  }
  call(method: string, params: unknown): Promise<unknown> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ v: PROTOCOL_VERSION, id, method, params }));
    });
  }
  async newAgent(name: string): Promise<Signer> {
    const signer = await signerFromSeeds(generateIdentitySeeds());
    const signature = await signer.sign("cello-v2-register", registerBytes({ serverId: this.serverId, identity: signer.publicIdentity, name }));
    await this.call("register", { identity: identityCodec.encode(signer.publicIdentity), name, signature: signatureCodec.encode(signature) });
    const clientNonce = new Uint8Array(randomBytes(32));
    const proof = await signer.sign("cello-v2-agent-auth", agentAuthBytes({ serverId: this.serverId, agentId: signer.id, serverNonce: this.nonce, clientNonce }));
    await this.call("auth", { agentId: toB64(signer.id), clientNonce: toB64(clientNonce), signature: signatureCodec.encode(proof) });
    return signer;
  }
  close(): void {
    this.#socket.close();
  }
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err: unknown) {
    return (err as { code?: string }).code ?? `no code: ${String(err)}`;
  }
  return "accepted";
}

async function rawPost(raw: Raw, signer: Signer, channel: string, seq: number, text: string, over: Partial<ChannelPostFields> = {}, signWith: Signer = signer, sentBody?: string): Promise<unknown> {
  const channelId = new Uint8Array(Buffer.from(channel, "hex"));
  const title = new TextEncoder().encode("title");
  const body = new TextEncoder().encode(text);
  const fields: ChannelPostFields = { channelId, generation: 1, authorId: signer.id, authorSeq: seq, publishedAt: Date.now(), titleHash: hashBlob(title), bodyHash: hashBlob(body), ...over };
  const signature = await signWith.sign("cello-v2-channel-post", channelPostBytes(fields));
  return raw.call("channel.post", {
    agent: toB64(signer.id), channel: toB64(channelId),
    post: channelPostCodec.encode({ fields, signature }), title: toB64(title), body: toB64(new TextEncoder().encode(sentBody ?? text)),
  });
}

before(async () => {
  for (const who of Object.keys(homes) as Who[]) {
    const login = run(who, ["login", "--server", url]);
    assert.equal(login.status, 0, `login failed: ${login.stderr}`);
    // Settings go in the database by command, as a person would change them. Nothing here is from the environment.
    assert.equal(run(who, ["channel-config", "--channel-check-seconds", "1", "--channel-lost-wait-seconds", String(LOST_WAIT_MS / 1000)]).status, 0);
    const created = run(who, ["create-agent", names[who]]);
    assert.equal(created.status, 0, created.stderr);
    ids[who] = created.json["agent_id"] as string;
    await until(`${who} online`, () => (run(who, ["status"]).json as unknown as { agents: { online: boolean }[] }).agents.every((a) => a.online));
  }
});

after(() => {
  for (const who of Object.keys(homes) as Who[]) run(who, ["logout"]);
});

test("a public channel: posts reach a reader by themselves, a publisher sees its reader count, and a non-reader is refused", async () => {
  const channel = create("ada", "Public news", "public");
  assert.equal(ok("cyd", "channel-join", channel)["state"], "active");
  assert.equal(ok("bea", "channel-join", channel)["state"], "active");
  const first = post("ada", channel, "PUBLIC-BODY-MARKER", "PUBLIC-TITLE-MARKER");
  const second = post("ada", channel, "second");
  assert.deepEqual([first, second], [1, 2], "one numbering, and the number is the answer");
  // Nobody asks: the push and the daemon's own check bring it.
  const seen = await until("the posts to reach Cyd", () => { const row = view("cyd", channel); return row.unread === 2 && row; });
  assert.equal(seen.position, 2);
  await until("the count to reach the publisher", () => view("ada", channel).readers === 2);
  assert.equal(view("cyd", channel).readers, undefined, "only a publisher sees how many readers it has");

  assert.equal(refused("cyd", "channel-post", channel, "I'm just a reader"), "not_allowed_to_post");
  const raw = await Raw.open();
  const stranger = await raw.newAgent("Stranger");
  assert.equal(await codeOf(raw.call("channel.fetch", { agent: toB64(stranger.id), channel: toB64(Buffer.from(channel, "hex")), after: 0 })), "not_a_member", "registered but not reading");
  const anonymous = await Raw.open();
  assert.equal(await codeOf(anonymous.call("channel.fetch", { agent: toB64(stranger.id), channel: toB64(Buffer.from(channel, "hex")), after: 0 })), "not_authenticated", "no anonymous reading");
  raw.close();
  anonymous.close();

  // Reading stops when a reader leaves, and comes back when it rejoins.
  ok("bea", "channel-leave", channel);
  await until("the count to drop", () => view("ada", channel).readers === 1);
  assert.equal(ok("bea", "channel-join", channel)["state"], "active", "someone who left can come back");
  ok("ada", "channel-eject", channel, ids.bea);
  assert.equal(refused("bea", "channel-join", channel), "ejected", "a public channel's block list holds");
});

test("a private group chat: approval, every member posting, and a database that holds no plaintext", async () => {
  const channel = create("ada", "Our group", "private", "members");
  assert.equal(ok("bea", "channel-join", channel, "--note", "hello, it's Bea")["state"], "waiting");
  assert.equal(ok("bea", "channel-join", channel, "--note", "hello, it's Bea")["state"], "waiting", "a repeat gets the same answer");
  assert.equal(refused("bea", "channel-post", channel, "not yet"), "not_a_member");
  const requests = ok("ada", "channel-requests", channel) as { requests: { agent_id: string; note: string; valid: boolean }[] };
  assert.deepEqual(requests.requests.map((r) => [r.agent_id, r.note, r.valid]), [[ids.bea, "hello, it's Bea", true]]);
  ok("ada", "channel-approve", channel, ids.bea);
  await until("Bea to learn she's in", () => view("bea", channel).state === "active");

  const adaFirst = post("ada", channel, "PRIVATE-BODY-MARKER-ADA", "PRIVATE-TITLE-MARKER-ADA");
  await until("Ada's post to reach Bea with no collect", () => view("bea", channel).unread === 1);
  const beaPosition = post("bea", channel, "PRIVATE-BODY-MARKER-BEA", "PRIVATE-TITLE-MARKER-BEA");
  assert.equal(beaPosition, adaFirst + 1, "one numbering across members");
  await until("Bea's post to reach Ada", () => view("ada", channel).unread === 1);

  // The test Andre asked for: the database itself, read as its owner, during the run. The public marker shows this search can find text.
  const dump = compose("exec", "-T", "postgres", "pg_dump", "--data-only", "--inserts", "-U", "cello_owner", "cello");
  const asHex = (text: string): string => Buffer.from(text).toString("hex");
  assert.ok(dump.includes(asHex("PUBLIC-BODY-MARKER")), "the search must be able to find a body");
  assert.ok(dump.includes(asHex("PUBLIC-TITLE-MARKER")), "the search must be able to find a title");
  for (const marker of ["PRIVATE-BODY-MARKER-ADA", "PRIVATE-BODY-MARKER-BEA", "PRIVATE-TITLE-MARKER-ADA", "PRIVATE-TITLE-MARKER-BEA"]) {
    assert.ok(!dump.includes(marker), `${marker} is in the database as text`);
    assert.ok(!dump.includes(asHex(marker)), `${marker} is in the database as bytes`);
    for (const shift of ["", "x", "xx"]) assert.ok(!dump.includes(Buffer.from(shift + marker).toString("base64url").slice(4, -4)), `${marker} is in the database as base64`);
  }

  // A member the database has made up gets ciphertext and no key.
  const mallory = await Raw.open();
  const evil = await mallory.newAgent("Mallory");
  const channelBytes = toB64(Buffer.from(channel, "hex"));
  assert.equal(await codeOf(mallory.call("channel.fetch", { agent: toB64(evil.id), channel: channelBytes, after: 0 })), "not_a_member");
  sql(`INSERT INTO channel_members (channel_id, agent_id, state) VALUES (${bytea(channel)}, ${bytea(Buffer.from(evil.id).toString("hex"))}, 'active')`);
  const got = await mallory.call("channel.fetch", { agent: toB64(evil.id), channel: channelBytes, after: 0 }) as { items: { body: string }[] };
  assert.equal(got.items.length, 2, "the row lets the server's own member fetch");
  for (const item of got.items) assert.ok(!Buffer.from(item.body, "base64url").toString().includes("PRIVATE"), "what it fetches is ciphertext");
  const keys = await mallory.call("channel.keys", { agent: toB64(evil.id), channel: channelBytes, from_generation: 1, after_roster: 0 }) as { entries: unknown[]; rosters: { members: unknown[] }[] };
  assert.equal(keys.entries.length, 0, "and there's no key for it");
  assert.equal(keys.rosters.at(-1)?.members.length, 2, "and it isn't on the roster");
  sql(`UPDATE channel_members SET state = 'left' WHERE agent_id = ${bytea(Buffer.from(evil.id).toString("hex"))}`);
  mallory.close();
});

test("forged and replayed posts are refused by the server, with an honest poster passing beside them", async () => {
  const channel = create("ada", "Named posters", "public", "posters");
  const raw = await Raw.open();
  const pia = await raw.newAgent("Pia");
  const piaHex = Buffer.from(pia.id).toString("hex");
  const mal = await raw.newAgent("Mal");
  ok("ada", "channel-add-poster", channel, piaHex);

  const honest = await rawPost(raw, pia, channel, 1, "Approved") as { ack: unknown };
  assert.equal(channelPostAckCodec.decode(honest.ack).fields.position, 1, "the honest post lands, so what's below isn't blanket refusal");

  assert.equal(await codeOf(rawPost(raw, mal, channel, 1, "I'm not on the list")), "not_allowed_to_post", "a stranger");
  assert.equal(await codeOf(rawPost(raw, mal, channel, 1, "Forged as Pia", { authorId: pia.id })), "bad_signature", "signed by Mal, naming Pia as author");
  assert.equal(await codeOf(rawPost(raw, pia, channel, 2, "Approved", {}, mal)), "bad_signature", "Pia's id, signed by Mal");
  assert.equal(await codeOf(rawPost(raw, pia, channel, 2, "what she signed", {}, pia, "something else")), "bad_request", "a body that isn't the one signed");
  assert.equal(await codeOf(rawPost(raw, pia, channel, 2, "next", { generation: 7 })), "generation_stale", "a key generation that isn't current");

  const otherChannel = create("ada", "Other", "public", "posters");
  assert.equal(await codeOf(rawPost(raw, pia, otherChannel, 1, "x", { channelId: new Uint8Array(Buffer.from(channel, "hex")) })), "bad_request", "signed for another channel");

  // The same bytes again: the first answer, and no new number.
  const channelId = new Uint8Array(Buffer.from(channel, "hex"));
  const title = new TextEncoder().encode("title");
  const body = new TextEncoder().encode("Repeat me");
  const fields: ChannelPostFields = { channelId, generation: 1, authorId: pia.id, authorSeq: 2, publishedAt: Date.now(), titleHash: hashBlob(title), bodyHash: hashBlob(body) };
  const signed = channelPostCodec.encode({ fields, signature: await pia.sign("cello-v2-channel-post", channelPostBytes(fields)) });
  const params = { agent: toB64(pia.id), channel: toB64(channelId), post: signed, title: toB64(title), body: toB64(body) };
  const once = await raw.call("channel.post", params) as { ack: unknown };
  const twice = await raw.call("channel.post", params) as { ack: unknown };
  assert.deepEqual(channelPostAckCodec.decode(twice.ack).fields, channelPostAckCodec.decode(once.ack).fields, "a repeat returns the original answer");
  assert.equal(sql(`SELECT count(*) FROM channel_posts WHERE channel_id = ${bytea(channel)}`), "2", "a repeat adds nothing");

  assert.equal(await codeOf(rawPost(raw, pia, channel, 2, "A different post, same number")), "post_conflict", "her number 2 is taken");
  await rawPost(raw, pia, channel, 5, "Skips ahead");
  assert.equal(await codeOf(rawPost(raw, pia, channel, 4, "An old number, never used")), "replayed_post", "numbers only go up");

  ok("ada", "channel-remove-poster", channel, piaHex);
  assert.equal(await codeOf(rawPost(raw, pia, channel, 6, "After removal")), "not_allowed_to_post", "off the signed list, off the channel");
  raw.close();
});

test("a post's size is enforced, and the refusal says to split it", () => {
  const channel = create("ada", "Big posts", "public");
  const limit = 256 * 1024;
  const fits = run("ada", ["channel-post", channel, "-", "--agent", "Ada"], "x".repeat(limit));
  assert.equal(fits.json["posted"], true, `exactly 256 KB is allowed: ${fits.stderr}`);
  const over = run("ada", ["channel-post", channel, "-", "--agent", "Ada"], "x".repeat(limit + 1));
  assert.notEqual(over.status, 0);
  assert.equal(over.json["error"], "too_large");
  assert.match(over.json["message"] as string, /[Ss]plit/);
});

test("aged out, a gap, a gap filled and a post lost are told apart, and only the right ones move a position", async () => {
  const channel = create("ada", "Numbers", "public");
  ok("cyd", "channel-join", channel);
  ok("cyd", "channel-settings", channel, "--delivery", "pull");
  for (let i = 1; i <= 8; i++) post("ada", channel, `post ${i}`);

  // Aged out: the server clears them and says so under its signature. This reader hadn't got to them.
  sql(`UPDATE channel_posts SET created_at = now() - interval '8 days' WHERE channel_id = ${bytea(channel)} AND position <= 4`);
  let row = collect("cyd", channel);
  assert.deepEqual([row.first_held, row.aged_out, row.position, row.missing, row.lost], [5, 4, 8, [], []], JSON.stringify(row));
  assert.ok(row.notices.some((n) => /4 posts aged out/.test(n)), "the reader is told in words");
  assert.equal(sql(`SELECT count(*) FROM channel_posts WHERE channel_id = ${bytea(channel)} AND position <= 4 AND (body IS NOT NULL OR title IS NOT NULL)`), "0", "the text has gone from the database");

  // A gap: the number is absent above first-held. The position stops there, and posts above it can still be read.
  for (let i = 9; i <= 11; i++) post("ada", channel, `post ${i}`);
  const hideTable = `hidden_${channel.slice(0, 12)}`;
  sql(`CREATE TABLE ${hideTable} AS SELECT * FROM channel_posts WHERE channel_id = ${bytea(channel)} AND position = 10; DELETE FROM channel_posts WHERE channel_id = ${bytea(channel)} AND position = 10`);
  row = collect("cyd", channel);
  assert.deepEqual([row.position, row.missing, row.lost], [9, [10], []], `the position stops at the gap: ${JSON.stringify(row)}`);
  assert.equal(row.unread, 6, "what's above the gap is held: 5 to 9, and 11");

  // The reader asks again, and when the server has it, the gap fills with nothing lost.
  sql(`INSERT INTO channel_posts SELECT * FROM ${hideTable}; DROP TABLE ${hideTable}`);
  row = collect("cyd", channel);
  assert.deepEqual([row.position, row.missing, row.lost, row.unread], [11, [], [], 7], `the gap fills: ${JSON.stringify(row)}`);

  // Lost: still absent after the wait. The reader is told and moves on, and so is the publisher told, by its own daemon.
  post("ada", channel, "post 12");
  post("ada", channel, "post 13");
  sql(`DELETE FROM channel_posts WHERE channel_id = ${bytea(channel)} AND position = 12`);
  row = collect("cyd", channel);
  assert.deepEqual([row.position, row.missing, row.lost], [11, [12], []], `not given up yet: ${JSON.stringify(row)}`);
  await new Promise((resolve) => setTimeout(resolve, LOST_WAIT_MS + 500));
  row = collect("cyd", channel);
  row = row.lost.length > 0 ? row : collect("cyd", channel);
  assert.deepEqual([row.position, row.missing, row.lost], [13, [], [12]], `lost, and moved on: ${JSON.stringify(row)}`);
  assert.ok(row.notices.some((n) => /number 12 is lost/.test(n)), "the reader is told");
  await until("the publisher to be told it was its own post", () => view("ada", channel).notices.find((n) => /your post at number 12/.test(n)));
  assert.equal(sql(`SELECT count(*) FROM channel_lost WHERE channel_id = ${bytea(channel)} AND position = 12`), "1");
});

test("a reader who was offline catches up by itself, with its position intact", async () => {
  const channel = create("ada", "Catch up", "public");
  ok("cyd", "channel-join", channel);
  post("ada", channel, "before");
  await until("the first post", () => view("cyd", channel).position === 1);
  assert.equal(run("cyd", ["logout"]).status, 0);
  for (let i = 0; i < 25; i++) post("ada", channel, `while away ${i}`);
  assert.equal(run("cyd", ["login", "--server", url]).status, 0);
  const row = await until("Cyd to catch up", () => { const seen = view("cyd", channel); return seen.position === 26 && seen; });
  assert.deepEqual([row.unread, row.missing], [26, []]);
});

test("moving the database and its key to a new home moves everything: channels, positions, keys and settings", async () => {
  const channel = create("ada", "Moving", "private", "members");
  ok("cyd", "channel-join", channel);
  ok("ada", "channel-approve", channel, ids.cyd);
  await until("Cyd in", () => view("cyd", channel).state === "active");
  ok("cyd", "channel-settings", channel, "--screen-bodies", "arrival");
  post("ada", channel, "before the move");
  await until("the first post", () => view("cyd", channel).position === 1);
  const set = run("cyd", ["channel-config", "--channel-lost-wait-seconds", "1234"]);
  assert.equal(set.status, 0, set.stderr);

  assert.equal(run("cyd", ["logout"]).status, 0);
  post("ada", channel, "while moving");
  const moved = mkdtempSync(join(tmpdir(), "cello-ch-moved-"));
  for (const file of readdirSync(homes.cyd)) if (file.startsWith("cello.db")) copyFileSync(join(homes.cyd, file), join(moved, file));
  const oldHome = homes.cyd;
  homes.cyd = moved;
  rmSync(oldHome, { recursive: true, force: true });
  const back = run("cyd", ["login", "--server", url]);
  assert.equal(back.status, 0, back.stderr);

  const config = run("cyd", ["channel-config"]).json;
  assert.deepEqual([config["channel_lost_wait_seconds"], config["channel_check_seconds"]], [1234, 1], "the settings came with it");
  const row = await until("the new home to read on from the right position", () => { const seen = view("cyd", channel); return seen.position === 2 && seen; });
  assert.deepEqual([row.state, row.unread, row.generation, (row as unknown as { screen_bodies: string }).screen_bodies], ["active", 2, 1, "arrival"], JSON.stringify(row));
  assert.ok(!row.notices.some((n) => /couldn't be opened/.test(n)), "and the key came with it");
  assert.equal(run("cyd", ["channel-config", "--channel-lost-wait-seconds", String(LOST_WAIT_MS / 1000)]).status, 0);
});

test("a hostile server: an old post re-issued under a new number, a changed body, a forged roster and a key of its own are all refused", async () => {
  const channel = create("ada", "Hostile", "private", "members");
  ok("bea", "channel-join", channel);
  ok("ada", "channel-approve", channel, ids.bea);
  await until("Bea in", () => view("bea", channel).state === "active");
  post("ada", channel, "Approved");
  await until("the first post", () => view("bea", channel).position === 1);

  // The server's real signing key, as a compromised server would have it.
  const keyFile = JSON.parse(compose("exec", "-T", "server", "cat", "/data/server-key.json")) as { ed: string; pq: string };
  const server = await signerFromSeeds({ ed: fromB64(keyFile.ed, "ed"), pq: fromB64(keyFile.pq, "pq") });
  const stored = JSON.parse(sql(`SELECT row_to_json(p) FROM (SELECT post, encode(post_hash, 'hex') AS h, encode(title, 'hex') AS t, encode(body, 'hex') AS b, encode(author_id, 'hex') AS a, author_seq, generation FROM channel_posts WHERE channel_id = ${bytea(channel)} AND position = 1) p`)) as { post: never; t: string; b: string; a: string; author_seq: number; generation: number };
  const reissue = async (position: number): Promise<void> => {
    const fields = channelPostCodec.decode(stored.post).fields;
    const ackFields = { serverId: server.id, channelId: fields.channelId, position, postHash: postHash(fields), time: Date.now() };
    const ack = channelPostAckCodec.encode({ fields: ackFields, signature: await server.sign("cello-v2-channel-post-ack", channelPostAckBytes(ackFields)) });
    // The post keeps its own signature. Only a unique constraint stands in the way, and a hostile server drops it.
    sql(`ALTER TABLE channel_posts DROP CONSTRAINT IF EXISTS channel_posts_channel_id_post_hash_key; ALTER TABLE channel_posts DROP CONSTRAINT IF EXISTS channel_posts_channel_id_author_id_author_seq_key;
         INSERT INTO channel_posts (channel_id, position, post_hash, author_id, author_seq, generation, post, ack, title, body) VALUES (${bytea(channel)}, ${position}, ${bytea(Buffer.from(postHash(fields)).toString("hex"))}, ${bytea(stored.a)}, ${stored.author_seq}, ${stored.generation}, '${JSON.stringify(stored.post)}', '${JSON.stringify(ack)}', ${bytea(stored.t)}, ${bytea(stored.b)});
         UPDATE channels SET tip = ${position} WHERE channel_id = ${bytea(channel)}`);
  };
  await reissue(2);
  let row = await until("Bea to refuse the re-issued post", () => { const seen = view("bea", channel); return seen.notices.some((n) => /Post number 2 was refused/.test(n)) && seen; });
  assert.deepEqual([row.position, row.unread], [2, 1], "it counts as delivered, never stalls, and adds nothing to read");
  assert.ok(row.notices.some((n) => /re-posted as new/.test(n)));

  // A changed body under the honest signature. Bea is on pull so that the change happens before she fetches it.
  ok("bea", "channel-settings", channel, "--delivery", "pull");
  post("ada", channel, "Second");
  sql(`UPDATE channel_posts SET body = '\\xdeadbeef' WHERE channel_id = ${bytea(channel)} AND position = 3`);
  row = collect("bea", channel);
  assert.ok(row.notices.some((n) => /Post number 3 was refused/.test(n)), `Bea refuses the changed body: ${row.notices.join("; ")}`);
  assert.equal(row.position, 3);

  // A key the server sealed itself, for the next generation, and a roster it signed itself.
  const fake = await signerFromSeeds(generateIdentitySeeds());
  const fakeRoster = await signRoster(fake, null, 2, [await signMemberKey(fake, fake.id, { x25519Public: new Uint8Array(32).fill(9), mlKemPublic: new Uint8Array(1184) }, 1)]);
  assert.equal(await readRoster(fakeRoster, fake.publicIdentity).then((r) => r !== null), true, "the forgery is well formed, under its own key");
  const before = view("bea", channel).generation;
  sql(`INSERT INTO channel_rosters (channel_id, revision, roster) SELECT channel_id, roster_revision + 1, '${JSON.stringify(fakeRoster)}'::jsonb FROM channels WHERE channel_id = ${bytea(channel)}; UPDATE channels SET roster_revision = roster_revision + 1 WHERE channel_id = ${bytea(channel)}`);
  // Every later roster is refused too: a daemon stops at the first break in the chain, and tells its person.
  row = collect("bea", channel);
  assert.ok(row.notices.some((n) => /member list that isn't signed/.test(n)), `Bea refuses the forged roster: ${row.notices.join("; ")}`);
  assert.equal(row.generation, before);

  // A group key the server sealed itself, to Bea's real member key, for a generation of its own making.
  const held = JSON.parse(sql(`SELECT roster FROM channel_rosters WHERE channel_id = ${bytea(channel)} AND revision = 2`)) as RosterFile;
  const beaRow = await readRoster(held, identityCodec.decode((JSON.parse(sql(`SELECT record FROM channels WHERE channel_id = ${bytea(channel)}`)) as { channel: unknown }).channel));
  assert.ok(beaRow, "the real roster verifies");
  const beaListed = inRoster(beaRow, new Uint8Array(Buffer.from(ids.bea, "hex")));
  assert.ok(beaListed);
  const forgedEntry = await sealKeyEntry(fake, beaRow, beaListed, 2, new Uint8Array(32).fill(9));
  sql(`DELETE FROM channel_rosters WHERE channel_id = ${bytea(channel)} AND revision = 3; UPDATE channels SET roster_revision = 2, generation = 2 WHERE channel_id = ${bytea(channel)};
       INSERT INTO channel_key_entries (channel_id, generation, member_id, entry) VALUES (${bytea(channel)}, 2, ${bytea(ids.bea)}, '${JSON.stringify(forgedEntry)}')`);
  row = collect("bea", channel);
  assert.ok(row.notices.some((n) => /that this channel's key didn't sign/.test(n)), `Bea refuses the server's key: ${row.notices.join("; ")}`);
  assert.equal(refused("bea", "channel-post", channel, "this must not go out under the server's key"), "generation_stale", "with no signed key for it, she can't post under it");
});

test("eject: the next read is refused, a new key starts, and a member offline across two ejects still reads everything it's owed", async () => {
  const channel = create("ada", "Rotation", "private", "members");
  const raw = await Raw.open();
  for (const who of ["bea", "cyd"] as const) {
    ok(who, "channel-join", channel);
    ok("ada", "channel-approve", channel, ids[who]);
    await until(`${who} in`, () => view(who, channel).state === "active");
  }
  post("ada", channel, "everyone sees this");
  await until("Bea and Cyd to have it", () => view("bea", channel).position === 1 && view("cyd", channel).position === 1);

  assert.equal(run("cyd", ["logout"]).status, 0);
  ok("ada", "channel-eject", channel, ids.bea);
  assert.equal(sql(`SELECT state FROM channel_members WHERE channel_id = ${bytea(channel)} AND agent_id = ${bytea(ids.bea)}`), "ejected");
  assert.equal(sql(`SELECT count(*) FROM channel_key_entries WHERE channel_id = ${bytea(channel)} AND generation = 2 AND member_id = ${bytea(ids.bea)}`), "0", "no key for the ejected member");
  const second = post("ada", channel, "after Bea went");
  assert.equal(second, 2);
  await until("Bea to learn she's out", () => view("bea", channel).state === "ejected");
  assert.equal(refused("bea", "channel-join", channel), "ejected", "ejected stays refused");
  assert.equal(refused("bea", "channel-post", channel, "still here?"), "not_a_member", "and can't post either");
  assert.equal(view("bea", channel).position, 1, "and got nothing new");

  // A second rotation with Cyd still away. Another member is what's ejected this time, made and approved just for it.
  const channelBytes = toB64(Buffer.from(channel, "hex"));
  const temp = await raw.newAgent("Temp");
  const keys = await import("@noble/curves/ed25519.js");
  const secret = keys.x25519.utils.randomSecretKey();
  const { mlKemGenerateSeed, mlKemKeypairFromSeed } = await import("../src/protocol/ml-kem.ts");
  const member = await signMemberKey(temp, new Uint8Array(Buffer.from(channel, "hex")), { x25519Public: keys.x25519.getPublicKey(secret), mlKemPublic: (await mlKemKeypairFromSeed(mlKemGenerateSeed())).publicKey }, Date.now());
  const info = await raw.call("channel.get", { agent: toB64(temp.id), channel: channelBytes }) as { info: { fields: { x25519Public: string; mlKemPublic: string } } };
  const { sealTo } = await import("../src/protocol/channel.ts");
  const request = await sealTo({ x25519Public: fromB64(info.info.fields.x25519Public, "x"), mlKemPublic: fromB64(info.info.fields.mlKemPublic, "m") }, new TextEncoder().encode(JSON.stringify({ ...member, note: "" })));
  await raw.call("channel.join", { agent: toB64(temp.id), channel: channelBytes, request });
  const tempHex = Buffer.from(temp.id).toString("hex");
  ok("ada", "channel-approve", channel, tempHex);
  ok("ada", "channel-eject", channel, tempHex);
  assert.equal(post("ada", channel, "after Temp went"), 3);

  // Cyd comes back holding generation 1, and collects 2 and 3 in turn.
  assert.equal(run("cyd", ["login", "--server", url]).status, 0);
  const row = await until("Cyd to catch up across two ejects", () => { const seen = view("cyd", channel); return seen.position === 3 && seen; });
  assert.deepEqual([row.generation, row.unread], [3, 3], JSON.stringify(row));
  assert.ok(!row.notices.some((n) => /couldn't be opened/.test(n)), `every post opened: ${row.notices.join("; ")}`);

  // A member who left can come back, with the admin's say-so, and the roster drops them meanwhile.
  ok("cyd", "channel-leave", channel);
  await until("Cyd off the roster", () => {
    const roster = JSON.parse(sql(`SELECT roster FROM channel_rosters WHERE channel_id = ${bytea(channel)} ORDER BY revision DESC LIMIT 1`)) as { members: { memberKey: { fields: { agentId: string } } }[] };
    return !roster.members.some((m) => Buffer.from(m.memberKey.fields.agentId, "base64url").toString("hex") === ids.cyd);
  });
  assert.equal(ok("cyd", "channel-join", channel)["state"], "waiting");
  ok("ada", "channel-refuse", channel, ids.cyd);
  assert.equal(ok("cyd", "channel-join", channel)["state"], "refused", "a repeat gets the same answer");
  raw.close();
});

test("TEXT: a member reads a private post, screened, and what's blocked counts as delivered", () => {
  const channel = create("ada", "Reading", "private", "members");
  ok("bea", "channel-join", channel);
  ok("ada", "channel-approve", channel, ids.bea);
  const position = post("ada", channel, "The launch is on Tuesday.", "Launch date");
  ok("bea", "channel-collect", channel);
  const titles = ok("bea", "channel-read", channel, "--titles-only") as { posts: { position: number; title: string; text?: string }[] };
  assert.deepEqual(titles.posts.map((p) => [p.position, p.title, p.text]), [[position, "Launch date", undefined]], "titles only, and no body");
  const read = ok("bea", "channel-read", channel) as { posts: { title: string; text: string; from_id: string }[] };
  assert.deepEqual(read.posts.map((p) => [p.title, p.text, p.from_id]), [["Launch date", "The launch is on Tuesday.", ids.ada]]);
  assert.equal((ok("bea", "channel-read", channel) as { posts: unknown[] }).posts.length, 0, "read once");
  const history = ok("ada", "channel-history", channel) as { posts: { text: string; own: boolean }[] };
  assert.deepEqual(history.posts.map((p) => [p.text, p.own]), [["The launch is on Tuesday.", true]], "the group chat's own view");
});

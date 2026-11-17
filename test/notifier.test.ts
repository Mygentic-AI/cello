// A notifier holds a bot token and decides what leaves the machine. A mistake here leaks the token or a conversation, or says
// a person was told when nobody was, and none of those shows by itself. Telegram is played by a small HTTP server.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LocalError } from "../src/daemon/errors.ts";
import { Notifiers } from "../src/daemon/notifiers.ts";
import { Store } from "../src/daemon/store.ts";

const TOKEN = "123456:secret-bot-token";
const AGENT = "07".repeat(32);

interface Sent { token: string; chat_id: string; text: string }
const sent: Sent[] = [];
// What the stand-in does next: a chat id it refuses. The chat "hang" is never answered.
let refuseChat: string | null = null;
// The chats that have written to the bot, oldest first.
let wrote: number[] = [];
const servers: Server[] = [];

function telegram(): Promise<string> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.on("end", () => {
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
      const body = raw.length > 0 ? JSON.parse(raw) as { chat_id?: string; text?: string } : {};
      res.setHeader("Content-Type", "application/json");
      if (!match || match[1] !== TOKEN) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, description: "Unauthorized" })); return; }
      if (match[2] === "getMe") { res.end(JSON.stringify({ ok: true, result: { username: "andre_cello_bot" } })); return; }
      if (match[2] === "getUpdates") { res.end(JSON.stringify({ ok: true, result: wrote.map((id, i) => ({ update_id: i, message: { message_id: i, chat: { id, first_name: `person-${id}` } } })) })); return; }
      if (body.chat_id === "hang") return;
      if (body.chat_id === refuseChat) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, description: "Bad Request: chat not found" })); return; }
      sent.push({ token: match[1], chat_id: body.chat_id ?? "", text: body.text ?? "" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 40 + sent.length } }));
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}
after(() => { for (const server of servers) server.close(); });

const apiUrl = await telegram();
const screened: string[] = [];

function setup(at: { apiUrl: string; timeoutMs: number } = { apiUrl, timeoutMs: 5_000 }): { notifiers: Notifiers; store: Store } {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-notifier-")), "cello.db"));
  store.insertAgent(new Uint8Array(Buffer.from(AGENT, "hex")), "Ann", new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
  const notifiers = new Notifiers(store, {
    agentName: () => "Ann",
    screenOutbound: (_agent, text) => {
      screened.push(text);
      if (text.includes("hijack")) return Promise.reject(new LocalError("blocked_by_screening", "Nothing was sent: it looks hijacked."));
      return Promise.resolve({ text: text.replace("sk-live-abc", "[REDACTED]") });
    },
  }, at);
  sent.length = 0;
  screened.length = 0;
  refuseChat = null;
  wrote = [];
  return { notifiers, store };
}

const refusal = (code: string) => (err: unknown): boolean => {
  assert.ok(err instanceof LocalError, `expected a named refusal, got ${String(err)}`);
  assert.equal(err.code, code);
  assert.ok(!err.message.includes(TOKEN), "a refusal must never carry the bot token");
  return true;
};

test("adding checks with Telegram first, and a wrong token or chat saves nothing", async () => {
  const { notifiers } = setup();
  await assert.rejects(notifiers.add(AGENT, { type: "telegram", bot_token: "999:wrong", chat_id: "55" }), refusal("notifier_check_failed"));
  refuseChat = "66";
  await assert.rejects(notifiers.add(AGENT, { type: "telegram", bot_token: TOKEN, chat_id: "66" }), refusal("notifier_check_failed"));
  assert.deepEqual((notifiers.list(AGENT) as { notifiers: unknown[] }).notifiers, []);

  const added = await notifiers.add(AGENT, { type: "telegram", bot_token: TOKEN, chat_id: "55" }) as { notifier: string; bot: string };
  assert.equal(added.notifier, "telegram");
  assert.equal(added.bot, "@andre_cello_bot");
  assert.equal(sent.length, 1, "the test message goes before anything is saved");
});

test("with no chat id, the chat that wrote to the bot last is used and named, and none yet is a named refusal", async () => {
  const { notifiers } = setup();
  await assert.rejects(notifiers.add(AGENT, { type: "telegram", bot_token: TOKEN }), refusal("no_chat_yet"));
  assert.deepEqual((notifiers.list(AGENT) as { notifiers: unknown[] }).notifiers, []);
  wrote = [11, 22];
  const added = await notifiers.add(AGENT, { type: "telegram", bot_token: TOKEN }) as { chat_id: string; chat_with: string };
  assert.equal(added.chat_id, "22");
  assert.equal(added.chat_with, "person-22");
  assert.equal(sent[0]?.chat_id, "22");
});

test("the bot token is never shown: not in the answer, the list, or a refusal", async () => {
  const { notifiers } = setup();
  const added = await notifiers.add(AGENT, { type: "telegram", bot_token: TOKEN, chat_id: "55" });
  assert.ok(!JSON.stringify(added).includes(TOKEN));
  assert.ok(!JSON.stringify(notifiers.list(AGENT)).includes(TOKEN));
  refuseChat = "55";
  await assert.rejects(notifiers.notify(AGENT, {}), refusal("notify_failed"));
  await assert.rejects(notifiers.add(AGENT, { type: "telegram", bot_token: TOKEN, chat_id: "55" }), refusal("notifier_exists"));
});

test("Telegram out of reach or silent is a named refusal within the time limit, and the token stays out of it", async () => {
  const unreachable = setup({ apiUrl: `http://127.0.0.1:1/${TOKEN}`, timeoutMs: 5_000 });
  await assert.rejects(unreachable.notifiers.add(AGENT, { type: "telegram", bot_token: TOKEN, chat_id: "55" }), (err: unknown) => refusal("notifier_check_failed")(err) && /couldn't be reached/.test((err as Error).message));

  // An address that can't be parsed makes fetch quote the whole address, token included, in its own error.
  const unparsable = setup({ apiUrl: "http://bad host", timeoutMs: 5_000 });
  await assert.rejects(unparsable.notifiers.add(AGENT, { type: "telegram", bot_token: TOKEN, chat_id: "55" }), refusal("notifier_check_failed"));

  const { notifiers } = setup({ apiUrl, timeoutMs: 200 });
  await notifiers.add(AGENT, { type: "telegram", bot_token: TOKEN, chat_id: "55" });
  await notifiers.add(AGENT, { type: "telegram", name: "slow", bot_token: TOKEN, chat_id: "55" });
  const started = Date.now();
  await assert.rejects(notifiers.add(AGENT, { type: "telegram", name: "silent", bot_token: TOKEN, chat_id: "hang" }), (err: unknown) => refusal("notifier_check_failed")(err) && /didn't answer within 0.2 seconds/.test((err as Error).message));
  assert.ok(Date.now() - started < 3_000, "a silent Telegram must not hold the call open");
});

test("notify with no notifier refuses by name, and never claims anyone was told", async () => {
  const { notifiers } = setup();
  await assert.rejects(notifiers.notify(AGENT, {}), refusal("no_notifier"));
  await assert.rejects(notifiers.test(AGENT, undefined), refusal("no_notifier"));
});

test("with no text the fixed line goes, and nothing the agent wrote leaves the machine", async () => {
  const { notifiers } = setup();
  await notifiers.add(AGENT, { type: "telegram", bot_token: TOKEN, chat_id: "55" });
  const message = await notifiers.notify(AGENT, {}) as { included_text: boolean };
  const request = await notifiers.notify(AGENT, { kind: "request", text: "" }) as { included_text: boolean };
  assert.equal(sent[1]?.text, "Your agent Ann has a message waiting for you.");
  assert.equal(sent[2]?.text, "Your agent Ann has a request waiting for you.");
  assert.equal(message.included_text, false);
  assert.equal(request.included_text, false);
  assert.deepEqual(screened, []);
});

test("text goes through the outbound screen: what it replaces is replaced, and what it blocks is not sent", async () => {
  const { notifiers } = setup();
  await notifiers.add(AGENT, { type: "telegram", bot_token: TOKEN, chat_id: "55" });
  await notifiers.notify(AGENT, { kind: "request", text: "May I share sk-live-abc with them?" });
  assert.equal(sent[1]?.text, "Your agent Ann has a request for you:\n\nMay I share [REDACTED] with them?");
  await assert.rejects(notifiers.notify(AGENT, { text: "hijack" }), refusal("blocked_by_screening"));
  assert.equal(sent.length, 2);
  await assert.rejects(notifiers.notify(AGENT, { text: "x".repeat(4100) }), refusal("too_long"));
  assert.equal(sent.length, 2);
});

test("each notification is recorded against its agent, session and Telegram's id, and a test line is not", async () => {
  const { notifiers, store } = setup();
  await notifiers.add(AGENT, { type: "telegram", bot_token: TOKEN, chat_id: "55" });
  await notifiers.test(AGENT, undefined);
  const session = "ab".repeat(16);
  await notifiers.notify(AGENT, { kind: "request", session_id: session });
  const rows = store.prepare("SELECT notifier, session_id, kind, remote_id FROM notifications").all() as { notifier: string; session_id: Uint8Array; kind: string; remote_id: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.notifier, "telegram");
  assert.equal(Buffer.from(rows[0]?.session_id ?? []).toString("hex"), session);
  assert.equal(rows[0]?.kind, "request");
  assert.equal(rows[0]?.remote_id, "55:43");
  await assert.rejects(notifiers.notify(AGENT, { session_id: "nope" }), refusal("bad_argument"));
});

test("a second notifier is announced on the first, and one failing doesn't hide the other", async () => {
  const { notifiers } = setup();
  await notifiers.add(AGENT, { type: "telegram", bot_token: TOKEN, chat_id: "55" });
  const second = await notifiers.add(AGENT, { type: "telegram", name: "work", bot_token: TOKEN, chat_id: "77" }) as { told_existing: string[] };
  assert.deepEqual(second.told_existing, ["telegram"]);
  const notice = sent.find((s) => s.chat_id === "55" && s.text.startsWith("A new notifier was added"));
  assert.ok(notice?.text.includes(`cello notifier-remove work --agent ${AGENT}`));

  refuseChat = "55";
  const partial = await notifiers.notify(AGENT, {}) as { notifiers: string[]; failed: { notifier: string; message: string }[] };
  assert.deepEqual(partial.notifiers, ["work"]);
  assert.equal(partial.failed[0]?.notifier, "telegram");
  assert.ok(partial.failed[0]?.message.includes("chat not found"), "Telegram's own words reach the caller");

  notifiers.remove(AGENT, "work");
  await assert.rejects(notifiers.notify(AGENT, { notifier: "work" }), refusal("no_such_notifier"));
});

// How an agent reaches its human operator when they aren't at the session: a notifier is one route to the person, such as a
// Telegram chat. The agent decides when to use one and what leaves the machine: a fixed line, or its own words.
// Anyone can set one up, agents included, because setting up a bot is hard enough already.
import { LocalError } from "./errors.ts";
import { logEvent } from "./log.ts";
import type { Store } from "./store.ts";
import { TELEGRAM, TelegramError, type TelegramEndpoint, botUsername, latestChat, sendText } from "./telegram.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notifiers (
  agent_id BLOB NOT NULL REFERENCES agents(agent_id),
  name     TEXT NOT NULL,
  type     TEXT NOT NULL CHECK (type IN ('telegram')),
  -- JSON, and it holds the bot token, so no command, log or notice ever shows it whole.
  config   TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, name)
);
-- One row per notification that reached a notifier, so a reply can be traced to the agent and session that asked.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  agent_id   BLOB NOT NULL REFERENCES agents(agent_id),
  notifier   TEXT NOT NULL,
  session_id BLOB,
  kind       TEXT NOT NULL,
  -- The notifier's own id for it. For Telegram: the chat id, a colon, and the message id.
  remote_id  TEXT NOT NULL,
  sent_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_remote ON notifications (remote_id);
`;

export const NOTIFIER_TYPES = ["telegram"] as const;
export const NOTIFY_KINDS = ["message", "request"] as const;
type Kind = (typeof NOTIFY_KINDS)[number];

// Telegram's own limit for one message.
const TELEGRAM_MAX_CHARS = 4096;
const NAME_RULE = /^[A-Za-z0-9_-]{1,32}$/;

// The fixed lines. They say that something is waiting and nothing about what.
export function cannedLine(agentName: string, kind: Kind): string {
  return `Your agent ${agentName} has a ${kind} waiting for you.`;
}
export function withText(agentName: string, kind: Kind, text: string): string {
  return `Your agent ${agentName} has a ${kind} for you:\n\n${text}`;
}

interface TelegramConfig { bot_token: string; chat_id: string; bot: string }
interface NotifierRow { name: string; type: string; config: string; added_at: number }

export interface NotifierHost {
  agentName(agentHex: string): string;
  // The same outbound screen a message gets, since the text goes to a service outside this machine.
  screenOutbound(agentHex: string, text: string, params: Record<string, unknown>, retry: string): Promise<{ text: string }>;
}

const idOf = (agentHex: string): Uint8Array => new Uint8Array(Buffer.from(agentHex, "hex"));

export class Notifiers {
  readonly #store: Store;
  readonly #host: NotifierHost;
  readonly #telegram: TelegramEndpoint;

  constructor(store: Store, host: NotifierHost, telegram: TelegramEndpoint = TELEGRAM) {
    this.#telegram = telegram;
    this.#store = store;
    this.#host = host;
    store.exec(SCHEMA);
  }

  #rows(agentHex: string): NotifierRow[] {
    return this.#store.prepare("SELECT name, type, config, added_at FROM notifiers WHERE agent_id = ? ORDER BY added_at, name").all(idOf(agentHex)) as NotifierRow[];
  }

  #row(agentHex: string, name: string): NotifierRow {
    const row = this.#rows(agentHex).find((r) => r.name === name);
    if (!row) throw new LocalError("no_such_notifier", `${this.#host.agentName(agentHex)} has no notifier named ${name}. notifier-list shows them.`);
    return row;
  }

  // One send through one notifier. Returns the notifier's own id for what it sent.
  async #deliver(row: NotifierRow, text: string): Promise<string> {
    const config = JSON.parse(row.config) as TelegramConfig;
    const messageId = await sendText(this.#telegram, config.bot_token, config.chat_id, text);
    return `${config.chat_id}:${messageId}`;
  }

  // Proves the token and the chat with Telegram before anything is stored, so a mistake shows here and not at the first real notify.
  async add(agentHex: string, params: Record<string, unknown>): Promise<unknown> {
    const type = params["type"];
    if (type !== "telegram") throw new LocalError("bad_argument", `type must be one of: ${NOTIFIER_TYPES.join(", ")}`);
    const name = typeof params["name"] === "string" ? params["name"] : type;
    if (!NAME_RULE.test(name)) throw new LocalError("bad_argument", "name must be 1 to 32 letters, digits, underscores or dashes");
    const token = params["bot_token"];
    if (typeof token !== "string" || token.length === 0) throw new LocalError("bad_argument", "A Telegram notifier needs bot_token: the token BotFather gave for the bot.");
    const agentName = this.#host.agentName(agentHex);
    const existing = this.#rows(agentHex);
    if (existing.some((r) => r.name === name)) throw new LocalError("notifier_exists", `${agentName} already has a notifier named ${name}. Remove it first with notifier-remove, or give this one another name.`);

    const apiUrl = this.#telegram;
    let bot: string;
    let chatId = typeof params["chat_id"] === "string" && params["chat_id"].length > 0 ? params["chat_id"] : undefined;
    let chatWho: string | undefined;
    try {
      bot = await botUsername(apiUrl, token);
      if (chatId === undefined) {
        // No chat id given: use the chat that wrote to the bot last, and say whose it is so a wrong one shows.
        const chat = await latestChat(apiUrl, token);
        if (chat && "group" in chat) throw new LocalError("no_chat_yet", `Nothing was saved. The last message to @${bot} came from the group "${chat.group}", and a group is only used when you name it. Send @${bot} a message from your own chat and run this again, or give the group's id with chat_id.`);
        if (!chat) throw new LocalError("no_chat_yet", `Nothing was saved. Nobody has written to @${bot} yet, so there's no chat to send to. Open Telegram, send @${bot} any message, and run this again. Or give the chat id with chat_id.`);
        chatId = chat.id;
        chatWho = chat.who;
      }
      await sendText(apiUrl, token, chatId, `CELLO is connected. Your agent ${agentName} can now reach you here.`);
    } catch (err: unknown) {
      if (!(err instanceof TelegramError)) throw err;
      throw new LocalError("notifier_check_failed", `Nothing was saved, because the check with Telegram failed. ${err.message}`);
    }
    const config: TelegramConfig = { bot_token: token, chat_id: chatId, bot };
    this.#store.prepare("INSERT INTO notifiers (agent_id, name, type, config, added_at) VALUES (?, ?, ?, ?, ?)").run(idOf(agentHex), name, type, JSON.stringify(config), Date.now());
    logEvent("notifier.added", { agent: agentHex, notifier: name, type });

    // The routes that were already there hear about the new one, so one added by a tricked agent doesn't go unseen.
    const told: string[] = [];
    const untold: { notifier: string; message: string }[] = [];
    for (const other of existing) {
      try {
        await this.#deliver(other, `A new notifier was added for your agent ${agentName}: ${name}, a Telegram chat with @${bot}. If that wasn't you, remove it with: cello notifier-remove ${name} --agent ${agentHex}`);
        told.push(other.name);
      } catch (err: unknown) {
        if (!(err instanceof TelegramError)) throw err;
        logEvent("notifier.failed", { agent: agentHex, notifier: other.name, message: err.message });
        untold.push({ notifier: other.name, message: err.message });
      }
    }
    return { added: true, agent: agentName, notifier: name, type, bot: `@${bot}`, chat_id: chatId, ...(chatWho ? { chat_with: chatWho } : {}), test_sent: true, told_existing: told, ...(untold.length > 0 ? { could_not_tell: untold } : {}) };
  }

  list(agentHex: string): unknown {
    return {
      agent: this.#host.agentName(agentHex),
      notifiers: this.#rows(agentHex).map((row) => {
        const config = JSON.parse(row.config) as TelegramConfig;
        return { notifier: row.name, type: row.type, bot: `@${config.bot}`, chat_id: config.chat_id, added_at: new Date(row.added_at).toISOString() };
      }),
    };
  }

  remove(agentHex: string, name: string): unknown {
    this.#row(agentHex, name);
    this.#store.prepare("DELETE FROM notifiers WHERE agent_id = ? AND name = ?").run(idOf(agentHex), name);
    logEvent("notifier.removed", { agent: agentHex, notifier: name });
    return { removed: true, agent: this.#host.agentName(agentHex), notifier: name };
  }

  #chosen(agentHex: string, name: string | undefined, command: string): NotifierRow[] {
    if (name !== undefined) return [this.#row(agentHex, name)];
    const rows = this.#rows(agentHex);
    if (rows.length === 0) {
      throw new LocalError("no_notifier", `${this.#host.agentName(agentHex)} has no notifier, so ${command === "notify" ? "nobody was told" : "there's nothing to test"}. Set one up with: cello notifier-add telegram --bot-token <token> --chat-id <id> --agent ${agentHex}`);
    }
    return rows;
  }

  // Sends to every chosen notifier. It answers sent only if at least one accepted it, and names each that didn't.
  async #sendAll(agentHex: string, rows: NotifierRow[], text: string, kind: string, sessionId: Uint8Array | null, record: boolean): Promise<unknown> {
    const reached: string[] = [];
    const failed: { notifier: string; message: string }[] = [];
    for (const row of rows) {
      try {
        const remoteId = await this.#deliver(row, text);
        if (record) this.#store.prepare("INSERT INTO notifications (agent_id, notifier, session_id, kind, remote_id, sent_at) VALUES (?, ?, ?, ?, ?, ?)").run(idOf(agentHex), row.name, sessionId, kind, remoteId, Date.now());
        reached.push(row.name);
      } catch (err: unknown) {
        if (!(err instanceof TelegramError)) throw err;
        logEvent("notifier.failed", { agent: agentHex, notifier: row.name, message: err.message });
        failed.push({ notifier: row.name, message: err.message });
      }
    }
    if (reached.length === 0) throw new LocalError("notify_failed", `Nobody was told. ${failed.map((f) => `${f.notifier}: ${f.message}`).join(" ")}`);
    return { sent: true, agent: this.#host.agentName(agentHex), notifiers: reached, ...(failed.length > 0 ? { failed } : {}) };
  }

  async test(agentHex: string, name: string | undefined): Promise<unknown> {
    const rows = this.#chosen(agentHex, name, "notifier-test");
    return this.#sendAll(agentHex, rows, `This is a test from your agent ${this.#host.agentName(agentHex)}. Its notifier works.`, "test", null, false);
  }

  async notify(agentHex: string, params: Record<string, unknown>): Promise<unknown> {
    const kind = (params["kind"] ?? "message") as Kind;
    if (!NOTIFY_KINDS.includes(kind)) throw new LocalError("bad_argument", `kind must be one of: ${NOTIFY_KINDS.join(", ")}`);
    const rows = this.#chosen(agentHex, params["notifier"] as string | undefined, "notify");
    const sessionHex = params["session_id"] as string | undefined;
    if (sessionHex !== undefined && !/^[0-9a-f]{32}$/.test(sessionHex)) throw new LocalError("bad_argument", "session_id must be 32 hex characters");
    const agentName = this.#host.agentName(agentHex);
    const given = params["text"] as string | undefined;
    let text = cannedLine(agentName, kind);
    if (given !== undefined && given.length > 0) {
      const screened = await this.#host.screenOutbound(agentHex, given, params, `cello notify - --kind ${kind} --allow-flagged --agent ${agentHex}`);
      text = withText(agentName, kind, screened.text);
      if (text.length > TELEGRAM_MAX_CHARS) throw new LocalError("too_long", `Nobody was told: with its first line this is ${text.length} characters, and one Telegram message holds ${TELEGRAM_MAX_CHARS}. Shorten it, or leave the text out to send the fixed line.`);
    }
    const answer = await this.#sendAll(agentHex, rows, text, kind, sessionHex === undefined ? null : new Uint8Array(Buffer.from(sessionHex, "hex")), true);
    logEvent("notifier.sent", { agent: agentHex, kind, with_text: given !== undefined && given.length > 0 });
    return { ...(answer as object), kind, included_text: given !== undefined && given.length > 0 };
  }
}

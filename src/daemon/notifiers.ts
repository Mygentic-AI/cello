// How an agent reaches its human operator when they aren't at the session: a notifier is one route to the person, such as a
// Telegram chat. The agent decides when to use one and what leaves the machine: a fixed line, or its own words.
// Anyone can set one up, agents included, because setting up a bot is hard enough already.
import { LocalError } from "./errors.ts";
import { logEvent } from "./log.ts";
import type { Store } from "./store.ts";
import { TELEGRAM, TelegramError, type TelegramEndpoint, type TelegramUpdate, botIdOf, botUsername, newestUpdate, sendText, updatesFrom } from "./telegram.ts";

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

// chat_id is what was given or found. chat_number is the chat's own number, from Telegram's answer, which a reply carries.
interface TelegramConfig { bot_token: string; chat_id: string; chat_number: string; bot: string }
interface NotifierRow { name: string; type: string; config: string; added_at: number }
// A notifier with its agent, and what a reply has to match: the bot and the chat's own number.
interface Holder { agentHex: string; name: string; botId: string; token: string; chat: string }

export interface NotifierHost {
  agentName(agentHex: string): string;
  // The same outbound screen a message gets, since the text goes to a service outside this machine.
  screenOutbound(agentHex: string, text: string, params: Record<string, unknown>, retry: string): Promise<{ text: string; report: Record<string, unknown> }>;
  // Whether any session holds this agent right now.
  reachable(agentHex: string): boolean;
  // A notice the agent reads with its next receive.
  tell(agentHex: string, text: string): void;
  // Hands the agent what its operator said. False when this one was already handed over.
  fromOperator(agentHex: string, sessionId: Uint8Array | null, text: string, via: string, sourceId: string): boolean;
}

const idOf = (agentHex: string): Uint8Array => new Uint8Array(Buffer.from(agentHex, "hex"));
const offsetKey = (botId: string): string => `notifier.telegram.next_update.${botId}`;
const FIRST_RETRY_MS = 1_000;
const LONGEST_RETRY_MS = 60_000;

// Ends early when the reader is stopped, so stopping the daemon never waits out a retry.
function pause(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      stop.removeEventListener("abort", done);
      resolve();
    }
    stop.addEventListener("abort", done);
  });
}

export class Notifiers {
  readonly #store: Store;
  readonly #host: NotifierHost;
  readonly #telegram: TelegramEndpoint;
  // One reader per bot, however many notifiers use it: Telegram allows a bot only one.
  readonly #readers = new Map<string, AbortController>();

  constructor(store: Store, host: NotifierHost, telegram: TelegramEndpoint = TELEGRAM) {
    this.#telegram = telegram;
    this.#store = store;
    this.#host = host;
    store.exec(SCHEMA);
  }

  // Starts listening for the operator's replies on every bot a notifier uses.
  start(): void {
    for (const holder of this.#holders()) this.#listen(holder.botId);
  }

  stop(): void {
    for (const reader of this.#readers.values()) reader.abort();
    this.#readers.clear();
  }

  // Every agent's notifiers, oldest first.
  #holders(): Holder[] {
    const rows = this.#store.prepare("SELECT agent_id, name, config FROM notifiers ORDER BY added_at, name").all() as { agent_id: Uint8Array; name: string; config: string }[];
    return rows.map((row) => {
      const config = JSON.parse(row.config) as TelegramConfig;
      return { agentHex: Buffer.from(row.agent_id).toString("hex"), name: row.name, botId: botIdOf(config.bot_token), token: config.bot_token, chat: config.chat_number };
    });
  }

  #listen(botId: string): void {
    if (this.#readers.has(botId)) return;
    const reader = new AbortController();
    this.#readers.set(botId, reader);
    void this.#read(botId, reader);
  }

  // Reads what people send the bot, for as long as a notifier uses it. The place reached is kept in the database and moves
  // on only once a reply is stored, so a restart or a failed write repeats nothing and loses nothing.
  async #read(botId: string, reader: AbortController): Promise<void> {
    const stop = reader.signal;
    let retry = FIRST_RETRY_MS;
    while (!stop.aborted) {
      // The newest notifier's token, since an older one may have been replaced at BotFather.
      const token = this.#holders().filter((h) => h.botId === botId).at(-1)?.token;
      if (token === undefined) break;
      try {
        const updates = await updatesFrom(this.#telegram, token, Number(this.#store.getConfig(offsetKey(botId)) ?? 0), stop);
        for (const update of updates) {
          await this.#onUpdate(botId, token, update);
          this.#store.setConfig(offsetKey(botId), String(update.update_id + 1));
        }
        retry = FIRST_RETRY_MS;
      } catch (err: unknown) {
        if (stop.aborted) break;
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof TelegramError ? err.code : undefined;
        if (code === 401 || code === 404 || code === 409) {
          logEvent("notifier.reading_stopped", { bot: botId, code, message });
          for (const holder of this.#holders().filter((h) => h.botId === botId)) {
            this.#host.tell(holder.agentHex, code === 409
              ? `Another program is reading the Telegram bot behind your notifier ${holder.name}, and a bot allows only one reader, so your operator's replies can't arrive here. Notifications still go out. Tell your operator to give this agent a bot nothing else uses: cello notifier-remove ${holder.name}, then notifier-add.`
              : `Telegram no longer accepts the token of the bot behind your notifier ${holder.name} (${message}), so you can't reach your operator through it and their replies won't arrive. Set it up again with a current token: cello notifier-remove ${holder.name}, then notifier-add.`);
          }
          break;
        }
        logEvent("notifier.reading_failed", { bot: botId, message, retry_ms: retry });
        await pause(retry, stop);
        retry = Math.min(retry * 2, LONGEST_RETRY_MS);
      }
    }
    if (this.#readers.get(botId) === reader) this.#readers.delete(botId);
  }

  // Says something back in the operator's chat. It's a courtesy: failing to say it never holds up or undoes the reply itself.
  async #answer(holder: Holder, text: string): Promise<void> {
    try {
      await sendText(this.#telegram, holder.token, holder.chat, text);
    } catch (err: unknown) {
      logEvent("notifier.answer_failed", { bot: holder.botId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // One thing sent to the bot. Only the exact bot and chat a notifier holds may speak as the operator, and only a private chat.
  async #onUpdate(botId: string, token: string, update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (message?.chat?.id === undefined) return;
    const chat = String(message.chat.id);
    const holders = this.#holders().filter((h) => h.botId === botId && h.chat === chat);
    const first = holders[0];
    if (!first) {
      logEvent("notifier.reply_ignored", { bot: botId, reason: "not a chat any notifier holds" });
      return;
    }
    const here: Holder = { ...first, token };
    if (message.chat.type !== "private") {
      await this.#answer(here, "Replies are only taken from a private chat with this bot, so this wasn't passed to any agent.");
      return;
    }
    const text = typeof message.text === "string" ? message.text.trim() : "";
    // Telegram's own greeting when a chat with a bot is opened. It isn't something the person said to an agent.
    if (text === "/start") return;
    if (text.length === 0) {
      await this.#answer(here, "Only text reaches your agent, so this wasn't passed on. Type your answer.");
      return;
    }
    const holds = (agentId: Uint8Array, notifier: string): Holder | undefined => holders.find((h) => h.name === notifier && h.agentHex === Buffer.from(agentId).toString("hex"));
    type Sent = { agent_id: Uint8Array; notifier: string; session_id: Uint8Array | null };
    let target: { holder: Holder; sessionId: Uint8Array | null } | undefined;
    // A reply to one of an agent's notifications goes to that agent, about that session.
    const repliedTo = message.reply_to_message?.message_id;
    if (repliedTo !== undefined) {
      const sent = (this.#store.prepare("SELECT agent_id, notifier, session_id FROM notifications WHERE remote_id = ? ORDER BY id DESC").all(`${chat}:${repliedTo}`) as Sent[]).find((row) => holds(row.agent_id, row.notifier));
      if (sent) target = { holder: holds(sent.agent_id, sent.notifier) as Holder, sessionId: sent.session_id };
    }
    // A plain message goes to whichever agent wrote to this chat last, because that's who the person is answering.
    if (!target) {
      const sent = (this.#store.prepare("SELECT agent_id, notifier, session_id FROM notifications WHERE remote_id LIKE ? ORDER BY id DESC LIMIT 50").all(`${chat}:%`) as Sent[]).find((row) => holds(row.agent_id, row.notifier));
      if (sent) target = { holder: holds(sent.agent_id, sent.notifier) as Holder, sessionId: sent.session_id };
    }
    if (!target) {
      if (new Set(holders.map((h) => h.agentHex)).size > 1) {
        await this.#answer(here, "More than one agent uses this chat, and none has written to you yet, so it isn't clear who this is for. It wasn't passed on. Reply to one of an agent's messages once it has written.");
        return;
      }
      target = { holder: first, sessionId: null };
    }
    const agentHex = target.holder.agentHex;
    if (!this.#host.fromOperator(agentHex, target.sessionId, text, target.holder.name, `telegram:${botId}:${update.update_id}`)) return;
    const name = this.#host.agentName(agentHex);
    await this.#answer(here, this.#host.reachable(agentHex) ? `Passed to ${name}.` : `Passed to ${name}. No session is holding ${name} right now, so it will see this when one next reads.`);
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
    const sent = await sendText(this.#telegram, config.bot_token, config.chat_id, text);
    return `${sent.chatId}:${sent.messageId}`;
  }

  // Proves the token and the chat with Telegram before anything is stored, so a mistake shows here and not at the first real notify.
  async add(agentHex: string, params: Record<string, unknown>): Promise<unknown> {
    const type = params["type"];
    if (type !== "telegram") throw new LocalError("bad_argument", `type must be one of: ${NOTIFIER_TYPES.join(", ")}`);
    const name = typeof params["name"] === "string" ? params["name"] : type;
    if (!NAME_RULE.test(name)) throw new LocalError("bad_argument", "name must be 1 to 32 letters, digits, underscores or dashes");
    // A pasted token often carries a stray space or newline, which Telegram answers with a bare "Not Found".
    const token = typeof params["bot_token"] === "string" ? params["bot_token"].trim() : "";
    if (token.length === 0) throw new LocalError("bad_argument", "A Telegram notifier needs bot_token: the token BotFather gave for the bot.");
    const agentName = this.#host.agentName(agentHex);
    const existing = this.#rows(agentHex);
    if (existing.some((r) => r.name === name)) throw new LocalError("notifier_exists", `${agentName} already has a notifier named ${name}. Remove it first with notifier-remove, or give this one another name.`);

    const apiUrl = this.#telegram;
    const botId = botIdOf(token);
    // A bot this daemon already reads can't be asked for its newest message: Telegram allows one reader, and asking would
    // throw away replies the reader hasn't taken yet.
    const reading = this.#readers.has(botId);
    let bot: string;
    let chatId = typeof params["chat_id"] === "string" && params["chat_id"].trim().length > 0 ? params["chat_id"].trim() : undefined;
    let chatWho: string | undefined;
    let chatNumber: string;
    let newest: TelegramUpdate | undefined;
    try {
      bot = await botUsername(apiUrl, token);
      if (reading && chatId === undefined) throw new LocalError("chat_id_needed", `Nothing was saved. This machine already uses @${bot} for another notifier, so the chat can't be looked up. Give it with chat_id: notifier-list on the agent that has it shows the one in use.`);
      if (!reading) newest = await newestUpdate(apiUrl, token);
      if (chatId === undefined) {
        // No chat id given: use the chat that wrote to the bot last, and say whose it is so a wrong one shows.
        // Only a person's own chat counts, so a group the bot sits in is never picked by accident.
        const chat = newest?.message?.chat;
        if (chat?.id === undefined) throw new LocalError("no_chat_yet", `Nothing was saved. Nobody has written to @${bot} yet, so there's no chat to send to. Open Telegram, send @${bot} any message, and run this again. Or give the chat id with chat_id.`);
        if (chat.type !== "private") throw new LocalError("no_chat_yet", `Nothing was saved. The last message to @${bot} came from the group "${chat.title ?? String(chat.id)}", and a group is only used when you name it. Send @${bot} a message from your own chat and run this again, or give the group's id with chat_id.`);
        chatId = String(chat.id);
        chatWho = chat.username ? `@${chat.username}` : chat.first_name ?? chatId;
      }
      chatNumber = (await sendText(apiUrl, token, chatId, `CELLO is connected. Your agent ${agentName} can now reach you here.`)).chatId;
    } catch (err: unknown) {
      if (!(err instanceof TelegramError)) throw err;
      throw new LocalError("notifier_check_failed", `Nothing was saved, because the check with Telegram failed. ${err.message}`);
    }
    const config: TelegramConfig = { bot_token: token, chat_id: chatId, chat_number: chatNumber, bot };
    this.#store.prepare("INSERT INTO notifiers (agent_id, name, type, config, added_at) VALUES (?, ?, ?, ?, ?)").run(idOf(agentHex), name, type, JSON.stringify(config), Date.now());
    logEvent("notifier.added", { agent: agentHex, notifier: name, type });
    // Reading starts after whatever was sent to the bot to set it up. A "hi" typed to find the chat is not an instruction.
    if (newest) this.#store.setConfig(offsetKey(botId), String(newest.update_id + 1));
    this.#listen(botId);

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
    return { added: true, agent: agentName, notifier: name, type, bot: `@${bot}`, chat_id: chatId, ...(chatWho ? { chat_with: chatWho } : {}), told_existing: told, ...(untold.length > 0 ? { could_not_tell: untold } : {}) };
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
    const botId = botIdOf((JSON.parse(this.#row(agentHex, name).config) as TelegramConfig).bot_token);
    this.#store.prepare("DELETE FROM notifiers WHERE agent_id = ? AND name = ?").run(idOf(agentHex), name);
    logEvent("notifier.removed", { agent: agentHex, notifier: name });
    // The bot's last notifier going takes its reader with it.
    if (!this.#holders().some((h) => h.botId === botId)) {
      this.#readers.get(botId)?.abort();
      this.#readers.delete(botId);
    }
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
    const only = params["notifier"];
    if (only !== undefined && typeof only !== "string") throw new LocalError("bad_argument", "notifier must be a notifier's name");
    const rows = this.#chosen(agentHex, only, "notify");
    const sessionHex = params["session_id"];
    if (sessionHex !== undefined && (typeof sessionHex !== "string" || !/^[0-9a-f]{32}$/.test(sessionHex))) throw new LocalError("bad_argument", "session_id must be 32 hex characters");
    const agentName = this.#host.agentName(agentHex);
    const given = params["text"];
    if (given !== undefined && typeof given !== "string") throw new LocalError("bad_argument", "text must be a string");
    let text = cannedLine(agentName, kind);
    // What the screen changed or let through, so the agent knows the person didn't read its exact words.
    let report: Record<string, unknown> = {};
    if (given !== undefined && given.length > 0) {
      const screened = await this.#host.screenOutbound(agentHex, given, params, `cello notify - --kind ${kind}${only ? ` --notifier ${only}` : ""}${sessionHex ? ` --session-id ${sessionHex}` : ""} --allow-flagged --agent ${agentHex}`);
      text = withText(agentName, kind, screened.text);
      report = screened.report;
      if (text.length > TELEGRAM_MAX_CHARS) throw new LocalError("too_long", `Nobody was told: with its first line this is ${text.length} characters, and one Telegram message holds ${TELEGRAM_MAX_CHARS}. Shorten it, or leave the text out to send the fixed line.`);
    }
    const answer = await this.#sendAll(agentHex, rows, text, kind, sessionHex === undefined ? null : new Uint8Array(Buffer.from(sessionHex, "hex")), true);
    logEvent("notifier.sent", { agent: agentHex, kind, with_text: given !== undefined && given.length > 0 });
    return { ...(answer as object), kind, included_text: given !== undefined && given.length > 0, ...report };
  }
}

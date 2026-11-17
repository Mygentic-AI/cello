// How an agent reaches its human operator when they aren't at the session: a notifier is one route to the person, such as a
// Telegram chat. The agent decides when to use one and what leaves the machine: a fixed line, or its own words.
// Anyone can set one up, agents included, because setting up a bot is hard enough already.
import { randomBytes } from "node:crypto";
import { LocalError } from "./errors.ts";
import { logEvent } from "./log.ts";
import type { Store } from "./store.ts";
import { TELEGRAM, TelegramError, type TelegramEndpoint, type TelegramUpdate, answerTap, botIdOf, botUsername, choiceIndex, clearButtons, newestUpdate, sendText, updatesFrom } from "./telegram.ts";

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
  -- The notifier's own id for it. For Telegram: the bot's id, the chat's number and the message's, with colons. All three,
  -- because each bot numbers its messages from one, so two bots in one person's chat share numbers.
  remote_id  TEXT NOT NULL,
  sent_at    INTEGER NOT NULL,
  -- The choices offered as buttons, as JSON, and which was tapped. asked is the same on every row one notify call wrote,
  -- so a question shown on two notifiers is still answered once.
  choices    TEXT,
  chosen     INTEGER,
  asked      TEXT
);
CREATE INDEX IF NOT EXISTS notifications_remote ON notifications (remote_id);
`;

export const NOTIFIER_TYPES = ["telegram"] as const;
export const NOTIFY_KINDS = ["message", "request"] as const;
type Kind = (typeof NOTIFY_KINDS)[number];

// Telegram's own limit for one message.
const TELEGRAM_MAX_CHARS = 4096;
const MAX_CHOICES = 8;
const MAX_CHOICE_CHARS = 40;
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
  // Hands the agent what its operator said. "already" when this one was handed over before, and "no_agent" when the agent
  // is no longer on this daemon.
  fromOperator(agentHex: string, sessionId: Uint8Array | null, text: string, via: string, sourceId: string): "stored" | "already" | "no_agent";
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
    // For a database from 0.0.317 to 0.0.319, whose table was made before choices existed.
    const columns = (store.prepare("PRAGMA table_info(notifications)").all() as { name: string }[]).map((column) => column.name);
    if (!columns.includes("choices")) store.exec("ALTER TABLE notifications ADD COLUMN choices TEXT");
    if (!columns.includes("chosen")) store.exec("ALTER TABLE notifications ADD COLUMN chosen INTEGER");
    if (!columns.includes("asked")) store.exec("ALTER TABLE notifications ADD COLUMN asked TEXT");
  }

  // Starts listening for the operator's replies on every bot a notifier uses.
  start(): void {
    for (const holder of this.#holders()) this.#listen(holder.botId);
  }

  stop(): void {
    for (const reader of this.#readers.values()) reader.abort();
    this.#readers.clear();
  }

  // An agent that's removed takes its notifiers with it, tokens included, and a bot nobody else uses stops being read.
  forget(agentHex: string): void {
    this.#store.prepare("DELETE FROM notifications WHERE agent_id = ?").run(idOf(agentHex));
    this.#store.prepare("DELETE FROM notifiers WHERE agent_id = ?").run(idOf(agentHex));
    const inUse = new Set(this.#holders().map((h) => h.botId));
    for (const [botId, reader] of this.#readers) {
      if (inUse.has(botId)) continue;
      reader.abort();
      this.#readers.delete(botId);
    }
    logEvent("notifier.agent_forgotten", { agent: agentHex });
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
    // Nothing in the reader may take the daemon down with it. If it dies it says so, and the next add or restart starts it again.
    this.#read(botId, reader).catch((err: unknown) => {
      if (this.#readers.get(botId) === reader) this.#readers.delete(botId);
      logEvent("notifier.reading_crashed", { bot: botId, message: err instanceof Error ? err.message : String(err) });
    });
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
          // A reader stopped part-way must not write its place over one a new notifier has just set.
          if (stop.aborted) break;
          await this.#onUpdate(botId, token, update);
          if (stop.aborted) break;
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

  // Takes the buttons off every message one notify call sent, on every notifier, and says in each chat what was decided.
  // One question is answered once, wherever it was shown.
  async #settleAsked(asked: string, tappedId: number, line: string, elsewhere: string): Promise<void> {
    const rows = this.#store.prepare("SELECT id, agent_id, notifier, remote_id FROM notifications WHERE asked = ?").all(asked) as { id: number; agent_id: Uint8Array; notifier: string; remote_id: string }[];
    const holders = this.#holders();
    for (const row of rows) {
      const holder = holders.find((h) => h.name === row.notifier && h.agentHex === Buffer.from(row.agent_id).toString("hex"));
      const messageId = Number(row.remote_id.split(":").at(-1));
      if (!holder || !Number.isInteger(messageId)) continue;
      try {
        await clearButtons(this.#telegram, holder.token, holder.chat, messageId);
        await sendText(this.#telegram, holder.token, holder.chat, row.id === tappedId ? line : elsewhere);
      } catch (err: unknown) {
        logEvent("notifier.answer_failed", { bot: holder.botId, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // A button was tapped. It answers one notification, so it goes to the agent and session that sent it, with no guessing.
  // The same gate as a typed reply: only the exact bot and private chat a notifier holds.
  async #onTap(botId: string, token: string, update: TelegramUpdate): Promise<void> {
    const tap = update.callback_query;
    const under = tap?.message;
    if (typeof tap?.id !== "string" || under?.chat?.id === undefined || typeof under.message_id !== "number") return;
    const chat = String(under.chat.id);
    const holders = this.#holders().filter((h) => h.botId === botId && h.chat === chat);
    const settle = async (line: string): Promise<void> => {
      try {
        await answerTap(this.#telegram, token, tap.id as string, line);
      } catch (err: unknown) {
        logEvent("notifier.answer_failed", { bot: botId, message: err instanceof Error ? err.message : String(err) });
      }
    };
    if (holders.length === 0 || under.chat.type !== "private") {
      logEvent("notifier.reply_ignored", { bot: botId, reason: "a tap from a chat no notifier holds" });
      return;
    }
    const sent = this.#store.prepare("SELECT id, agent_id, notifier, session_id, choices, asked FROM notifications WHERE remote_id = ? ORDER BY id DESC").get(`${botId}:${chat}:${under.message_id}`) as { id: number; agent_id: Uint8Array; notifier: string; session_id: Uint8Array | null; choices: string | null; asked: string | null } | undefined;
    const holder = sent && holders.find((h) => h.name === sent.notifier && h.agentHex === Buffer.from(sent.agent_id).toString("hex"));
    const choices = sent?.choices ? JSON.parse(sent.choices) as string[] : [];
    if (!sent || !holder || sent.asked === null || choices.length === 0) {
      await settle("This is no longer waiting for an answer.");
      return;
    }
    const index = choiceIndex(tap.data);
    const label = index === undefined ? undefined : choices[index];
    if (label === undefined) {
      await settle("That isn't one of the choices.");
      return;
    }
    // One question may have gone out on several notifiers. It's answered once, whichever chat the tap came from.
    const answered = this.#store.prepare("SELECT chosen FROM notifications WHERE asked = ? AND chosen IS NOT NULL LIMIT 1").get(sent.asked) as { chosen: number } | undefined;
    if (answered) {
      await settle(`Already answered: ${choices[answered.chosen] ?? "another choice"}.`);
      return;
    }
    const outcome = this.#host.fromOperator(holder.agentHex, sent.session_id, label, holder.name, `telegram:${botId}:${update.update_id}`);
    if (outcome === "no_agent") {
      await settle("The agent this was for is no longer on this machine.");
      return;
    }
    // Marked before anything is said back, so a second tap in the same moment finds it answered.
    this.#store.prepare("UPDATE notifications SET chosen = ? WHERE asked = ? AND chosen IS NULL").run(index, sent.asked);
    const name = this.#host.agentName(holder.agentHex);
    // "already" is this same tap fetched again after a restart: the agent has it, and the buttons may still be showing.
    await settle(`Passed to ${name}.`);
    await this.#settleAsked(sent.asked, sent.id, `You chose: ${label}. Passed to ${name}.`, `Answered on another of ${name}'s notifiers: ${label}.`);
  }

  // One thing sent to the bot. Only the exact bot and chat a notifier holds may speak as the operator, and only a private chat.
  async #onUpdate(botId: string, token: string, update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.#onTap(botId, token, update);
      return;
    }
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
    if (/^\/start(@\S+)?(\s|$)/.test(text)) return;
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
      const sent = this.#store.prepare("SELECT agent_id, notifier, session_id FROM notifications WHERE remote_id = ? ORDER BY id DESC").get(`${botId}:${chat}:${repliedTo}`) as Sent | undefined;
      const holder = sent && holds(sent.agent_id, sent.notifier);
      if (sent && !holder) {
        // The person named an agent by answering its message. Handing it to another one would be a guess they didn't make.
        await this.#answer(here, "The agent that sent that message no longer uses this chat, so your reply wasn't passed on.");
        return;
      }
      if (sent && holder) target = { holder, sessionId: sent.session_id };
    }
    // A plain message goes to whichever agent wrote to this chat last, because that's who the person is answering. It
    // names no session: only answering a message says which conversation it's about.
    if (!target) {
      const sent = (this.#store.prepare("SELECT agent_id, notifier, session_id FROM notifications WHERE remote_id LIKE ? ORDER BY id DESC LIMIT 50").all(`${botId}:${chat}:%`) as Sent[]).find((row) => holds(row.agent_id, row.notifier));
      if (sent) target = { holder: holds(sent.agent_id, sent.notifier) as Holder, sessionId: null };
    }
    if (!target) {
      if (new Set(holders.map((h) => h.agentHex)).size > 1) {
        await this.#answer(here, "More than one agent uses this chat, and none has written to you yet, so it isn't clear who this is for. It wasn't passed on. Reply to one of an agent's messages once it has written.");
        return;
      }
      target = { holder: first, sessionId: null };
    }
    const agentHex = target.holder.agentHex;
    const outcome = this.#host.fromOperator(agentHex, target.sessionId, text, target.holder.name, `telegram:${botId}:${update.update_id}`);
    if (outcome === "already") return;
    if (outcome === "no_agent") {
      // Never silently: the person believes they've given an instruction.
      await this.#answer(here, "The agent this was for is no longer on this machine, so it wasn't passed on.");
      return;
    }
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
  async #deliver(row: NotifierRow, text: string, choices: readonly string[] = []): Promise<string> {
    const config = JSON.parse(row.config) as TelegramConfig;
    const sent = await sendText(this.#telegram, config.bot_token, config.chat_id, text, choices);
    return `${botIdOf(config.bot_token)}:${sent.chatId}:${sent.messageId}`;
  }

  // Proves the token and the chat with Telegram before anything is stored, so a mistake shows here and not at the first real notify.
  async add(agentHex: string, params: Record<string, unknown>): Promise<unknown> {
    const type = params["type"];
    if (type !== "telegram") throw new LocalError("bad_argument", `type must be one of: ${NOTIFIER_TYPES.join(", ")}`);
    const name = typeof params["name"] === "string" ? params["name"] : type;
    if (!NAME_RULE.test(name)) throw new LocalError("bad_argument", "name must be 1 to 32 letters, digits, underscores or dashes");
    // A pasted token often carries a stray space or newline, which Telegram answers with a bare "Not Found".
    let token = typeof params["bot_token"] === "string" ? params["bot_token"].trim() : "";
    // Another agent on this machine already has the bot: take its notifier as it is, so the token is typed once, ever, and
    // an agent can set this up for a new agent without being shown it.
    let sameChat: string | undefined;
    const sameAs = params["same_as_agent"];
    if (typeof sameAs === "string") {
      if (token.length > 0) throw new LocalError("bad_argument", "give bot_token or same_as, not both");
      const theirs = this.#rows(sameAs).filter((row) => row.type === type);
      const source = theirs.find((row) => row.name === name) ?? (theirs.length === 1 ? theirs[0] : undefined);
      if (!source) throw new LocalError("no_such_notifier", `${this.#host.agentName(sameAs)} has ${theirs.length === 0 ? "no Telegram notifier to copy" : `${theirs.length} Telegram notifiers, so say which with name: ${theirs.map((row) => row.name).join(", ")}`}.`);
      const config = JSON.parse(source.config) as TelegramConfig;
      token = config.bot_token;
      sameChat = config.chat_number;
    }
    if (token.length === 0) throw new LocalError("bad_argument", "A Telegram notifier needs bot_token, the token BotFather gave for the bot, or same_as, an agent on this machine that already has one.");
    const agentName = this.#host.agentName(agentHex);
    const existing = this.#rows(agentHex);
    if (existing.some((r) => r.name === name)) throw new LocalError("notifier_exists", `${agentName} already has a notifier named ${name}. Remove it first with notifier-remove, or give this one another name.`);

    const apiUrl = this.#telegram;
    const botId = botIdOf(token);
    // A bot this daemon already reads can't be asked for its newest message: Telegram allows one reader, and asking would
    // throw away replies the reader hasn't taken yet.
    // The database says whether it's in use, not the running readers, so this holds from the daemon's first moment.
    const sameBot = this.#holders().filter((h) => h.botId === botId);
    const reading = sameBot.length > 0;
    let bot: string;
    let chatId = typeof params["chat_id"] === "string" && params["chat_id"].trim().length > 0 ? params["chat_id"].trim() : sameChat;
    let chatWho: string | undefined;
    let chatNumber: string;
    let newest: TelegramUpdate | undefined;
    try {
      bot = await botUsername(apiUrl, token);
      if (reading && chatId === undefined) {
        // One bot can serve every agent a person has. The next agent uses the chat the first one found, with nothing more to give.
        const chats = [...new Set(sameBot.map((h) => h.chat))];
        if (chats.length !== 1) throw new LocalError("chat_id_needed", `Nothing was saved. This machine uses @${bot} with more than one chat, so it isn't clear which one this agent should write to. Give it with chat_id: notifier-list on an agent that has it shows them.`);
        chatId = chats[0] as string;
        chatWho = "the chat this bot already writes to";
      }
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
  async #sendAll(agentHex: string, rows: NotifierRow[], text: string, kind: string, sessionId: Uint8Array | null, record: boolean, choices: readonly string[] = []): Promise<unknown> {
    const reached: string[] = [];
    const failed: { notifier: string; message: string }[] = [];
    // The same on every notifier this one call reaches, so a question with choices is answered once across all of them.
    const asked = choices.length > 0 ? randomBytes(12).toString("hex") : null;
    for (const row of rows) {
      try {
        const remoteId = await this.#deliver(row, text, choices);
        if (record) this.#store.prepare("INSERT INTO notifications (agent_id, notifier, session_id, kind, remote_id, sent_at, choices, asked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(idOf(agentHex), row.name, sessionId, kind, remoteId, Date.now(), asked ? JSON.stringify(choices) : null, asked);
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
    // Choices the person answers with one tap. They are the agent's words too, so they pass the same screen, together, and
    // if the screen changes how many lines there are, nothing is sent: a button must mean what the agent meant by it.
    let choices: string[] = [];
    const offered = params["choices"];
    if (offered !== undefined) {
      if (typeof offered !== "string") throw new LocalError("bad_argument", "choices must be text: the choices with | between them");
      // A line break inside one would shift every choice after it when they're screened together, a line each.
      if (/[\r\n]/.test(offered)) throw new LocalError("bad_argument", "a choice can't hold a line break. Put each on one line, with | between them.");
      choices = offered.split("|").map((choice) => choice.trim()).filter((choice) => choice.length > 0);
      if (choices.length < 2 || choices.length > MAX_CHOICES) throw new LocalError("bad_argument", `choices takes 2 to ${MAX_CHOICES} choices with | between them, such as "Agree|Disagree". This has ${choices.length}.`);
      const long = choices.find((choice) => choice.length > MAX_CHOICE_CHARS);
      if (long !== undefined) throw new LocalError("too_long", `A choice holds ${MAX_CHOICE_CHARS} characters, so it fits on a button, and "${long.slice(0, 30)}..." is ${long.length}. Put the detail in the text and keep the choice short.`);
      if (new Set(choices).size !== choices.length) throw new LocalError("bad_argument", "two of the choices are the same, so the answer wouldn't say which was meant");
      const screened = await this.#host.screenOutbound(agentHex, choices.join("\n"), params, `cello notify --choices ... --allow-flagged --agent ${agentHex}`);
      const after = screened.text.split("\n");
      if (after.length !== choices.length || after.some((choice) => choice.trim().length === 0)) throw new LocalError("blocked_by_screening", "Nobody was told: the outbound screen changed the choices so they no longer line up. Reword them.");
      choices = after.map((choice) => choice.trim());
      // Two different choices can come out of the screen as the same words, and then a tap wouldn't say which was meant.
      if (new Set(choices).size !== choices.length) throw new LocalError("blocked_by_screening", "Nobody was told: after the outbound screen replaced part of them, two of the choices read the same. Reword them so each differs without what was replaced.");
      report = { ...report, ...screened.report };
    }
    const answer = await this.#sendAll(agentHex, rows, text, kind, sessionHex === undefined ? null : new Uint8Array(Buffer.from(sessionHex, "hex")), true, choices);
    logEvent("notifier.sent", { agent: agentHex, kind, with_text: given !== undefined && given.length > 0, choices: choices.length });
    return { ...(answer as object), kind, included_text: given !== undefined && given.length > 0, ...(choices.length > 0 ? { choices } : {}), ...report };
  }
}

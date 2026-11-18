// The Telegram notifier: a chat with a bot the person made. It sends through the bot, and reads what the person sends back,
// one reader per bot however many notifiers use it, because Telegram allows a bot only one.
import { LocalError } from "./errors.ts";
import { logEvent } from "./log.ts";
import type { Connected, Delivered, NotifierAdapter, NotifierContext, Outgoing, Settled, StoredNotifier } from "./notifier-adapter.ts";
import { TelegramError, type TelegramEndpoint, type TelegramUpdate, answerTap, botIdOf, botUsername, choiceIndex, clearButtons, newestUpdate, sendButtons, sendText, setCommands, thumbsUp, updatesFrom } from "./telegram.ts";

// A pick made with /agents, kept in the notifications table as its own kind. A button carries "pick:" and the start of the
// agent's id: Telegram allows 64 bytes, and 32 hex characters can't collide between the few agents sharing one chat.
const PICK = "pick";
const PICK_DATA = "pick:";
const PICK_PREFIX_CHARS = 32;

// chat_id is what was given or found. chat_number is the chat's own number, from Telegram's answer, which a reply carries.
interface TelegramConfig { bot_token: string; chat_id: string; chat_number: string; bot: string }
// A notifier with its agent, and what a reply has to match: the bot and the chat's own number.
interface Holder { agentHex: string; name: string; botId: string; token: string; chat: string }

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

export class TelegramNotifier implements NotifierAdapter {
  // Telegram's own limit for one message.
  readonly maxChars = 4096;
  readonly local = false;
  readonly #ctx: NotifierContext;
  readonly #telegram: TelegramEndpoint;
  // One reader per bot, however many notifiers use it: Telegram allows a bot only one.
  readonly #readers = new Map<string, AbortController>();

  constructor(ctx: NotifierContext, telegram: TelegramEndpoint) {
    this.#ctx = ctx;
    this.#telegram = telegram;
  }

  // Starts listening for the operator's replies on every bot a notifier uses.
  start(): void {
    for (const holder of this.#holders()) this.#listen(holder.botId);
  }

  stop(): void {
    for (const reader of this.#readers.values()) reader.abort();
    this.#readers.clear();
  }

  // A bot nobody uses any more stops being read.
  prune(): void {
    const inUse = new Set(this.#holders().map((h) => h.botId));
    for (const [botId, reader] of this.#readers) {
      if (inUse.has(botId)) continue;
      reader.abort();
      this.#readers.delete(botId);
    }
  }

  // Every agent's Telegram notifiers, oldest first.
  #holders(): Holder[] {
    return this.#ctx.rows().map((row) => {
      const config = JSON.parse(row.config) as TelegramConfig;
      return { agentHex: row.agentHex, name: row.name, botId: botIdOf(config.bot_token), token: config.bot_token, chat: config.chat_number };
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
    // So typing "/" in the chat offers /agents. It's only a hint: the command works typed in full without it.
    // The newest token, as the reader uses, since an older one may have been replaced at BotFather.
    const newest = this.#holders().filter((h) => h.botId === botId).at(-1);
    if (newest) {
      setCommands(this.#telegram, newest.token, [{ command: "agents", description: "Choose which agent your messages go to" }])
        .catch((err: unknown) => logEvent("notifier.commands_failed", { bot: botId, message: err instanceof Error ? err.message : String(err) }));
    }
    while (!stop.aborted) {
      // The newest notifier's token, since an older one may have been replaced at BotFather.
      const token = this.#holders().filter((h) => h.botId === botId).at(-1)?.token;
      if (token === undefined) break;
      try {
        const updates = await updatesFrom(this.#telegram, token, Number(this.#ctx.store.getConfig(offsetKey(botId)) ?? 0), stop);
        for (const update of updates) {
          // A reader stopped part-way must not write its place over one a new notifier has just set.
          if (stop.aborted) break;
          await this.#onUpdate(botId, token, update);
          if (stop.aborted) break;
          this.#ctx.store.setConfig(offsetKey(botId), String(update.update_id + 1));
        }
        retry = FIRST_RETRY_MS;
      } catch (err: unknown) {
        if (stop.aborted) break;
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof TelegramError ? err.code : undefined;
        if (code === 401 || code === 404 || code === 409) {
          logEvent("notifier.reading_stopped", { bot: botId, code, message });
          for (const holder of this.#holders().filter((h) => h.botId === botId)) {
            this.#ctx.host.tell(holder.agentHex, code === 409
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
  // quiet: the line only confirms what the person just did, so the phone doesn't sound. A line saying their words didn't
  // reach anyone does sound.
  async #answer(holder: Holder, text: string, quiet = false): Promise<void> {
    try {
      await sendText(this.#telegram, holder.token, holder.chat, text, [], quiet);
    } catch (err: unknown) {
      logEvent("notifier.answer_failed", { bot: holder.botId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Takes the buttons off one message this notifier sent, and says quietly what was decided.
  async settle(configText: string, remoteId: string, settled: Settled): Promise<void> {
    // Typed here: the person's reply is right under it and already says it was passed on, so only the buttons go.
    const line = settled.here ? (settled.typed ? undefined : `You chose: ${settled.label}. Passed to ${settled.agentName}.`) : `Answered on another of ${settled.agentName}'s notifiers: ${settled.label}.`;
    const config = JSON.parse(configText) as TelegramConfig;
    const holder = { botId: botIdOf(config.bot_token), token: config.bot_token, chat: config.chat_number };
    const messageId = Number(remoteId.split(":").at(-1));
    if (!Number.isInteger(messageId)) return;
    try {
      await clearButtons(this.#telegram, holder.token, holder.chat, messageId);
      if (line !== undefined) await sendText(this.#telegram, holder.token, holder.chat, line, [], true);
    } catch (err: unknown) {
      logEvent("notifier.answer_failed", { bot: holder.botId, message: err instanceof Error ? err.message : String(err) });
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
    if (typeof tap.data === "string" && tap.data.startsWith(PICK_DATA)) {
      const prefix = tap.data.slice(PICK_DATA.length);
      const holder = holders.find((h) => h.agentHex.startsWith(prefix));
      if (!holder || prefix.length === 0) {
        await settle("That agent no longer uses this chat.");
        return;
      }
      // Kept beside the notifications, so a plain message finds the newest of the two. It names no session.
      // The same tap read again after a restart is already there. Writing it again would make an old pick the newest row,
      // and take plain messages back from an agent that has written since.
      const remoteId = `${botId}:${chat}:pick:${update.update_id}`;
      const name = this.#ctx.host.agentName(holder.agentHex);
      if (this.#ctx.store.prepare("SELECT 1 FROM notifications WHERE remote_id = ?").get(remoteId)) {
        await settle(`Now talking to ${name}.`);
        return;
      }
      this.#ctx.store.prepare("INSERT INTO notifications (agent_id, notifier, session_id, kind, remote_id, sent_at) VALUES (?, ?, NULL, ?, ?, ?)").run(idOf(holder.agentHex), holder.name, PICK, remoteId, Date.now());
      await settle(`Now talking to ${name}.`);
      await this.#answer({ ...holder, token }, `Now talking to ${name}. Your messages go to ${name} until another agent writes to you. Replying to a message always goes to whoever sent it.`, true);
      return;
    }
    const holds = (agentHex: string, name: string): boolean => holders.some((h) => h.name === name && h.agentHex === agentHex);
    await this.#ctx.choose(`${botId}:${chat}:${under.message_id}`, holds, choiceIndex(tap.data), `telegram:${botId}:${update.update_id}`, settle);
  }

  // /agents: one button per agent that uses this chat, so the person can say who their plain messages are for.
  async #offerAgents(here: Holder, holders: Holder[]): Promise<void> {
    const agents = [...new Map(holders.map((h) => [h.agentHex, h])).values()];
    const buttons = agents.map((h) => ({ text: this.#ctx.host.agentName(h.agentHex), data: `${PICK_DATA}${h.agentHex.slice(0, PICK_PREFIX_CHARS)}` }));
    try {
      await sendButtons(this.#telegram, here.token, here.chat, "Who should your messages go to? Pick one. Replying to a message always goes to whoever sent it.", buttons, true);
    } catch (err: unknown) {
      logEvent("notifier.answer_failed", { bot: here.botId, message: err instanceof Error ? err.message : String(err) });
      // /agents has no other answer, so say something rather than leave the person wondering.
      await this.#answer(here, `The list of agents couldn't be sent. Send /agents again. Agents in this chat: ${buttons.map((b) => b.text).join(", ")}.`, true);
    }
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
    if (/^\/agents(@\S+)?$/i.test(text)) {
      await this.#offerAgents(here, holders);
      return;
    }
    if (text.length === 0) {
      await this.#answer(here, "Only text reaches your agent, so this wasn't passed on. Type your answer.");
      return;
    }
    const holds = (agentId: Uint8Array, notifier: string): Holder | undefined => holders.find((h) => h.name === notifier && h.agentHex === Buffer.from(agentId).toString("hex"));
    type Sent = { agent_id: Uint8Array; notifier: string; session_id: Uint8Array | null; kind?: string };
    // guessed: the person didn't say which agent, and more than one uses this chat. Then they're told who it went to.
    let target: { holder: Holder; sessionId: Uint8Array | null; guessed?: boolean; answers?: string } | undefined;
    // A reply to one of an agent's notifications goes to that agent, about that session.
    const repliedTo = message.reply_to_message?.message_id;
    if (repliedTo !== undefined) {
      const sent = this.#ctx.store.prepare("SELECT agent_id, notifier, session_id FROM notifications WHERE remote_id = ? ORDER BY id DESC").get(`${botId}:${chat}:${repliedTo}`) as Sent | undefined;
      const holder = sent && holds(sent.agent_id, sent.notifier);
      if (sent && !holder) {
        // The person named an agent by answering its message. Handing it to another one would be a guess they didn't make.
        await this.#answer(here, "The agent that sent that message no longer uses this chat, so your reply wasn't passed on.");
        return;
      }
      if (sent && holder) target = { holder, sessionId: sent.session_id, answers: `${botId}:${chat}:${repliedTo}` };
    }
    // A plain message goes to whichever agent wrote to this chat last, because that's who the person is answering. It
    // names no session: only answering a message says which conversation it's about.
    if (!target) {
      // A pick from /agents is stored in the same list, so whichever is newer wins: the person's pick, or an agent writing since.
      const sent = (this.#ctx.store.prepare("SELECT agent_id, notifier, session_id, kind FROM notifications WHERE remote_id LIKE ? ORDER BY id DESC LIMIT 50").all(`${botId}:${chat}:%`) as Sent[]).find((row) => holds(row.agent_id, row.notifier));
      if (sent) target = { holder: holds(sent.agent_id, sent.notifier) as Holder, sessionId: null, guessed: sent.kind !== PICK && new Set(holders.map((h) => h.agentHex)).size > 1 };
    }
    if (!target) {
      if (new Set(holders.map((h) => h.agentHex)).size > 1) {
        await this.#answer(here, "More than one agent uses this chat, and none has written to you yet, so it isn't clear who this is for. It wasn't passed on. Reply to one of an agent's messages once it has written.");
        return;
      }
      target = { holder: first, sessionId: null };
    }
    const agentHex = target.holder.agentHex;
    const outcome = this.#ctx.host.fromOperator(agentHex, target.sessionId, text, target.holder.name, `telegram:${botId}:${update.update_id}`);
    // A typed reply to a question with choices answers it everywhere: its buttons go, here and on every other notifier.
    // Also when it was handed over before a restart, since the buttons may still be showing.
    if (outcome !== "no_agent" && target.answers !== undefined) await this.#ctx.answeredInWords(target.answers);
    if (outcome === "already") return;
    if (outcome === "no_agent") {
      // Never silently: the person believes they've given an instruction.
      await this.#answer(here, "The agent this was for is no longer on this machine, so it wasn't passed on.");
      return;
    }
    const name = this.#ctx.host.agentName(agentHex);
    if (!this.#ctx.host.reachable(agentHex)) {
      await this.#answer(here, `Passed to ${name}. No session is holding ${name} right now, so it will see this when one next reads.`, true);
      return;
    }
    // When it's plain who the reply went to, a 👍 on it says so, and nothing new appears in the chat.
    if (!target.guessed && typeof message.message_id === "number") {
      try {
        await thumbsUp(this.#telegram, token, chat, message.message_id);
        return;
      } catch (err: unknown) {
        logEvent("notifier.reaction_failed", { bot: botId, message: err instanceof Error ? err.message : String(err) });
      }
    }
    await this.#answer(here, `Passed to ${name}.`, true);
  }

  // The remote id is the bot's id, the chat's number and the message's, with colons.
  async deliver(notifier: StoredNotifier, message: Outgoing): Promise<Delivered> {
    const config = JSON.parse(notifier.config) as TelegramConfig;
    const sent = await sendText(this.#telegram, config.bot_token, config.chat_id, message.line, message.choices);
    return { remoteId: `${botIdOf(config.bot_token)}:${sent.chatId}:${sent.messageId}` };
  }

  show(configText: string): Record<string, unknown> {
    const config = JSON.parse(configText) as TelegramConfig;
    return { bot: `@${config.bot}`, chat_id: config.chat_id };
  }

  prepare(params: Record<string, unknown>, copied: (() => string) | undefined): (agentName: string) => Promise<Connected> {
    // A pasted token often carries a stray space or newline, which Telegram answers with a bare "Not Found".
    let token = typeof params["bot_token"] === "string" ? params["bot_token"].trim() : "";
    // Another agent on this machine already has the bot: take its notifier as it is, so the token is typed once, ever, and
    // an agent can set this up for a new agent without being shown it.
    let sameChat: string | undefined;
    if (copied) {
      if (token.length > 0) throw new LocalError("bad_argument", "give bot_token or same_as, not both");
      const config = JSON.parse(copied()) as TelegramConfig;
      token = config.bot_token;
      sameChat = config.chat_number;
    }
    if (token.length === 0) throw new LocalError("bad_argument", "A Telegram notifier needs bot_token, the token BotFather gave for the bot, or same_as, an agent on this machine that already has one.");
    return (agentName) => this.#connect(token, params, sameChat, agentName);
  }

  // Proves the token and the chat with Telegram before anything is stored, so a mistake shows here and not at the first real notify.
  async #connect(token: string, params: Record<string, unknown>, sameChat: string | undefined, agentName: string): Promise<Connected> {
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
      throw new LocalError("notifier_check_failed", `Nothing was saved, because the check with Telegram failed. ${err.message}${err instanceof TelegramError && err.maybeSent ? " Running this again is safe: at worst the chat shows the connected line twice." : ""}`);
    }
    const config: TelegramConfig = { bot_token: token, chat_id: chatId, chat_number: chatNumber, bot };
    return {
      config,
      shown: { bot: `@${bot}`, chat_id: chatId, ...(chatWho ? { chat_with: chatWho } : {}) },
      route: `a Telegram chat with @${bot}`,
      saved: () => {
        // Reading starts after whatever was sent to the bot to set it up. A "hi" typed to find the chat is not an instruction.
        if (newest) this.#ctx.store.setConfig(offsetKey(botId), String(newest.update_id + 1));
        this.#listen(botId);
      },
    };
  }
}

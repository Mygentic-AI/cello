// How an agent reaches its human operator when they aren't at the session: a notifier is one route to the person, such as a
// Telegram chat. The agent decides when to use one and what leaves the machine: a fixed line, or its own words.
// Anyone can set one up, agents included, because setting up a bot is hard enough already.
// This is the part every type shares. Each type's own code is its adapter, listed in the constructor.
import { randomBytes } from "node:crypto";
import { NOTIFIER_TYPES, type NotifierTypeName, notifierType } from "../notifier-types.ts";
import { LocalError } from "./errors.ts";
import { logEvent } from "./log.ts";
import { type ChoiceOutcome, type Delivered, DeliveryError, type NotifierAdapter, type NotifierContext, type NotifierHost, type Outgoing, type Settled, type StoredNotifier } from "./notifier-adapter.ts";
import { MacNotifier } from "./notifier-mac.ts";
import { TelegramNotifier } from "./notifier-telegram.ts";
import type { Store } from "./store.ts";
import { TELEGRAM, type TelegramEndpoint } from "./telegram.ts";

export type { NotifierHost } from "./notifier-adapter.ts";

const NOTIFIERS_COLUMNS = `(
  agent_id BLOB NOT NULL REFERENCES agents(agent_id),
  name     TEXT NOT NULL,
  -- Checked in code against the registered types, so a new type needs no table change.
  type     TEXT NOT NULL,
  -- JSON, and it holds the bot token, so no command, log or notice ever shows it whole.
  config   TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, name)
)`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notifiers ${NOTIFIERS_COLUMNS};
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

export const NOTIFY_KINDS = ["message", "request"] as const;
type Kind = (typeof NOTIFY_KINDS)[number];

const MAX_CHOICES = 8;
// What notifications.chosen holds when the person typed their answer rather than choosing, and how that's said.
const TYPED = -1;
const TYPED_LABEL = "a typed answer";
const MAX_CHOICE_CHARS = 40;
const NAME_RULE = /^[A-Za-z0-9_-]{1,32}$/;

// The fixed lines. They say that something is waiting and nothing about what.
export function cannedLine(agentName: string, kind: Kind): string {
  return `Your agent ${agentName} has a ${kind} waiting for you.`;
}
export function withText(agentName: string, kind: Kind, text: string): string {
  return `Your agent ${agentName} has a ${kind} for you:\n\n${text}`;
}

interface NotifierRow { name: string; type: string; config: string; added_at: number }

const idOf = (agentHex: string): Uint8Array => new Uint8Array(Buffer.from(agentHex, "hex"));
const serviceOf = (type: string): string => notifierType(type)?.label ?? type;
// Only a database written by a newer version holds a type this one doesn't know. It's named, never read as another type.
const unknownType = (type: string): string => `This version of CELLO can't use a ${type} notifier. Upgrade CELLO, or remove it with notifier-remove.`;

// Up to 0.0.324 the table allowed only telegram, in a CHECK. SQLite can't drop a CHECK, so the table is made again without
// it and the rows copied across, in one transaction.
function dropTypeCheck(store: Store): void {
  const made = store.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifiers'").get() as { sql: string } | undefined;
  if (!made || !/CHECK\s*\(\s*type\s+IN\b/i.test(made.sql)) return;
  store.transaction(() => {
    store.exec(`CREATE TABLE notifiers_rebuilt ${NOTIFIERS_COLUMNS}`);
    store.exec("INSERT INTO notifiers_rebuilt (agent_id, name, type, config, added_at) SELECT agent_id, name, type, config, added_at FROM notifiers");
    store.exec("DROP TABLE notifiers");
    store.exec("ALTER TABLE notifiers_rebuilt RENAME TO notifiers");
  });
  logEvent("notifier.table_rebuilt", { rows: (store.prepare("SELECT count(*) AS c FROM notifiers").get() as { c: number }).c });
}

export class Notifiers {
  readonly #store: Store;
  readonly #host: NotifierHost;
  readonly #adapters: ReadonlyMap<string, NotifierAdapter>;

  // operatorSocket is where the Mac app's door listens. Left out, there's no door, and a mac notifier can't be added.
  constructor(store: Store, host: NotifierHost, telegram: TelegramEndpoint = TELEGRAM, operatorSocket?: string) {
    this.#store = store;
    this.#host = host;
    dropTypeCheck(store);
    store.exec(SCHEMA);
    // For a database from 0.0.317 to 0.0.319, whose table was made before choices existed.
    const columns = (store.prepare("PRAGMA table_info(notifications)").all() as { name: string }[]).map((column) => column.name);
    if (!columns.includes("choices")) store.exec("ALTER TABLE notifications ADD COLUMN choices TEXT");
    if (!columns.includes("chosen")) store.exec("ALTER TABLE notifications ADD COLUMN chosen INTEGER");
    if (!columns.includes("asked")) store.exec("ALTER TABLE notifications ADD COLUMN asked TEXT");
    // One adapter for every registered type: a type missing here doesn't compile.
    const adapters: Record<NotifierTypeName, NotifierAdapter> = {
      telegram: new TelegramNotifier(this.#context("telegram"), telegram),
      mac: new MacNotifier(this.#context("mac"), operatorSocket),
    };
    this.#adapters = new Map(Object.entries(adapters));
  }

  #context(type: NotifierTypeName): NotifierContext {
    return {
      store: this.#store,
      host: this.#host,
      rows: () => (this.#store.prepare("SELECT agent_id, name, config FROM notifiers WHERE type = ? ORDER BY added_at, name").all(type) as { agent_id: Uint8Array; name: string; config: string }[])
        .map((row): StoredNotifier => ({ agentHex: Buffer.from(row.agent_id).toString("hex"), name: row.name, config: row.config })),
      choose: (remoteId, holds, index, sourceId, reply) => this.#choose(remoteId, holds, index, sourceId, reply),
      answeredInWords: (remoteId) => this.#answeredInWords(remoteId),
    };
  }

  // A typed answer to a question with choices. Marked as chosen with TYPED, so a later tap anywhere is told it's answered,
  // and every copy, this one included, is settled.
  async #answeredInWords(remoteId: string): Promise<void> {
    const sent = this.#store.prepare("SELECT id, agent_id, notifier, asked FROM notifications WHERE remote_id = ? ORDER BY id DESC").get(remoteId) as { id: number; agent_id: Uint8Array; notifier: string; asked: string | null } | undefined;
    if (!sent || sent.asked === null) return;
    // Checked and marked with nothing awaited between, so a tap in the same moment finds one or the other.
    if (this.#store.prepare("SELECT 1 FROM notifications WHERE asked = ? AND chosen IS NOT NULL LIMIT 1").get(sent.asked)) return;
    this.#store.prepare("UPDATE notifications SET chosen = ? WHERE asked = ?").run(TYPED, sent.asked);
    const agentHex = Buffer.from(sent.agent_id).toString("hex");
    const type = this.#rows(agentHex).find((row) => row.name === sent.notifier)?.type;
    await this.#settleAsked(sent.asked, sent.id, { label: TYPED_LABEL, agentName: this.#host.agentName(agentHex), where: type === undefined ? sent.notifier : serviceOf(type), notifier: sent.notifier });
  }

  // Starts listening for the operator's replies, on every type.
  start(): void {
    for (const adapter of this.#adapters.values()) adapter.start();
  }

  stop(): void {
    for (const adapter of this.#adapters.values()) adapter.stop();
  }

  // An agent that's removed takes its notifiers with it, tokens included, and a bot nobody else uses stops being read.
  forget(agentHex: string): void {
    this.#store.prepare("DELETE FROM notifications WHERE agent_id = ?").run(idOf(agentHex));
    this.#store.prepare("DELETE FROM notifiers WHERE agent_id = ?").run(idOf(agentHex));
    for (const adapter of this.#adapters.values()) adapter.prune();
    logEvent("notifier.agent_forgotten", { agent: agentHex });
  }

  // Takes the buttons off every message one notify call sent, on every notifier, and says in each chat what was decided.
  // One question is answered once, wherever it was shown.
  async #settleAsked(asked: string, tappedId: number, chosen: Omit<Settled, "here">): Promise<void> {
    const rows = this.#store.prepare("SELECT id, agent_id, notifier, remote_id FROM notifications WHERE asked = ?").all(asked) as { id: number; agent_id: Uint8Array; notifier: string; remote_id: string }[];
    for (const row of rows) {
      // Each through its own notifier, by that notifier's type. One that's gone since has nothing left to settle.
      const notifier = this.#rows(Buffer.from(row.agent_id).toString("hex")).find((r) => r.name === row.notifier);
      if (!notifier) continue;
      const adapter = this.#adapters.get(notifier.type);
      if (!adapter) {
        logEvent("notifier.answer_failed", { notifier: notifier.name, message: unknownType(notifier.type) });
        continue;
      }
      await adapter.settle(notifier.config, row.remote_id, { ...chosen, here: row.id === tappedId });
    }
  }

  // A choice made on one notifier, whatever its type. remoteId is the notifier's id for the message the choice was under,
  // holds says which notifiers the person who chose may answer for, and settle says a line back to them.
  async #choose(remoteId: string, holds: (agentHex: string, name: string) => boolean, index: number | undefined, sourceId: string, settle: (line: string) => Promise<void>): Promise<ChoiceOutcome> {
    const sent = this.#store.prepare("SELECT id, agent_id, notifier, session_id, choices, asked FROM notifications WHERE remote_id = ? ORDER BY id DESC").get(remoteId) as { id: number; agent_id: Uint8Array; notifier: string; session_id: Uint8Array | null; choices: string | null; asked: string | null } | undefined;
    const sentBy = sent && Buffer.from(sent.agent_id).toString("hex");
    const holder = sent && sentBy !== undefined && holds(sentBy, sent.notifier) ? { agentHex: sentBy, name: sent.notifier } : undefined;
    const choices = sent?.choices ? JSON.parse(sent.choices) as string[] : [];
    if (!sent || !holder || sent.asked === null || choices.length === 0) {
      await settle("This is no longer waiting for an answer.");
      return "not_waiting";
    }
    const label = index === undefined ? undefined : choices[index];
    if (label === undefined) {
      await settle("That isn't one of the choices.");
      return "not_a_choice";
    }
    // One question may have gone out on several notifiers. It's answered once, whichever chat the tap came from.
    const answered = this.#store.prepare("SELECT chosen FROM notifications WHERE asked = ? AND chosen IS NOT NULL LIMIT 1").get(sent.asked) as { chosen: number } | undefined;
    if (answered) {
      await settle(`Already answered: ${answered.chosen === TYPED ? TYPED_LABEL : choices[answered.chosen] ?? "another choice"}.`);
      return "already_answered";
    }
    const outcome = this.#host.fromOperator(holder.agentHex, sent.session_id, label, holder.name, sourceId);
    if (outcome === "no_agent") {
      await settle("The agent this was for is no longer on this machine.");
      return "no_agent";
    }
    // Marked before anything is said back, so a second tap in the same moment finds it answered.
    this.#store.prepare("UPDATE notifications SET chosen = ? WHERE asked = ? AND chosen IS NULL").run(index, sent.asked);
    const name = this.#host.agentName(holder.agentHex);
    const type = this.#rows(holder.agentHex).find((row) => row.name === holder.name)?.type;
    // "already" is this same tap fetched again after a restart: the agent has it, and the buttons may still be showing.
    await settle(`Passed to ${name}.`);
    await this.#settleAsked(sent.asked, sent.id, { label, agentName: name, where: type === undefined ? holder.name : serviceOf(type), notifier: holder.name });
    return "passed";
  }

  #rows(agentHex: string): NotifierRow[] {
    return this.#store.prepare("SELECT name, type, config, added_at FROM notifiers WHERE agent_id = ? ORDER BY added_at, name").all(idOf(agentHex)) as NotifierRow[];
  }

  #row(agentHex: string, name: string): NotifierRow {
    const row = this.#rows(agentHex).find((r) => r.name === name);
    if (!row) throw new LocalError("no_such_notifier", `${this.#host.agentName(agentHex)} has no notifier named ${name}. notifier-list shows them.`);
    return row;
  }

  // One send through one notifier, by its type.
  async #deliver(agentHex: string, row: NotifierRow, message: Outgoing): Promise<Delivered> {
    const adapter = this.#adapters.get(row.type);
    if (!adapter) throw new DeliveryError(unknownType(row.type));
    return adapter.deliver({ agentHex, name: row.name, config: row.config }, message);
  }

  // A notifier whose messages never leave this machine. One of a type this version doesn't know counts as leaving it.
  #local(row: NotifierRow): boolean {
    return this.#adapters.get(row.type)?.local ?? false;
  }

  // The type checks with its service before anything is stored, so a mistake shows here and not at the first real notify.
  async add(agentHex: string, params: Record<string, unknown>): Promise<unknown> {
    const type = notifierType(params["type"]);
    const adapter = type && this.#adapters.get(type.name);
    if (!type || !adapter) throw new LocalError("bad_argument", `type must be one of: ${NOTIFIER_TYPES.map((t) => t.name).join(", ")}`);
    // An option only another type takes would be ignored here, so it's refused.
    const own = new Set<string>(type.params.map((p) => p.name));
    const foreign = NOTIFIER_TYPES.flatMap((t) => t.params.map((p) => p.name)).find((name) => !own.has(name) && params[name] !== undefined);
    if (foreign !== undefined) throw new LocalError("bad_argument", `a ${type.name} notifier takes no ${foreign}`);
    const name = typeof params["name"] === "string" ? params["name"] : type.name;
    if (!NAME_RULE.test(name)) throw new LocalError("bad_argument", "name must be 1 to 32 letters, digits, underscores or dashes");
    // Another agent on this machine already has one of this type: the new one is made from it, so a secret is given once.
    const sameAs = params["same_as_agent"];
    const copied = typeof sameAs !== "string" ? undefined : (): string => {
      const theirs = this.#rows(sameAs).filter((row) => row.type === type.name);
      const source = theirs.find((row) => row.name === name) ?? (theirs.length === 1 ? theirs[0] : undefined);
      if (!source) throw new LocalError("no_such_notifier", `${this.#host.agentName(sameAs)} has ${theirs.length === 0 ? `no ${type.label} notifier to copy` : `${theirs.length} ${type.label} notifiers, so say which with name: ${theirs.map((row) => row.name).join(", ")}`}.`);
      return source.config;
    };
    const connect = adapter.prepare(params, copied);
    const agentName = this.#host.agentName(agentHex);
    const existing = this.#rows(agentHex);
    if (existing.some((r) => r.name === name)) throw new LocalError("notifier_exists", `${agentName} already has a notifier named ${name}. Remove it first with notifier-remove, or give this one another name.`);

    const connected = await connect(agentName, agentHex);
    this.#store.prepare("INSERT INTO notifiers (agent_id, name, type, config, added_at) VALUES (?, ?, ?, ?, ?)").run(idOf(agentHex), name, type.name, JSON.stringify(connected.config), Date.now());
    logEvent("notifier.added", { agent: agentHex, notifier: name, type: type.name });
    connected.saved();

    // The routes that were already there hear about the new one, so one added by a tricked agent doesn't go unseen.
    const told: string[] = [];
    const untold: { notifier: string; message: string }[] = [];
    const line = `A new notifier was added for your agent ${agentName}: ${name}, ${connected.route}. If that wasn't you, remove it with: cello notifier-remove ${name} --agent ${agentHex}`;
    for (const other of existing) {
      try {
        // Kept until the person has it, where a notifier keeps things, so it counts as told.
        const delivered = await this.#deliver(agentHex, other, { agentHex, kind: "message", line, words: null, choices: [], sessionHex: null });
        void delivered.shown?.();
        told.push(other.name);
      } catch (err: unknown) {
        if (!(err instanceof DeliveryError)) throw err;
        logEvent("notifier.failed", { agent: agentHex, notifier: other.name, message: err.message });
        untold.push({ notifier: other.name, message: err.message });
      }
    }
    return { added: true, agent: agentName, notifier: name, type: type.name, ...connected.shown, told_existing: told, ...(untold.length > 0 ? { could_not_tell: untold } : {}) };
  }

  list(agentHex: string): unknown {
    return {
      agent: this.#host.agentName(agentHex),
      notifiers: this.#rows(agentHex).map((row) => {
        const adapter = this.#adapters.get(row.type);
        return { notifier: row.name, type: row.type, ...(adapter ? adapter.show(row.config) : { problem: unknownType(row.type) }), added_at: new Date(row.added_at).toISOString() };
      }),
    };
  }

  remove(agentHex: string, name: string): unknown {
    this.#row(agentHex, name);
    this.#store.prepare("DELETE FROM notifiers WHERE agent_id = ? AND name = ?").run(idOf(agentHex), name);
    logEvent("notifier.removed", { agent: agentHex, notifier: name });
    // The last notifier using something, such as a bot, takes its reader with it.
    for (const adapter of this.#adapters.values()) adapter.prune();
    return { removed: true, agent: this.#host.agentName(agentHex), notifier: name };
  }

  #chosen(agentHex: string, name: string | undefined, command: string): NotifierRow[] {
    if (name !== undefined) return [this.#row(agentHex, name)];
    const rows = this.#rows(agentHex);
    if (rows.length === 0) {
      throw new LocalError("no_notifier", `${this.#host.agentName(agentHex)} has no notifier, so ${command === "notify" ? "nobody was told" : "there's nothing to test"}. Your operator can set one up: cello notifier-add -h lists the kinds, such as Telegram or the CELLO app on a Mac, and how to add each for this agent (--agent ${agentHex}).`);
    }
    return rows;
  }

  // Sends to every chosen notifier, each its own form of the message. It answers sent: true if at least one has it in front
  // of the person, "queued" if one is keeping it until they're back, and names each that failed.
  async #sendAll(agentHex: string, rows: NotifierRow[], messageFor: (row: NotifierRow) => Outgoing, kind: string, record: boolean): Promise<unknown> {
    const reached: string[] = [];
    const failed: { notifier: string; message: string }[] = [];
    // Taken by the service but not confirmed. Kept apart from failed: an agent told "nobody was told" sends again, and the
    // person sees the same message twice.
    const unconfirmed: { notifier: string; message: string }[] = [];
    const unconfirmedBy = new Set<string>();
    // Kept by a notifier until the person is back. Never a failure: the agent must not send it again.
    const queued: { notifier: string; note: string }[] = [];
    const messages = rows.map((row) => ({ row, message: messageFor(row) }));
    const withChoices = messages.some(({ message }) => message.choices.length > 0);
    // The same on every notifier this one call reaches, so a question with choices is answered once across all of them.
    const asked = withChoices ? randomBytes(12).toString("hex") : null;
    // Each is recorded before it's shown, so a choice made the moment it appears finds it. They're then awaited together,
    // so one notifier waiting to hear it was shown doesn't hold up another.
    const showing: Promise<void>[] = [];
    for (const { row, message } of messages) {
      try {
        const delivered = await this.#deliver(agentHex, row, message);
        if (record) this.#store.prepare("INSERT INTO notifications (agent_id, notifier, session_id, kind, remote_id, sent_at, choices, asked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(idOf(agentHex), row.name, message.sessionHex === null ? null : idOf(message.sessionHex), kind, delivered.remoteId, Date.now(), asked && message.choices.length > 0 ? JSON.stringify(message.choices) : null, asked);
        if (!delivered.shown) {
          reached.push(row.name);
          continue;
        }
        showing.push(delivered.shown().then((waiting) => {
          if (waiting === undefined) reached.push(row.name);
          else queued.push({ notifier: row.name, note: waiting });
        }));
      } catch (err: unknown) {
        if (!(err instanceof DeliveryError)) throw err;
        logEvent(err.maybeSent ? "notifier.unconfirmed" : "notifier.failed", { agent: agentHex, notifier: row.name, message: err.message });
        (err.maybeSent ? unconfirmed : failed).push({ notifier: row.name, message: err.message });
        if (err.maybeSent) unconfirmedBy.add(serviceOf(row.type));
      }
    }
    await Promise.all(showing);
    if (reached.length === 0 && unconfirmed.length === 0 && queued.length === 0) throw new LocalError("notify_failed", `Nobody was told. ${failed.map((f) => `${f.notifier}: ${f.message}`).join(" ")}`);
    const maybe = unconfirmed.length === 0 ? {} : {
      unconfirmed,
      unconfirmed_note: `${[...unconfirmedBy].join(" and ")} took this but didn't confirm it, so it most likely arrived. Don't send it again unless your operator says it didn't come.${withChoices ? " If it did arrive, its buttons won't work, so your operator would type the answer." : ""}`,
    };
    const waiting = queued.length === 0 ? {} : { queued: queued.map((q) => q.notifier), queued_note: queued.map((q) => q.note).join(" ") };
    return { sent: reached.length > 0 ? true : queued.length > 0 ? "queued" : "unconfirmed", agent: this.#host.agentName(agentHex), notifiers: reached, ...waiting, ...maybe, ...(failed.length > 0 ? { failed } : {}) };
  }

  async test(agentHex: string, name: string | undefined): Promise<unknown> {
    const rows = this.#chosen(agentHex, name, "notifier-test");
    const line = `This is a test from your agent ${this.#host.agentName(agentHex)}. Its notifier works.`;
    return this.#sendAll(agentHex, rows, () => ({ agentHex, kind: "test", line, words: null, choices: [], sessionHex: null }), "test", false);
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
    const words = given !== undefined && given.length > 0 ? given : null;
    // The outbound screen is for what leaves this machine. A notifier that keeps it here, such as the Mac app, gets the
    // agent's words as written, and when every chosen notifier is like that nothing is screened.
    const leaves = rows.some((row) => !this.#local(row));
    let sentWords = words;
    // What the screen changed or let through, so the agent knows the person didn't read its exact words.
    let report: Record<string, unknown> = {};
    if (words !== null && leaves) {
      const screened = await this.#host.screenOutbound(agentHex, words, params, `cello notify - --kind ${kind}${only ? ` --notifier ${only}` : ""}${sessionHex ? ` --session-id ${sessionHex}` : ""} --allow-flagged --agent ${agentHex}`);
      sentWords = screened.text;
      report = screened.report;
    }
    const lineFor = (row: NotifierRow): string => {
      const these = this.#local(row) ? words : sentWords;
      return these === null ? cannedLine(agentName, kind) : withText(agentName, kind, these);
    };
    if (words !== null) {
      // The tightest limit among the notifiers it goes to, each against its own form of the message.
      const over = rows.flatMap((row) => { const max = this.#adapters.get(row.type)?.maxChars; const length = lineFor(row).length; return max === undefined || length <= max ? [] : [{ max, length, service: serviceOf(row.type) }]; }).sort((a, b) => a.max - b.max)[0];
      if (over) throw new LocalError("too_long", `Nobody was told: with its first line this is ${over.length} characters, and one ${over.service} message holds ${over.max}. Shorten it, or leave the text out to send the fixed line.`);
    }
    // Choices the person answers with one tap. They are the agent's words too, so they pass the same screen, together, and
    // if the screen changes how many lines there are, nothing is sent: a button must mean what the agent meant by it.
    let choices: string[] = [];
    let sentChoices: string[] = [];
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
      if (leaves) {
        const screened = await this.#host.screenOutbound(agentHex, choices.join("\n"), params, `cello notify --choices ... --allow-flagged --agent ${agentHex}`);
        const after = screened.text.split("\n");
        if (after.length !== choices.length || after.some((choice) => choice.trim().length === 0)) throw new LocalError("blocked_by_screening", "Nobody was told: the outbound screen changed the choices so they no longer line up. Reword them.");
        sentChoices = after.map((choice) => choice.trim());
        // Two different choices can come out of the screen as the same words, and then a tap wouldn't say which was meant.
        if (new Set(sentChoices).size !== sentChoices.length) throw new LocalError("blocked_by_screening", "Nobody was told: after the outbound screen replaced part of them, two of the choices read the same. Reword them so each differs without what was replaced.");
        report = { ...report, ...screened.report };
      } else {
        sentChoices = choices;
      }
    }
    const session = sessionHex === undefined ? null : sessionHex;
    const answer = await this.#sendAll(agentHex, rows, (row) => {
      const local = this.#local(row);
      return { agentHex, kind, line: lineFor(row), words: local ? words : sentWords, choices: local ? choices : sentChoices, sessionHex: session };
    }, kind, true);
    logEvent("notifier.sent", { agent: agentHex, kind, with_text: words !== null, choices: choices.length });
    // The choices as a service outside this machine showed them, which is how a tap there comes back.
    return { ...(answer as object), kind, included_text: words !== null, ...(choices.length > 0 ? { choices: sentChoices } : {}), ...report };
  }
}

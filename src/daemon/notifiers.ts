// How an agent reaches its human operator when they aren't at the session: a notifier is one route to the person, such as a
// Telegram chat. The agent decides when to use one and what leaves the machine: a fixed line, or its own words.
// Anyone can set one up, agents included, because setting up a bot is hard enough already.
// This is the part every type shares. Each type's own code is its adapter, listed in the constructor.
import { randomBytes } from "node:crypto";
import { NOTIFIER_TYPES, type NotifierTypeName, notifierType } from "../notifier-types.ts";
import { LocalError } from "./errors.ts";
import { logEvent } from "./log.ts";
import { DeliveryError, type NotifierAdapter, type NotifierContext, type NotifierHost, type StoredNotifier } from "./notifier-adapter.ts";
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
const label = (type: string): string => notifierType(type)?.label ?? type;
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

  constructor(store: Store, host: NotifierHost, telegram: TelegramEndpoint = TELEGRAM) {
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
    };
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
  async #settleAsked(asked: string, tappedId: number, line: string, elsewhere: string): Promise<void> {
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
      await adapter.settle(notifier.config, row.remote_id, row.id === tappedId ? line : elsewhere);
    }
  }

  // A choice made on one notifier, whatever its type. remoteId is the notifier's id for the message the choice was under,
  // holds says which notifiers the person who chose may answer for, and reply says a line back to them.
  async #choose(remoteId: string, holds: (agentHex: string, name: string) => boolean, index: number | undefined, sourceId: string, settle: (line: string) => Promise<void>): Promise<void> {
    const sent = this.#store.prepare("SELECT id, agent_id, notifier, session_id, choices, asked FROM notifications WHERE remote_id = ? ORDER BY id DESC").get(remoteId) as { id: number; agent_id: Uint8Array; notifier: string; session_id: Uint8Array | null; choices: string | null; asked: string | null } | undefined;
    const sentBy = sent && Buffer.from(sent.agent_id).toString("hex");
    const holder = sent && sentBy !== undefined && holds(sentBy, sent.notifier) ? { agentHex: sentBy, name: sent.notifier } : undefined;
    const choices = sent?.choices ? JSON.parse(sent.choices) as string[] : [];
    if (!sent || !holder || sent.asked === null || choices.length === 0) {
      await settle("This is no longer waiting for an answer.");
      return;
    }
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
    const outcome = this.#host.fromOperator(holder.agentHex, sent.session_id, label, holder.name, sourceId);
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

  #rows(agentHex: string): NotifierRow[] {
    return this.#store.prepare("SELECT name, type, config, added_at FROM notifiers WHERE agent_id = ? ORDER BY added_at, name").all(idOf(agentHex)) as NotifierRow[];
  }

  #row(agentHex: string, name: string): NotifierRow {
    const row = this.#rows(agentHex).find((r) => r.name === name);
    if (!row) throw new LocalError("no_such_notifier", `${this.#host.agentName(agentHex)} has no notifier named ${name}. notifier-list shows them.`);
    return row;
  }

  // One send through one notifier, by its type. Returns the notifier's own id for what it sent.
  async #deliver(row: NotifierRow, text: string, choices: readonly string[] = []): Promise<string> {
    const adapter = this.#adapters.get(row.type);
    if (!adapter) throw new DeliveryError(unknownType(row.type));
    return adapter.deliver(row.config, text, choices);
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

    const connected = await connect(agentName);
    this.#store.prepare("INSERT INTO notifiers (agent_id, name, type, config, added_at) VALUES (?, ?, ?, ?, ?)").run(idOf(agentHex), name, type.name, JSON.stringify(connected.config), Date.now());
    logEvent("notifier.added", { agent: agentHex, notifier: name, type: type.name });
    connected.saved();

    // The routes that were already there hear about the new one, so one added by a tricked agent doesn't go unseen.
    const told: string[] = [];
    const untold: { notifier: string; message: string }[] = [];
    for (const other of existing) {
      try {
        await this.#deliver(other, `A new notifier was added for your agent ${agentName}: ${name}, ${connected.route}. If that wasn't you, remove it with: cello notifier-remove ${name} --agent ${agentHex}`);
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
      throw new LocalError("no_notifier", `${this.#host.agentName(agentHex)} has no notifier, so ${command === "notify" ? "nobody was told" : "there's nothing to test"}. Set one up with: cello notifier-add telegram --bot-token <token> --chat-id <id> --agent ${agentHex}`);
    }
    return rows;
  }

  // Sends to every chosen notifier. It answers sent only if at least one accepted it, and names each that didn't.
  async #sendAll(agentHex: string, rows: NotifierRow[], text: string, kind: string, sessionId: Uint8Array | null, record: boolean, choices: readonly string[] = []): Promise<unknown> {
    const reached: string[] = [];
    const failed: { notifier: string; message: string }[] = [];
    // Taken by the service but not confirmed. Kept apart from failed: an agent told "nobody was told" sends again, and the
    // person sees the same message twice.
    const unconfirmed: { notifier: string; message: string }[] = [];
    const unconfirmedBy = new Set<string>();
    // The same on every notifier this one call reaches, so a question with choices is answered once across all of them.
    const asked = choices.length > 0 ? randomBytes(12).toString("hex") : null;
    for (const row of rows) {
      try {
        const remoteId = await this.#deliver(row, text, choices);
        if (record) this.#store.prepare("INSERT INTO notifications (agent_id, notifier, session_id, kind, remote_id, sent_at, choices, asked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(idOf(agentHex), row.name, sessionId, kind, remoteId, Date.now(), asked ? JSON.stringify(choices) : null, asked);
        reached.push(row.name);
      } catch (err: unknown) {
        if (!(err instanceof DeliveryError)) throw err;
        logEvent(err.maybeSent ? "notifier.unconfirmed" : "notifier.failed", { agent: agentHex, notifier: row.name, message: err.message });
        (err.maybeSent ? unconfirmed : failed).push({ notifier: row.name, message: err.message });
        if (err.maybeSent) unconfirmedBy.add(label(row.type));
      }
    }
    if (reached.length === 0 && unconfirmed.length === 0) throw new LocalError("notify_failed", `Nobody was told. ${failed.map((f) => `${f.notifier}: ${f.message}`).join(" ")}`);
    const maybe = unconfirmed.length === 0 ? {} : {
      unconfirmed,
      unconfirmed_note: `${[...unconfirmedBy].join(" and ")} took this but didn't confirm it, so it most likely arrived. Don't send it again unless your operator says it didn't come.${choices.length > 0 ? " If it did arrive, its buttons won't work, so your operator would type the answer." : ""}`,
    };
    return { sent: reached.length > 0 ? true : "unconfirmed", agent: this.#host.agentName(agentHex), notifiers: reached, ...maybe, ...(failed.length > 0 ? { failed } : {}) };
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
      // The tightest limit among the notifiers it goes to.
      const limit = rows.flatMap((row) => { const max = this.#adapters.get(row.type)?.maxChars; return max === undefined ? [] : [{ max, service: label(row.type) }]; }).sort((a, b) => a.max - b.max)[0];
      if (limit && text.length > limit.max) throw new LocalError("too_long", `Nobody was told: with its first line this is ${text.length} characters, and one ${limit.service} message holds ${limit.max}. Shorten it, or leave the text out to send the fixed line.`);
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

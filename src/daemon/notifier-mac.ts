// The Mac notifier: the CELLO app on this Mac, reached through the operator's door (operator-door.ts). One app serves every
// agent on the machine. Nothing leaves the machine, so the agent's words reach it whole, without the outbound screen.
// The app keeps nothing on disk: the daemon keeps each notification's words until it's answered or settled, and a plain
// message's until a day after it was shown, then empties them, as operator_messages does once a reply is read.
import { LocalError } from "./errors.ts";
import { logEvent } from "./log.ts";
import { DeliveryError, followUpLine, followUpText } from "./notifier-adapter.ts";
import type { ChoiceOutcome, Connected, Delivered, NotifierAdapter, NotifierContext, Outgoing, Settled, StoredNotifier } from "./notifier-adapter.ts";
import { type DoorConnection, type DoorHandler, type DoorReply, OperatorDoor, type OperatorOp } from "./operator-door.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mac_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   BLOB NOT NULL REFERENCES agents(agent_id),
  notifier   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  -- The agent's words, in full. Emptied once it's answered, settled elsewhere, or a day old and not a request.
  text       TEXT NOT NULL,
  choices    TEXT,
  session_id BLOB,
  -- Who the agent was talking to when it asked, as JSON, so the app can say so.
  talking_to TEXT,
  sent_at    INTEGER NOT NULL,
  shown_at   INTEGER,
  done_at    INTEGER
);
`;

// How long notify waits for the app to say a notification is on screen before answering "queued".
const SHOWN_WAIT_MS = 3_000;
const DAY_MS = 24 * 60 * 60_000;
// How often old plain messages are emptied while the daemon runs. Subscribing empties them too.
const SWEEP_MS = 60 * 60_000;
// The longest a pause may be set for. Longer is a mistake, or removing the Mac.
const LONGEST_PAUSE_MS = 365 * DAY_MS;
const MAX_REPLY_CHARS = 16_000;
// The app's own id for a reply, so one sent again after a dropped connection reaches the agent once.
const REF_RULE = /^[A-Za-z0-9_-]{8,64}$/;
const PAUSED_KEY = "notifier.mac.paused_until";
const SEEN_KEY = "notifier.mac.last_seen";

interface QueueRow { id: number; agent_id: Uint8Array; notifier: string; kind: string; text: string; choices: string | null; session_id: Uint8Array | null; talking_to: string | null; sent_at: number; shown_at: number | null }
interface TalkingTo { agent_id: string; name: string; named_by: "you" | "itself" | "nobody" }

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const idOf = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const remoteOf = (id: number): string => `mac:${id}`;
const queueIdOf = (remoteId: string): number | undefined => {
  const match = /^mac:(\d+)$/.exec(remoteId);
  return match ? Number(match[1]) : undefined;
};

export class MacNotifier implements NotifierAdapter, DoorHandler {
  // A notification is read in a panel, not a chat bubble. This only stops a runaway.
  readonly maxChars = 32_000;
  readonly local = true;
  readonly #ctx: NotifierContext;
  readonly #door: OperatorDoor | undefined;
  // Waits for the app to say a notification is on screen, by queue id.
  readonly #waiting = new Map<number, Set<() => void>>();
  #sweeper: NodeJS.Timeout | undefined;
  // Why the door didn't open, when it didn't.
  #doorProblem: string | undefined;
  // The agents that reach the Mac, as the app was last told, so it hears when one goes.
  readonly #reaching: Set<string>;

  // No socket path: no door, as on any machine but a Mac.
  constructor(ctx: NotifierContext, socketPath: string | undefined) {
    this.#ctx = ctx;
    ctx.store.exec(SCHEMA);
    this.#door = socketPath === undefined ? undefined : new OperatorDoor(socketPath, this);
    this.#reaching = new Set(ctx.rows().map((row) => row.agentHex));
  }

  start(): void {
    this.#sweep();
    this.#sweeper = setInterval(() => this.#sweep(), SWEEP_MS);
    this.#sweeper.unref();
    // The door failing to open costs the Mac route, never the daemon, and it's said by name wherever the route is used.
    this.#door?.open().then(() => { this.#doorProblem = undefined; }, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.#doorProblem = `CELLO's door for the Mac app, ${this.#door?.path ?? "operator.sock"}, couldn't open (${message}), so the app can't connect. Restarting CELLO (cello logout, then cello login) tries again.`;
      logEvent("operator_door.unavailable", { message });
    });
  }

  stop(): void {
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#door?.close();
    for (const done of this.#waiting.values()) for (const wake of done) wake();
    this.#waiting.clear();
  }

  // A notifier that's gone takes its waiting notifications with it, words and all, and the app hears the agent left.
  prune(): void {
    const current = this.#ctx.rows();
    const holding = new Set(current.map((row) => `${row.agentHex}/${row.name}`));
    const rows = this.#ctx.store.prepare("SELECT DISTINCT agent_id, notifier FROM mac_queue").all() as { agent_id: Uint8Array; notifier: string }[];
    for (const row of rows) {
      if (holding.has(`${hexOf(row.agent_id)}/${row.notifier}`)) continue;
      this.#ctx.store.prepare("DELETE FROM mac_queue WHERE agent_id = ? AND notifier = ?").run(row.agent_id, row.notifier);
    }
    // Every agent the app knows of that's gone, whether or not it ever sent anything.
    const still = new Set(current.map((row) => row.agentHex));
    for (const agentHex of [...this.#reaching]) {
      if (still.has(agentHex)) continue;
      this.#reaching.delete(agentHex);
      this.#push({ op: "agent_removed", agent_id: agentHex });
    }
  }

  prepare(params: Record<string, unknown>, copied: (() => string) | undefined): (agentName: string, agentHex: string) => Promise<Connected> {
    if (this.#door === undefined) throw new LocalError("not_supported", "The CELLO app runs on a Mac, so a mac notifier can't be added on this machine.");
    if (this.#doorProblem !== undefined) throw new LocalError("notifier_check_failed", `Nothing was saved. ${this.#doorProblem}`);
    // Nothing secret to copy, but naming an agent that has none is still a mistake worth saying.
    copied?.();
    return async (agentName, agentHex) => {
      const theirs = this.#ctx.rows().find((row) => row.agentHex === agentHex);
      if (theirs) throw new LocalError("notifier_exists", `${agentName} already reaches its operator through CELLO on this Mac, as ${theirs.name}. One is enough.`);
      const open = this.#subscribers().length > 0;
      return Promise.resolve({
        config: {},
        shown: {
          app: open ? "open" : "not open",
          next: open ? `CELLO on this Mac shows ${agentName}'s notifications from now on.` : `Open CELLO on this Mac to finish. One Allow there covers every agent on this Mac. Until then, notify says queued and keeps each one for when it opens.`,
        },
        route: "the CELLO app on this Mac",
        saved: () => {
          this.#reaching.add(agentHex);
          this.#push({ op: "agent_added", agent_id: agentHex, agent: agentName });
        },
      });
    };
  }

  show(): Record<string, unknown> {
    const seen = Number(this.#ctx.store.getConfig(SEEN_KEY) ?? 0);
    const paused = this.#pausedUntil();
    return {
      ...(this.#doorProblem === undefined ? {} : { problem: this.#doorProblem }),
      app: this.#subscribers().length > 0 ? "open" : seen > 0 ? `not open, last open ${new Date(seen).toISOString()}` : "never opened",
      ...(paused === undefined ? {} : { paused_until: new Date(paused).toISOString() }),
    };
  }

  async deliver(notifier: StoredNotifier, message: Outgoing): Promise<Delivered> {
    // A failure, not a wait: the app can't connect until CELLO is restarted, so "queued" would be untrue.
    if (this.#doorProblem !== undefined) throw new DeliveryError(this.#doorProblem);
    const talking = message.sessionHex === null ? undefined : this.#ctx.host.counterparty(notifier.agentHex, message.sessionHex);
    const inserted = this.#ctx.store.prepare("INSERT INTO mac_queue (agent_id, notifier, kind, text, choices, session_id, talking_to, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id").get(
      idOf(notifier.agentHex), notifier.name, message.kind, message.words ?? message.line, message.choices.length > 0 ? JSON.stringify(message.choices) : null,
      message.sessionHex === null ? null : idOf(message.sessionHex), talking ? JSON.stringify(talking) : null, Date.now(),
    ) as { id: number };
    const id = inserted.id;
    return Promise.resolve({ remoteId: remoteOf(id), shown: () => this.#show(id) });
  }

  // Puts it in front of the person if the app is there. Answers undefined once the app says it's on screen, or the line
  // telling the agent why it isn't yet, which always says not to send it again. While paused it still goes to the app,
  // marked silent, so it waits in the panel with no banner or sound, and the agent is told the person is away.
  async #show(id: number): Promise<string | undefined> {
    const paused = this.#pausedUntil();
    if (paused !== undefined) {
      const row = this.#row(id);
      // The app must not ack a silent one until it's actually on screen, such as when the panel is opened. Until then
      // it stays unseen, so the summary banner after the pause includes it.
      if (row) this.#push(this.#frame(row, true));
      return `Your operator hasn't seen this yet: they've paused CELLO on their Mac until ${new Date(paused).toISOString()}, so they're away. It's waiting in their CELLO panel for when they're back. Don't send it again.`;
    }
    const listening = this.#subscribers();
    if (listening.length === 0) {
      const seen = Number(this.#ctx.store.getConfig(SEEN_KEY) ?? 0);
      if (seen === 0) return "Your operator hasn't seen this yet: CELLO hasn't been opened on their Mac since it was set up. It's kept, and shows when they open it. Don't send it again.";
      const days = Math.floor((Date.now() - seen) / DAY_MS);
      if (days >= 1) return `Your operator hasn't seen this yet: CELLO on their Mac hasn't connected for ${days} day${days === 1 ? "" : "s"}, so it may have been quit or removed. It's kept, and shows if it comes back. Don't send it again. If it can't wait, ask in the session if they're there.`;
      return "Your operator hasn't seen this yet: CELLO on their Mac isn't connected right now, as when the Mac is asleep. It's kept, and shows as soon as it's back. Don't send it again.";
    }
    const row = this.#row(id);
    if (!row) return undefined;
    const shown = new Promise<boolean>((resolve) => {
      const done = new Set(this.#waiting.get(id) ?? []);
      const timer = setTimeout(() => finish(false), SHOWN_WAIT_MS);
      const wake = (): void => finish(true);
      function finish(on: boolean): void {
        clearTimeout(timer);
        done.delete(wake);
        resolve(on);
      }
      done.add(wake);
      this.#waiting.set(id, done);
    });
    const frame = this.#frame(row);
    for (const connection of listening) connection.send(frame);
    const on = await shown;
    if (this.#waiting.get(id)?.size === 0) this.#waiting.delete(id);
    return on || this.#row(id)?.shown_at != null ? undefined : "Your operator may not have seen this yet: CELLO on their Mac took it but didn't say it was on screen. It's kept until it is. Don't send it again.";
  }

  async settle(_config: string, remoteId: string, settled: Settled): Promise<void> {
    const id = queueIdOf(remoteId);
    if (id === undefined) return;
    this.#done(id);
    this.#push({ op: "settled", id, label: settled.label, where: settled.where, here: settled.here, typed: settled.typed });
    return Promise.resolve();
  }

  closed(connection: DoorConnection): void {
    if (connection.subscribed) this.#ctx.store.setConfig(SEEN_KEY, String(Date.now()));
  }

  async handle(connection: DoorConnection, op: OperatorOp, request: Record<string, unknown>): Promise<DoorReply> {
    switch (op) {
      case "subscribe": return this.#subscribe(connection);
      case "ack": return this.#ack(request);
      case "pick": return this.#pick(request);
      case "reply": return this.#reply(request);
      case "pause": return this.#pause(request);
      case "resume": return this.#resume();
      case "remove": return this.#remove();
      case "remove_agent": return this.#removeAgent(request);
      case "agents": return this.#listAgents();
      case "add_agent": return this.#addAgent(request);
    }
  }

  #subscribe(connection: DoorConnection): Promise<DoorReply> {
    connection.subscribed = true;
    this.#ctx.store.setConfig(SEEN_KEY, String(Date.now()));
    this.#sweep();
    const paused = this.#pausedUntil();
    logEvent("operator_door.subscribed", { connection: connection.id });
    return Promise.resolve({
      fields: { agents: this.#agents(), paused_until: paused === undefined ? null : new Date(paused).toISOString() },
      // What came while it was away, oldest first, each with its age. While paused, silently, into the panel.
      after: () => {
        for (const row of this.#backlog()) connection.send(this.#frame(row, paused !== undefined));
      },
    });
  }

  #ack(request: Record<string, unknown>): Promise<DoorReply> {
    const id = this.#idIn(request);
    this.#ctx.store.prepare("UPDATE mac_queue SET shown_at = ? WHERE id = ? AND shown_at IS NULL").run(Date.now(), id);
    for (const wake of [...(this.#waiting.get(id) ?? [])]) wake();
    return Promise.resolve({});
  }

  async #pick(request: Record<string, unknown>): Promise<DoorReply> {
    const id = this.#idIn(request);
    const choice = request["choice"];
    if (typeof choice !== "number" || !Number.isInteger(choice)) throw new LocalError("bad_request", "choice must be the index of the choice, from 0.");
    let said = "";
    const outcome: ChoiceOutcome = await this.#ctx.choose(remoteOf(id), (agentHex, name) => this.#holds(agentHex, name), choice, `mac:pick:${id}`, (line) => {
      said = line;
      return Promise.resolve();
    });
    if (outcome !== "passed") throw new LocalError(outcome, said);
    return { fields: { said } };
  }

  async #reply(request: Record<string, unknown>): Promise<DoorReply> {
    const ref = request["ref"];
    if (typeof ref !== "string" || !REF_RULE.test(ref)) throw new LocalError("bad_request", "A reply needs ref: the app's own id for it, 8 to 64 letters, digits, dashes or underscores, so it reaches the agent once even if sent again.");
    const raw = request["text"];
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text.length === 0) throw new LocalError("bad_request", "A reply needs text.");
    if (text.length > MAX_REPLY_CHARS) throw new LocalError("too_long", `A reply holds at most ${MAX_REPLY_CHARS} characters.`);
    let target: { agentHex: string; notifier: string; session: Uint8Array | null; queueId?: number };
    if (request["id"] !== undefined) {
      const id = this.#idIn(request);
      // Answered or settled already is fine, as replying to an old message in Telegram is: it still names the agent and
      // the session. Only a notification whose agent no longer reaches the Mac is gone.
      const row = this.#ctx.store.prepare("SELECT agent_id, notifier, session_id FROM mac_queue WHERE id = ?").get(id) as Pick<QueueRow, "agent_id" | "notifier" | "session_id"> | undefined;
      const agentHex = row && hexOf(row.agent_id);
      if (!row || agentHex === undefined || !this.#holds(agentHex, row.notifier)) throw new LocalError("not_waiting", "That notification is gone, so the reply wasn't passed on.");
      target = { agentHex, notifier: row.notifier, session: row.session_id, queueId: id };
    } else {
      const agent = request["agent"];
      const theirs = typeof agent === "string" ? this.#ctx.rows().find((row) => row.agentHex === agent) : undefined;
      if (!theirs) throw new LocalError("no_such_agent", "Name the agent by its agent_id, one that reaches you here. subscribe lists them.");
      target = { agentHex: theirs.agentHex, notifier: theirs.name, session: null };
    }
    // Already answered, here or on another notifier: still passed on, as a follow-up that says what came first, as Telegram does.
    const first = target.queueId === undefined ? undefined : this.#ctx.priorAnswer(remoteOf(target.queueId));
    const outcome = this.#ctx.host.fromOperator(target.agentHex, target.session, first === undefined ? text : followUpText(first, text), target.notifier, `mac:reply:${ref}`);
    if (outcome === "no_agent") throw new LocalError("no_agent", "The agent this was for is no longer on this machine, so it wasn't passed on.");
    if (target.queueId !== undefined) {
      // Typed under a question with choices: answered everywhere, so the phone's buttons go too.
      await this.#ctx.answeredInWords(remoteOf(target.queueId));
      this.#done(target.queueId);
    }
    const name = this.#ctx.host.agentName(target.agentHex);
    // "already" is this same reply sent again, and the answer found first may be its own, so it isn't called a follow-up.
    // Telegram likewise says nothing on a reply it already passed on.
    const followUp = first !== undefined && outcome === "stored";
    return { fields: { passed_to: name, agent_id: target.agentHex, already: outcome === "already", ...(followUp ? { follow_up: true, first_answer: first, said: followUpLine(first, name) } : {}), ...(this.#ctx.host.reachable(target.agentHex) ? {} : { note: `No session is holding ${name} right now, so it will see this when one next reads.` }) } };
  }

  #pause(request: Record<string, unknown>): Promise<DoorReply> {
    const until = typeof request["until"] === "string" ? Date.parse(request["until"]) : Number.NaN;
    const now = Date.now();
    if (!Number.isFinite(until) || until <= now) throw new LocalError("bad_request", "until must be a time to come, such as 2026-11-19T09:00:00Z.");
    if (until - now > LONGEST_PAUSE_MS) throw new LocalError("bad_request", "A pause lasts at most a year. To stop CELLO on this Mac, remove it.");
    this.#ctx.store.setConfig(PAUSED_KEY, String(until));
    logEvent("operator_door.paused", { until: new Date(until).toISOString() });
    return Promise.resolve({ fields: { paused_until: new Date(until).toISOString() } });
  }

  // What came during the pause is in the panel already, so nothing is sent again. A pause also ends by itself at its time.
  #resume(): Promise<DoorReply> {
    this.#ctx.store.setConfig(PAUSED_KEY, "");
    logEvent("operator_door.resumed", {});
    return Promise.resolve({ fields: { paused_until: null } });
  }

  // Takes CELLO on this Mac off every agent, and tells each agent it can't reach its operator here any more.
  #remove(): Promise<DoorReply> {
    const agents = this.#agents();
    this.#ctx.store.prepare("DELETE FROM notifiers WHERE type = 'mac'").run();
    this.prune();
    this.#ctx.store.setConfig(PAUSED_KEY, "");
    for (const agent of agents) {
      logEvent("notifier.removed", { agent: agent.agent_id, notifier: agent.notifier, by: "operator_door" });
      this.#ctx.host.tell(agent.agent_id, "Your operator removed CELLO from their Mac, so notify no longer reaches them there.");
    }
    return Promise.resolve({ fields: { removed_from: agents.map((a) => ({ agent_id: a.agent_id, agent: a.agent })) } });
  }

  // Takes the Mac off one agent, as Settings' Remove beside it does, and tells that agent. The others keep it.
  #removeAgent(request: Record<string, unknown>): Promise<DoorReply> {
    const agent = request["agent"];
    const theirs = typeof agent === "string" ? this.#ctx.rows().filter((row) => row.agentHex === agent) : [];
    if (typeof agent !== "string" || theirs.length === 0) throw new LocalError("no_such_agent", "Name the agent by its agent_id, one that reaches you here. subscribe lists them.");
    const name = this.#nameOf(agent);
    this.#ctx.store.prepare("DELETE FROM notifiers WHERE type = 'mac' AND agent_id = ?").run(idOf(agent));
    this.prune();
    for (const row of theirs) logEvent("notifier.removed", { agent, notifier: row.name, by: "operator_door" });
    this.#ctx.host.tell(agent, "Your operator took you off CELLO on their Mac, so notify no longer reaches them there. Their other notifiers are as they were.");
    return Promise.resolve({ fields: { removed: { agent_id: agent, agent: name } } });
  }

  // Settings' Add or remove agents: who reaches the Mac, and every other agent on this machine, each with its lock, so
  // the app can say before a click that a locked one can't be added from there.
  #listAgents(): Promise<DoorReply> {
    const using = new Set(this.#ctx.rows().map((row) => row.agentHex));
    const others = this.#ctx.host.localAgents().filter((agent) => !using.has(agent.agentHex))
      .map((agent) => ({ agent_id: agent.agentHex, agent: agent.name, locked: this.#ctx.host.notifiersLocked(agent.agentHex) }));
    return Promise.resolve({ fields: { agents: this.#agents(), others } });
  }

  // Adds the Mac for an agent on this machine, as notifier-add mac --route-only does, so the agent's other routes are told.
  // A locked agent is refused here outright: anything running as the owner can open this socket, so it can't stand in
  // for the person at a terminal that the lock asks for.
  async #addAgent(request: Record<string, unknown>): Promise<DoorReply> {
    const agent = request["agent"];
    const theirs = typeof agent === "string" ? this.#ctx.host.localAgents().find((a) => a.agentHex === agent) : undefined;
    if (!theirs) throw new LocalError("no_such_agent", "Name an agent on this machine by its agent_id. agents lists them.");
    if (this.#ctx.host.notifiersLocked(theirs.agentHex)) {
      throw new LocalError("notifiers_locked", `${theirs.name}'s notifiers are locked (notifiers.anyone_can_change is off), so the Mac can't be added for it from the app. A person at a terminal can: cello notifier-add mac --route-only --agent ${theirs.agentHex}`);
    }
    await this.#ctx.addRoute(theirs.agentHex);
    logEvent("notifier.added_from_app", { agent: theirs.agentHex });
    return { fields: { added: { agent_id: theirs.agentHex, agent: theirs.name } } };
  }

  #holds(agentHex: string, name: string): boolean {
    return this.#ctx.rows().some((row) => row.agentHex === agentHex && row.name === name);
  }

  #idIn(request: Record<string, unknown>): number {
    const id = request["id"];
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) throw new LocalError("bad_request", "id must be a notification's id.");
    return id;
  }

  #row(id: number): QueueRow | undefined {
    return this.#ctx.store.prepare("SELECT id, agent_id, notifier, kind, text, choices, session_id, talking_to, sent_at, shown_at FROM mac_queue WHERE id = ? AND done_at IS NULL").get(id) as QueueRow | undefined;
  }

  #backlog(): QueueRow[] {
    return this.#ctx.store.prepare("SELECT id, agent_id, notifier, kind, text, choices, session_id, talking_to, sent_at, shown_at FROM mac_queue WHERE done_at IS NULL ORDER BY id").all() as QueueRow[];
  }

  // Answered, settled or old: the words go, and the row stays, so a late pick is told it's no longer waiting and a late
  // reply still finds its agent and session.
  #done(id: number): void {
    this.#ctx.store.prepare("UPDATE mac_queue SET text = '', done_at = ? WHERE id = ? AND done_at IS NULL").run(Date.now(), id);
  }

  // A plain message goes a day after it was on screen. One never shown is kept, since the agent was told it would be and
  // not to send it again.
  #sweep(): void {
    this.#ctx.store.prepare("UPDATE mac_queue SET text = '', done_at = ? WHERE done_at IS NULL AND kind != 'request' AND shown_at IS NOT NULL AND shown_at < ?").run(Date.now(), Date.now() - DAY_MS);
  }

  // silent: the person paused CELLO, so the app puts it in the panel with no banner or sound.
  #frame(row: QueueRow, silent = false): Record<string, unknown> {
    const agentHex = hexOf(row.agent_id);
    const talking = row.talking_to === null ? null : JSON.parse(row.talking_to) as TalkingTo;
    return {
      op: "notification",
      id: row.id,
      agent_id: agentHex,
      agent: this.#nameOf(agentHex),
      kind: row.kind,
      text: row.text,
      choices: row.choices === null ? [] : JSON.parse(row.choices) as string[],
      session_id: row.session_id === null ? null : hexOf(row.session_id),
      // The owner's own name for them is checked by the owner. Any other name is one they chose, and nobody checks it.
      talking_to: talking === null ? null : { ...talking, unverified: talking.named_by !== "you" },
      sent_at: new Date(row.sent_at).toISOString(),
      age_seconds: Math.max(0, Math.round((Date.now() - row.sent_at) / 1000)),
      shown: row.shown_at !== null,
      silent,
    };
  }

  #nameOf(agentHex: string): string {
    try {
      return this.#ctx.host.agentName(agentHex);
    } catch {
      return agentHex;
    }
  }

  #agents(): { agent_id: string; agent: string; notifier: string }[] {
    return this.#ctx.rows().map((row) => ({ agent_id: row.agentHex, agent: this.#nameOf(row.agentHex), notifier: row.name }));
  }

  #subscribers(): DoorConnection[] {
    return this.#door?.connections().filter((connection) => connection.subscribed) ?? [];
  }

  #push(frame: Record<string, unknown>): void {
    for (const connection of this.#subscribers()) connection.send(frame);
  }

  #pausedUntil(): number | undefined {
    const until = Number(this.#ctx.store.getConfig(PAUSED_KEY) || 0);
    return until > Date.now() ? until : undefined;
  }
}

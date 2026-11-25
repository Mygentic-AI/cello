// The daemon: the local socket opens first, so a client never sees "failed" while it's coming up.
import { doorbellWarning } from "./doorbell-warning.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { HELLO_METHOD, daemonProof, ipcHandshakeRequired, newIpcKey } from "../ipc/handshake.ts";
import { createServer, type Socket, createConnection } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { DEFAULT_WAIT_SECONDS } from "../ipc/operations.ts";
import { addCommand } from "../notifier-types.ts";
import type { IpcNotification, IpcRequest, IpcResponse } from "../ipc/protocol.ts";
import { CONFIG_SERVER_URL, type Doorbell, Engine, LocalError, ONCE_WRITTEN, type Signal } from "./engine.ts";
import { type RunningAccountPage, serveAccountPage } from "./account-page.ts";
import { Channels } from "./channels.ts";
import { Discovery } from "./discovery.ts";
import { requirePerson as requirePersonFor } from "./errors.ts";
import { Notes } from "./notes.ts";
import { Notifiers } from "./notifiers.ts";
import { logEvent } from "./log.ts";
import { currentSetting } from "./settings.ts";
import { celloHome, databasePath, endpointIsFile, holdsOldVersion, ipcKeyPath, oldVersionMessage, operatorSocketPath, socketPath } from "./paths.ts";
import { TELEGRAM } from "./telegram.ts";
import { Store } from "./store.ts";

const home = celloHome();
if (holdsOldVersion(home)) {
  logEvent("daemon.old_version_data", { message: oldVersionMessage(home) });
  process.exit(1);
}
mkdirSync(home, { recursive: true, mode: 0o700 });
const path = socketPath(home);
const ipcKey = ipcHandshakeRequired() ? newIpcKey() : undefined;

// One daemon per home. A socket file nobody answers on is left over from a crash.
async function clearStaleSocket(): Promise<void> {
  if (endpointIsFile() && !existsSync(path)) return;
  const answered = await new Promise<boolean>((resolve) => {
    const probe = createConnection(path);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
  if (answered) throw new Error(`a daemon is already running on ${path}`);
  if (endpointIsFile()) unlinkSync(path);
}

// Identity and state never live on a connection. Every call names its agent and its caller.
// A caller is a plain string, not a proof: only this machine's owner can open this socket, and the worst a caller
// can do by lying is pose as another caller of the same owner.
// The holder is a caller. Sockets here are only a way to reach a caller right now, and can vanish at any moment.
interface Holder { caller: string; since: number }
interface Listener { socket: Socket; caller: string; releaseOnClose: boolean; onBell?: (bell: Doorbell) => void }

await clearStaleSocket();
const store = new Store(databasePath(home));
// The server is named once, and then lives in the database, so moving the database and its key moves everything.
const serverUrl = process.argv[2] ?? store.getConfig(CONFIG_SERVER_URL);
if (!serverUrl) {
  logEvent("daemon.no_server", { message: "no server is set for this data yet. Run: cello setup, or cello login --server <url>" });
  process.exit(1);
}
const sockets = new Set<Socket>();
const holders = new Map<string, Holder>();
const listeners = new Map<string, Set<Listener>>();

function writeFrame(socket: Socket, frame: IpcNotification): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
}

function ring(agentHex: string, bell: Doorbell): void {
  for (const listener of listeners.get(agentHex) ?? []) {
    if (listener.onBell) listener.onBell(bell);
    else writeFrame(listener.socket, { notification: bell.type, data: { ...bell } });
  }
}

const engine = new Engine(store, serverUrl, { ring, channelPush: (frame) => channels.onPush(frame), reachable: (agent) => holders.has(agent), notesAtStart: (agent, sessions) => notes.atStart(agent, sessions) });
const channels = new Channels(store, engine.channelHost());
const discovery = new Discovery({ ...engine.discoveryHost(), channelSigner: (agentHex, channelHex) => channels.adminSigner(agentHex, channelHex), lookupSignals: (agentHex, address) => engine.wallet.lookup(agentHex, address) });
const notifiers = new Notifiers(store, engine.notifierHost(), TELEGRAM, operatorSocketPath(home));
const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const notes: Notes = new Notes(store, engine.governance.reach, {
  agentName: (agentHex) => engine.agentName(agentHex),
  holdsMessage: (agentHex, sessionHex, position) => store.entryAt(fromHex(agentHex), fromHex(sessionHex), position) !== undefined,
  holdsPost: (agentHex, channelHex, position) => channels.holdsPost(agentHex, channelHex, position),
  sessionOpen: (agentHex, sessionHex) => engine.sessionOpen(agentHex, sessionHex),
  isContact: (agentHex, contactHex) => engine.governance.contacts.get(fromHex(agentHex), fromHex(contactHex)) !== undefined,
});
const STALL_RESOLUTION_MS = 5;
const mainThreadDelay = monitorEventLoopDelay({ resolution: STALL_RESOLUTION_MS });
mainThreadDelay.enable();

function text(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new LocalError("bad_argument", `${key} must be a non-empty string`);
  return value;
}

function optionalText(params: Record<string, unknown>, key: string): string | undefined {
  return params[key] === undefined ? undefined : text(params, key);
}

function describeCaller(caller: string): string {
  if (caller === "cli") return "the command line on this machine";
  return caller.startsWith("mcp:") ? "another session" : `the caller "${caller}"`;
}

function takeHold(agentHex: string, caller: string, force: boolean): void {
  const holder = holders.get(agentHex);
  if (holder && holder.caller !== caller) {
    if (!force) throw new LocalError("agent_held", `${describeCaller(holder.caller)} holds ${engine.agentName(agentHex)}. It can be taken over with force.`);
    for (const listener of [...(listeners.get(agentHex) ?? [])]) {
      if (listener.caller === caller) continue;
      // A wait in progress ends now and says why, rather than running out its time.
      if (listener.onBell) listener.onBell({ type: "agent_displaced", agent: engine.agentName(agentHex), agent_id: agentHex });
      else writeFrame(listener.socket, { notification: "agent_displaced", data: { agent: engine.agentName(agentHex), agent_id: agentHex } });
      listeners.get(agentHex)?.delete(listener);
    }
  }
  if (holder?.caller !== caller) holders.set(agentHex, { caller, since: Date.now() });
}

// Every call that acts as an agent passes through here, with its identity in the call itself.
function acting(params: Record<string, unknown>): string {
  const agent = engine.resolveAgent(text(params, "agent"));
  takeHold(agent, text(params, "caller"), params["force"] === true);
  return agent;
}

// A send or a new session from a session no doorbell reaches says so, or it talks and never hears the replies.
function withDoorbellWarning<T>(answer: T, agentHex: string, params: Record<string, unknown>): T {
  const warning = doorbellWarning(listeners.get(agentHex) ?? [], text(params, "caller"), engine.agentName(agentHex));
  return warning && answer && typeof answer === "object" ? { ...answer, doorbell_warning: warning } : answer;
}

// Naming an agent is enough for what doesn't speak for it in a conversation, such as its wallet and its notifiers: no hold is taken.
function named(params: Record<string, unknown>): string {
  return engine.resolveAgent(text(params, "agent"));
}

// One answer per agent this daemon holds, all at once, so a slow issuer costs the call one wait rather than one per agent.
// Every failure is that agent's line, with its code and words, and never the whole call's: one agent can't stop the rest.
async function eachAgent(work: (agentHex: string) => Promise<unknown>): Promise<unknown> {
  const agents = await Promise.all(engine.agentHexes().map(async (agentHex) => {
    let name = agentHex;
    try {
      name = engine.agentName(agentHex);
      return { agent: name, agent_id: agentHex, ok: true, ...(await work(agentHex) as object) };
    } catch (err: unknown) {
      if (err instanceof LocalError) return { agent: name, agent_id: agentHex, ok: false, error: err.code, message: err.message };
      const message = err instanceof Error ? err.message : String(err);
      logEvent("daemon.each_agent.failed", { agent: agentHex, message });
      return { agent: name, agent_id: agentHex, ok: false, error: "internal_error", message: `This agent's request failed inside the daemon: ${message}` };
    }
  }));
  return { agents };
}

function requirePerson(params: Record<string, unknown>): void {
  if (params["person_confirmed"] !== true) throw new LocalError("person_required", "This takes a person at a terminal, on this machine, with the cello command. Nothing changed.");
}

// For a command a person will paste into a shell: single quotes, so nothing in an agent's text is run or expanded.
const shellQuoted = (value: unknown): string => `'${String(value ?? "").replaceAll("'", "'\\''")}'`;

// The whole command, options included, so what the person runs is what the agent asked for and not a plainer Reminder.
function reminderSetCommand(agent: string, params: Record<string, unknown>): string {
  const flags = [
    ...(params["at_start"] === true ? ["--at-start"] : []),
    ...(["every_messages", "every_minutes", "with", "session", "for_minutes"] as const).flatMap((name) => (params[name] === undefined ? [] : [`--${name.replace("_", "-")} ${shellQuoted(params[name])}`])),
  ];
  return ["cello reminder-set", shellQuoted(params["text"]), ...flags, `--agent ${agent}`].join(" ");
}

// Whose notes a call is about: the agent it names as itself, unless it names another as owner.
function noteOwner(writer: string, params: Record<string, unknown>): string {
  return params["owner"] === undefined ? writer : engine.resolveAgent(text(params, "owner"));
}

// Reminders and notifiers are open to anyone unless their agent's lock is on. Then a change takes a person, as governance does.
function unlessLocked(agent: string, key: string, params: Record<string, unknown>, what: string, command: string): void {
  if (engine.governance.reach.setting(new Uint8Array(Buffer.from(agent, "hex")), key) === "true") return;
  requirePersonFor(params, `${what} The lock is the setting ${key}.`, command);
}

function stopListening(socket: Socket): void {
  for (const [agent, set] of listeners) {
    // All of this socket's listeners go first, so a wait in progress on it can't keep a dead caller's hold alive.
    const gone = [...set].filter((listener) => listener.socket === socket);
    for (const listener of gone) set.delete(listener);
    for (const listener of gone) {
      const stillThere = [...set].some((other) => other.caller === listener.caller);
      // A session's hold lasts as long as it can be reached. The command line's lasts until it lets go.
      if (listener.releaseOnClose && !stillThere && holders.get(agent)?.caller === listener.caller) holders.delete(agent);
    }
  }
}

// A Claude session (caller mcp:<uuid>) talks over one long-lived connection, so when its last one closes the session is
// gone, and every hold it took goes with it, however it was taken. Identity still comes from each call; only the hold ends.
// The command line and named callers like hermes may connect per call, so their holds last until they let go.
const sessionSockets = new Map<string, Set<Socket>>();

function noteSessionSocket(socket: Socket, caller: unknown): void {
  if (typeof caller !== "string" || !caller.startsWith("mcp:")) return;
  const set = sessionSockets.get(caller) ?? new Set<Socket>();
  set.add(socket);
  sessionSockets.set(caller, set);
}

function releaseSessionHolds(socket: Socket): void {
  for (const [caller, set] of sessionSockets) {
    if (!set.delete(socket) || set.size > 0) continue;
    sessionSockets.delete(caller);
    for (const [agent, holder] of holders) if (holder.caller === caller) holders.delete(agent);
  }
}

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent("daemon.stopping");
  void accountPage?.close();
  channels.stop();
  notifiers.stop();
  engine.stop();
  for (const socket of sockets) socket.destroy();
  ipc.close(() => {
    store.close();
    process.exit(0);
  });
}

// A result that counts only once it's written to an open socket. That protects a caller that hung up first.
// It can't protect one killed after the write and before reading it: written isn't the same as read.
class AfterWrite {
  readonly result: unknown;
  readonly commit: () => void;
  constructor(result: unknown, commit: () => void) {
    this.result = result;
    this.commit = commit;
  }
}

// For a program passing a read on: it counts only when the program says it reached whoever asked. Tokens live in memory,
// so after a restart or this long the messages are simply still unread.
const DEFERRED_READ_MS = 5 * 60_000;
const deferredReads = new Map<string, { agent: string; commit: () => void; timer: NodeJS.Timeout }>();

function delivered(params: Record<string, unknown>, agent: string, read: { result: unknown; commit: () => void }): unknown {
  if (params["defer_commit"] !== true) return new AfterWrite(read.result, read.commit);
  const token = randomUUID();
  const timer = setTimeout(() => deferredReads.delete(token), DEFERRED_READ_MS);
  timer.unref();
  deferredReads.set(token, { agent, commit: read.commit, timer });
  return { ...(read.result as object), commit_token: token };
}

function waitForEvent(socket: Socket, agent: string, caller: string, seconds: number): Promise<unknown> {
  return new Promise((resolve) => {
    const set = listeners.get(agent) ?? new Set<Listener>();
    listeners.set(agent, set);
    const finish = (outcome: unknown): void => {
      clearTimeout(timer);
      socket.off("close", gone);
      set.delete(listener);
      resolve(outcome);
    };
    const listener: Listener = { socket, caller, releaseOnClose: false, onBell: (bell) => finish({ event: bell.type, ...bell }) };
    const gone = (): void => finish({ event: "caller_gone" });
    const timer = setTimeout(() => finish({ event: "timeout" }), seconds * 1000);
    socket.once("close", gone);
    set.add(listener);
  });
}

function governed(method: string, params: Record<string, unknown>): unknown {
  const named = params["agent"] === undefined ? undefined : engine.resolveAgent(text(params, "agent"));
  const id = named === undefined ? undefined : new Uint8Array(Buffer.from(named, "hex"));
  const g = engine.governance;
  if (method === "settings") return g.listSettings(id);
  if (method === "settings_set") {
    const answer = g.settingsSet(id, named, params);
    channels.settingsChanged();
    return answer;
  }
  if (!id || !named) throw new LocalError("no_current_agent", "name the agent");
  switch (method) {
    case "contacts": return g.listContacts(id);
    case "contact_add": return g.contactAdd(id, named, params);
    case "contact_remove": {
      const answer = g.contactRemove(id, named, params) as { removed: boolean; contact_id: string };
      // Remembered, so a note about this contact can tell it was removed from one that was never added.
      if (answer.removed) notes.contactRemoved(named, answer.contact_id);
      return answer;
    }
    case "contact_set_tier": return g.contactSetTier(id, named, params);
    case "contact_set_away": return g.contactSetAway(id, params);
    case "contact_set_moniker": return g.contactSetMoniker(id, params);
    case "config": return g.listGuards(id, params["key"] as string | undefined);
    case "config_set": return g.guardSet(id, named, params);
    case "screening": return g.setScreening(id, named, params);
    case "screening_log": return g.screeningLog(id, params["limit"] as number | undefined);
    case "signal_rules": return g.signalRules(id);
    case "signal_rule_set": return g.signalRuleSet(id, named, params);
    case "signal_rule_clear": return g.signalRuleClear(id, named, params);
    case "policy_list": return g.policyList(id);
    case "policy_pending": return g.policyPending(id);
    case "policy_propose": return g.policyPropose(id, named, params);
    case "policy_approve": return g.policyApprove(id, named, params);
    case "moniker": return g.setOwnMoniker(id, named, params);
    default: throw new LocalError("unknown_method", `no such method: ${method}`);
  }
}

// A call with no socket behind it can't be woken or kept waiting, so the two that need one refuse by name.
function needSocket(socket: Socket | undefined, method: string): Socket {
  if (!socket) throw new LocalError("needs_connection", `${method} needs the connection of a session, so it can't be asked this way.`);
  return socket;
}

async function handle(socket: Socket | undefined, method: string, params: Record<string, unknown>): Promise<unknown> {
  // Channel actions stop with everything else. The server refuses them too, so this only saves the trip and covers what's read from here.
  if (method.startsWith("channel_") && typeof params["agent"] === "string") engine.assertCanAct(engine.resolveAgent(params["agent"]));
  switch (method) {
    case HELLO_METHOD: {
      if (!ipcKey) throw new LocalError("not_supported", "this daemon doesn't prove itself on this platform");
      return { proof: daemonProof(ipcKey, text(params, "nonce")) };
    }
    case "status": {
      // A fact about this thread, measured here. It's the longest it has been held up since the last time anyone asked.
      const longestStallMs = Math.max(0, Math.round(mainThreadDelay.max / 1e6 - STALL_RESOLUTION_MS));
      mainThreadDelay.reset();
      return { pid: process.pid, home, main_thread: { longest_stall_ms: longestStallMs }, account_page: accountPageState, ...(engine.status() as object) };
    }
    // The link carries the secret, so it goes only to a person at a terminal.
    case "account": {
      requirePerson(params);
      if (!accountPage) throw new LocalError("account_page_unavailable", `The account page isn't running: ${accountPageState.problem ?? "it hasn't started yet"}.`);
      return { url: `http://127.0.0.1:${accountPage.port}/#${accountPageToken}` };
    }
    case "create_agent":
      return engine.createAgent(text(params, "name"));
    case "enroll_agent":
      return engine.enrollAgent(optionalText(params, "name"), optionalText(params, "code"), optionalText(params, "email_code"));
    case "invite":
      if (params["new"] === true && params["revoke"] === true) throw new LocalError("bad_argument", "Give --new or --revoke, not both.");
      return engine.inviteMake(engine.resolveAgent(text(params, "agent")), params["new"] === true, params["revoke"] === true);
    case "invite_use":
      return engine.inviteUse(engine.resolveAgent(text(params, "agent")), text(params, "code"));
    case "enroll_start":
      return engine.enrollStart(optionalText(params, "name"), text(params, "email"));
    case "signals_list":
      return engine.wallet.list(named(params), params["all"] === true);
    case "signals_view":
      return engine.wallet.view(named(params), text(params, "hash"));
    case "signals_enable":
      return engine.wallet.enable(named(params), text(params, "hash"));
    case "signals_disable":
      return engine.wallet.disable(named(params), text(params, "hash"));
    // Named: that agent, answered as before. Not named: every agent on this daemon, one line each, and one failing stops none of the rest.
    case "signals_collect":
      return params["agent"] === undefined ? eachAgent((agent) => engine.wallet.collect(agent)) : engine.wallet.collect(named(params));
    case "signals_request":
      if (text(params, "kind") !== "usage") throw new LocalError("bad_argument", "The only signal an agent can request is usage: cello signals request usage");
      if (params["agent"] === undefined) return eachAgent((agent) => engine.wallet.requestUsage(agent));
      return { agent: engine.agentName(named(params)), ...(await engine.wallet.requestUsage(named(params))) };
    case "signals_publish":
      return engine.wallet.publish(acting(params), text(params, "hash"));
    case "signals_unpublish":
      return engine.wallet.unpublish(acting(params), optionalText(params, "hash"), optionalText(params, "signal_id"));
    case "signals_presented":
      return engine.presentedSignals(named(params), text(params, "session_id"));
    case "signals_lookup":
      return engine.wallet.lookup(acting(params), text(params, "address"));
    case "discover_agents":
    case "discover_channels": {
      const options = { query: optionalText(params, "query"), tags: optionalText(params, "tags"), match: optionalText(params, "match"), cursor: optionalText(params, "cursor"), limit: typeof params["limit"] === "number" ? params["limit"] : undefined };
      return discovery.search(acting(params), method === "discover_agents" ? "agent" : "channel", options);
    }
    case "listing_publish":
      return discovery.publish(acting(params), { channel: optionalText(params, "channel"), name: text(params, "name"), description: optionalText(params, "description"), tags: optionalText(params, "tags"), language: optionalText(params, "language") });
    case "listing_renew":
      return discovery.renew(acting(params), optionalText(params, "channel"));
    case "listing_unpublish":
      return discovery.unpublish(acting(params), optionalText(params, "channel"));
    case "listing_show": {
      // The owner's own view. An agent that isn't on this machine gets pointed to the command that shows anyone's listing.
      const named = text(params, "agent");
      try {
        engine.resolveAgent(named);
      } catch (err: unknown) {
        if (!(err instanceof LocalError) || err.code !== "unknown_agent") throw err;
        if (/^[0-9a-f]{64}(@.+)?$/.test(named)) throw new LocalError("not_your_agent", `listing show is for agents on this machine, and ${named} isn't one. To see another agent's listing and its signals: cello discover show ${named}`);
        throw new LocalError("unknown_agent", `No agent on this machine is called ${named}: check the name with cello agents. To see another agent's listing and its signals, use its address: cello discover show <address>`);
      }
      return discovery.show(acting(params), optionalText(params, "channel"));
    }
    case "discover_show":
      return discovery.showOne(acting(params), text(params, "target"));
    case "issuer_trust": {
      const agent = named(params);
      if (params["person_confirmed"] !== true) throw new LocalError("person_required", `This would count signals from ${engine.wallet.describeIssuerOf(agent, text(params, "hash"))} as verified on this machine. Anyone can create an issuer, so this weakens a guard. Nothing changed. Only a person at a terminal can do this, with the cello command.`);
      return engine.wallet.trustIssuer(agent, text(params, "hash"));
    }
    case "issuer_untrust":
      return engine.wallet.untrustIssuer(named(params), text(params, "hash"));
    case "use_agent": {
      const agent = acting(params);
      notes.takenUp(agent);
      return { name: engine.agentName(agent), agent_id: agent, unread: engine.unreadCount(agent) };
    }
    // Takes hold, and keeps this socket as the way to reach the caller with doorbells. Used by a session that can be woken.
    case "subscribe": {
      const agent = acting(params);
      notes.takenUp(agent);
      const set = listeners.get(agent) ?? new Set<Listener>();
      listeners.set(agent, set);
      const caller = text(params, "caller");
      // Selecting an agent twice must not ring twice.
      const own = needSocket(socket, method);
      if (![...set].some((listener) => listener.socket === own && listener.caller === caller && !listener.onBell)) {
        set.add({ socket: own, caller, releaseOnClose: true });
      }
      return { name: engine.agentName(agent), agent_id: agent, unread: engine.unreadCount(agent) };
    }
    case "stop_using_agent": {
      const agent = engine.resolveAgent(text(params, "agent"));
      const caller = text(params, "caller");
      if (holders.get(agent)?.caller === caller) holders.delete(agent);
      for (const listener of [...(listeners.get(agent) ?? [])]) {
        if (listener.caller === caller && !listener.onBell) listeners.get(agent)?.delete(listener);
      }
      return { released: true, agent_id: agent };
    }
    case "initiate_session": {
      const agent = acting(params);
      const answer = withDoorbellWarning(await engine.initiate(agent, text(params, "target"), params), agent, params);
      const onceWritten = (answer as { [ONCE_WRITTEN]?: () => void })[ONCE_WRITTEN];
      return onceWritten ? new AfterWrite(answer, onceWritten) : answer;
    }
    case "send": {
      const agent = acting(params);
      return withDoorbellWarning(await engine.send(agent, text(params, "session_id"), text(params, "text"), params["signal"] as Signal, params["est_minutes"] as number | undefined, params["notice"] === true, params), agent, params);
    }
    case "receive": {
      const agent = acting(params);
      return delivered(params, agent, engine.receive(agent, params["session_id"] === undefined ? undefined : text(params, "session_id")));
    }
    case "commit_read": {
      const agent = acting(params);
      const token = text(params, "token");
      const read = deferredReads.get(token);
      if (read?.agent !== agent) throw new LocalError("read_token_unknown", "That read has expired or isn't this agent's. Nothing was marked as read, so the messages come back on the next read.");
      deferredReads.delete(token);
      clearTimeout(read.timer);
      read.commit();
      return { committed: true };
    }
    case "wait": {
      const agent = acting(params);
      const seconds = params["timeout_seconds"] === undefined ? DEFAULT_WAIT_SECONDS : params["timeout_seconds"];
      if (typeof seconds !== "number" || !(seconds > 0)) throw new LocalError("bad_argument", "timeout_seconds must be a positive number");
      engine.assertCanAct(agent);
      const unread = engine.unreadCount(agent);
      if (unread > 0) return { event: "unread", unread };
      return waitForEvent(needSocket(socket, method), agent, text(params, "caller"), seconds);
    }
    case "close_session":
      return engine.close(acting(params), text(params, "session_id"));
    case "seal":
      return engine.seal(acting(params), text(params, "session_id"), params["through"] as number | undefined);
    case "seals":
      return engine.seals(engine.resolveAgent(text(params, "agent")), params["session_id"] === undefined ? undefined : text(params, "session_id"));
    case "export_seal":
      return engine.exportSeal(engine.resolveAgent(text(params, "agent")), text(params, "seal_id"));
    case "export_transcript":
      return engine.exportTranscript(engine.resolveAgent(text(params, "agent")), text(params, "session_id"), {
        reveal: params["reveal"] === undefined ? undefined : text(params, "reveal"),
        all: params["all"] === true,
        sealId: params["seal_id"] === undefined ? undefined : text(params, "seal_id"),
      });
    // Only a person at a terminal, through the command line, which confirms first. These have no tools.
    case "suspend":
      requirePerson(params);
      return engine.suspend(engine.resolveAgent(text(params, "agent")), params["reason"]);
    case "retire":
      requirePerson(params);
      return engine.retire(engine.resolveAgent(text(params, "agent")), params["reason"]);
    case "remove_agent": {
      requirePerson(params);
      const agent = engine.resolveAgent(text(params, "agent"));
      const answer = await engine.removeAgent(agent);
      holders.delete(agent);
      notifiers.forget(agent);
      engine.reminders.forget(agent);
      notes.forget(agent);
      return answer;
    }
    case "agent_status":
      return engine.agentStatus(engine.resolveAgent(text(params, "agent")));
    // Reading a record acts as nobody, so these need no hold.
    case "agents":
      return engine.agents();
    case "rename_agent":
      return engine.renameAgent(engine.resolveAgent(text(params, "agent")), text(params, "name"));
    case "sessions":
      return engine.sessions(engine.resolveAgent(text(params, "agent")), params["all"] === true);
    case "greetings":
      return engine.greetings(engine.resolveAgent(text(params, "agent")));
    case "inbox":
      return engine.inbox(engine.resolveAgent(text(params, "agent")));
    case "transcript":
      return engine.transcript(engine.resolveAgent(text(params, "agent")), text(params, "session_id"), typeof params["after"] === "number" ? params["after"] : 0);
    case "evidence":
      return engine.evidence(engine.resolveAgent(text(params, "agent")), text(params, "session_id"));
    case "verify_session":
      return engine.verifySession(engine.resolveAgent(text(params, "agent")), text(params, "session_id"));
    // What a person decides. Each of these judges which way a change goes, and refuses a loosening that no person agreed to.
    case "contacts":
    case "contact_add":
    case "contact_remove":
    case "contact_set_tier":
    case "contact_set_away":
    case "contact_set_moniker":
    case "settings":
    case "settings_set":
    case "config":
    case "config_set":
    case "screening":
    case "screening_log":
    case "signal_rules":
    case "signal_rule_set":
    case "signal_rule_clear":
    case "policy_list":
    case "policy_pending":
    case "policy_propose":
    case "policy_approve":
    case "moniker":
      return governed(method, params);
    // Reaching the person. None of these acts as the agent in a conversation, so none takes the hold.
    case "notifier_add": {
      const agent = named(params);
      unlessLocked(agent, "notifiers.anyone_can_change", params, `This adds a notifier for ${agent}, and that agent's notifiers are locked.`, addCommand(params, agent, shellQuoted));
      // Named like any agent, and resolved here so the notifier only ever deals in ids.
      return notifiers.add(agent, params["same_as"] === undefined ? params : { ...params, same_as_agent: engine.resolveAgent(text(params, "same_as")) });
    }
    case "notifier_list":
      return notifiers.list(named(params));
    case "notifier_remove": {
      const agent = named(params);
      unlessLocked(agent, "notifiers.anyone_can_change", params, `This removes a notifier from ${agent}, and that agent's notifiers are locked.`, `cello notifier-remove ${shellQuoted(params["name"])} --agent ${agent}`);
      return notifiers.remove(agent, text(params, "name"));
    }
    case "notifier_test":
      return notifiers.test(named(params), optionalText(params, "name"));
    case "notify":
      return notifiers.notify(named(params), params);
    // Reminders aren't governance: anyone sets one, an agent included, for itself or for another of the owner's agents.
    case "reminder_set": {
      const agent = named(params);
      unlessLocked(agent, "reminders.anyone_can_change", params, `This sets a Reminder for ${agent}, and that agent's Reminders are locked.`, reminderSetCommand(agent, params));
      return engine.reminders.set(agent, params);
    }
    case "reminder_list":
      return engine.reminders.list(named(params));
    case "reminder_remove": {
      const agent = named(params);
      unlessLocked(agent, "reminders.anyone_can_change", params, `This removes a Reminder from ${agent}, and that agent's Reminders are locked.`, `cello reminder-remove ${String(params["reminder"])} --agent ${agent}`);
      return engine.reminders.remove(agent, params["reminder"]);
    }
    // Notes name two agents: the one writing, which is stamped on the note, and the owner, which is the same unless said.
    case "note_set": {
      const writer = named(params);
      const owner = noteOwner(writer, params);
      return notes.set(writer, owner, params);
    }
    case "note_get":
      return notes.get(named(params), params["note"], params["history"] === true);
    case "note_list":
      return notes.list(named(params), params);
    case "note_remove": {
      const writer = named(params);
      const owner = noteOwner(writer, params);
      return notes.remove(writer, owner, params["note"]);
    }
    case "channel_create":
      return channels.create(acting(params), text(params, "name"), text(params, "type"), optionalText(params, "posting"), params["retention_days"] as number | undefined);
    case "channel_join":
      return channels.join(acting(params), text(params, "channel_id"), optionalText(params, "note"));
    case "channel_leave":
      return channels.leave(acting(params), text(params, "channel_id"));
    case "channel_requests":
      return channels.requests(engine.resolveAgent(text(params, "agent")), text(params, "channel_id"));
    case "channel_approve":
      return channels.approve(acting(params), text(params, "channel_id"), text(params, "member"));
    case "channel_refuse":
      return channels.refuse(acting(params), text(params, "channel_id"), text(params, "member"));
    case "channel_eject":
      return channels.eject(acting(params), text(params, "channel_id"), text(params, "member"));
    case "channel_add_poster":
      return channels.addPoster(acting(params), text(params, "channel_id"), text(params, "poster"));
    case "channel_remove_poster":
      return channels.removePoster(acting(params), text(params, "channel_id"), text(params, "poster"));
    case "channel_post":
      return channels.post(acting(params), text(params, "channel_id"), text(params, "text"), optionalText(params, "title"), params);
    case "channel_collect":
      return channels.collect(engine.resolveAgent(text(params, "agent")), optionalText(params, "channel_id"));
    case "channels":
      return channels.list(engine.resolveAgent(text(params, "agent")));
    case "channel_settings":
      return channels.settings(acting(params), text(params, "channel_id"), optionalText(params, "delivery"), optionalText(params, "screen_bodies"));
    case "channel_read": {
      const agent = acting(params);
      const read = await channels.read(agent, text(params, "channel_id"), params["titles_only"] === true);
      // The channel's notes ride on the first read after the agent is taken up, and count as shown once the answer is written.
      const noted = notes.atChannelRead(agent, text(params, "channel_id"));
      return delivered(params, agent, { result: { ...(read.result as object), ...(noted.shown ? { notes: noted.shown } : {}) }, commit: () => { read.commit(); noted.commit(); } });
    }
    case "channel_history":
      return channels.history(engine.resolveAgent(text(params, "agent")), text(params, "channel_id"), typeof params["after"] === "number" ? params["after"] : 0);
    case "screener_reload":
      return engine.reloadScreener();
    case "shutdown":
      setImmediate(shutdown);
      return { stopping: true };
    default:
      throw new LocalError("unknown_method", `no such method: ${method}`);
  }
}

// The page's secret lives in the encrypted database with everything else, so moving the database moves the link's meaning.
const ACCOUNT_PAGE_TOKEN_KEY = "account_page.token";
let accountPageToken = store.getConfig(ACCOUNT_PAGE_TOKEN_KEY);
if (!accountPageToken) {
  accountPageToken = randomBytes(32).toString("hex");
  store.setConfig(ACCOUNT_PAGE_TOKEN_KEY, accountPageToken);
}
let accountPage: RunningAccountPage | undefined;
// What status says about the page, from what happened when it tried to start.
let accountPageState: { listening: boolean; port?: number; problem?: string } = { listening: false };

// A port someone else holds costs the page, never the daemon.
async function startAccountPage(): Promise<void> {
  const port = currentSetting(store, "account_page_port");
  try {
    accountPage = await serveAccountPage({
      host: "127.0.0.1",
      port,
      token: accountPageToken as string,
      call: (method, params) => handle(undefined, method, params),
      allowedHosts: (bound) => [`127.0.0.1:${bound}`, `localhost:${bound}`],
    });
    accountPageState = { listening: true, port: accountPage.port };
    logEvent("account_page.listening", { port: accountPage.port });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    accountPageState = { listening: false, port, problem: `port ${port} could not be used (${reason}). Change it with: cello settings-set account_page_port <port>, then log in again` };
    logEvent("account_page.unavailable", { port, reason });
  }
}

const ipc = createServer((socket) => {
  sockets.add(socket);
  const respond = (response: IpcResponse, afterWrite?: () => void): void => {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(response)}\n`, (err) => {
      if (!err && afterWrite) afterWrite();
    });
  };
  createInterface({ input: socket }).on("line", (line) => {
    let request: IpcRequest;
    try {
      request = JSON.parse(line) as IpcRequest;
    } catch {
      socket.destroy();
      return;
    }
    noteSessionSocket(socket, request.params?.["caller"]);
    handle(socket, request.method, request.params ?? {}).then(
      (result) => {
        if (result instanceof AfterWrite) respond({ id: request.id, ok: true, result: result.result }, result.commit);
        else respond({ id: request.id, ok: true, result });
      },
      (err: unknown) => {
        if (err instanceof LocalError) {
          respond({ id: request.id, ok: false, error: { code: err.code, message: err.message } });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        logEvent("ipc.failed", { method: request.method, message });
        respond({ id: request.id, ok: false, error: { code: "internal_error", message } });
      },
    );
  });
  socket.on("close", () => {
    stopListening(socket);
    sockets.delete(socket);
    releaseSessionHolds(socket);
  });
  socket.on("error", () => undefined);
});

// Written before the pipe opens, so a client that reaches this daemon can always read the key it proves itself with.
if (ipcKey) writeFileSync(ipcKeyPath(home), `${ipcKey}\n`, { mode: 0o600 });
await new Promise<void>((resolve) => ipc.listen({ path, readableAll: false, writableAll: false }, resolve));
logEvent("daemon.listening", { pid: process.pid, server: serverUrl });
await engine.start();
notifiers.start();
channels.start();
await startAccountPage();

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

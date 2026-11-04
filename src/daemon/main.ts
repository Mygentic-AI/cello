// The daemon: the local socket opens first, so a client never sees "failed" while it's coming up.
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Socket, createConnection } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { DEFAULT_WAIT_SECONDS } from "../ipc/operations.ts";
import type { IpcNotification, IpcRequest, IpcResponse } from "../ipc/protocol.ts";
import { CONFIG_SERVER_URL, type Doorbell, Engine, LocalError, type Signal } from "./engine.ts";
import { Channels } from "./channels.ts";
import { logEvent } from "./log.ts";
import { celloHome, databasePath, socketPath } from "./paths.ts";
import { Store } from "./store.ts";

const home = celloHome();
mkdirSync(home, { recursive: true, mode: 0o700 });
const path = socketPath(home);

// One daemon per home. A socket file nobody answers on is left over from a crash.
async function clearStaleSocket(): Promise<void> {
  if (!existsSync(path)) return;
  const answered = await new Promise<boolean>((resolve) => {
    const probe = createConnection(path);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
  if (answered) throw new Error(`a daemon is already running on ${path}`);
  unlinkSync(path);
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
  logEvent("daemon.no_server", { message: "no server is set for this data yet. Run: cello-v2 login --server <url>" });
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

const engine = new Engine(store, serverUrl, { ring, channelPush: (frame) => channels.onPush(frame) });
const channels = new Channels(store, engine.channelHost());
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
      writeFrame(listener.socket, { notification: "agent_displaced", data: { agent: engine.agentName(agentHex) } });
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

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent("daemon.stopping");
  channels.stop();
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

async function handle(socket: Socket, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "status": {
      // A fact about this thread, measured here. It's the longest it has been held up since the last time anyone asked.
      const longestStallMs = Math.max(0, Math.round(mainThreadDelay.max / 1e6 - STALL_RESOLUTION_MS));
      mainThreadDelay.reset();
      return { pid: process.pid, home, main_thread: { longest_stall_ms: longestStallMs }, ...(engine.status() as object) };
    }
    case "create_agent":
      return engine.createAgent(text(params, "name"));
    case "use_agent": {
      const agent = acting(params);
      return { name: engine.agentName(agent), agent_id: agent, unread: engine.unreadCount(agent) };
    }
    // Takes hold, and keeps this socket as the way to reach the caller with doorbells. Used by a session that can be woken.
    case "subscribe": {
      const agent = acting(params);
      const set = listeners.get(agent) ?? new Set<Listener>();
      listeners.set(agent, set);
      const caller = text(params, "caller");
      // Selecting an agent twice must not ring twice.
      if (![...set].some((listener) => listener.socket === socket && listener.caller === caller && !listener.onBell)) {
        set.add({ socket, caller, releaseOnClose: true });
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
    case "initiate_session":
      return engine.initiate(acting(params), text(params, "target"));
    case "send":
      return engine.send(acting(params), text(params, "session_id"), text(params, "text"), params["signal"] as Signal, params["est_minutes"] as number | undefined, params["notice"] === true);
    case "receive": {
      const { result, commit } = engine.receive(acting(params), params["session_id"] === undefined ? undefined : text(params, "session_id"));
      return new AfterWrite(result, commit);
    }
    case "wait": {
      const agent = acting(params);
      const seconds = params["timeout_seconds"] === undefined ? DEFAULT_WAIT_SECONDS : params["timeout_seconds"];
      if (typeof seconds !== "number" || !(seconds > 0)) throw new LocalError("bad_argument", "timeout_seconds must be a positive number");
      const unread = engine.unreadCount(agent);
      if (unread > 0) return { event: "unread", unread };
      return waitForEvent(socket, agent, text(params, "caller"), seconds);
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
    // Reading a record acts as nobody, so these need no hold.
    case "agents":
      return engine.agents();
    case "sessions":
      return engine.sessions(engine.resolveAgent(text(params, "agent")), params["all"] === true);
    case "inbox":
      return engine.inbox(engine.resolveAgent(text(params, "agent")));
    case "transcript":
      return engine.transcript(engine.resolveAgent(text(params, "agent")), text(params, "session_id"), typeof params["after"] === "number" ? params["after"] : 0);
    case "verify_session":
      return engine.verifySession(engine.resolveAgent(text(params, "agent")), text(params, "session_id"));
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
      return channels.post(acting(params), text(params, "channel_id"), text(params, "text"), optionalText(params, "title"));
    case "channel_collect":
      return channels.collect(engine.resolveAgent(text(params, "agent")), optionalText(params, "channel_id"));
    case "channels":
      return channels.list(engine.resolveAgent(text(params, "agent")));
    case "channel_settings":
      return channels.settings(acting(params), text(params, "channel_id"), optionalText(params, "delivery"), optionalText(params, "screen_bodies"));
    case "channel_read": {
      const { result, commit } = await channels.read(acting(params), text(params, "channel_id"), params["titles_only"] === true);
      return new AfterWrite(result, commit);
    }
    case "channel_history":
      return channels.history(engine.resolveAgent(text(params, "agent")), text(params, "channel_id"), typeof params["after"] === "number" ? params["after"] : 0);
    // Not in the tool table's MCP half: only the command line reaches these, after it has asked a person.
    case "screening":
      return engine.setScreeningRule(engine.resolveAgent(text(params, "agent")), text(params, "sender"), params["level"]);
    case "settings": {
      const answer = engine.settings(params["name"], params["value"]);
      channels.settingsChanged();
      return answer;
    }
    case "screener_reload":
      return engine.reloadScreener();
    case "shutdown":
      setImmediate(shutdown);
      return { stopping: true };
    default:
      throw new LocalError("unknown_method", `no such method: ${method}`);
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
  });
  socket.on("error", () => undefined);
});

await new Promise<void>((resolve) => ipc.listen({ path, readableAll: false, writableAll: false }, resolve));
logEvent("daemon.listening", { pid: process.pid, server: serverUrl });
await engine.start();
channels.start();

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

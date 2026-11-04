// The daemon: the local socket opens first, so a client never sees "failed" while it's coming up.
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Socket, createConnection } from "node:net";
import { createInterface } from "node:readline";
import type { IpcNotification, IpcRequest, IpcResponse } from "../ipc/protocol.ts";
import { type Doorbell, Engine, LocalError, type Signal } from "./engine.ts";
import { logEvent } from "./log.ts";
import { celloHome, databasePath, socketPath } from "./paths.ts";
import { Store } from "./store.ts";

const serverUrl = process.argv[2];
if (!serverUrl) throw new Error("usage: daemon <server-url>");

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

interface Client { socket: Socket; current: string | null }

await clearStaleSocket();
const store = new Store(databasePath(home));
const clients = new Set<Client>();
const holders = new Map<string, Client>();

function ring(agentHex: string, bell: Doorbell): void {
  const holder = holders.get(agentHex);
  if (!holder) return;
  const frame: IpcNotification = { notification: bell.type, data: { ...bell } };
  holder.socket.write(`${JSON.stringify(frame)}\n`);
}

const engine = new Engine(store, serverUrl, { ring });

function release(client: Client): void {
  if (client.current && holders.get(client.current) === client) holders.delete(client.current);
  client.current = null;
}

function currentAgent(client: Client): string {
  if (!client.current) throw new LocalError("no_current_agent", "select an agent first with use_agent");
  return client.current;
}

function text(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new LocalError("bad_argument", `${key} must be a string`);
  return value;
}

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent("daemon.stopping");
  engine.stop();
  for (const client of clients) client.socket.destroy();
  ipc.close(() => {
    store.close();
    process.exit(0);
  });
}

async function handle(client: Client, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "status":
      return { pid: process.pid, home, ...(engine.status() as object) };
    case "create_agent":
      return engine.createAgent(text(params, "name"));
    case "use_agent": {
      const agent = engine.resolveAgent(text(params, "agent"));
      const holder = holders.get(agent);
      if (holder && holder !== client && params["force"] !== true) {
        throw new LocalError("agent_held", `another session holds ${engine.agentName(agent)}. It can be taken over with force.`);
      }
      release(client);
      if (holder && holder !== client) {
        holder.current = null;
        const frame: IpcNotification = { notification: "agent_displaced", data: { agent: engine.agentName(agent) } };
        holder.socket.write(`${JSON.stringify(frame)}\n`);
      }
      holders.set(agent, client);
      client.current = agent;
      return { name: engine.agentName(agent), agent_id: agent, unread: engine.unreadCount(agent) };
    }
    case "initiate_session":
      return engine.initiate(currentAgent(client), text(params, "target"));
    case "send":
      return engine.send(currentAgent(client), text(params, "session_id"), text(params, "text"), params["signal"] as Signal, params["est_minutes"] as number | undefined, params["notice"] === true);
    case "receive":
      return engine.receive(currentAgent(client), params["session_id"] === undefined ? undefined : text(params, "session_id"));
    case "close_session":
      return engine.close(currentAgent(client), text(params, "session_id"));
    case "verify_session":
      return engine.verifySession(engine.resolveAgent(text(params, "agent")), text(params, "session_id"));
    case "shutdown":
      setImmediate(shutdown);
      return { stopping: true };
    default:
      throw new LocalError("unknown_method", `no such method: ${method}`);
  }
}

const ipc = createServer((socket) => {
  const client: Client = { socket, current: null };
  clients.add(client);
  createInterface({ input: socket }).on("line", (line) => {
    let request: IpcRequest;
    try {
      request = JSON.parse(line) as IpcRequest;
    } catch {
      socket.destroy();
      return;
    }
    handle(client, request.method, request.params ?? {}).then(
      (result) => respond({ id: request.id, ok: true, result }),
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
  const respond = (response: IpcResponse): void => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
  };
  socket.on("close", () => {
    release(client);
    clients.delete(client);
  });
  socket.on("error", () => undefined);
});

await new Promise<void>((resolve) => ipc.listen({ path, readableAll: false, writableAll: false }, resolve));
logEvent("daemon.listening", { pid: process.pid, server: serverUrl });
await engine.start();

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// One WebSocket from the daemon to its server. Daemons only dial out, so NAT never matters.
// It reconnects by itself, and everything sent over it can be repeated safely.
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import WebSocket from "ws";
import { toHex } from "../protocol/encode.ts";
import { type PublicIdentity, identityId, verifySignature } from "../protocol/identity.ts";
import { serverAuthBytes } from "../protocol/structures.ts";
import { type ErrorCode, MAX_FRAME_BYTES, PROTOCOL_VERSION, type PushFrame, type ResponseFrame, fromB64, identityCodec, signatureCodec, toB64 } from "../protocol/wire.ts";
import { logEvent } from "./log.ts";

const CALL_TIMEOUT_MS = 20_000;
const SERVER_SILENCE_MS = 45_000;
// Under the server's 15-second heartbeat.
const KEEP_ALIVE_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

export class ServerRefused extends Error {
  readonly code: ErrorCode;
  readonly tip: number | undefined;
  constructor(code: ErrorCode, message: string, tip?: number) {
    super(message);
    this.name = "ServerRefused";
    this.code = code;
    this.tip = tip;
  }
}

// The server wasn't reached, or didn't answer in time. The caller doesn't know whether it took effect.
export class ServerUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerUnreachable";
  }
}

export interface ConnectedServer {
  identity: PublicIdentity;
  id: Uint8Array;
  nonce: Uint8Array;
}

export interface LinkEvents {
  // Pins the server on first contact. Returns a reason to refuse this server, or null.
  checkIdentity(identity: PublicIdentity): string | null;
  connected(server: ConnectedServer): Promise<void>;
  disconnected(): void;
  push(frame: PushFrame): void;
}

export class ServerLink {
  readonly #url: string;
  readonly #events: LinkEvents;
  #socket: WebSocket | undefined;
  #ready = false;
  #stopped = false;
  #nextId = 1;
  #backoff = 1000;
  #problem: string | null = null;
  #silence: NodeJS.Timeout | undefined;
  #keepAlive: NodeJS.Timeout | undefined;
  #tcp: Socket | undefined;
  #bytesHeard = 0;
  readonly #waiting = new Map<number, { resolve(value: unknown): void; reject(err: Error): void; timer: NodeJS.Timeout }>();
  // Names this link's log events, so a count of reconnects means one connection.
  readonly #name: string;

  constructor(url: string, events: LinkEvents, name = "server") {
    this.#url = url;
    this.#events = events;
    this.#name = name;
  }

  get ready(): boolean {
    return this.#ready;
  }

  get problem(): string | null {
    return this.#problem;
  }

  start(): void {
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    this.#socket?.close();
  }

  #open(): void {
    if (this.#stopped) return;
    const socket = new WebSocket(this.#url, { maxPayload: MAX_FRAME_BYTES });
    this.#socket = socket;
    this.#tcp = undefined;
    socket.on("upgrade", (response) => { this.#tcp = response.socket; });
    socket.on("open", () => {
      // The server's heartbeat needs to hear something from us, and its ping can sit behind queued long replies.
      // This way a daemon that's busy reading those isn't taken for a dead one.
      this.#keepAlive = setInterval(() => socket.ping(), KEEP_ALIVE_MS);
      void this.#greet();
    });
    socket.on("message", (raw: Buffer) => this.#receive(raw));
    socket.on("ping", () => this.#heardServer());
    socket.on("close", () => this.#closed());
    socket.on("error", (err) => {
      this.#problem = `can't reach the server: ${err.message}`;
      logEvent(`${this.#name}.socket_error`, { message: err.message });
    });
    this.#heardServer();
  }

  // A silent drop shows as no pings. The server pings every 15 seconds.
  // On a slow link a ping can queue behind one long message, so bytes still arriving count as hearing the server.
  #heardServer(): void {
    clearTimeout(this.#silence);
    this.#bytesHeard = this.#tcp?.bytesRead ?? 0;
    this.#silence = setTimeout(() => {
      if ((this.#tcp?.bytesRead ?? 0) > this.#bytesHeard) {
        this.#heardServer();
        return;
      }
      logEvent(`${this.#name}.silent`);
      this.#socket?.terminate();
    }, SERVER_SILENCE_MS);
  }

  async #greet(): Promise<void> {
    try {
      const clientNonce = new Uint8Array(randomBytes(32));
      const hello = await this.#send("hello", { clientNonce: toB64(clientNonce) }) as { server: unknown; serverNonce: unknown; signature: unknown };
      const identity = identityCodec.decode(hello.server, "server");
      const serverNonce = fromB64(hello.serverNonce, "serverNonce");
      const id = identityId(identity);
      const proof = serverAuthBytes({ serverId: id, clientNonce, serverNonce });
      if (!(await verifySignature(identity, "cello-v2-server-auth", proof, signatureCodec.decode(hello.signature, "signature")))) {
        throw new Error("the server's proof of identity didn't verify");
      }
      const refusal = this.#events.checkIdentity(identity);
      if (refusal) throw new Error(refusal);
      this.#ready = true;
      this.#problem = null;
      this.#backoff = 1000;
      logEvent(`${this.#name}.connected`, { server: toHex(id) });
      await this.#events.connected({ identity, id, nonce: serverNonce });
    } catch (err: unknown) {
      this.#problem = err instanceof Error ? err.message : String(err);
      logEvent(`${this.#name}.greeting_failed`, { message: this.#problem });
      this.#socket?.close();
    }
  }

  #closed(): void {
    clearTimeout(this.#silence);
    clearInterval(this.#keepAlive);
    const wasReady = this.#ready;
    this.#ready = false;
    for (const [id, waiter] of this.#waiting) {
      clearTimeout(waiter.timer);
      waiter.reject(new ServerUnreachable("the connection to the server dropped"));
      this.#waiting.delete(id);
    }
    if (wasReady) {
      this.#problem = "the connection to the server dropped";
      this.#events.disconnected();
    }
    if (this.#stopped) return;
    const delay = this.#backoff * (0.5 + Math.random() / 2);
    this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS);
    setTimeout(() => this.#open(), delay);
  }

  #receive(raw: Buffer): void {
    this.#heardServer();
    let frame: ResponseFrame | PushFrame;
    try {
      frame = JSON.parse(raw.toString()) as ResponseFrame | PushFrame;
    } catch {
      logEvent("server.bad_frame");
      return;
    }
    if ("push" in frame) {
      this.#events.push(frame);
      return;
    }
    const waiter = this.#waiting.get(frame.id);
    if (!waiter) return;
    this.#waiting.delete(frame.id);
    clearTimeout(waiter.timer);
    if (frame.ok) waiter.resolve(frame.result);
    else waiter.reject(new ServerRefused(frame.error.code, frame.error.message, frame.error.tip));
  }

  #send(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== socket.OPEN) return Promise.reject(new ServerUnreachable("not connected to the server"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new ServerUnreachable(`the server didn't answer ${method} in time`));
      }, timeoutMs);
      this.#waiting.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, id, method, params }));
    });
  }

  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.#ready) return Promise.reject(new ServerUnreachable(this.#problem ?? "not connected to the server"));
    return this.#send(method, params, timeoutMs);
  }
}

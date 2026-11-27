// The operator's door: a socket of its own beside daemon.sock, for the CELLO app on a Mac. What arrives here is the
// person's own answer, so it takes only what that app needs, and nothing a cello command or tool can do is reachable
// through it. daemon.sock in turn has no way to speak as the operator. One JSON object per line, each way.
// Anything running as the owner could open it, as it could open the database key. The claim is the same as Telegram's:
// no command, tool or counterparty reaches it.
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { createInterface } from "node:readline";
import { LocalError } from "./errors.ts";
import { logEvent } from "./log.ts";

// Raised whenever a message's meaning changes, so an app and a daemon that disagree say so by name and do nothing else.
export const OPERATOR_PROTOCOL = 1;

// Everything the door takes. hello comes first, and anything else, or any other word, is refused.
export const OPERATOR_OPS = ["hello", "subscribe", "ack", "pick", "reply", "pause", "resume", "remove", "remove_agent", "agents", "add_agent"] as const;
export type OperatorOp = Exclude<(typeof OPERATOR_OPS)[number], "hello">;

// A person's line is short. A longer one is a fault, and the connection goes.
const MAX_LINE_CHARS = 64 * 1024;

export interface DoorConnection {
  readonly id: number;
  subscribed: boolean;
  send(frame: Record<string, unknown>): void;
}

// What a request answers, and anything to push once that answer is written, such as the waiting notifications.
export interface DoorReply { fields?: Record<string, unknown>; after?: () => void }

export interface DoorHandler {
  handle(connection: DoorConnection, op: OperatorOp, request: Record<string, unknown>): Promise<DoorReply>;
  closed(connection: DoorConnection): void;
}

interface Open extends DoorConnection { socket: Socket; helloed: boolean }

export class OperatorDoor {
  readonly #path: string;
  readonly #handler: DoorHandler;
  readonly #open = new Set<Open>();
  #server: Server | undefined;
  #next = 1;

  constructor(path: string, handler: DoorHandler) {
    this.#path = path;
    this.#handler = handler;
  }

  get path(): string {
    return this.#path;
  }

  // Called once daemon.sock is known to be this daemon's, so a file here is one a crash left behind.
  async open(): Promise<void> {
    if (existsSync(this.#path)) unlinkSync(this.#path);
    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path: this.#path, readableAll: false, writableAll: false }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // The home folder is the owner's alone already. The socket is too, whatever the umask said.
    chmodSync(this.#path, 0o600);
    logEvent("operator_door.listening", { path: this.#path });
  }

  close(): void {
    for (const open of this.#open) open.socket.destroy();
    this.#open.clear();
    this.#server?.close();
    this.#server = undefined;
    try {
      if (existsSync(this.#path)) unlinkSync(this.#path);
    } catch {
      // Gone already, or the next start clears it.
    }
  }

  connections(): DoorConnection[] {
    return [...this.#open];
  }

  #accept(socket: Socket): void {
    const open: Open = {
      id: this.#next++,
      subscribed: false,
      helloed: false,
      socket,
      send: (frame) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
      },
    };
    this.#open.add(open);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.#open.delete(open);
      this.#handler.closed(open);
    });
    // One at a time, in order, so a pick sent right after an ack is handled after it.
    let chain = Promise.resolve();
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
      chain = chain.then(() => this.#line(open, line));
    });
  }

  async #line(open: Open, line: string): Promise<void> {
    if (open.socket.destroyed || line.trim().length === 0) return;
    if (line.length > MAX_LINE_CHARS) {
      this.#refuse(open, undefined, "too_long", `A line holds at most ${MAX_LINE_CHARS} characters, so the connection was closed.`);
      open.socket.destroy();
      return;
    }
    let request: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      request = parsed as Record<string, unknown>;
    } catch {
      this.#refuse(open, undefined, "bad_request", "Each line must be one JSON object, so the connection was closed.");
      open.socket.destroy();
      return;
    }
    const ref = request["ref"];
    const op = request["op"];
    if (typeof op !== "string" || !(OPERATOR_OPS as readonly string[]).includes(op)) {
      logEvent("operator_door.refused", { op: typeof op === "string" ? op.slice(0, 40) : typeof request["method"] === "string" ? `method:${request["method"].slice(0, 40)}` : "none" });
      this.#refuse(open, ref, "not_allowed", `This socket takes only ${OPERATOR_OPS.join(", ")}, as op. Everything else is done with the cello command.`);
      return;
    }
    if (op === "hello") {
      this.#hello(open, ref, request);
      return;
    }
    if (!open.helloed) {
      this.#refuse(open, ref, "hello_first", `Say hello first, with protocol ${OPERATOR_PROTOCOL}.`);
      return;
    }
    try {
      const reply = await this.#handler.handle(open, op as OperatorOp, request);
      open.send({ op: "result", ...(ref === undefined ? {} : { ref }), ok: true, ...reply.fields });
      reply.after?.();
    } catch (err: unknown) {
      if (err instanceof LocalError) {
        this.#refuse(open, ref, err.code, err.message);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logEvent("operator_door.failed", { op, message });
      this.#refuse(open, ref, "internal_error", `That failed inside CELLO: ${message}`);
    }
  }

  #hello(open: Open, ref: unknown, request: Record<string, unknown>): void {
    const theirs = request["protocol"];
    if (theirs !== OPERATOR_PROTOCOL) {
      this.#refuse(open, ref, "protocol_mismatch", `This widget speaks version ${String(theirs)} of the operator protocol and CELLO here speaks ${OPERATOR_PROTOCOL}. Update ${typeof theirs === "number" && theirs > OPERATOR_PROTOCOL ? "CELLO on this machine" : "the CELLO widget for Mac"} so they match. Nothing else was done.`);
      open.socket.end();
      return;
    }
    open.helloed = true;
    open.send({ op: "result", ...(ref === undefined ? {} : { ref }), ok: true, protocol: OPERATOR_PROTOCOL });
  }

  #refuse(open: Open, ref: unknown, error: string, message: string): void {
    open.send({ op: "result", ...(ref === undefined ? {} : { ref }), ok: false, error, message });
  }
}

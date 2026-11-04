import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { IpcNotification, IpcRequest, IpcResponse } from "./protocol.ts";

export class DaemonRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DaemonRefused";
    this.code = code;
  }
}

export class DaemonGone extends Error {
  readonly code = "daemon_not_running";
  constructor() {
    super("the daemon isn't running. Run: cello-v2 login");
    this.name = "DaemonGone";
  }
}

export class IpcClient {
  readonly #socket: Socket;
  readonly #waiting = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
  #nextId = 1;
  onNotification: (frame: IpcNotification) => void = () => undefined;
  onClose: () => void = () => undefined;

  private constructor(socket: Socket) {
    this.#socket = socket;
    createInterface({ input: socket }).on("line", (line) => {
      const frame = JSON.parse(line) as IpcResponse | IpcNotification;
      if ("notification" in frame) {
        this.onNotification(frame);
        return;
      }
      const waiter = this.#waiting.get(frame.id);
      this.#waiting.delete(frame.id);
      if (frame.ok) waiter?.resolve(frame.result);
      else waiter?.reject(new DaemonRefused(frame.error.code, frame.error.message));
    });
    socket.on("close", () => {
      for (const waiter of this.#waiting.values()) waiter.reject(new DaemonGone());
      this.#waiting.clear();
      this.onClose();
    });
    socket.on("error", () => undefined);
  }

  static connect(path: string): Promise<IpcClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => {
        socket.removeAllListeners("error");
        resolve(new IpcClient(socket));
      });
      socket.once("error", () => reject(new DaemonGone()));
    });
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextId++;
    const request: IpcRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      if (this.#socket.destroyed) {
        reject(new DaemonGone());
        return;
      }
      this.#waiting.set(id, { resolve, reject });
      this.#socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  close(): void {
    this.#socket.destroy();
  }
}

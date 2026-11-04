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

// A wedged daemon mustn't hang a tool forever. It outlasts every wait the daemon has of its own.
const CALL_TIMEOUT_MS = 90_000;

export class IpcClient {
  readonly #socket: Socket;
  readonly #waiting = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
  #nextId = 1;
  onNotification: (frame: IpcNotification) => void = () => undefined;
  onClose: () => void = () => undefined;

  private constructor(socket: Socket) {
    this.#socket = socket;
    createInterface({ input: socket }).on("line", (line) => {
      let frame: IpcResponse | IpcNotification;
      try {
        frame = JSON.parse(line) as IpcResponse | IpcNotification;
      } catch {
        // A daemon killed part way through a line. This is the call being cut off, so the close below reports it.
        socket.destroy();
        return;
      }
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
      // The daemon may have saved this call before it stopped, so a send cut off here can still land by itself.
      for (const waiter of this.#waiting.values()) waiter.reject(new DaemonRefused("daemon_stopped_during_call", "the daemon stopped during this call, so it may still take effect. A message may go out by itself after the next login: check the transcript before sending it again."));
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

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const id = this.#nextId++;
    const request: IpcRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      if (this.#socket.destroyed) {
        reject(new DaemonGone());
        return;
      }
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new DaemonRefused("daemon_no_answer", `the daemon didn't answer ${method} within ${timeoutMs / 1000} seconds, so its outcome is unknown`));
      }, timeoutMs);
      this.#waiting.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(err) { clearTimeout(timer); reject(err); },
      });
      this.#socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  close(): void {
    this.#socket.destroy();
  }
}

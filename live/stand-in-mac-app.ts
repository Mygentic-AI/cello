// Plays the CELLO app on a Mac: it connects to the operator's door, one JSON object a line, and does what the person would
// do there. It keeps every frame it was sent, so a test can wait for one and check it.
import { randomBytes } from "node:crypto";
import { type Socket, createConnection } from "node:net";
import { createInterface } from "node:readline";

export type Frame = Record<string, unknown>;

export class StandInMacApp {
  readonly frames: Frame[] = [];
  readonly #socket: Socket;
  readonly #waiters = new Set<() => void>();
  // Says each notification is on screen as it arrives, as the app does once it has shown a banner.
  autoAck = false;
  #ended = false;

  private constructor(socket: Socket) {
    this.#socket = socket;
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
      const frame = JSON.parse(line) as Frame;
      this.frames.push(frame);
      if (this.autoAck && frame["op"] === "notification") this.send({ op: "ack", id: frame["id"] });
      for (const wake of [...this.#waiters]) wake();
    });
    socket.on("close", () => {
      this.#ended = true;
      for (const wake of [...this.#waiters]) wake();
    });
    socket.on("error", () => undefined);
  }

  static connect(path: string): Promise<StandInMacApp> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => resolve(new StandInMacApp(socket)));
      socket.once("error", reject);
    });
  }

  // Connects, says hello with the protocol given, and subscribes.
  static async open(path: string, protocol = 1): Promise<{ app: StandInMacApp; subscribed: Frame }> {
    const app = await StandInMacApp.connect(path);
    const hello = await app.request({ op: "hello", protocol });
    if (hello["ok"] !== true) throw new Error(`hello was refused: ${JSON.stringify(hello)}`);
    return { app, subscribed: await app.request({ op: "subscribe" }) };
  }

  get ended(): boolean {
    return this.#ended;
  }

  // A raw line, which need not be JSON or anything the door takes.
  write(line: string): void {
    this.#socket.write(`${line}\n`);
  }

  send(frame: Frame): void {
    this.write(JSON.stringify(frame));
  }

  // Sends with a fresh ref, unless it has one, and waits for the answer that carries it.
  async request(frame: Frame, timeoutMs = 10_000): Promise<Frame> {
    const ref = typeof frame["ref"] === "string" ? frame["ref"] : `ref-${randomBytes(6).toString("hex")}`;
    const before = this.frames.length;
    this.send({ ...frame, ref });
    return this.waitFor((f) => f["op"] === "result" && f["ref"] === ref, `the answer to ${String(frame["op"] ?? frame["method"])}`, timeoutMs, before);
  }

  // Waits for a frame that matches, looking from frame number `from` on.
  waitFor(match: (frame: Frame) => boolean, what: string, timeoutMs = 10_000, from = 0): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const found = this.frames.slice(from).find(match);
        if (!found) return false;
        finish();
        resolve(found);
        return true;
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`timed out waiting for ${what}. Frames: ${JSON.stringify(this.frames.slice(from))}`));
      }, timeoutMs);
      const wake = (): void => {
        if (!check() && this.#ended) {
          finish();
          reject(new Error(`the door closed while waiting for ${what}. Frames: ${JSON.stringify(this.frames.slice(from))}`));
        }
      };
      const finish = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(wake);
      };
      this.#waiters.add(wake);
      wake();
    });
  }

  // Waits until the daemon closes the connection.
  closedByDaemon(timeoutMs = 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.#ended) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error("the door stayed open")), timeoutMs);
      this.#socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#ended) {
        resolve();
        return;
      }
      this.#socket.once("close", () => resolve());
      this.#socket.end();
    });
  }
}

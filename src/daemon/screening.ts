// Decides what the screening thread does next. Everything durable is in the entries table: this holds only what's in flight,
// and it's rebuilt from that table after any restart. The worker does one step when asked, which is what makes a short
// message wait at most one step, about one model window.
import { extname } from "node:path";
import { Worker } from "node:worker_threads";
import type { InboundVerdict } from "../screener/inbound.ts";
import type { OutboundVerdict } from "../screener/outbound.ts";
import { logEvent } from "./log.ts";
import type { Settings } from "./settings.ts";

export type ScreeningLevel = "full" | "deterministic" | "off";
export interface LanguageGuard { enforce: boolean; allow: string[] }
export interface PiiGuard { whitelist: string[]; email: boolean; phone: boolean }

const TELL_CHECK_MS = 1_000;
const RESTART_BASE_MS = 500;
const RESTART_MAX_MS = 30_000;
const OUTBOUND_LIMIT_MS = 30_000;
// Steps in a screen besides model windows: the sanitizer, one for each scan variant, and the verdict.
const FIXED_STEPS = 24;
const WINDOW_BYTES_GUESS = 8_000;

export interface ScreenJob {
  entryId: number;
  agentHex: string;
  sessionHex: string;
  position: number;
  senderHex: string;
  bytes: number;
  arrived: number;
  // A channel's title or body, which has no entry to read back. sessionHex then names the channel and the part.
  channelText?: { bytes: Uint8Array; done(verdict: InboundVerdict): void };
}

interface Running extends ScreenJob {
  id: number;
  lane: "short" | "long";
  started: boolean;
  // A screen in progress lives in one thread, so it stays with that thread.
  slot: Slot | undefined;
  steps: number;
  windows: number | null;
  attempts: number;
  told: boolean;
}

export interface ModelFact { state: string; running: boolean; backend: string | null; reason: string | null }

export interface ScreeningEvents {
  // The body and the level are read only when a screen starts, so a long queue holds no text in memory.
  load(job: ScreenJob): { body: Uint8Array; level: ScreeningLevel; language: LanguageGuard } | null;
  verdict(job: ScreenJob, verdict: InboundVerdict): void;
  delayed(job: ScreenJob, aboutSeconds: number): void;
  workerCrashed(message: string, waiting: number): void;
  modelChecked(model: ModelFact): void;
}

const workerUrl = (): URL => new URL(`../screener/worker${extname(new URL(import.meta.url).pathname)}`, import.meta.url);

const NOT_SCREENED: InboundVerdict["ran"] = { deterministic: false, model: false, model_failed_copies: 0 };

export class ScreeningQueue {
  readonly #events: ScreeningEvents;
  // Oldest first, per conversation. Only the head may run, so order within a conversation can't change.
  readonly #sessions = new Map<string, Running[]>();
  // Whose turn is next, per lane. Keyed by the sender's id, because a limit per session is one a stranger opens more sessions to escape.
  readonly #lastSender: Record<"short" | "long", string> = { short: "", long: "" };
  readonly #slots: Slot[] = [];
  readonly settings: Settings;
  #nextId = 1;
  #tellTimer: NodeJS.Timeout | undefined;
  #msPerStep = 5;
  #stopped = false;
  restarts = 0;
  lastCrash: string | null = null;
  model: ModelFact | null = null;

  constructor(events: ScreeningEvents, settings: Settings) {
    this.#events = events;
    this.settings = settings;
    // One thread by default. More are a setting, and only the owner of a machine can say what it can afford.
    for (let i = 0; i < settings.screener_workers; i++) this.#slots.push(new Slot(this));
  }

  onModel(model: ModelFact): void {
    this.model = model;
    this.#events.modelChecked(model);
  }

  start(): void {
    for (const slot of this.#slots) slot.spawn();
    this.#tellTimer = setInterval(() => this.#tellDelays(), TELL_CHECK_MS);
    this.#tellTimer.unref();
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#tellTimer);
    for (const slot of this.#slots) slot.stop();
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  add(job: ScreenJob): void {
    const key = job.agentHex + job.sessionHex;
    const queue = this.#sessions.get(key) ?? [];
    if (queue.some((queued) => queued.entryId === job.entryId)) return;
    // Measuring costs a whole tokenizer run, so only what might be short gets it. A wrong guess only delays that one message.
    queue.push({ ...job, id: this.#nextId++, lane: job.bytes <= this.settings.screener_measure_max_bytes ? "short" : "long", started: false, slot: undefined, steps: 0, windows: null, attempts: 0, told: false });
    this.#sessions.set(key, queue);
    this.pump();
  }

  // Takes the worker down and up again, to pick up a newly installed model. Work in flight starts over.
  reload(): void {
    for (const queue of this.#sessions.values()) for (const job of queue) job.started = false;
    for (const slot of this.#slots) {
      slot.stop();
      slot.spawn();
    }
  }

  pending(): { short: number; long: number } {
    const counts = { short: 0, long: 0 };
    for (const queue of this.#sessions.values()) for (const job of queue) counts[job.lane]++;
    return counts;
  }

  // Which position is being waited on in this conversation, and roughly how long until it's done. Null when nothing is.
  waiting(agentHex: string, sessionHex: string): { position: number; about_seconds: number } | null {
    const head = this.#sessions.get(agentHex + sessionHex)?.[0];
    return head ? { position: head.position, about_seconds: this.#estimateSeconds(head) } : null;
  }

  #remainingSteps(job: Running): number {
    const windows = job.windows ?? (this.model?.running ? Math.ceil(job.bytes / WINDOW_BYTES_GUESS) : 0);
    return Math.max(1, FIXED_STEPS + windows - job.steps);
  }

  // Its own steps, what's ahead of it in its conversation, and the other long messages it takes turns with. Rough by design.
  #estimateSeconds(job: Running): number {
    let steps = 0;
    for (const queue of this.#sessions.values()) {
      for (const other of queue) {
        const ahead = queue[0]?.agentHex === job.agentHex && queue[0].sessionHex === job.sessionHex;
        if ((ahead && other.position <= job.position) || (!ahead && other.lane === "long")) steps += this.#remainingSteps(other);
      }
    }
    return Math.max(1, Math.ceil(steps * this.#msPerStep / 1000));
  }

  #tellDelays(): void {
    const now = Date.now();
    for (const queue of this.#sessions.values()) {
      const head = queue[0];
      if (!head || head.told || now - head.arrived < this.settings.screener_tell_after_ms) continue;
      head.told = true;
      this.#events.delayed(head, this.#estimateSeconds(head));
    }
  }

  // The next conversation head in this lane, taking turns across senders.
  #pick(lane: "short" | "long", slot: Slot): Running | undefined {
    const bySender = new Map<string, Running>();
    for (const queue of this.#sessions.values()) {
      const head = queue[0];
      if (!head || head.lane !== lane || bySender.has(head.senderHex) || !this.#free(head, slot)) continue;
      bySender.set(head.senderHex, head);
    }
    if (bySender.size === 0) return undefined;
    const senders = [...bySender.keys()].sort();
    const next = senders.find((sender) => sender > this.#lastSender[lane]) ?? (senders[0] as string);
    this.#lastSender[lane] = next;
    return bySender.get(next);
  }

  #free(job: Running, slot: Slot): boolean {
    return !this.#slots.some((other) => other.job === job) && (!job.started || job.slot === slot);
  }

  #longInProgress(slot: Slot): Running | undefined {
    for (const queue of this.#sessions.values()) {
      const head = queue[0];
      if (head?.lane === "long" && head.started && this.#free(head, slot)) return head;
    }
    return undefined;
  }

  // Short work goes first, one step at a time. The long lane runs one message at a time, whichever turn it took.
  pump(): void {
    if (this.#stopped) return;
    for (const slot of this.#slots) {
      if (!slot.ready || slot.job) continue;
      const job = this.#pick("short", slot) ?? this.#longInProgress(slot) ?? this.#pick("long", slot);
      if (job) this.#run(slot, job);
    }
  }

  #run(slot: Slot, job: Running): void {
    if (job.started) {
      slot.step(job);
      return;
    }
    const loaded = this.#events.load(job);
    if (!loaded) {
      this.#finish(job);
      this.pump();
      return;
    }
    if (loaded.level === "off") {
      this.#finish(job);
      this.#events.verdict(job, { verdict: "allow", delivered: null, findings: [], reason: "its owner turned screening off for this sender", score: null, ran: NOT_SCREENED });
      this.pump();
      return;
    }
    job.started = true;
    job.slot = slot;
    slot.start(job, loaded.body, loaded.level, loaded.language);
  }

  #finish(job: Running): void {
    const key = job.agentHex + job.sessionHex;
    const queue = this.#sessions.get(key);
    if (!queue) return;
    const at = queue.indexOf(job);
    if (at >= 0) queue.splice(at, 1);
    if (queue.length === 0) this.#sessions.delete(key);
  }

  onStepped(job: Running, measured: number | undefined, ms: number): void {
    job.steps++;
    this.#msPerStep = this.#msPerStep * 0.9 + ms * 0.1;
    if (measured !== undefined) {
      job.windows = measured;
      job.lane = measured <= this.settings.screener_short_max_windows ? "short" : "long";
    }
    this.pump();
  }

  onDone(job: Running, verdict: InboundVerdict): void {
    this.#finish(job);
    this.#events.verdict(job, verdict);
    this.pump();
  }

  #giveUp(job: Running, message: string): void {
    // A message that stops the screen every time stays undelivered, and mustn't hold up its conversation for good.
    this.#finish(job);
    logEvent("screening.gave_up", { agent: job.agentHex, session: job.sessionHex, position: job.position, message });
    this.#events.verdict(job, { verdict: "blocked", delivered: null, findings: [], reason: `the screen failed on it ${this.settings.screener_max_attempts} times, so it wasn't delivered`, score: null, ran: NOT_SCREENED });
  }

  onFailed(job: Running, message: string): void {
    job.started = false;
    job.attempts++;
    if (job.attempts >= this.settings.screener_max_attempts) this.#giveUp(job, message);
    this.pump();
  }

  onCrash(slot: Slot, message: string): void {
    const job = slot.job;
    this.restarts++;
    this.lastCrash = message;
    logEvent("screening.worker_crashed", { message, restarts: this.restarts });
    // Only what lived in this thread starts over. Another thread's screens carry on.
    for (const queue of this.#sessions.values()) for (const queued of queue) if (queued.slot === slot) queued.started = false;
    if (job) {
      job.attempts++;
      if (job.attempts >= this.settings.screener_max_attempts) this.#giveUp(job, message);
    }
    const counts = this.pending();
    this.#events.workerCrashed(message, counts.short + counts.long);
    setTimeout(() => {
      if (!this.#stopped) slot.spawn();
    }, Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.min(this.restarts, 10))).unref();
  }
}

type WorkerReply =
  | { type: "ready"; model: ModelFact }
  | { type: "stepped"; id: number; measured?: number }
  | { type: "done"; id: number; verdict: InboundVerdict }
  | { type: "failed"; id: number; message: string };

class Slot {
  readonly #queue: ScreeningQueue;
  #worker: Worker | undefined;
  #sentAt = 0;
  ready = false;
  job: Running | undefined;

  constructor(queue: ScreeningQueue) {
    this.#queue = queue;
  }

  spawn(): void {
    const { screener_model_threads: modelThreads, screener_worker_memory_mb: memory } = this.#queue.settings;
    const worker = new Worker(workerUrl(), { workerData: { role: "inbound", modelThreads }, resourceLimits: { maxOldGenerationSizeMb: memory } });
    this.#worker = worker;
    this.ready = false;
    this.job = undefined;
    worker.on("message", (reply: WorkerReply) => this.#onReply(reply));
    const lost = (message: string): void => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      this.ready = false;
      const failed = this.job;
      this.#queue.onCrash(this, message);
      if (this.job === failed) this.job = undefined;
    };
    worker.on("error", (err: unknown) => lost(err instanceof Error ? err.message : String(err)));
    worker.on("exit", (code) => lost(`the screening thread exited with code ${code}`));
  }

  stop(): void {
    const worker = this.#worker;
    this.#worker = undefined;
    this.ready = false;
    this.job = undefined;
    void worker?.terminate();
  }

  start(job: Running, body: Uint8Array, level: "full" | "deterministic", language: LanguageGuard): void {
    this.job = job;
    this.#sentAt = performance.now();
    this.#worker?.postMessage({ type: "start", id: job.id, body, level, language });
  }

  step(job: Running): void {
    this.job = job;
    this.#sentAt = performance.now();
    this.#worker?.postMessage({ type: "step", id: job.id });
  }

  #onReply(reply: WorkerReply): void {
    if (reply.type === "ready") {
      this.#queue.onModel(reply.model);
      this.ready = true;
      logEvent("screening.worker_ready", { model: reply.model.state, running: reply.model.running, backend: reply.model.backend });
      this.#queue.pump();
      return;
    }
    const job = this.job;
    // A reply from before a restart names a job this thread no longer holds.
    if (!job || job.id !== reply.id) return;
    this.job = undefined;
    if (reply.type === "stepped") this.#queue.onStepped(job, reply.measured, performance.now() - this.#sentAt);
    else if (reply.type === "done") this.#queue.onDone(job, reply.verdict);
    else this.#queue.onFailed(job, reply.message);
  }
}

// Outbound never runs the model, so it has a thread of its own, and a send never waits behind a long inbound screen.
export class OutboundScreen {
  readonly #calls = new Map<number, { resolve(verdict: OutboundVerdict): void; reject(err: Error): void; timer: NodeJS.Timeout }>();
  #worker: Worker | undefined;
  #nextId = 1;
  #stopped = false;

  start(): void {
    const worker = new Worker(workerUrl(), { workerData: { role: "outbound" } });
    this.#worker = worker;
    worker.on("message", (reply: { type: string; id?: number; verdict?: OutboundVerdict; message?: string }) => {
      const call = reply.id === undefined ? undefined : this.#calls.get(reply.id);
      if (!call) return;
      this.#calls.delete(reply.id as number);
      clearTimeout(call.timer);
      if (reply.verdict) call.resolve(reply.verdict);
      else call.reject(new Error(reply.message ?? "the outbound screen failed"));
    });
    const lost = (message: string): void => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      logEvent("screening.outbound_worker_crashed", { message });
      for (const call of this.#calls.values()) {
        clearTimeout(call.timer);
        call.reject(new Error(message));
      }
      this.#calls.clear();
      if (!this.#stopped) setTimeout(() => { if (!this.#stopped) this.start(); }, RESTART_BASE_MS).unref();
    };
    worker.on("error", (err: unknown) => lost(err instanceof Error ? err.message : String(err)));
    worker.on("exit", (code) => lost(`the outbound screening thread exited with code ${code}`));
  }

  stop(): void {
    this.#stopped = true;
    const worker = this.#worker;
    this.#worker = undefined;
    void worker?.terminate();
  }

  screen(text: string, keys: readonly string[], pii: PiiGuard): Promise<OutboundVerdict> {
    return new Promise((resolve, reject) => {
      const worker = this.#worker;
      if (!worker) {
        reject(new Error("the outbound screening thread isn't running"));
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#calls.delete(id);
        reject(new Error(`the outbound screen took longer than ${OUTBOUND_LIMIT_MS / 1000} seconds`));
      }, OUTBOUND_LIMIT_MS);
      this.#calls.set(id, { resolve, reject, timer });
      worker.postMessage({ type: "outbound", id, text, keys, pii });
    });
  }
}

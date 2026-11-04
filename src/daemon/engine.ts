// The owner's node: keys, conversations and recovery. Durable state decides everything.
// After any restart, the same catch-up path runs: resend what's pending, then read from position.
import { randomBytes } from "node:crypto";
import { openSessionContent, sealSessionContent } from "../protocol/aead.ts";
import { ChainVerifier, type ChainFault, type WitnessedEntry, verifyTranscript } from "../protocol/chain.ts";
import { ZERO_HASH, equalBytes, toHex } from "../protocol/encode.ts";
import { type PublicIdentity, type Signer, generateIdentitySeeds, identityId, signerFromSeeds, verifySignature } from "../protocol/identity.ts";
import { deriveSessionSecrets, destroySessionEphemeral, generateSessionEphemeral } from "../protocol/key-agreement.ts";
import { verifyConsistency } from "../protocol/merkle.ts";
import { mlKemDecapsulate, mlKemEncapsulate } from "../protocol/ml-kem.ts";
import { deriveSessionSalt, generateSaltContribution, saltedContentHash } from "../protocol/salt.ts";
import { type SealRecord, type SealRecordOnWire, checkSealRecord, decodeSealRecord, describeSeal, sealId, sealSummary } from "../protocol/seal.ts";
import { buildTranscript } from "../protocol/transcript.ts";
import {
  type AssignmentFields,
  EntryKind,
  EntryMode,
  type EntryFields,
  acceptBytes,
  agentAuthBytes,
  assignmentBytes,
  ciphertextHash,
  confirmBytes,
  deliveryAckBytes,
  entryBytes,
  entryHash,
  offerBytes,
  registerBytes,
  sealRequestBytes,
  structureHash,
} from "../protocol/structures.ts";
import {
  MAX_CIPHERTEXT_BYTES,
  type PushFrame,
  type SessionOnWire,
  type Signed,
  type WireSigned,
  type WitnessedOnWire,
  fromB64,
  identityCodec,
  signatureCodec,
  signedAccept,
  signedAck,
  signedAssignment,
  signedConfirm,
  signedDeliveryAck,
  signedEntry,
  signedOffer,
  signedSealRequest,
  toB64,
} from "../protocol/wire.ts";
import { LocalError, requirePerson } from "./errors.ts";
import { Governance } from "./governance.ts";
import { type ConnectedServer, ServerLink, ServerRefused, ServerUnreachable } from "./link.ts";
import { logEvent } from "./log.ts";
import { OutboundRateLimiter } from "./rate-limit.ts";
import { type LanguageGuard, type ModelFact, OutboundScreen, type ScreenJob, type ScreeningLevel, ScreeningQueue } from "./screening.ts";
import { type Settings, loadSettings } from "./settings.ts";
import { tierName } from "./tiers.ts";
import type { EntryRow, SessionRow, Store } from "./store.ts";
import type { InboundVerdict } from "../screener/inbound.ts";

const SEND_WINDOW_MS = 10 * 60 * 1000;
const INITIATE_WAIT_MS = 20_000;
const POSITION_CHECK_MS = 30_000;
const AUTH_RETRY_MS = 5_000;
// One reply's message text. Replies are built whole on the one thread every agent shares, and a string can't pass about 512 MB.
const MAX_REPLY_BYTES = 8_000_000;
const CONFIG_SERVER_URL = "server_url";
const CONFIG_SERVER_IDENTITY = "server_identity";
const CONFIG_SEAL_KEY = "seal_key";
const CONFIG_SEAL_LOG_HEAD = "seal_log_head";
const SEAL_EVERYTHING_HELD = 0;
// Not refusals of the seal itself: the first means this agent's login hasn't finished, the second that the server failed.
const SEAL_RETRY_CODES: readonly string[] = ["not_authenticated", "internal_error"];
// A timer can stop counting while a machine sleeps, so no wait outlasts this before the clock is read again.
const STANDBY_CHECK_MAX_MS = 60_000;
const LATEST_DATE_MS = 8.64e15;
// How long a run of verdicts is left to settle before the sender is told how far screening has got.
const SCREENED_ACK_DELAY_MS = 1_000;
const SENDER_BACKLOG_CHECK_MS = 250;
const CONFIG_MODEL_EVER_RAN = "screener_model_ever_ran";
const MODEL_MISSING = "This agent's database used the screening model, and the model isn't installed on this machine, so only the deterministic rules are running. To add it, a person runs: cello-v2 screener install";
const WORKER_CRASH_TELL_EVERY_MS = 60_000;
const SIGNAL_VALUES: readonly unknown[] = ["over", "standby", "wrap"];
const BYTE_LIMIT_REASON = "this conversation is past its byte limit";

export { LocalError };

export const SIGNALS = ["over", "standby", "wrap"] as const;
export type Signal = (typeof SIGNALS)[number];

export interface Doorbell {
  type: "session_started" | "message" | "peer_closed" | "session_closed" | "notice" | "standby_overdue" | "screening_delayed";
  // Your own operator's admission policy for this caller. It's the one place a doorbell carries text, and no other party wrote it.
  policy?: unknown;
  policy_error?: string;
  agent: string;
  session_id?: string;
  from_id?: string;
  position?: number;
  about_seconds?: number;
}

interface VerdictDetail {
  delivered: string | null;
  findings: InboundVerdict["findings"];
  reason: string | null;
  score: number | null;
  ran: InboundVerdict["ran"];
}

// Everything an agent is shown of a message. A signal or a number is only passed on if it's a value CELLO itself writes,
// because the text is the only part that's screened, and a hostile sender could put words in any other field.
function shownMessage(row: EntryRow, closing: boolean): Record<string, unknown> {
  const body = parseBody(row.body);
  const estMinutes = typeof body?.est_minutes === "number" && body.est_minutes > 0 ? { est_minutes: body.est_minutes } : {};
  if (row.own === 1) {
    return closing ? { closed_their_side: true } : { text: body?.text ?? null, signal: body?.signal ?? null, ...estMinutes };
  }
  if (row.verdict === null) return { screening: { verdict: "not_screened_yet" } };
  const detail = JSON.parse(row.verdict_detail as string) as VerdictDetail;
  const screening = { verdict: row.verdict, findings: detail.findings, ...(detail.score === null ? {} : { score: detail.score }), ...(detail.reason ? { reason: detail.reason } : {}), ran: detail.ran };
  if (row.verdict === "blocked") return { blocked: true, screening };
  if (closing) return { closed_their_side: true };
  const signal = SIGNAL_VALUES.includes(body?.signal) ? body?.signal : null;
  return { text: body ? (detail.delivered ?? body.text) : null, signal, ...estMinutes, ...(body ? {} : { unreadable: true }), screening };
}

interface AgentContext {
  signer: Signer;
  hex: string;
  name: string;
  registered: boolean;
  online: boolean;
}

interface Body {
  n: string;
  text: string;
  signal: Signal | null;
  est_minutes: number | null;
}

function parseHex(value: unknown, bytes: number, name: string): Uint8Array {
  if (typeof value !== "string" || value.length !== bytes * 2 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new LocalError("bad_argument", `${name} must be ${bytes * 2} hex characters`);
  }
  return new Uint8Array(Buffer.from(value, "hex"));
}

function parseBody(bytes: Uint8Array): Body | null {
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as Body;
    if (typeof body.text !== "string") return null;
    return body;
  } catch {
    return null;
  }
}

interface OpenStandby {
  by: "you" | "other_side";
  position: number;
  due: number;
}

// Both daemons start from the server's ack time, so they agree on the due time. Each compares it with its own clock,
// so a clock that's wrong by a minute tells a minute early or late, and changes nothing else.
// The minutes can come from the other party, so anything that isn't a usable time counts as no time.
function standbyDue(estMinutes: unknown, ackTime: number): number | undefined {
  if (typeof estMinutes !== "number" || !(estMinutes > 0)) return undefined;
  const due = Math.ceil(ackTime + estMinutes * 60_000);
  return due <= LATEST_DATE_MS ? due : undefined;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

type AttemptOutcome =
  | { status: "landed"; position: number }
  | { status: "pending" }
  | { status: "refused"; code: string; message: string };

export interface EngineEvents {
  ring(agentHex: string, bell: Doorbell): void;
}

function notSealedYet(reason: string): unknown {
  return { sealed: false, status: "not_sealed_yet", message: `This isn't sealed yet: ${reason}. The request is saved and retried by itself, and you'll get a notice.` };
}

export class Engine {
  readonly #store: Store;
  readonly #events: EngineEvents;
  readonly #link: ServerLink;
  readonly #url: string;
  readonly #agents = new Map<string, AgentContext>();
  readonly #lanes = new Map<string, Promise<unknown>>();
  readonly #verifiers = new Map<string, ChainVerifier>();
  readonly #activation = new Map<string, () => void>();
  #server: ConnectedServer | undefined;
  #positionCheck: NodeJS.Timeout | undefined;
  #standbyCheck: NodeJS.Timeout | undefined;
  #standbyCheckAt = 0;
  readonly #settings: Settings;
  readonly #screening: ScreeningQueue;
  readonly #outbound = new OutboundScreen();
  readonly #ackTimers = new Map<string, NodeJS.Timeout>();
  readonly #rates = new Map<string, { max: number; window: number; limiter: OutboundRateLimiter }>();
  readonly governance: Governance;
  #lastCrashTold = 0;
  #modelMissingTold = false;

  constructor(store: Store, url: string, events: EngineEvents) {
    this.#store = store;
    this.#events = events;
    this.#url = url;
    this.#settings = loadSettings(store);
    this.governance = new Governance(store, {
      notify: (agentId, text) => {
        const agent = this.#agents.get(toHex(agentId));
        if (agent) this.#notify(agent, null, text);
      },
      isLocalAgent: (id) => this.#agents.has(toHex(id)),
    });
    this.#screening = new ScreeningQueue({
      load: (job) => this.#loadForScreen(job),
      verdict: (job, verdict) => this.#onVerdict(job, verdict),
      delayed: (job, aboutSeconds) => this.#onScreenDelayed(job, aboutSeconds),
      workerCrashed: (message, waiting) => this.#onWorkerCrashed(message, waiting),
      modelChecked: (model) => this.#onModelChecked(model),
    }, this.#settings);
    this.#link = new ServerLink(url, {
      checkIdentity: (identity) => this.#checkServerIdentity(identity),
      connected: async (server) => {
        this.#server = server;
        for (const agent of this.#agents.values()) void this.#bringOnline(agent, server);
      },
      disconnected: () => {
        this.#server = undefined;
        for (const agent of this.#agents.values()) agent.online = false;
      },
      push: (frame) => this.#onPush(frame),
    });
  }

  async start(): Promise<void> {
    const pinned = this.#store.getConfig(CONFIG_SERVER_URL);
    if (pinned && pinned !== this.#url) throw new LocalError("server_changed", `this data belongs to ${pinned}, not ${this.#url}. Use a separate CELLO_V2_HOME.`);
    this.#store.setConfig(CONFIG_SERVER_URL, this.#url);
    for (const row of this.#store.agents()) {
      const signer = await signerFromSeeds({ ed: row.ed_seed, pq: row.pq_seed });
      this.#agents.set(toHex(signer.id), { signer, hex: toHex(signer.id), name: row.name, registered: row.registered === 1, online: false });
      this.governance.writeDefaults(signer.id);
    }
    this.#checkStandbys();
    this.#screening.start();
    this.#outbound.start();
    // A restart repeats no finished work: whatever had no verdict is simply still in the table.
    for (const row of this.#store.unscreened()) {
      this.#screening.add({ entryId: row.id, agentHex: toHex(row.agent_id), sessionHex: toHex(row.session_id), position: row.position as number, senderHex: toHex(row.sender), bytes: row.size, arrived: Date.now() });
    }
    this.#link.start();
    // Pushes are hints. This catches a lost one, so it costs seconds rather than a conversation.
    this.#positionCheck = setInterval(() => {
      for (const agent of this.#agents.values()) if (agent.online) void this.#catchUpAgent(agent);
    }, POSITION_CHECK_MS);
  }

  stop(): void {
    clearInterval(this.#positionCheck);
    clearTimeout(this.#standbyCheck);
    for (const timer of this.#ackTimers.values()) clearTimeout(timer);
    this.#screening.stop();
    this.#outbound.stop();
    this.#link.stop();
  }

  // ---- Screening. A verdict goes on the entry, and it's the only thing that makes a message deliverable. ----

  #loadForScreen(job: ScreenJob): { body: Uint8Array; level: ScreeningLevel; language: LanguageGuard } | null {
    const body = this.#store.bodyOf(job.entryId);
    const agent = this.#agents.get(job.agentHex);
    if (!body || !agent) return null;
    const language = { enforce: this.governance.guards.value<boolean>(agent.signer.id, "language_enforce"), allow: this.governance.guards.value<string[]>(agent.signer.id, "language_allow") };
    return { body, level: this.governance.screeningRule(agent.signer.id, job.senderHex).level, language };
  }

  // The doorbell comes after the write, so anyone it wakes finds the message there.
  #onVerdict(job: ScreenJob, verdict: InboundVerdict): void {
    const agent = this.#agents.get(job.agentHex);
    if (!agent) return;
    const sessionId = parseHex(job.sessionHex, 16, "session id");
    const detail: VerdictDetail = { delivered: verdict.delivered, findings: verdict.findings, reason: verdict.reason, score: verdict.score, ran: verdict.ran };
    const row = this.#store.entryAt(agent.signer.id, sessionId, job.position);
    if (!row) return;
    const closing = signedEntry.decode(JSON.parse(row.entry)).fields.kind === EntryKind.close;
    this.#store.transaction(() => {
      this.#store.setVerdict(job.entryId, verdict.verdict, JSON.stringify(detail));
      if (verdict.verdict === "blocked") this.#store.addNotice(agent.signer.id, sessionId, `The message at position ${job.position} was not delivered: ${verdict.reason as string}.`);
    });
    logEvent("screening.verdict", { agent: job.agentHex, session: job.sessionHex, position: job.position, verdict: verdict.verdict, findings: verdict.findings.map((f) => f.what), score: verdict.score, ms: Date.now() - job.arrived });
    this.#events.ring(agent.hex, { type: closing ? "peer_closed" : "message", agent: agent.name, session_id: job.sessionHex, from_id: job.senderHex });
    this.#ackSoon(agent, job.sessionHex);
  }

  #onScreenDelayed(job: ScreenJob, aboutSeconds: number): void {
    const agent = this.#agents.get(job.agentHex);
    if (!agent) return;
    logEvent("screening.delayed", { agent: job.agentHex, session: job.sessionHex, position: job.position, about_seconds: aboutSeconds });
    this.#events.ring(agent.hex, { type: "screening_delayed", agent: agent.name, session_id: job.sessionHex, position: job.position, about_seconds: aboutSeconds });
    const sessionId = parseHex(job.sessionHex, 16, "session id");
    this.#background("screening delay ack", this.#lane(agent.hex, job.sessionHex, async () => {
      const local = this.#store.session(agent.signer.id, sessionId);
      if (local) await this.#deliver(agent, local, aboutSeconds);
    }));
  }

  // A database can move to a machine without the model. That's said plainly, once per start, rather than quietly running less.
  #onModelChecked(model: ModelFact): void {
    if (model.running) {
      this.#store.setConfig(CONFIG_MODEL_EVER_RAN, "1");
      return;
    }
    if (this.#store.getConfig(CONFIG_MODEL_EVER_RAN) !== "1" || this.#modelMissingTold) return;
    this.#modelMissingTold = true;
    logEvent("screening.model_missing", { state: model.state, reason: model.reason });
    for (const agent of this.#agents.values()) this.#notify(agent, null, MODEL_MISSING);
  }

  #onWorkerCrashed(message: string, waiting: number): void {
    const now = Date.now();
    if (now - this.#lastCrashTold < WORKER_CRASH_TELL_EVERY_MS) return;
    this.#lastCrashTold = now;
    const text = `The screening thread crashed and is restarting (${message}). Nothing unscreened was delivered, and ${waiting} message(s) are waiting for it.`;
    for (const agent of this.#agents.values()) {
      this.#store.addNotice(agent.signer.id, null, text);
      this.#events.ring(agent.hex, { type: "notice", agent: agent.name });
    }
  }

  // Sent when a run of verdicts settles, so a burst costs one signature, and it's retried by the next catch-up if it fails.
  #ackSoon(agent: AgentContext, sessionHex: string): void {
    const key = agent.hex + sessionHex;
    if (this.#ackTimers.has(key)) return;
    this.#ackTimers.set(key, setTimeout(() => {
      this.#ackTimers.delete(key);
      const sessionId = parseHex(sessionHex, 16, "session id");
      this.#background("screened ack", this.#lane(agent.hex, sessionHex, async () => {
        const local = this.#store.session(agent.signer.id, sessionId);
        if (local) await this.#deliver(agent, local);
      }));
    }, SCREENED_ACK_DELAY_MS));
  }

  // The highest position with nothing unscreened at or before it.
  #screenedThrough(agent: AgentContext, local: SessionRow): number {
    const first = this.#store.firstUnscreened(agent.signer.id, local.session_id);
    return first === undefined ? local.verified_position : first - 1;
  }

  screeningFacts(): unknown {
    const model = this.#screening.model;
    const missing = model !== null && !model.running && this.#store.getConfig(CONFIG_MODEL_EVER_RAN) === "1";
    return {
      deterministic: { running: model !== null, rules: model ? "sanitizing, variants and patterns" : "starting" },
      model: { ...(model ?? { state: "starting", running: false, backend: null, reason: null }), ...(missing ? { needs_installing: MODEL_MISSING } : {}) },
      worker: { restarts: this.#screening.restarts, last_crash: this.#screening.lastCrash },
      queue: this.#screening.pending(),
    };
  }

  reloadScreener(): unknown {
    this.#screening.reload();
    return { reloaded: true };
  }

  // Which screeners really run on what this sender writes, right now.
  #sessionScreening(agent: AgentContext, local: SessionRow): Record<string, unknown> {
    const rule = this.governance.screeningRule(agent.signer.id, toHex(local.counterparty_id));
    const modelRunning = this.#screening.model?.running === true;
    const screeners = rule.level === "off" ? [] : rule.level === "full" && modelRunning ? ["deterministic", "model"] : ["deterministic"];
    const waiting = this.#screening.waiting(agent.hex, toHex(local.session_id));
    return { level: rule.level, from: rule.from, screeners, ...(waiting ? { waiting_on: waiting } : {}) };
  }

  #checkServerIdentity(identity: PublicIdentity): string | null {
    const encoded = JSON.stringify(identityCodec.encode(identity));
    const pinned = this.#store.getConfig(CONFIG_SERVER_IDENTITY);
    if (!pinned) {
      this.#store.setConfig(CONFIG_SERVER_IDENTITY, encoded);
      return null;
    }
    return pinned === encoded ? null : "this server's identity keys have changed since first contact, so its signatures can't be trusted";
  }

  #serverIdentity(): PublicIdentity {
    const pinned = this.#store.getConfig(CONFIG_SERVER_IDENTITY);
    if (!pinned) throw new LocalError("server_unreachable", "this daemon hasn't reached its server yet");
    return identityCodec.decode(JSON.parse(pinned), "pinned server identity");
  }

  #serverId(): Uint8Array {
    return identityId(this.#serverIdentity());
  }

  // Runs work for one session one at a time, so order on disk matches order of arrival.
  #lane<T>(agentHex: string, sessionHex: string, work: () => Promise<T>): Promise<T> {
    const key = agentHex + sessionHex;
    const previous = this.#lanes.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.#lanes.set(key, run.catch(() => undefined));
    return run;
  }

  #background(what: string, work: Promise<unknown>): void {
    work.catch((err: unknown) => {
      if (err instanceof ServerUnreachable) {
        logEvent("server.unreachable_during", { what, message: err.message });
        return;
      }
      logEvent("background.failed", { what, message: err instanceof Error ? err.message : String(err) });
    });
  }

  async #bringOnline(agent: AgentContext, server: ConnectedServer): Promise<void> {
    try {
      if (!agent.registered) await this.#register(agent);
      while (this.#server === server) {
        try {
          const clientNonce = new Uint8Array(randomBytes(32));
          const proof = agentAuthBytes({ serverId: server.id, agentId: agent.signer.id, serverNonce: server.nonce, clientNonce });
          const signature = await agent.signer.sign("cello-v2-agent-auth", proof);
          await this.#link.call("auth", { agentId: toB64(agent.signer.id), clientNonce: toB64(clientNonce), signature: signatureCodec.encode(signature) });
          agent.online = true;
          logEvent("agent.online", { agent: agent.hex });
          await this.#catchUpAgent(agent);
          return;
        } catch (err: unknown) {
          // After an unclean drop, the server holds the old connection until its heartbeat ends it.
          if (!(err instanceof ServerRefused) || err.code !== "agent_already_connected") throw err;
          await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_MS));
        }
      }
    } catch (err: unknown) {
      logEvent("agent.bring_online_failed", { agent: agent.hex, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async #register(agent: AgentContext): Promise<void> {
    const identity = agent.signer.publicIdentity;
    const signature = await agent.signer.sign("cello-v2-register", registerBytes({ serverId: this.#serverId(), identity, name: agent.name }));
    await this.#link.call("register", { identity: identityCodec.encode(identity), name: agent.name, signature: signatureCodec.encode(signature) });
    this.#store.markRegistered(agent.signer.id);
    agent.registered = true;
    logEvent("agent.registered", { agent: agent.hex });
  }

  async #catchUpAgent(agent: AgentContext): Promise<void> {
    try {
      const listedAt = Date.now();
      const listed = await this.#link.call("session.list", { agent: toB64(agent.signer.id) }) as { sessions: SessionOnWire[] };
      const seen = new Set<string>();
      for (const wire of listed.sessions) {
        const sessionId = signedOffer.decode(wire.offer).fields.sessionId;
        const sessionHex = toHex(sessionId);
        seen.add(sessionHex);
        this.#background("session update", this.#lane(agent.hex, sessionHex, async () => {
          await this.#onSessionWire(agent, wire);
          this.#tellLatePeer(agent, sessionId, listedAt, wire.tip);
        }));
      }
      // An offer written to disk just before a crash may never have reached the server.
      for (const row of this.#store.sessionsOf(agent.signer.id)) {
        const sessionHex = toHex(row.session_id);
        if (seen.has(sessionHex) || row.state !== "offered") continue;
        this.#background("offer resend", this.#link.call("session.offer", { agent: toB64(agent.signer.id), offer: JSON.parse(row.offer) }));
      }
    } catch (err: unknown) {
      logEvent("agent.catch_up_failed", { agent: agent.hex, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Frames come from outside, and one bad frame mustn't take down every agent on this daemon.
  #onPush(frame: PushFrame): void {
    try {
      const agent = this.#agents.get(frame.agent);
      if (!agent) return;
      if (frame.push === "session") {
        const wire = frame.data as SessionOnWire;
        const sessionHex = toHex(signedOffer.decode(wire.offer).fields.sessionId);
        this.#background("session push", this.#lane(agent.hex, sessionHex, () => this.#onSessionWire(agent, wire)));
        return;
      }
      if (frame.push === "delivery") {
        const wire = (frame.data as { deliveryAck: WireSigned }).deliveryAck;
        const sessionHex = toHex(signedDeliveryAck.decode(wire, "deliveryAck").fields.sessionId);
        this.#background("delivery push", this.#lane(agent.hex, sessionHex, () => this.#onPeerDeliveryAck(agent, wire)));
        return;
      }
      const item = frame.data as WitnessedOnWire;
      const sessionHex = toHex(signedEntry.decode(item.entry).fields.sessionId);
      this.#background("entry push", this.#lane(agent.hex, sessionHex, () => this.#onEntryPush(agent, item)));
    } catch (err: unknown) {
      logEvent("server.bad_push", { kind: frame.push, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---- Session setup ----

  async #onSessionWire(agent: AgentContext, wire: SessionOnWire): Promise<void> {
    const offer = signedOffer.decode(wire.offer, "offer");
    const sessionId = offer.fields.sessionId;
    let local = this.#store.session(agent.signer.id, sessionId);
    if (!local) {
      if (!equalBytes(offer.fields.calleeId, agent.signer.id)) {
        logEvent("session.unknown_as_caller", { agent: agent.hex, session: toHex(sessionId) });
        return;
      }
      await this.#acceptOffer(agent, wire);
      return;
    }
    if (local.role === "caller") {
      if (local.state === "offered" && wire.accept) {
        await this.#answerAccept(agent, local, wire.accept);
        local = this.#store.session(agent.signer.id, sessionId) as SessionRow;
      }
      if (local.state === "accepted") await this.#finishAsCaller(agent, local, wire.assignment);
    } else if (local.state === "accepted") {
      if (!wire.accept) {
        await this.#link.call("session.accept", { agent: toB64(agent.signer.id), sessionId: toB64(sessionId), accept: JSON.parse(local.accept as string) });
      } else if (wire.confirm && wire.assignment) {
        await this.#finishAsCallee(agent, local, wire.confirm, wire.assignment);
      }
    }
    local = this.#store.session(agent.signer.id, sessionId) as SessionRow;
    if (local.state === "active" || local.state === "closed") {
      const hasWork = wire.tip > local.verified_position || this.#store.pendingEntries(agent.signer.id, sessionId).length > 0 || local.fault !== null || local.delivered_through < this.#latestFromPeer(agent, local) || (local.delivered_through > 0 && Math.min(this.#screenedThrough(agent, local), local.delivered_through) > local.acked_screened);
      if (hasWork) await this.#settle(agent, local);
      if (this.#store.sealWants(agent.signer.id, sessionId).length > 0) await this.#retrySeals(agent, sessionId);
    }
  }

  // Tiers and policy aren't in this iteration, so a daemon takes every validly signed call.
  async #acceptOffer(agent: AgentContext, wire: SessionOnWire): Promise<void> {
    const offer = signedOffer.decode(wire.offer, "offer");
    const fields = offer.fields;
    const callerKeys = identityCodec.decode(wire.callerIdentity, "callerIdentity");
    if (!equalBytes(identityId(callerKeys), fields.callerId)) throw new Error("the caller's keys don't match the caller's id");
    if (!equalBytes(fields.serverId, this.#serverId())) throw new Error("this offer names a different server");
    if (!(await verifySignature(callerKeys, "cello-v2-session-offer", offerBytes(fields), offer.signature))) throw new Error("this offer isn't signed by its caller");
    if (fields.expiresAt <= Date.now()) {
      logEvent("session.offer_expired", { session: toHex(fields.sessionId) });
      return;
    }

    const own = await generateSessionEphemeral();
    const { ciphertext, sharedSecret } = await mlKemEncapsulate(fields.mlKemPublic);
    const { contentKey } = deriveSessionSecrets({
      ownEphemeralSecret: own.secretKey,
      peerEphemeralPublic: fields.x25519Public,
      sessionId: fields.sessionId,
      extraSharedSecret: sharedSecret,
      pqTranscript: concat(ciphertext, fields.mlKemPublic),
    });
    const salt = generateSaltContribution();
    const acceptFields = {
      offerHash: structureHash(offerBytes(fields)),
      x25519Public: own.publicKey,
      mlKemCiphertext: ciphertext,
      sealedSalt: sealSessionContent(contentKey, salt),
    };
    const signature = await agent.signer.sign("cello-v2-session-accept", acceptBytes(acceptFields));
    const accept = signedAccept.encode({ fields: acceptFields, signature });
    this.#store.insertSession({
      agent_id: agent.signer.id,
      session_id: fields.sessionId,
      role: "callee",
      counterparty_id: fields.callerId,
      counterparty_name: wire.callerName,
      counterparty_keys: JSON.stringify(wire.callerIdentity),
      state: "accepted",
      offer: JSON.stringify(wire.offer),
      accept: JSON.stringify(accept),
      session_key: contentKey,
      own_salt: salt,
    });
    destroySessionEphemeral(own);
    sharedSecret.fill(0);
    await this.#link.call("session.accept", { agent: toB64(agent.signer.id), sessionId: toB64(fields.sessionId), accept });
    logEvent("session.accepted", { agent: agent.hex, session: toHex(fields.sessionId) });
  }

  async #answerAccept(agent: AgentContext, local: SessionRow, wireAccept: WireSigned): Promise<void> {
    const accept = signedAccept.decode(wireAccept, "accept");
    const keys = this.#counterpartyKeys(local);
    const offerFields = signedOffer.decode(JSON.parse(local.offer)).fields;
    if (!equalBytes(accept.fields.offerHash, structureHash(offerBytes(offerFields)))) throw new Error("this accept answers a different offer");
    if (!(await verifySignature(keys, "cello-v2-session-accept", acceptBytes(accept.fields), accept.signature))) throw new Error("this accept isn't signed by the agent called");
    const seed = local.mlkem_seed;
    const secret = local.x25519_secret;
    if (!seed || !secret) throw new Error("this session's own key halves are missing");
    const sharedSecret = await mlKemDecapsulate(seed, accept.fields.mlKemCiphertext);
    const { contentKey } = deriveSessionSecrets({
      ownEphemeralSecret: secret,
      peerEphemeralPublic: accept.fields.x25519Public,
      sessionId: local.session_id,
      extraSharedSecret: sharedSecret,
      pqTranscript: concat(accept.fields.mlKemCiphertext, offerFields.mlKemPublic),
    });
    const peerSalt = openSessionContent(contentKey, accept.fields.sealedSalt);
    if (!peerSalt) throw new Error("the counterparty's salt didn't decrypt, so the two sides hold different keys");
    const ownSalt = generateSaltContribution();
    const confirmFields = { acceptHash: structureHash(acceptBytes(accept.fields)), sealedSalt: sealSessionContent(contentKey, ownSalt) };
    const signature = await agent.signer.sign("cello-v2-session-confirm", confirmBytes(confirmFields));
    this.#store.updateSession(agent.signer.id, local.session_id, {
      state: "accepted",
      accept: JSON.stringify(wireAccept),
      confirm: JSON.stringify(signedConfirm.encode({ fields: confirmFields, signature })),
      session_key: contentKey,
      own_salt: ownSalt,
      salt: deriveSessionSalt(ownSalt, peerSalt),
      x25519_secret: null,
      mlkem_seed: null,
    });
    sharedSecret.fill(0);
  }

  async #finishAsCaller(agent: AgentContext, local: SessionRow, wireAssignment: WireSigned | null): Promise<void> {
    let assignment = wireAssignment;
    if (!assignment) {
      const result = await this.#link.call("session.confirm", { agent: toB64(agent.signer.id), sessionId: toB64(local.session_id), confirm: JSON.parse(local.confirm as string) }) as { assignment: WireSigned };
      assignment = result.assignment;
    }
    await this.#activate(agent, local, JSON.parse(local.confirm as string) as WireSigned, assignment, local.salt as Uint8Array);
  }

  async #finishAsCallee(agent: AgentContext, local: SessionRow, wireConfirm: WireSigned, wireAssignment: WireSigned): Promise<void> {
    const confirm = signedConfirm.decode(wireConfirm, "confirm");
    const keys = this.#counterpartyKeys(local);
    const acceptFields = signedAccept.decode(JSON.parse(local.accept as string)).fields;
    if (!equalBytes(confirm.fields.acceptHash, structureHash(acceptBytes(acceptFields)))) throw new Error("this confirm answers a different accept");
    if (!(await verifySignature(keys, "cello-v2-session-confirm", confirmBytes(confirm.fields), confirm.signature))) throw new Error("this confirm isn't signed by the caller");
    const peerSalt = openSessionContent(local.session_key as Uint8Array, confirm.fields.sealedSalt);
    if (!peerSalt) throw new Error("the counterparty's salt didn't decrypt, so the two sides hold different keys");
    await this.#activate(agent, local, wireConfirm, wireAssignment, deriveSessionSalt(local.own_salt as Uint8Array, peerSalt));
  }

  async #activate(agent: AgentContext, local: SessionRow, wireConfirm: WireSigned, wireAssignment: WireSigned, salt: Uint8Array): Promise<void> {
    const assignment = signedAssignment.decode(wireAssignment, "assignment");
    const expected: Omit<AssignmentFields, "time"> = {
      serverId: this.#serverId(),
      sessionId: local.session_id,
      callerId: local.role === "caller" ? agent.signer.id : local.counterparty_id,
      calleeId: local.role === "caller" ? local.counterparty_id : agent.signer.id,
      confirmHash: structureHash(confirmBytes(signedConfirm.decode(wireConfirm).fields)),
    };
    const matches = (Object.keys(expected) as (keyof typeof expected)[]).every((key) => equalBytes(assignment.fields[key], expected[key]));
    if (!matches || !(await verifySignature(this.#serverIdentity(), "cello-v2-session-assignment", assignmentBytes(assignment.fields), assignment.signature))) {
      throw new Error("the server's assignment doesn't match this session's setup");
    }
    this.#store.updateSession(agent.signer.id, local.session_id, {
      state: "active",
      confirm: JSON.stringify(wireConfirm),
      assignment: JSON.stringify(wireAssignment),
      salt,
      last_activity_at: assignment.fields.time,
    });
    const sessionHex = toHex(local.session_id);
    const peerHex = toHex(local.counterparty_id);
    logEvent("session.active", { agent: agent.hex, session: sessionHex });
    const admission = local.role === "callee" ? this.governance.admissionFor(agent.signer.id, peerHex, this.governance.contacts.tierOf(agent.signer.id, local.counterparty_id)) : {};
    this.#events.ring(agent.hex, { type: "session_started", agent: agent.name, session_id: sessionHex, from_id: peerHex, ...admission });
    this.#activation.get(agent.hex + sessionHex)?.();
  }

  #counterpartyKeys(local: SessionRow): PublicIdentity {
    const keys = identityCodec.decode(JSON.parse(local.counterparty_keys), "counterparty keys");
    if (!equalBytes(identityId(keys), local.counterparty_id)) throw new Error("the stored counterparty keys don't match its id");
    return keys;
  }

  // ---- Reading from position ----

  #verifier(agent: AgentContext, local: SessionRow): ChainVerifier {
    const key = agent.hex + toHex(local.session_id);
    const cached = this.#verifiers.get(key);
    if (cached) return cached;
    const verifier = new ChainVerifier({
      sessionId: local.session_id,
      server: this.#serverIdentity(),
      participants: [agent.signer.publicIdentity, this.#counterpartyKeys(local)],
    });
    for (const row of this.#store.signedRecord(agent.signer.id, local.session_id, local.verified_position)) {
      verifier.adopt(signedEntry.decode(JSON.parse(row.entry)).fields);
    }
    this.#verifiers.set(key, verifier);
    return verifier;
  }

  async #onEntryPush(agent: AgentContext, item: WitnessedOnWire): Promise<void> {
    const sessionId = signedEntry.decode(item.entry).fields.sessionId;
    const local = this.#store.session(agent.signer.id, sessionId);
    if (!local || (local.state !== "active" && local.state !== "closed")) return;
    const position = signedAck.decode(item.ack).fields.position;
    const verifier = this.#verifier(agent, local);
    if (position === verifier.position + 1 && (await this.#ingest(agent, local, item))) {
      await this.#deliver(agent, this.#store.session(agent.signer.id, sessionId) as SessionRow);
      return;
    }
    if (position > verifier.position) await this.#settle(agent, local);
  }

  // Resend what's pending, read everything new in order, then confirm what's stored.
  async #settle(agent: AgentContext, start: SessionRow): Promise<void> {
    const sessionId = start.session_id;
    await this.#resendPending(agent, start);
    let local = this.#store.session(agent.signer.id, sessionId) as SessionRow;
    for (;;) {
      const before = this.#verifier(agent, local).position;
      const result = await this.#link.call("entry.fetch", { agent: toB64(agent.signer.id), sessionId: toB64(sessionId), after: before }) as { items: WitnessedOnWire[]; tip: number };
      for (const item of result.items) {
        local = this.#store.session(agent.signer.id, sessionId) as SessionRow;
        if (!(await this.#ingest(agent, local, item))) return;
      }
      local = this.#store.session(agent.signer.id, sessionId) as SessionRow;
      const after = this.#verifier(agent, local).position;
      if (after >= result.tip) break;
      // A server that claims more but gives nothing new would otherwise keep this lane fetching forever.
      if (after === before) {
        this.#hold(agent, local, "server_sent_nothing_new", before + 1);
        return;
      }
    }
    local = this.#store.session(agent.signer.id, sessionId) as SessionRow;
    if (local.fault) {
      this.#store.updateSession(agent.signer.id, sessionId, { fault: null });
      logEvent("session.fault_cleared", { session: toHex(sessionId) });
    }
    await this.#deliver(agent, this.#store.session(agent.signer.id, sessionId) as SessionRow);
  }

  async #resendPending(agent: AgentContext, local: SessionRow): Promise<void> {
    for (const row of this.#store.pendingEntries(agent.signer.id, local.session_id)) {
      const outcome = await this.#attempt(agent, local, row);
      const preview = parseBody(row.body)?.text.slice(0, 120) ?? "";
      if (outcome.status === "landed") {
        this.#notify(agent, local.session_id, `Your message "${preview}" has now landed at position ${outcome.position}.`);
      } else if (outcome.status === "refused") {
        this.#notify(agent, local.session_id, `Your message "${preview}" was not sent: ${outcome.code}, ${outcome.message}.`);
      } else {
        return;
      }
    }
  }

  #notify(agent: AgentContext, sessionId: Uint8Array | null, text: string): void {
    this.#store.addNotice(agent.signer.id, sessionId, text);
    this.#events.ring(agent.hex, { type: "notice", agent: agent.name, ...(sessionId ? { session_id: toHex(sessionId) } : {}) });
  }

  // Doesn't stop the conversation for good: it's rechecked at every catch-up, so a bad deploy thaws by itself.
  #hold(agent: AgentContext, local: SessionRow, reason: string, position: number): void {
    this.#verifiers.delete(agent.hex + toHex(local.session_id));
    if (local.fault === reason) return;
    this.#store.updateSession(agent.signer.id, local.session_id, { fault: reason });
    logEvent("session.holding", { agent: agent.hex, session: toHex(local.session_id), reason, position });
    this.#notify(agent, local.session_id, `This session is holding at position ${position}, because something from the server didn't check out (${reason}). Nothing is lost, and it rechecks by itself.`);
  }

  // The running total for one conversation, read against whatever tier the sender is at now, so blocking stops it at once.
  // Known and above start again after a quiet spell, so a long conversation doesn't simply stop. A stranger's never does.
  #countBytes(agent: AgentContext, local: SessionRow, size: number, at: number): { total: number; told: number; withheld: boolean; tellNow: boolean; limit: number; resets: boolean } {
    const limits = this.governance.reach.limitsFor(agent.signer.id, this.governance.contacts.tierOf(agent.signer.id, local.counterparty_id));
    const resets = limits.bytes_reset_minutes > 0;
    const restart = resets && local.last_activity_at > 0 && at - local.last_activity_at >= limits.bytes_reset_minutes * 60_000;
    const total = (restart ? 0 : local.bytes_received) + size;
    const withheld = total > limits.max_bytes;
    const alreadyTold = !restart && local.bytes_told === 1;
    return { total, told: alreadyTold || withheld ? 1 : 0, withheld, tellNow: withheld && !alreadyTold, limit: limits.max_bytes, resets };
  }

  // Your own name for it wins, and a name it gave itself says so.
  #who(agent: AgentContext, local: SessionRow): string {
    return this.governance.contacts.who(agent.signer.id, local.counterparty_id, toHex(local.counterparty_id), local.counterparty_name || null).who;
  }

  async #ingest(agent: AgentContext, local: SessionRow, item: WitnessedOnWire): Promise<boolean> {
    let witnessed: WitnessedEntry;
    let entry: Signed<EntryFields>;
    try {
      entry = signedEntry.decode(item.entry, "entry");
      const ack = signedAck.decode(item.ack, "ack");
      witnessed = { fields: entry.fields, signature: entry.signature, ack: ack.fields, ackSignature: ack.signature };
    } catch (err: unknown) {
      this.#hold(agent, local, `malformed_frame: ${err instanceof Error ? err.message : String(err)}`, local.verified_position + 1);
      return false;
    }
    const verifier = this.#verifier(agent, local);
    const position = witnessed.ack.position;
    if (position <= verifier.position) return true;
    const fault: ChainFault | null = await verifier.check(witnessed);
    if (fault) {
      this.#hold(agent, local, fault, position);
      return false;
    }
    const closing = entry.fields.kind === EntryKind.close;
    const fromMe = equalBytes(entry.fields.authorId, agent.signer.id);
    const hash = entryHash(entry.fields);
    let body: Uint8Array | undefined;

    if (fromMe) {
      const own = this.#store.ownEntryByHash(agent.signer.id, local.session_id, hash);
      if (!own) {
        this.#hold(agent, local, "own_entry_unknown", position);
        return false;
      }
      body = own.body;
    } else {
      if (!item.ciphertext) {
        this.#hold(agent, local, "encrypted_text_missing", position);
        return false;
      }
      const ciphertext = fromB64(item.ciphertext, "ciphertext");
      const opened = equalBytes(ciphertextHash(ciphertext), entry.fields.ciphertextHash) ? openSessionContent(local.session_key as Uint8Array, ciphertext) : null;
      if (!opened || !equalBytes(saltedContentHash(local.salt as Uint8Array, opened), entry.fields.contentHash)) {
        this.#hold(agent, local, "text_does_not_match_signature", position);
        return false;
      }
      body = opened;
    }

    const ownClosed = local.own_closed === 1 || (closing && fromMe);
    const peerClosed = local.peer_closed === 1 || (closing && !fromMe);
    const nowClosed = ownClosed && peerClosed;
    const counted = !fromMe && !closing ? this.#countBytes(agent, local, (body as Uint8Array).length, witnessed.ack.time) : undefined;
    try {
      this.#store.transaction(() => {
        if (fromMe) {
          const own = this.#store.ownEntryByHash(agent.signer.id, local.session_id, hash) as EntryRow;
          this.#store.markLanded(own.id, position, JSON.stringify(item.ack));
        } else {
          this.#store.insertEntry({
            agent_id: agent.signer.id,
            session_id: local.session_id,
            entry_hash: hash,
            position,
            state: "received",
            own: 0,
            entry: JSON.stringify(item.entry),
            ack: JSON.stringify(item.ack),
            body: body as Uint8Array,
          });
          if (counted?.withheld) this.#store.markWithheld(this.#store.entryIdAt(agent.signer.id, local.session_id, position) as number, JSON.stringify({ delivered: null, findings: [], reason: BYTE_LIMIT_REASON, score: null, ran: { deterministic: false, model: false, model_failed_copies: 0 } } satisfies VerdictDetail));
        }
        this.#store.updateSession(agent.signer.id, local.session_id, {
          ...(counted ? { bytes_received: counted.total, bytes_told: counted.told } : {}),
          last_activity_at: witnessed.ack.time,
          verified_position: position,
          own_closed: ownClosed ? 1 : 0,
          peer_closed: peerClosed ? 1 : 0,
          ...(nowClosed ? { state: "closed" as const, session_key: null } : {}),
        });
      });
    } catch (err) {
      // The check above already advanced the cached chain, so rebuild it from what's on disk.
      this.#verifiers.delete(agent.hex + toHex(local.session_id));
      throw err;
    }

    const sessionHex = toHex(local.session_id);
    const bell = { agent: agent.name, session_id: sessionHex, from_id: toHex(local.counterparty_id) };
    // Told once, and it rings no doorbell per message, so a flood past the limit can't keep waking anyone or cost a screen.
    if (counted?.tellNow) this.#notify(agent, local.session_id, `This conversation has passed its limit of ${counted.limit} bytes, so what it sends from now on isn't delivered. ${counted.resets ? "The count starts again after a quiet spell." : "The count doesn't reset at this tier."} The other side isn't told. Either side can start a new conversation.`);
    // Stored, but not deliverable until it has a verdict. Its doorbell rings then, from #onVerdict.
    if (!fromMe && !counted?.withheld) {
      const entryId = this.#store.entryIdAt(agent.signer.id, local.session_id, position) as number;
      this.#screening.add({ entryId, agentHex: agent.hex, sessionHex, position, senderHex: toHex(local.counterparty_id), bytes: (body as Uint8Array).length, arrived: Date.now() });
    }
    if (nowClosed && local.state !== "closed") {
      logEvent("session.closed", { agent: agent.hex, session: sessionHex });
      this.#events.ring(agent.hex, { ...bell, type: "session_closed" });
    }
    const written = parseBody(body as Uint8Array);
    const due = !closing && written?.signal === "standby" ? standbyDue(written.est_minutes, witnessed.ack.time) : undefined;
    if (due !== undefined) this.#armStandbyCheck(due);
    return true;
  }

  // ---- Standbys past their time. Only the two daemons can see these, so all of this is local, and it only tells. ----

  #standbyIn(row: EntryRow | undefined, by: OpenStandby["by"], local: SessionRow): OpenStandby | undefined {
    if (!row || row.position === null || row.ack === null || row.position > local.verified_position) return undefined;
    if (signedEntry.decode(JSON.parse(row.entry)).fields.kind !== EntryKind.message) return undefined;
    const body = parseBody(row.body);
    if (body?.signal !== "standby") return undefined;
    const due = standbyDue(body.est_minutes, signedAck.decode(JSON.parse(row.ack)).fields.time);
    return due === undefined ? undefined : { by, position: row.position, due };
  }

  // A promise is open while it's its author's latest word. A follow-up still on its way to the server has no position
  // yet, so it counts as following up. If it's refused it leaves the chain, and the promise before it is open again.
  #openStandbys(agent: AgentContext, local: SessionRow): OpenStandby[] {
    if (local.state !== "active") return [];
    const own = this.#standbyIn(this.#store.lastOwnEntry(agent.signer.id, local.session_id), "you", local);
    const peer = this.#standbyIn(this.#store.lastPeerEntry(agent.signer.id, local.session_id), "other_side", local);
    return [own, peer].filter((standby) => standby !== undefined);
  }

  #standbyView(agent: AgentContext, local: SessionRow): unknown[] {
    const now = Date.now();
    return this.#openStandbys(agent, local).map((s) => ({ by: s.by, position: s.position, due_at: new Date(s.due).toISOString(), overdue: s.due <= now }));
  }

  // One timer, set only while a promise is open. Every wait ends at the due time or the limit, and then reads the clock.
  #armStandbyCheck(due: number): void {
    if (this.#standbyCheck && due >= this.#standbyCheckAt) return;
    clearTimeout(this.#standbyCheck);
    const now = Date.now();
    this.#standbyCheckAt = Math.min(due, now + STANDBY_CHECK_MAX_MS);
    this.#standbyCheck = setTimeout(() => this.#checkStandbys(), Math.max(0, this.#standbyCheckAt - now));
  }

  // Your own promise is settled by what's on this disk, so it can be told right now, even with no server.
  // The other side's may have been kept on the server, unread, so it's left for a catch-up to confirm.
  #checkStandbys(): void {
    this.#standbyCheck = undefined;
    const now = Date.now();
    let next = Infinity;
    for (const agent of this.#agents.values()) {
      let confirm = false;
      for (const local of this.#store.sessionsOf(agent.signer.id)) {
        try {
          for (const standby of this.#openStandbys(agent, local)) {
            if (this.#store.standbyTold(agent.signer.id, local.session_id, standby.position)) continue;
            if (standby.due > now) next = Math.min(next, standby.due);
            else if (standby.by === "you") this.#tellLate(agent, local, standby);
            else confirm = true;
          }
        } catch (err: unknown) {
          logEvent("standby.check_failed", { agent: agent.hex, session: toHex(local.session_id), message: err instanceof Error ? err.message : String(err) });
        }
      }
      // Offline, the catch-up comes with the reconnect. A failed one comes round again with the position check.
      if (confirm && agent.online) void this.#catchUpAgent(agent);
    }
    if (next !== Infinity) this.#armStandbyCheck(next);
  }

  // The list was asked for after the promise fell due and this daemon holds all of it, so nothing kept the promise by then.
  #tellLatePeer(agent: AgentContext, sessionId: Uint8Array, listedAt: number, tip: number): void {
    const local = this.#store.session(agent.signer.id, sessionId);
    if (!local || local.verified_position < tip) return;
    for (const standby of this.#openStandbys(agent, local)) {
      if (standby.by === "other_side" && standby.due <= listedAt) this.#tellLate(agent, local, standby);
    }
  }

  // The mark and the notice commit together. A crash before the doorbell still leaves the notice for the next receive or wait.
  #tellLate(agent: AgentContext, local: SessionRow, standby: OpenStandby): void {
    const due = new Date(standby.due).toISOString();
    const text = standby.by === "you"
      ? `You said you'd follow up by now, in your message at position ${standby.position}, due ${due}.`
      : `The other side said it would follow up by now, in its message at position ${standby.position}, due ${due}, and it hasn't.`;
    const told = this.#store.transaction(() => {
      if (this.#store.standbyTold(agent.signer.id, local.session_id, standby.position)) return false;
      this.#store.markStandbyTold(agent.signer.id, local.session_id, standby.position);
      this.#store.addNotice(agent.signer.id, local.session_id, text);
      return true;
    });
    if (!told) return;
    const sessionHex = toHex(local.session_id);
    logEvent("standby.overdue", { agent: agent.hex, session: sessionHex, by: standby.by, position: standby.position });
    this.#events.ring(agent.hex, { type: "standby_overdue", agent: agent.name, session_id: sessionHex });
  }

  #latestFromPeer(agent: AgentContext, local: SessionRow): number {
    return this.#store.unreadBounds(agent.signer.id, local.session_id, local.delivered_through)?.last ?? 0;
  }

  // Runs only after the text is stored and decrypted. This signature is what lets the server remove it.
  // It also says how far screening has got, so it goes again when that moves, or when the screen is held up.
  async #deliver(agent: AgentContext, local: SessionRow, etaSeconds = 0): Promise<void> {
    const through = Math.max(this.#latestFromPeer(agent, local), local.delivered_through);
    if (through === 0) return;
    const screened = Math.min(this.#screenedThrough(agent, local), through);
    if (through === local.delivered_through && screened <= local.acked_screened && etaSeconds === 0) return;
    const ack = signedAck.decode(JSON.parse(this.#store.ackAt(agent.signer.id, local.session_id, through) as string)).fields;
    const fields = { sessionId: local.session_id, readerId: agent.signer.id, throughPosition: through, entryHash: ack.entryHash, root: ack.root, screenedThrough: screened, screeningEtaSeconds: etaSeconds };
    const signature = await agent.signer.sign("cello-v2-delivery-ack", deliveryAckBytes(fields));
    await this.#link.call("delivery.ack", { agent: toB64(agent.signer.id), deliveryAck: signedDeliveryAck.encode({ fields, signature }) });
    this.#store.updateSession(agent.signer.id, local.session_id, { delivered_through: through, acked_screened: screened });
  }

  // How far the reader has screened what it holds. This is only ever used to tell and to pace, so a false one costs a delay.
  async #onPeerDeliveryAck(agent: AgentContext, wire: WireSigned): Promise<void> {
    const signed = signedDeliveryAck.decode(wire, "deliveryAck");
    const { fields } = signed;
    const local = this.#store.session(agent.signer.id, fields.sessionId);
    if (!local || !equalBytes(fields.readerId, local.counterparty_id)) return;
    if (!(await verifySignature(this.#counterpartyKeys(local), "cello-v2-delivery-ack", deliveryAckBytes(fields), signed.signature))) return;
    if (fields.screenedThrough > local.peer_screened_through) this.#store.updateSession(agent.signer.id, local.session_id, { peer_screened_through: fields.screenedThrough });
    const position = fields.screenedThrough + 1;
    if (fields.screeningEtaSeconds > 0 && position > local.peer_eta_told) {
      this.#store.updateSession(agent.signer.id, local.session_id, { peer_eta_told: position });
      this.#notify(agent, local.session_id, `The other side is still screening position ${position}, for about ${fields.screeningEtaSeconds} more seconds. Its machine has the message, and its agent hasn't been shown it yet.`);
    }
  }

  // A bot can outrun its reader. This waits a bounded time for the gap to close, then sends anyway, and says so.
  async #paceForReader(agent: AgentContext, sessionId: Uint8Array): Promise<Record<string, unknown>> {
    const gap = (): number => {
      const local = this.#store.session(agent.signer.id, sessionId);
      return local ? this.#store.countOwnAfter(agent.signer.id, sessionId, local.peer_screened_through) : 0;
    };
    const { sender_backlog_gap: allowed, sender_backlog_wait_ms: limit } = this.#settings;
    if (gap() <= allowed) return {};
    const started = Date.now();
    while (gap() > allowed && Date.now() - started < limit) {
      await new Promise((resolve) => setTimeout(resolve, SENDER_BACKLOG_CHECK_MS));
    }
    const behind = gap();
    const waited = Date.now() - started;
    return { slowed: { waited_ms: waited, reader_behind_by: behind, message: `The other side's screening is ${behind} of your messages behind, so this send waited ${Math.round(waited / 1000)} seconds. Your messages are safe, and they're delivered in order as it catches up.` } };
  }

  // Credentials and hijack artifacts stop here, before anything is signed, on a thread that never runs the model.
  async #screenOutbound(agent: AgentContext, text: string, params: Record<string, unknown>): Promise<{ text: string; report: Record<string, unknown> }> {
    const keys = [...this.#agents.keys(), ...this.#store.sessionsOf(agent.signer.id).map((s) => toHex(s.counterparty_id))];
    const guards = this.governance.guards;
    const pii = { whitelist: guards.value<string[]>(agent.signer.id, "pii_whitelist"), email: guards.value<boolean>(agent.signer.id, "pii_check_email"), phone: guards.value<boolean>(agent.signer.id, "pii_check_phone") };
    let verdict;
    try {
      verdict = await this.#outbound.screen(text, keys, pii);
    } catch (err: unknown) {
      throw new LocalError("screener_unavailable", `The outbound screen didn't run, so nothing was sent: ${err instanceof Error ? err.message : String(err)}. It restarts by itself, so try again.`);
    }
    if (verdict.disposition === "block") throw new LocalError("blocked_by_screening", `Nothing was sent: ${verdict.reason as string}. Categories: ${verdict.categories.join(", ")}.`);
    if (verdict.disposition === "hold") {
      const held = (verdict.held ?? []).map((h) => `${h.category.replace("pii:", "")} ${h.value}`).join(", ");
      if (params["allow_flagged"] !== true) {
        throw new LocalError("held_by_guard", `Nothing was sent, because it looks like personal data: ${held}. Say it without that, or have it let through with allow_flagged, which needs a person unless autonomous_override is on.`);
      }
      if (!guards.value<boolean>(agent.signer.id, "autonomous_override")) {
        requirePerson(params, `This sends personal data from ${agent.hex}: ${held}.`, `cello-v2 send ${params["session_id"] as string} - --allow-flagged --over --agent ${agent.hex}`);
      }
      logEvent("guard.held_value_sent", { agent: agent.hex, categories: (verdict.held ?? []).map((h) => h.category), by_a_person: params["person_confirmed"] === true });
      return { text: verdict.text, report: { let_through: (verdict.held ?? []).map((h) => h.category) } };
    }
    if (verdict.disposition === "redact") return { text: verdict.text, report: { redacted: verdict.categories, message: "Parts of your message were replaced before sending: the text that went out isn't exactly what you wrote." } };
    return { text, report: {} };
  }

  // ---- Sending ----

  async #attempt(agent: AgentContext, local: SessionRow, row: EntryRow): Promise<AttemptOutcome> {
    let result: { ack: WireSigned };
    try {
      result = await this.#link.call("entry.append", {
        agent: toB64(agent.signer.id),
        entry: JSON.parse(row.entry),
        ciphertext: toB64(row.ciphertext as Uint8Array),
      }) as { ack: WireSigned };
    } catch (err: unknown) {
      if (err instanceof ServerUnreachable) return { status: "pending" };
      if (err instanceof ServerRefused) {
        // A repeat of a landed entry always returns its ack, so a refusal means this entry never landed.
        this.#store.markNotSent(row.id);
        this.#armStandbyCheck(Date.now());
        return { status: "refused", code: err.code, message: err.message };
      }
      throw err;
    }
    const ack = signedAck.decode(result.ack, "ack").fields;
    if (!equalBytes(ack.entryHash, row.entry_hash)) throw new Error("the server acknowledged a different entry");
    this.#store.markLanded(row.id, ack.position, JSON.stringify(result.ack));
    const verifier = this.#verifier(agent, local);
    if (ack.position === verifier.position + 1) {
      const fresh = this.#store.session(agent.signer.id, local.session_id) as SessionRow;
      await this.#ingest(agent, fresh, { entry: JSON.parse(row.entry) as WireSigned, ack: result.ack, ciphertext: null });
    }
    return { status: "landed", position: ack.position };
  }

  async #append(agent: AgentContext, local: SessionRow, kind: EntryFields["kind"], mode: EntryFields["mode"], body: Body): Promise<AttemptOutcome> {
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
    const ciphertext = sealSessionContent(local.session_key as Uint8Array, bodyBytes);
    if (ciphertext.length > MAX_CIPHERTEXT_BYTES) throw new LocalError("too_large", `this message is ${bodyBytes.length} bytes, over the limit of about 1 MB`);

    const verifier = this.#verifier(agent, local);
    const firstUnread = this.#store.firstUnreadToAnswer(agent.signer.id, local.session_id, local.read_position);
    const readPosition = firstUnread !== undefined ? firstUnread - 1 : verifier.position;
    const readRoot = verifier.rootAt(readPosition);
    if (!readRoot) throw new Error(`no root is held for position ${readPosition}`);

    const last = this.#store.lastOwnEntry(agent.signer.id, local.session_id);
    const lastFields = last ? signedEntry.decode(JSON.parse(last.entry)).fields : undefined;
    const fields: EntryFields = {
      sessionId: local.session_id,
      authorId: agent.signer.id,
      authorSeq: (lastFields?.authorSeq ?? 0) + 1,
      prevOwnHash: last ? last.entry_hash : ZERO_HASH,
      readPosition,
      readRoot,
      kind,
      mode,
      contentHash: saltedContentHash(local.salt as Uint8Array, bodyBytes),
      ciphertextHash: ciphertextHash(ciphertext),
      notAfter: Date.now() + SEND_WINDOW_MS,
    };
    const signature = await agent.signer.sign("cello-v2-entry", entryBytes(fields));
    // On disk before it goes anywhere, so a crash after this point can only resend identical bytes.
    this.#store.insertEntry({
      agent_id: agent.signer.id,
      session_id: local.session_id,
      entry_hash: entryHash(fields),
      state: "pending",
      own: 1,
      entry: JSON.stringify(signedEntry.encode({ fields, signature })),
      ciphertext,
      body: bodyBytes,
    });
    const row = this.#store.lastOwnEntry(agent.signer.id, local.session_id) as EntryRow;
    return this.#attempt(agent, local, row);
  }

  #requireAgent(agentHex: string): AgentContext {
    const agent = this.#agents.get(agentHex);
    if (!agent) throw new LocalError("unknown_agent", "no such agent on this machine");
    return agent;
  }

  #requireSession(agent: AgentContext, sessionHex: string): SessionRow {
    const local = this.#store.session(agent.signer.id, parseHex(sessionHex, 16, "session id"));
    if (!local) throw new LocalError("unknown_session", "this agent has no such session");
    return local;
  }

  // Returns an outcome rather than throwing for anything the agent can act on.
  // The outbound cap, read fresh each send so a change holds from the next message. A slot is only used by a send that goes.
  #rateFor(agent: AgentContext): OutboundRateLimiter | undefined {
    const max = this.governance.guards.value<number>(agent.signer.id, "rate_max_per_window");
    const window = this.governance.guards.value<number>(agent.signer.id, "rate_window_ms");
    if (max === 0) return undefined;
    const held = this.#rates.get(agent.hex);
    if (held?.max === max && held.window === window) return held.limiter;
    const limiter = new OutboundRateLimiter({ maxPerWindow: max, windowMs: window });
    this.#rates.set(agent.hex, { max, window, limiter });
    return limiter;
  }

  async send(agentHex: string, sessionHex: string, text: string, signal: Signal, estMinutes: number | undefined, notice: boolean, params: Record<string, unknown> = {}): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    const rate = this.#rateFor(agent);
    const limited = rate?.peek(agent.hex);
    if (limited?.limited) throw new LocalError("rate_limited", limited.guidance as string);
    if (!SIGNALS.includes(signal)) throw new LocalError("missing_signal", `signal must be one of ${SIGNALS.join(", ")}`);
    if (signal === "standby" && standbyDue(estMinutes, Date.now()) === undefined) throw new LocalError("missing_est_minutes", "standby needs est_minutes, a positive number of minutes until your follow-up");
    const screened = await this.#screenOutbound(agent, text, { ...params, session_id: sessionHex });
    // A notice is how "stop" gets through, so it never waits. These waits are outside the lane, so what arrives meanwhile isn't held up.
    const paced = notice ? {} : await this.#paceForReader(agent, this.#requireSession(agent, sessionHex).session_id);
    return this.#lane(agentHex, sessionHex, async () => {
      let local = this.#requireSession(agent, sessionHex);
      if (local.state !== "active") throw new LocalError(local.state === "closed" ? "session_closed" : "session_not_active", `this session is ${local.state}`);
      if (local.own_closed) throw new LocalError("session_closed", "you've already closed this session");
      if (local.fault) throw new LocalError("session_holding", `this session is holding: ${local.fault}. It rechecks by itself.`);
      if (!notice && this.#store.unreadCount(agent.signer.id, local.session_id, local.read_position) > 0) {
        const deliverable = this.#store.deliverableCount(agent.signer.id, local.session_id, local.read_position);
        const waiting = this.#screening.waiting(agent.hex, sessionHex);
        if (deliverable === 0 && waiting) {
          throw new LocalError("session_not_current", `A message has arrived that's still being screened: position ${waiting.position}, for about ${waiting.about_seconds} more seconds. Nothing was sent. A doorbell rings when it's ready. To say something now, such as stop, send it as a notice.`);
        }
        throw new LocalError("session_not_current", "a message has arrived that you haven't read. Nothing was sent. Call receive, then decide what to say.");
      }
      if (this.#store.pendingEntries(agent.signer.id, local.session_id).length > 0) {
        await this.#resendPending(agent, local);
        local = this.#store.session(agent.signer.id, local.session_id) as SessionRow;
        if (this.#store.pendingEntries(agent.signer.id, local.session_id).length > 0) {
          throw new LocalError("previous_send_pending", "your previous message hasn't reached the server yet, so this one wasn't queued. Try again once it has.");
        }
      }
      const body: Body = { n: toB64(new Uint8Array(randomBytes(16))), text: screened.text, signal, est_minutes: estMinutes ?? null };
      const outcome = await this.#append(agent, local, EntryKind.message, notice ? EntryMode.notice : EntryMode.reply, body);
      if (outcome.status === "landed") {
        rate?.record(agent.hex);
        // Answering a call is a reply. Talking in a session you called only becomes one once they've spoken.
        if (local.role === "callee" || this.#store.lastPeerEntry(agent.signer.id, local.session_id)) this.governance.engaged(agent.signer.id, local.counterparty_id, "replied");
      }
      return { ...(await this.#reportSend(agent, local, outcome) as object), ...screened.report, ...paced };
    });
  }

  async #reportSend(agent: AgentContext, local: SessionRow, outcome: AttemptOutcome): Promise<unknown> {
    if (outcome.status === "landed") {
      const fresh = this.#store.session(agent.signer.id, local.session_id) as SessionRow;
      if (outcome.position > this.#verifier(agent, fresh).position) await this.#settle(agent, fresh);
      return { sent: true, position: outcome.position };
    }
    if (outcome.status === "pending") return { sent: false, status: "not_sent_yet", message: "The server can't be reached. Your message is saved, and it goes when the server is back. You'll get a notice." };
    if (outcome.code === "not_current") {
      await this.#settle(agent, this.#store.session(agent.signer.id, local.session_id) as SessionRow);
      throw new LocalError("session_not_current", "a message arrived just before yours. Nothing was sent. Call receive, then decide what to say.");
    }
    throw new LocalError(outcome.code, outcome.message);
  }

  async close(agentHex: string, sessionHex: string): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    return this.#lane(agentHex, sessionHex, async () => {
      const local = this.#requireSession(agent, sessionHex);
      if (local.own_closed || local.state === "closed") return { closed: true, state: local.state };
      if (local.state !== "active") throw new LocalError("session_not_active", `this session is ${local.state}`);
      await this.#resendPending(agent, local);
      // Durable before the close goes, so a crash anywhere after this still ends in a seal.
      this.#store.addSealWant(agent.signer.id, local.session_id, SEAL_EVERYTHING_HELD);
      const body: Body = { n: toB64(new Uint8Array(randomBytes(16))), text: "", signal: null, est_minutes: null };
      const outcome = await this.#append(agent, this.#store.session(agent.signer.id, local.session_id) as SessionRow, EntryKind.close, EntryMode.notice, body);
      const report = await this.#reportSend(agent, local, outcome) as { sent: boolean };
      const seal = report.sent ? await this.#sealAfterClose(agent, local.session_id) : notSealedYet("the close hasn't reached the server");
      const fresh = this.#store.session(agent.signer.id, local.session_id) as SessionRow;
      return { closed: report.sent, state: fresh.state, peer_closed: fresh.peer_closed === 1, seal, ...report };
    });
  }

  // ---- Sealing ----

  async seal(agentHex: string, sessionHex: string, through: number | undefined): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    if (through !== undefined && (!Number.isSafeInteger(through) || through < 1)) throw new LocalError("bad_argument", "through must be a position, a whole number from 1 up");
    return this.#lane(agentHex, sessionHex, async () => {
      const local = this.#requireSession(agent, sessionHex);
      if (local.verified_position < 1) throw new LocalError("nothing_to_seal", "this session has no witnessed messages yet");
      if (through !== undefined && through > local.verified_position) throw new LocalError("seal_beyond_held", `you hold this session through position ${local.verified_position}, so ${through} can't be sealed`);
      const wanted = through ?? local.verified_position;
      this.#store.addSealWant(agent.signer.id, local.session_id, wanted);
      return this.#attemptSeal(agent, local.session_id, wanted);
    });
  }

  // A want is removed only by a stored seal or a final refusal. Anything else leaves it to retry at the next catch-up.
  async #attemptSeal(agent: AgentContext, sessionId: Uint8Array, wanted: number): Promise<unknown> {
    const local = this.#store.session(agent.signer.id, sessionId) as SessionRow;
    const through = wanted === SEAL_EVERYTHING_HELD ? local.verified_position : wanted;
    if (through < 1) {
      this.#store.removeSealWant(agent.signer.id, sessionId, wanted);
      throw new LocalError("nothing_to_seal", "this session has no witnessed messages yet");
    }
    if (!agent.online) return notSealedYet(this.#link.problem ?? "this agent isn't online yet");
    const root = this.#verifier(agent, local).rootAt(through);
    if (!root) throw new Error(`no root is held for position ${through}`);
    const fields = { serverId: this.#serverId(), sessionId, sealerId: agent.signer.id, throughPosition: through, root };
    const signature = await agent.signer.sign("cello-v2-seal-request", sealRequestBytes(fields));
    let answer: { record: SealRecordOnWire; logProof: string[] | null };
    try {
      answer = await this.#link.call("seal.request", {
        agent: toB64(agent.signer.id),
        request: signedSealRequest.encode({ fields, signature }),
        knownLogSize: this.#knownSealLogHead()?.size ?? 0,
      }) as typeof answer;
    } catch (err: unknown) {
      if (err instanceof ServerUnreachable) return notSealedYet(err.message);
      if (err instanceof ServerRefused && SEAL_RETRY_CODES.includes(err.code)) return notSealedYet(`${err.code}: ${err.message}`);
      if (err instanceof ServerRefused) {
        this.#store.removeSealWant(agent.signer.id, sessionId, wanted);
        throw new LocalError(err.code, err.message);
      }
      throw err;
    }
    let record: SealRecord;
    try {
      record = await this.#checkSealAnswer(agent, local, through, root, answer.record, answer.logProof);
    } catch (err: unknown) {
      this.#store.removeSealWant(agent.signer.id, sessionId, wanted);
      logEvent("seal.refused", { agent: agent.hex, session: toHex(sessionId), code: err instanceof LocalError ? err.code : "failed" });
      throw err;
    }
    const head = record.log.head.fields;
    this.#store.transaction(() => {
      this.#store.addSeal(agent.signer.id, sealId(record.certificate.fields), sessionId, JSON.stringify(answer.record));
      this.#store.removeSealWant(agent.signer.id, sessionId, wanted);
      this.#store.setConfig(CONFIG_SEAL_KEY, toHex(head.sealKeyId));
      if (head.size > (this.#knownSealLogHead()?.size ?? 0)) this.#store.setConfig(CONFIG_SEAL_LOG_HEAD, JSON.stringify({ size: head.size, root: toB64(head.root) }));
    });
    logEvent("seal.stored", { agent: agent.hex, session: toHex(sessionId), through });
    return { sealed: true, ...sealSummary(record), statement: describeSeal(record) };
  }

  #knownSealLogHead(): { size: number; root: Uint8Array } | undefined {
    const stored = this.#store.getConfig(CONFIG_SEAL_LOG_HEAD);
    if (!stored) return undefined;
    const parsed = JSON.parse(stored) as { size: number; root: string };
    return { size: parsed.size, root: fromB64(parsed.root, "stored seal log root") };
  }

  // The server can send anything, so nothing is stored or reported as sealed until it all checks out against this record.
  async #checkSealAnswer(agent: AgentContext, local: SessionRow, through: number, root: Uint8Array, raw: SealRecordOnWire, logProof: string[] | null): Promise<SealRecord> {
    let decoded: SealRecord;
    try {
      decoded = decodeSealRecord(raw);
    } catch (err: unknown) {
      throw new LocalError("malformed_record", `the server's seal record can't be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!equalBytes(identityId(decoded.server), this.#serverId())) throw new LocalError("seal_wrong_server", "this seal names a server other than the one this daemon pinned");
    const sealKeyId = identityId(decoded.sealKey);
    const pinned = this.#store.getConfig(CONFIG_SEAL_KEY);
    if (pinned && pinned !== toHex(sealKeyId)) throw new LocalError("seal_key_changed", `this server's seal key has changed since your first seal: it was ${pinned}, and it's now ${toHex(sealKeyId)}`);
    const check = await checkSealRecord(raw, sealKeyId);
    if (!check.ok) throw new LocalError(check.fault, check.message);
    const cert = check.record.certificate.fields;
    if (!equalBytes(cert.root, root)) throw new LocalError("seal_root_mismatch", `the server sealed a different history from the one you hold at position ${through}`);
    const subject = equalBytes(cert.sessionId, local.session_id) && equalBytes(cert.sealerId, agent.signer.id) && equalBytes(cert.counterpartyId, local.counterparty_id) && cert.throughPosition === through;
    if (!subject) throw new LocalError("seal_wrong_subject", "the server's certificate isn't for this seal: its session, parties or position differ");
    if (cert.tip < local.verified_position || (local.state === "closed" && cert.closed !== 1)) {
      throw new LocalError("seal_misreports_session", `the certificate says ${cert.tip} positions and closed=${cert.closed}, and you hold ${local.verified_position} in a session that is ${local.state}`);
    }
    this.#checkSealLogHistory(check.record, logProof);
    return check.record;
  }

  // Catches a log rewritten since this daemon last saw it. It can't catch two readers being shown different logs: only an outside witness can.
  #checkSealLogHistory(record: SealRecord, logProof: string[] | null): void {
    const known = this.#knownSealLogHead();
    if (!known) return;
    const head = record.log.head.fields;
    const rewritten = new LocalError("seal_log_rewritten", `this server's seal log no longer contains what it showed you when it had ${known.size} seals. Nothing was stored.`);
    if (!logProof) throw rewritten;
    const path = logProof.map((hash) => fromB64(hash, "logProof"));
    const consistent = known.size <= head.size
      ? verifyConsistency(known.size, head.size, known.root, head.root, path)
      : verifyConsistency(head.size, known.size, head.root, known.root, path);
    if (!consistent) throw rewritten;
  }

  async #sealAfterClose(agent: AgentContext, sessionId: Uint8Array): Promise<unknown> {
    try {
      return await this.#attemptSeal(agent, sessionId, SEAL_EVERYTHING_HELD);
    } catch (err: unknown) {
      if (!(err instanceof LocalError)) throw err;
      return { sealed: false, status: "refused", error: err.code, message: err.message };
    }
  }

  async #retrySeals(agent: AgentContext, sessionId: Uint8Array): Promise<void> {
    for (const want of this.#store.sealWants(agent.signer.id, sessionId)) {
      const label = want.through === SEAL_EVERYTHING_HELD ? "The seal after your close" : `Your seal through position ${want.through}`;
      try {
        const result = await this.#attemptSeal(agent, sessionId, want.through) as { sealed: boolean; seal_id?: string };
        // One still waiting mustn't hold up a different one that could finish.
        if (!result.sealed) continue;
        this.#notify(agent, sessionId, `${label} is done. Its id is ${result.seal_id as string}.`);
      } catch (err: unknown) {
        if (!(err instanceof LocalError)) throw err;
        this.#notify(agent, sessionId, `${label} wasn't made: ${err.code}, ${err.message}.`);
      }
    }
  }

  seals(agentHex: string, sessionHex: string | undefined): unknown {
    const agent = this.#requireAgent(agentHex);
    const sessionId = sessionHex === undefined ? undefined : this.#requireSession(agent, sessionHex).session_id;
    return {
      seals: this.#store.seals(agent.signer.id, sessionId).map((row) => sealSummary(decodeSealRecord(JSON.parse(row.record)))),
      waiting: this.#store.sealWants(agent.signer.id, sessionId).map((want) => ({ session_id: toHex(want.session_id), through: want.through === SEAL_EVERYTHING_HELD ? "everything held" : want.through })),
    };
  }

  exportSeal(agentHex: string, sealHex: string): unknown {
    const agent = this.#requireAgent(agentHex);
    const row = this.#store.seal(agent.signer.id, parseHex(sealHex, 32, "seal id"));
    if (!row) throw new LocalError("unknown_seal", "this agent holds no seal with that id");
    return JSON.parse(row.record);
  }

  // Reads this agent's own record, so it needs no server and moves no read position.
  async exportTranscript(agentHex: string, sessionHex: string, choice: { reveal: string | undefined; all: boolean; sealId: string | undefined }): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    const local = this.#requireSession(agent, sessionHex);
    const unscreened = this.#store.firstUnscreened(agent.signer.id, local.session_id);
    if (unscreened !== undefined && (choice.all || choice.reveal !== undefined)) {
      throw new LocalError("not_screened_yet", `Position ${unscreened} is still being screened, so nothing can be revealed yet. Try again once it's done.`);
    }
    const built = await buildTranscript({
      ...choice,
      session: toHex(local.session_id),
      sealCommand: `cello-v2 seal ${toHex(local.session_id)} --agent ${agent.name}`,
      entries: this.#store.verifiedEntries(agent.signer.id, local.session_id, local.verified_position).map((row) => ({
        position: row.position as number,
        entry: JSON.parse(row.entry) as WireSigned,
        ack: row.ack ? JSON.parse(row.ack) as WireSigned : null,
        body: row.body,
      })),
      seals: this.#store.seals(agent.signer.id, local.session_id).map((row) => JSON.parse(row.record) as unknown),
      salt: local.salt,
    });
    if (!built.ok) throw new LocalError(built.fault, built.message);
    return { file: built.file, summary: built.summary };
  }

  // ---- What agents and people ask for ----

  async createAgent(name: string): Promise<unknown> {
    if (!name || new TextEncoder().encode(name).length > 64) throw new LocalError("bad_argument", "an agent name must be 1 to 64 bytes");
    if ([...this.#agents.values()].some((a) => a.name === name)) throw new LocalError("agent_name_taken", `this machine already has an agent named ${name}`);
    const seeds = generateIdentitySeeds();
    const signer = await signerFromSeeds(seeds);
    this.#store.insertAgent(signer.id, name, seeds.ed, seeds.pq);
    const agent: AgentContext = { signer, hex: toHex(signer.id), name, registered: false, online: false };
    this.#agents.set(agent.hex, agent);
    this.governance.writeDefaults(signer.id);
    if (this.#server) await this.#bringOnline(agent, this.#server);
    const note = agent.online ? {} : { note: `saved, but not online yet: ${this.#link.problem ?? "the server didn't take it"}. It registers by itself once the server is reachable.` };
    return { name, agent_id: agent.hex, registered: agent.registered, online: agent.online, ...note };
  }

  resolveAgent(nameOrId: string): string {
    const byId = this.#agents.get(nameOrId);
    if (byId) return byId.hex;
    for (const agent of this.#agents.values()) if (agent.name === nameOrId) return agent.hex;
    throw new LocalError("unknown_agent", `no agent named ${nameOrId} on this machine`);
  }

  agentName(agentHex: string): string {
    return this.#requireAgent(agentHex).name;
  }

  async initiate(agentHex: string, target: string): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    const targetId = parseHex(target, 32, "target");
    if (equalBytes(targetId, agent.signer.id)) throw new LocalError("bad_argument", "an agent can't start a session with itself");
    const lookup = await this.#call(() => this.#link.call("lookup", { agent: toB64(agent.signer.id), target: toB64(targetId) })) as { identity: unknown; name: string };
    const identity = identityCodec.decode(lookup.identity, "identity");
    // The id you typed is the check: a server can't substitute other keys under it.
    if (!equalBytes(identityId(identity), targetId)) throw new LocalError("wrong_identity", "the server returned keys that don't match the id you asked for");

    const sessionId = new Uint8Array(randomBytes(16));
    const sessionHex = toHex(sessionId);
    const own = await generateSessionEphemeral();
    const fields = {
      serverId: this.#serverId(),
      sessionId,
      callerId: agent.signer.id,
      calleeId: targetId,
      x25519Public: own.publicKey,
      mlKemPublic: own.mlKemPublic,
      expiresAt: Date.now() + this.#settings.offer_lifetime_minutes * 60_000,
    };
    const signature = await agent.signer.sign("cello-v2-session-offer", offerBytes(fields));
    const offer = signedOffer.encode({ fields, signature });
    const activated = new Promise<void>((resolve) => this.#activation.set(agent.hex + sessionHex, resolve));
    await this.#lane(agentHex, sessionHex, async () => {
      this.#store.insertSession({
        agent_id: agent.signer.id,
        session_id: sessionId,
        role: "caller",
        counterparty_id: targetId,
        counterparty_name: lookup.name,
        counterparty_keys: JSON.stringify(lookup.identity),
        state: "offered",
        offer: JSON.stringify(offer),
        x25519_secret: own.secretKey,
        mlkem_seed: own.mlKemSeed,
      });
      await this.#call(() => this.#link.call("session.offer", { agent: toB64(agent.signer.id), offer }));
    });
    this.governance.engaged(agent.signer.id, targetId, "initiated");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([activated, new Promise((resolve) => { timer = setTimeout(resolve, INITIATE_WAIT_MS); })]);
    clearTimeout(timer);
    this.#activation.delete(agent.hex + sessionHex);
    const state = (this.#store.session(agent.signer.id, sessionId) as SessionRow).state;
    return { session_id: sessionHex, state: state === "active" ? "active" : "waiting", counterparty: lookup.name };
  }

  async #call(work: () => Promise<unknown>): Promise<unknown> {
    try {
      return await work();
    } catch (err: unknown) {
      if (err instanceof ServerRefused) throw new LocalError(err.code, err.message);
      if (err instanceof ServerUnreachable) throw new LocalError("server_unreachable", err.message);
      throw err;
    }
  }

  // Reading changes nothing. Only commit() moves the position, and the daemon calls it after the reply is written,
  // so a caller that hangs up first leaves the messages unread. An operator's look at a record never moves it either.
  receive(agentHex: string, sessionHex?: string): { result: unknown; commit(): void } {
    const agent = this.#requireAgent(agentHex);
    const sessions = sessionHex ? [this.#requireSession(agent, sessionHex)] : this.#store.sessionsOf(agent.signer.id);
    const messages: unknown[] = [];
    const reads: { sessionId: Uint8Array; through: number }[] = [];
    const screening: unknown[] = [];
    const policies: unknown[] = [];
    let room = MAX_REPLY_BYTES;
    let more = false;
    for (const local of sessions) {
      if (room <= 0) {
        more ||= this.#store.deliverableCount(agent.signer.id, local.session_id, local.read_position) > 0;
        continue;
      }
      const page = this.#store.unreadPage(agent.signer.id, local.session_id, local.read_position, room);
      const unread = page.rows;
      more ||= page.more;
      for (const row of unread) {
        room -= row.body.length;
        const closing = signedEntry.decode(JSON.parse(row.entry)).fields.kind === EntryKind.close;
        messages.push({
          session_id: toHex(local.session_id),
          from: this.#who(agent, local),
          from_id: toHex(local.counterparty_id),
          position: row.position,
          ...shownMessage(row, closing),
        });
      }
      if (unread.length > 0) {
        reads.push({ sessionId: local.session_id, through: (unread.at(-1) as EntryRow).position as number });
        const conduct = this.governance.conductFor(agent.signer.id, toHex(local.session_id), toHex(local.counterparty_id), this.governance.contacts.tierOf(agent.signer.id, local.counterparty_id), unread.length);
        if (Object.keys(conduct).length > 0) policies.push({ session_id: toHex(local.session_id), ...conduct });
      }
      const held = this.#screening.waiting(agent.hex, toHex(local.session_id));
      if (held) screening.push({ session_id: toHex(local.session_id), ...held });
    }
    const notices = this.#store.notices(agent.signer.id);
    return {
      result: { messages, notices: notices.map((n) => ({ session_id: n.session_id ? toHex(n.session_id) : null, text: n.text })), ...(screening.length > 0 ? { still_screening: screening } : {}), ...(policies.length > 0 ? { policies } : {}), ...(more ? { more: true } : {}) },
      commit: () => {
        this.#store.transaction(() => {
          for (const read of reads) {
            // Two reads can overlap, so a position only ever moves forward.
            const current = this.#store.session(agent.signer.id, read.sessionId) as SessionRow;
            if (read.through > current.read_position) this.#store.updateSession(agent.signer.id, read.sessionId, { read_position: read.through });
          }
          if (notices.length > 0) this.#store.clearNotices(agent.signer.id, (notices.at(-1) as { id: number }).id);
        });
      },
    };
  }

  // These four only read. None moves a read position, so looking never counts as reading.
  agents(): unknown {
    return {
      agents: [...this.#agents.values()].map((agent) => ({ name: agent.name, agent_id: agent.hex, registered: agent.registered, online: agent.online, unread: this.unreadCount(agent.hex) })),
    };
  }

  sessions(agentHex: string, includeClosed: boolean): unknown {
    const agent = this.#requireAgent(agentHex);
    const rows = this.#store.sessionsOf(agent.signer.id).filter((s) => includeClosed || s.state !== "closed");
    return {
      sessions: rows.map((s) => ({
        session_id: toHex(s.session_id),
        with: this.#who(agent, s),
        with_id: toHex(s.counterparty_id),
        tier: tierName(this.governance.contacts.tierOf(agent.signer.id, s.counterparty_id)),
        ...(this.#agents.has(toHex(s.counterparty_id)) ? { same_daemon: true } : {}),
        bytes_received: s.bytes_received,
        byte_limit: this.governance.reach.limitsFor(agent.signer.id, this.governance.contacts.tierOf(agent.signer.id, s.counterparty_id)).max_bytes,
        ...(s.role === "callee" ? this.governance.admissionFor(agent.signer.id, toHex(s.counterparty_id), this.governance.contacts.tierOf(agent.signer.id, s.counterparty_id)) : {}),
        state: s.state,
        position: s.verified_position,
        unread: this.#store.unreadCount(agent.signer.id, s.session_id, s.read_position),
        own_closed: s.own_closed === 1,
        peer_closed: s.peer_closed === 1,
        fault: s.fault,
        standbys: this.#standbyView(agent, s),
        screening: this.#sessionScreening(agent, s),
      })),
    };
  }

  // Who has written and how much, with none of the text.
  inbox(agentHex: string): unknown {
    const agent = this.#requireAgent(agentHex);
    const waiting = this.#store.sessionsOf(agent.signer.id).flatMap((s) => {
      const unread = this.#store.unreadCount(agent.signer.id, s.session_id, s.read_position);
      const held = this.#screening.waiting(agent.hex, toHex(s.session_id));
      return unread > 0 ? [{ session_id: toHex(s.session_id), from: s.counterparty_name, from_id: toHex(s.counterparty_id), unread, ready: this.#store.deliverableCount(agent.signer.id, s.session_id, s.read_position), ...(held ? { still_screening: held } : {}) }] : [];
    });
    return { waiting, notices: this.#store.notices(agent.signer.id).length };
  }

  // Everything this agent holds of a conversation, its own messages included, in the order the server set.
  transcript(agentHex: string, sessionHex: string, after = 0): unknown {
    const agent = this.#requireAgent(agentHex);
    const local = this.#requireSession(agent, sessionHex);
    const page = this.#store.recordPage(agent.signer.id, local.session_id, after, local.verified_position, MAX_REPLY_BYTES);
    // An agent can call this, so it's a way of reading: nothing unscreened or blocked comes through it either.
    const entries = page.rows.map((row) => {
      const closing = signedEntry.decode(JSON.parse(row.entry)).fields.kind === EntryKind.close;
      return {
        position: row.position,
        from: row.own === 1 ? agent.name : local.counterparty_name,
        from_id: toHex(row.own === 1 ? agent.signer.id : local.counterparty_id),
        own: row.own === 1,
        ...shownMessage(row, closing),
      };
    });
    return { session_id: toHex(local.session_id), with: local.counterparty_name, with_id: toHex(local.counterparty_id), state: local.state, read_position: local.read_position, entries, ...(page.more ? { more: true } : {}) };
  }

  // What can be read right now. A message still being screened isn't in it, or a caller would be told to read and find nothing.
  unreadCount(agentHex: string): number {
    const agent = this.#requireAgent(agentHex);
    const messages = this.#store.sessionsOf(agent.signer.id).reduce((sum, s) => sum + this.#store.deliverableCount(agent.signer.id, s.session_id, s.read_position), 0);
    return messages + this.#store.notices(agent.signer.id).length;
  }

  // Checks this agent's own record, using only public keys.
  async verifySession(agentHex: string, sessionHex: string): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    const local = this.#requireSession(agent, sessionHex);
    const items: WitnessedEntry[] = this.#store.signedRecord(agent.signer.id, local.session_id, local.verified_position).map((row) => {
      const entry = signedEntry.decode(JSON.parse(row.entry));
      const ack = signedAck.decode(JSON.parse(row.ack as string));
      return { fields: entry.fields, signature: entry.signature, ack: ack.fields, ackSignature: ack.signature };
    });
    const report = await verifyTranscript({ sessionId: local.session_id, server: this.#serverIdentity(), participants: [agent.signer.publicIdentity, this.#counterpartyKeys(local)] }, items);
    return { ok: report.ok, position: report.position, root: toHex(report.root), fault: report.fault ?? null, fault_at: report.faultAt ?? null };
  }

  status(): unknown {
    return {
      server: this.#url,
      connected: this.#link.ready,
      problem: this.#link.problem,
      screening: this.screeningFacts(),
      agents: [...this.#agents.values()].map((agent) => ({
        name: agent.name,
        agent_id: agent.hex,
        registered: agent.registered,
        online: agent.online,
        unread: this.unreadCount(agent.hex),
        sessions: this.#store.sessionsOf(agent.signer.id).map((s) => ({
          session_id: toHex(s.session_id),
          with: s.counterparty_name,
          with_id: toHex(s.counterparty_id),
          state: s.state,
          position: s.verified_position,
          read_position: s.read_position,
          own_closed: s.own_closed === 1,
          peer_closed: s.peer_closed === 1,
          fault: s.fault,
          standbys: this.#standbyView(agent, s),
          screening: this.#sessionScreening(agent, s),
        })),
      })),
    };
  }
}

// The owner's node: keys, conversations and recovery. Durable state decides everything.
// After any restart, the same catch-up path runs: resend what's pending, then read from position.
import { createHash, randomBytes } from "node:crypto";
import { openSessionContent, sealSessionContent } from "../protocol/aead.ts";
import { ChainVerifier, type ChainFault, type WitnessedEntry, provesTwoAcks, verifyTranscript, witnessed } from "../protocol/chain.ts";
import { ZERO_HASH, equalBytes, toHex } from "../protocol/encode.ts";
import { type PublicIdentity, type Signer, generateIdentitySeeds, identityId, signerFromSeeds, verifySignature } from "../protocol/identity.ts";
import { deriveSessionSecrets, destroySessionEphemeral, generateSessionEphemeral } from "../protocol/key-agreement.ts";
import { verifyConsistency } from "../protocol/merkle.ts";
import { mlKemDecapsulate, mlKemEncapsulate } from "../protocol/ml-kem.ts";
import { deriveSessionSalt, generateSaltContribution, saltedContentHash } from "../protocol/salt.ts";
import { type SealRecord, type SealRecordOnWire, checkSealRecord, decodeSealRecord, describeSeal, sealId, sealSummary } from "../protocol/seal.ts";
import { type ReasonName, STATUS_DOMAIN, type StatusName, type StatusRecordOnWire, checkStatusLog } from "../protocol/status.ts";
import { buildTranscript } from "../protocol/transcript.ts";
import {
  AgentStatus,
  StatusIssuer,
  StatusReason,
  statusStatementBytes,
  type AssignmentFields,
  EntryKind,
  EntryMode,
  type EntryFields,
  type OfferFields,
  acceptBytes,
  refuseBytes,
  agentAuthBytes,
  ciphertextHash,
  confirmBytes,
  deliveryAckBytes,
  entryBytes,
  entryHash,
  greetingBytes,
  offerBytes,
  registerBytes,
  sealRequestBytes,
  structureHash,
  type Body,
  MAX_REFUSED_POSITIONS,
  bodyBytes,
  refusedList,
  readBodyBytes,
} from "../protocol/structures.ts";
import {
  LONG_CIPHERTEXT_BYTES,
  MAX_CIPHERTEXT_BYTES,
  MAX_GREETING_BYTES,
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
  signedGreeting,
  signedOffer,
  signedRefuse,
  signedSealRequest,
  signedStatusStatement,
  toB64,
} from "../protocol/wire.ts";
import { Away, type GreetingRow, ONE_MESSAGE_LINE } from "./away.ts";
import { LocalError, requirePerson } from "./errors.ts";
import { Governance, REFUSAL_SENTENCES, type RefusalCode } from "./governance.ts";
import { validateMoniker } from "./who-label.ts";
import type { ChannelHost } from "./channels.ts";
import { PlainTextServer, formatAddress, parseAddress, serverUrlFrom } from "./address.ts";
import { type ConnectedServer, ServerLink, ServerRefused, ServerUnreachable } from "./link.ts";
import { logEvent } from "./log.ts";
import { OutboundRateLimiter } from "./rate-limit.ts";
import { type LanguageGuard, type ModelFact, OutboundScreen, type ScreenJob, type ScreeningLevel, ScreeningQueue } from "./screening.ts";
import { type Settings, loadSettings } from "./settings.ts";
import { TIER, tierName } from "./tiers.ts";
import type { AgentStatusRow, EntryRow, SessionRow, Store } from "./store.ts";
import type { InboundVerdict } from "../screener/inbound.ts";

const SEND_WINDOW_MS = 10 * 60 * 1000;
const INITIATE_WAIT_MS = 20_000;
const POSITION_CHECK_MS = 30_000;
const AUTH_RETRY_MS = 5_000;
// How long a person waits for each server to hear of a status change before being told which it hasn't reached. It keeps trying.
const STATUS_TELL_MS = 5_000;
// How long a send waits for its long upload before saying "not sent yet" and leaving it to carry on.
const LONG_SEND_PATIENCE_MS = 20_000;
// As long as a signed entry stays valid. A dead connection shows sooner, as silence.
const LONG_CALL_TIMEOUT_MS = SEND_WINDOW_MS;
const STILL_UPLOADING = Symbol("still uploading");
// One reply's message text. Replies are built whole on the one thread every agent shares, and a string can't pass about 512 MB.
const MAX_REPLY_BYTES = 8_000_000;
export const CONFIG_SERVER_URL = "server_url";
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

const greetingKey = (contentKey: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update("cello-session-greeting").update(contentKey).digest());
const refusalKey = (sharedSecret: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update("cello-session-refusal").update(sharedSecret).digest());

// Only these words ever come out of a refusal, whatever the other side put in it.
function refusalSentence(opened: Uint8Array | null): string {
  const fallback = "This agent refused the call.";
  if (!opened) return fallback;
  let parsed: { code?: unknown; limit?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(opened)) as typeof parsed;
  } catch {
    return fallback;
  }
  if (typeof parsed.code !== "string" || !Object.hasOwn(REFUSAL_SENTENCES, parsed.code)) return fallback;
  const sentence = REFUSAL_SENTENCES[parsed.code as RefusalCode];
  return Number.isSafeInteger(parsed.limit) ? `${sentence} The limit is ${parsed.limit as number}.` : sentence;
}

export { LocalError };

export const SIGNALS = ["over", "standby", "wrap"] as const;
export type Signal = (typeof SIGNALS)[number];

export interface Doorbell {
  type: "session_started" | "message" | "peer_closed" | "session_closed" | "notice" | "standby_overdue" | "screening_delayed" | "away_greeting" | "channel_post" | "channel_notice" | "channel_request" | "agent_status";
  // Your own operator's admission policy for this caller. It's the one place a doorbell carries text, and no other party wrote it.
  policy?: unknown;
  policy_error?: string;
  agent: string;
  session_id?: string;
  from_id?: string;
  channel_id?: string;
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
  statuses: Map<string, AgentStatusRow>;
}

interface Standing { status: AgentStatusRow["status"]; reason: string; record: StatusRecordOnWire | null }

function parseHex(value: unknown, bytes: number, name: string): Uint8Array {
  if (typeof value !== "string" || value.length !== bytes * 2 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new LocalError("bad_argument", `${name} must be ${bytes * 2} hex characters`);
  }
  return new Uint8Array(Buffer.from(value, "hex"));
}

const parseBody = readBodyBytes;
const UNVERIFIABLE_REASON = "its text isn't what its author signed";

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
  | { status: "pending"; uploading?: true }
  | { status: "refused"; code: string; message: string };

export interface EngineEvents {
  ring(agentHex: string, bell: Doorbell): void;
  channelPush(frame: PushFrame): void;
  // Whether anyone holds this agent right now. The away greeting and the doorbell go by the same answer.
  reachable(agentHex: string): boolean;
}

// A way to a server. The home route is the server this daemon logged in to, where its agents live and can be called.
// Any other is a server hosting a conversation one of these agents started. Only a caller's own act opens one:
// nothing arriving from outside can make this daemon dial anywhere, so a stranger can't learn where it is.
interface Route {
  url: string;
  home: boolean;
  link: ServerLink;
  // The second connection, for long messages only, so moving one can't hold up anyone's short ones.
  longLink: ServerLink;
  longServer: ConnectedServer | undefined;
  longProved: Set<string>;
  server: ConnectedServer | undefined;
  // On a visit: the agents that have a conversation here, and those that have proved their keys on this connection.
  wanted: Set<string>;
  online: Set<string>;
  visits: Map<string, Promise<void>>;
  // Calls being set up, which have no session row yet to keep this route open.
  opening: number;
}

function notSealedYet(reason: string): unknown {
  return { sealed: false, status: "not_sealed_yet", message: `This isn't sealed yet: ${reason}. The request is saved and retried by itself, and you'll get a notice.` };
}

export class Engine {
  readonly #store: Store;
  readonly #events: EngineEvents;
  readonly #link: ServerLink;
  // Long uploads under way, by entry row. Each outlives the send that started it, so a retry never sends it twice.
  readonly #uploads = new Map<number, { finished: Promise<unknown>; done: boolean }>();
  readonly #url: string;
  readonly #home: Route;
  readonly #visiting = new Map<string, Route>();
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
  // Below zero, so a channel's job can't share an id with an entry's.
  #nextChannelJob = 0;
  readonly #ackTimers = new Map<string, NodeJS.Timeout>();
  readonly #rates = new Map<string, { max: number; window: number; limiter: OutboundRateLimiter }>();
  readonly #refusals = new Map<string, string>();
  readonly governance: Governance;
  readonly #away: Away;
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
    this.#away = new Away(store);
    this.#screening = new ScreeningQueue({
      load: (job) => this.#loadForScreen(job),
      verdict: (job, verdict) => this.#onVerdict(job, verdict),
      delayed: (job, aboutSeconds) => this.#onScreenDelayed(job, aboutSeconds),
      workerCrashed: (message, waiting) => this.#onWorkerCrashed(message, waiting),
      modelChecked: (model) => this.#onModelChecked(model),
    }, this.#settings);
    this.#link = new ServerLink(url, {
      checkIdentity: (identity) => this.#checkServerIdentity(identity, url),
      connected: async (server) => {
        this.#server = server;
        for (const agent of this.#agents.values()) void this.#bringOnline(agent, server);
      },
      disconnected: () => {
        this.#server = undefined;
        for (const agent of this.#agents.values()) agent.online = false;
      },
      push: (frame) => this.#onPush(frame, this.#home),
    });
    this.#home = { url, home: true, link: this.#link, longLink: this.#longLinkTo(url, () => this.#home), longServer: undefined, longProved: new Set(), server: undefined, wanted: new Set(), online: new Set(), visits: new Map(), opening: 0 };
  }

  async start(): Promise<void> {
    const pinned = this.#store.getConfig(CONFIG_SERVER_URL);
    if (pinned && pinned !== this.#url) throw new LocalError("server_changed", `this data belongs to ${pinned}, not ${this.#url}. Use a separate CELLO_V2_HOME.`);
    this.#store.setConfig(CONFIG_SERVER_URL, this.#url);
    for (const row of this.#store.agents()) {
      const signer = await signerFromSeeds({ ed: row.ed_seed, pq: row.pq_seed });
      const statuses = new Map(this.#store.statusRows(signer.id).map((status) => [status.server_url, status]));
      this.#agents.set(toHex(signer.id), { signer, hex: toHex(signer.id), name: row.name, registered: row.registered === 1, online: false, statuses });
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
    this.#retryOutbox();
    this.#home.longLink.start();
    for (const row of this.#away.unscreened()) this.#screenGreeting(row);
    // Back to every conversation hosted elsewhere, because a restart doesn't end one.
    for (const agent of this.#agents.values()) {
      for (const local of this.#store.sessionsOf(agent.signer.id)) {
        if (local.server_url && !this.#visitFinished(agent, local)) this.#routeFor(agent, local);
      }
    }
    // Pushes are hints. This catches a lost one, so it costs seconds rather than a conversation.
    this.#positionCheck = setInterval(() => {
      this.#catchUpEverywhere();
      this.#retryOutbox();
      this.#retireIdleVisits();
    }, POSITION_CHECK_MS);
  }

  stop(): void {
    clearInterval(this.#positionCheck);
    clearTimeout(this.#standbyCheck);
    for (const timer of this.#ackTimers.values()) clearTimeout(timer);
    this.#screening.stop();
    this.#outbound.stop();
    this.#link.stop();
    this.#home.longLink.stop();
    for (const route of this.#visiting.values()) {
      route.link.stop();
      route.longLink.stop();
    }
  }

  #longLinkTo(url: string, route: () => Route): ServerLink {
    return new ServerLink(url, {
      checkIdentity: (identity) => this.#checkServerIdentity(identity, url),
      connected: async (server) => {
        route().longServer = server;
        route().longProved.clear();
      },
      disconnected: () => { route().longServer = undefined; },
      // The server only ever pushes on the connection an agent came online on.
      push: () => undefined,
    }, "server_long");
  }

  // Each call still names its agent. Proof is per agent and per connection, so an agent proves itself here the first time it needs to.
  // It goes to the server hosting the conversation, which on a visit isn't this daemon's own.
  async #longCall(agent: AgentContext, route: Route, method: string, params: unknown): Promise<unknown> {
    const server = route.longServer;
    if (!server) throw new ServerUnreachable(route.longLink.problem ?? "the connection for long messages isn't up");
    if (!route.longProved.has(agent.hex)) {
      if (route.home) {
        const clientNonce = new Uint8Array(randomBytes(32));
        const proof = agentAuthBytes({ serverId: server.id, agentId: agent.signer.id, serverNonce: server.nonce, clientNonce });
        const signature = await agent.signer.sign("cello-agent-auth", proof);
        await route.longLink.call("auth", { agentId: toB64(agent.signer.id), clientNonce: toB64(clientNonce), signature: signatureCodec.encode(signature), long: true }, LONG_CALL_TIMEOUT_MS);
      } else {
        await route.longLink.call("visit", { ...await this.#visitProof(agent, server), long: true }, LONG_CALL_TIMEOUT_MS);
      }
      if (route.longServer === server) route.longProved.add(agent.hex);
    }
    return route.longLink.call(method, params, LONG_CALL_TIMEOUT_MS);
  }

  // ---- Screening. A verdict goes on the entry, and it's the only thing that makes a message deliverable. ----

  #loadForScreen(job: ScreenJob): { body: Uint8Array; level: ScreeningLevel; language: LanguageGuard } | null {
    if (job.channelText) {
      const reader = this.#agents.get(job.agentHex);
      if (!reader) return null;
      const guards = this.governance.guards;
      return { body: job.channelText.bytes, level: this.governance.screeningRule(reader.signer.id, job.senderHex).level, language: { enforce: guards.value<boolean>(reader.signer.id, "language_enforce"), allow: guards.value<string[]>(reader.signer.id, "language_allow") } };
    }
    const body = this.#store.bodyOf(job.entryId);
    const agent = this.#agents.get(job.agentHex);
    if (!body || !agent) return null;
    const language = { enforce: this.governance.guards.value<boolean>(agent.signer.id, "language_enforce"), allow: this.governance.guards.value<string[]>(agent.signer.id, "language_allow") };
    return { body, level: this.governance.screeningRule(agent.signer.id, job.senderHex).level, language };
  }

  // The doorbell comes after the write, so anyone it wakes finds the message there.
  #onVerdict(job: ScreenJob, verdict: InboundVerdict): void {
    if (job.channelText) {
      job.channelText.done(verdict);
      return;
    }
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
    // A channel has no sender waiting on this reader, and its reader is told by channel_read.
    if (job.channelText) return;
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

  async #visitProof(agent: AgentContext, server: ConnectedServer): Promise<Record<string, unknown>> {
    const identity = agent.signer.publicIdentity;
    const clientNonce = new Uint8Array(randomBytes(32));
    return {
      identity: identityCodec.encode(identity),
      clientNonce: toB64(clientNonce),
      nameSignature: signatureCodec.encode(await agent.signer.sign("cello-visit", registerBytes({ serverId: server.id, identity }))),
      signature: signatureCodec.encode(await agent.signer.sign("cello-agent-auth", agentAuthBytes({ serverId: server.id, agentId: agent.signer.id, serverNonce: server.nonce, clientNonce }))),
    };
  }

  // ---- Servers other than this daemon's own ----

  #pinKey(key: string, url: string): string {
    return url === this.#url ? key : `${key}:${url}`;
  }

  #urlOf(local: SessionRow): string {
    return local.server_url ?? this.#url;
  }

  #visitRoute(url: string): Route {
    const existing = this.#visiting.get(url);
    if (existing) return existing;
    const route: Route = {
      url,
      home: false,
      server: undefined,
      wanted: new Set(),
      online: new Set(),
      visits: new Map(),
      opening: 0,
      longLink: this.#longLinkTo(url, () => route),
      longServer: undefined,
      longProved: new Set(),
      link: new ServerLink(url, {
        checkIdentity: (identity) => this.#checkServerIdentity(identity, url),
        connected: async (server) => {
          route.server = server;
          this.#flushOutbox(route);
          for (const hex of route.wanted) this.#wantVisit(route, this.#requireAgent(hex));
        },
        disconnected: () => {
          route.server = undefined;
          route.online.clear();
        },
        push: (frame) => this.#onPush(frame, route),
      }),
    };
    this.#visiting.set(url, route);
    route.link.start();
    route.longLink.start();
    return route;
  }

  #routeFor(agent: AgentContext, local: SessionRow): Route {
    if (!local.server_url) return this.#home;
    const route = this.#visitRoute(local.server_url);
    this.#wantVisit(route, agent);
    return route;
  }

  #wantVisit(route: Route, agent: AgentContext): void {
    if (this.#stopAt(agent, route.url)?.status === "retired") return;
    route.wanted.add(agent.hex);
    if (route.server && !route.online.has(agent.hex)) this.#background("visit", this.#visit(route, agent));
  }

  #visit(route: Route, agent: AgentContext): Promise<void> {
    const running = route.visits.get(agent.hex);
    if (running) return running;
    const started = this.#visitOnce(route, agent).finally(() => route.visits.delete(agent.hex));
    route.visits.set(agent.hex, started);
    return started;
  }

  // Keys alone are enough: the other server needs no enrolment and doesn't ask anyone about this agent.
  async #visitOnce(route: Route, agent: AgentContext): Promise<void> {
    const server = route.server;
    while (server && route.server === server) {
      try {
        const answer = await route.link.call("visit", await this.#visitProof(agent, server)) as { standing: Standing };
        route.online.add(agent.hex);
        logEvent("agent.visiting", { agent: agent.hex, server: toHex(server.id) });
        this.#noteStanding(agent, route, answer.standing);
        await this.#catchUpAgent(agent, route);
        return;
      } catch (err: unknown) {
        if (err instanceof ServerRefused && err.code === "agent_retired") {
          this.#noteStanding(agent, route, { status: "retired", reason: "none", record: null });
          return;
        }
        // After an unclean drop, the server holds the old connection until its heartbeat ends it.
        if (!(err instanceof ServerRefused) || err.code !== "agent_already_connected") throw err;
        await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_MS));
      }
    }
  }

  #isOnline(agent: AgentContext, route: Route): boolean {
    return route.home ? agent.online : route.online.has(agent.hex);
  }

  #doneOpening(route: Route): void {
    route.opening--;
    this.#retireIdleVisits();
  }

  // The way to the server a new call goes to, ready to use, or a failure naming why not.
  // The caller of this holds the route open, and lets go with #doneOpening.
  async #reach(agent: AgentContext, url: string | undefined): Promise<Route> {
    const home = (): Route => {
      this.#home.opening++;
      return this.#home;
    };
    if (!url || url === serverUrlFrom(this.#url)) return home();
    const route = this.#visitRoute(url);
    route.opening++;
    route.wanted.add(agent.hex);
    try {
      const deadline = Date.now() + INITIATE_WAIT_MS;
      while (!route.server && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!route.server) throw new LocalError("server_unreachable", `can't reach ${url}: ${route.link.problem ?? "it didn't answer"}`);
      // This daemon's own server under another address. It's where these agents already live.
      if (this.#store.getConfig(CONFIG_SERVER_IDENTITY) && equalBytes(route.server.id, this.#serverId())) {
        route.wanted.delete(agent.hex);
        this.#doneOpening(route);
        return home();
      }
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LocalError("server_unreachable", `${url} didn't take this agent's proof of identity in time`)), INITIATE_WAIT_MS); });
      try {
        await Promise.race([this.#call(() => this.#visit(route, agent)), late]);
      } finally {
        clearTimeout(timer);
      }
      return route;
    } catch (err) {
      this.#doneOpening(route);
      throw err;
    }
  }

  #visitFinished(agent: AgentContext, local: SessionRow): boolean {
    if (this.#stopAt(agent, this.#urlOf(local))?.status === "retired") return true;
    if (local.state === "offered") return signedOffer.decode(JSON.parse(local.offer)).fields.expiresAt <= Date.now() && this.#store.pendingEntries(agent.signer.id, local.session_id).length === 0;
    return local.state === "closed"
      && this.#store.sealWants(agent.signer.id, local.session_id).length === 0
      && this.#store.pendingEntries(agent.signer.id, local.session_id).length === 0
      && local.delivered_through >= this.#latestFromPeer(agent, local);
  }

  // A visit is for its conversations, so the connection goes once they have nothing left to do. A later seal reopens it.
  #retireIdleVisits(): void {
    for (const route of this.#visiting.values()) {
      if (route.opening > 0) continue;
      const busy = [...this.#agents.values()].some((agent) => this.#store.sessionsOf(agent.signer.id).some((local) => local.server_url === route.url && !this.#visitFinished(agent, local)));
      if (busy || this.#store.outbox(route.url).length > 0) continue;
      route.link.stop();
      route.longLink.stop();
      this.#visiting.delete(route.url);
      logEvent("server.visit_ended", { server: route.server ? toHex(route.server.id) : null });
    }
  }

  #catchUpEverywhere(only?: AgentContext): void {
    for (const agent of this.#agents.values()) {
      if (only && agent !== only) continue;
      if (agent.online) void this.#catchUpAgent(agent, this.#home);
      for (const route of this.#visiting.values()) if (route.online.has(agent.hex)) void this.#catchUpAgent(agent, route);
    }
  }

  #checkServerIdentity(identity: PublicIdentity, url: string): string | null {
    const encoded = JSON.stringify(identityCodec.encode(identity));
    const pinned = this.#store.getConfig(this.#pinKey(CONFIG_SERVER_IDENTITY, url));
    if (!pinned) {
      this.#store.setConfig(this.#pinKey(CONFIG_SERVER_IDENTITY, url), encoded);
      return null;
    }
    return pinned === encoded ? null : "this server's identity keys have changed since first contact, so its signatures can't be trusted";
  }

  #serverIdentity(url: string = this.#url): PublicIdentity {
    const pinned = this.#store.getConfig(this.#pinKey(CONFIG_SERVER_IDENTITY, url));
    if (!pinned) throw new LocalError("server_unreachable", "this daemon hasn't reached that server yet");
    return identityCodec.decode(JSON.parse(pinned), "pinned server identity");
  }

  #serverId(url: string = this.#url): Uint8Array {
    return identityId(this.#serverIdentity(url));
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
          const signature = await agent.signer.sign("cello-agent-auth", proof);
          const answer = await this.#link.call("auth", { agentId: toB64(agent.signer.id), clientNonce: toB64(clientNonce), signature: signatureCodec.encode(signature) }) as { standing: Standing };
          agent.online = true;
          logEvent("agent.online", { agent: agent.hex });
          this.#noteStanding(agent, this.#home, answer.standing);
          this.#flushOutbox(this.#home);
          await this.#catchUpAgent(agent);
          return;
        } catch (err: unknown) {
          if (err instanceof ServerRefused && err.code === "agent_retired") {
            this.#noteStanding(agent, this.#home, { status: "retired", reason: "none", record: null });
            this.#flushOutbox(this.#home);
            return;
          }
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
    const signature = await agent.signer.sign("cello-register", registerBytes({ serverId: this.#serverId(), identity }));
    await this.#link.call("register", { identity: identityCodec.encode(identity), signature: signatureCodec.encode(signature) });
    this.#store.markRegistered(agent.signer.id);
    agent.registered = true;
    logEvent("agent.registered", { agent: agent.hex });
  }

  async #catchUpAgent(agent: AgentContext, route: Route = this.#home): Promise<void> {
    try {
      const stop = this.#stopAt(agent, route.url);
      if (stop) {
        // Stopped, it can't read or send, and the server won't list anything. What it may still do is finish a seal it asked for.
        if (stop.status === "suspended") {
          for (const local of this.#store.sessionsOf(agent.signer.id)) {
            if (this.#urlOf(local) !== route.url || this.#store.sealWants(agent.signer.id, local.session_id).length === 0) continue;
            this.#background("seal while suspended", this.#lane(agent.hex, toHex(local.session_id), () => this.#retrySeals(agent, local.session_id)));
          }
        }
        return;
      }
      const listedAt = Date.now();
      const listed = await route.link.call("session.list", { agent: toB64(agent.signer.id) }) as { sessions: SessionOnWire[] };
      const seen = new Set<string>();
      for (const wire of listed.sessions) {
        const sessionId = signedOffer.decode(wire.offer).fields.sessionId;
        const sessionHex = toHex(sessionId);
        seen.add(sessionHex);
        this.#background("session update", this.#lane(agent.hex, sessionHex, async () => {
          await this.#onSessionWire(agent, wire, route);
          this.#tellLatePeer(agent, sessionId, listedAt, wire.tip);
        }));
      }
      // An offer written to disk just before a crash may never have reached the server.
      for (const row of this.#store.sessionsOf(agent.signer.id)) {
        const sessionHex = toHex(row.session_id);
        if (seen.has(sessionHex) || row.state !== "offered" || this.#urlOf(row) !== route.url) continue;
        this.#background("offer resend", route.link.call("session.offer", { agent: toB64(agent.signer.id), offer: JSON.parse(row.offer) }));
      }
    } catch (err: unknown) {
      logEvent("agent.catch_up_failed", { agent: agent.hex, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Frames come from outside, and one bad frame mustn't take down every agent on this daemon.
  #onPush(frame: PushFrame, route: Route): void {
    try {
      const agent = this.#agents.get(frame.agent);
      if (!agent) return;
      if (frame.push === "status") {
        this.#noteStanding(agent, route, frame.data as Standing);
        return;
      }
      if (frame.push === "channel") {
        this.#events.channelPush(frame);
        return;
      }
      if (frame.push === "session") {
        const wire = frame.data as SessionOnWire;
        const sessionHex = toHex(signedOffer.decode(wire.offer).fields.sessionId);
        this.#background("session push", this.#lane(agent.hex, sessionHex, () => this.#onSessionWire(agent, wire, route)));
        return;
      }
      if (frame.push === "delivery") {
        const { deliveryAck: wire, screeningEtaSeconds } = frame.data as { deliveryAck: WireSigned; screeningEtaSeconds: unknown };
        const sessionHex = toHex(signedDeliveryAck.decode(wire, "deliveryAck").fields.sessionId);
        this.#background("delivery push", this.#lane(agent.hex, sessionHex, () => this.#onPeerDeliveryAck(agent, wire, screeningEtaSeconds)));
        return;
      }
      const item = frame.data as WitnessedOnWire;
      const sessionHex = toHex(signedEntry.decode(item.entry).fields.sessionId);
      this.#background("entry push", this.#lane(agent.hex, sessionHex, () => this.#onEntryPush(agent, item, route)));
    } catch (err: unknown) {
      logEvent("server.bad_push", { kind: frame.push, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---- Session setup ----

  async #onSessionWire(agent: AgentContext, wire: SessionOnWire, route: Route): Promise<void> {
    const offer = signedOffer.decode(wire.offer, "offer");
    const sessionId = offer.fields.sessionId;
    let local = this.#store.session(agent.signer.id, sessionId);
    if (!local) {
      if (!equalBytes(offer.fields.calleeId, agent.signer.id)) {
        logEvent("session.unknown_as_caller", { agent: agent.hex, session: toHex(sessionId) });
        return;
      }
      // An agent is called only at its own server. Any other server claiming a call for it is making it up.
      if (!route.home) {
        logEvent("session.offer_from_wrong_server", { agent: agent.hex, session: toHex(sessionId) });
        return;
      }
      await this.#acceptOffer(agent, wire);
      return;
    }
    // One server can't speak for a conversation another one hosts.
    if (this.#urlOf(local) !== route.url) {
      logEvent("session.frame_from_wrong_server", { agent: agent.hex, session: toHex(sessionId) });
      return;
    }
    const stopped = wire.stopped === true;
    if (stopped !== this.#store.isStopped(agent.signer.id, sessionId)) {
      this.#store.setStopped(agent.signer.id, sessionId, stopped);
      this.#notify(agent, sessionId, stopped ? "This conversation has stopped. What you hold is safe, and you can still seal it." : "This conversation can carry on.");
    }
    if (local.role === "caller") {
      if (local.state === "offered" && wire.refusal) {
        await this.#onRefused(agent, local, wire.refusal);
        return;
      }
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
    if (local.role === "caller" && wire.greeting && local.session_key) await this.#onGreeting(agent, local, wire.greeting);
    if (local.role === "callee" && local.state === "active") await this.#greetIfDue(agent, local);
    if (local.state === "active" || local.state === "closed") {
      const hasWork = wire.tip > local.verified_position || this.#store.pendingEntries(agent.signer.id, sessionId).length > 0 || local.fault !== null || local.delivered_through < this.#latestFromPeer(agent, local) || (local.delivered_through > 0 && Math.min(this.#screenedThrough(agent, local), local.delivered_through) > local.acked_screened);
      if (hasWork) await this.#settle(agent, local);
      if (this.#store.sealWants(agent.signer.id, sessionId).length > 0) await this.#retrySeals(agent, sessionId);
    }
  }

  // Tiers and policy aren't in this iteration, so a daemon takes every validly signed call.
  // A definite no: the caller never waits out the offer. No session row is kept here, and the server takes it off this agent's
  // list, so a restart doesn't count it twice. The reason goes to the caller's own key, so the server can't read it.
  async #refuseOffer(agent: AgentContext, offer: Signed<OfferFields>, refusal: { code: RefusalCode; limit?: number }): Promise<void> {
    const { fields } = offer;
    const { ciphertext, sharedSecret } = await mlKemEncapsulate(fields.mlKemPublic);
    const refuseFields = {
      offerHash: structureHash(offer.bytes),
      mlKemCiphertext: ciphertext,
      sealedReason: sealSessionContent(refusalKey(sharedSecret), new TextEncoder().encode(JSON.stringify(refusal))),
    };
    sharedSecret.fill(0);
    const signature = await agent.signer.sign("cello-session-refuse", refuseBytes(refuseFields));
    await this.#link.call("session.refuse", { agent: toB64(agent.signer.id), sessionId: toB64(fields.sessionId), refusal: signedRefuse.encode({ fields: refuseFields, signature }) });
    this.governance.noteRefusal(agent.signer.id, agent.hex, toHex(fields.callerId), refusal.code);
  }

  // What the caller's daemon says it heard. Only a callee's signature can make this happen, and only fixed sentences come out.
  async #onRefused(agent: AgentContext, local: SessionRow, wire: WireSigned): Promise<void> {
    const refusal = signedRefuse.decode(wire, "refusal");
    if (!equalBytes(refusal.fields.offerHash, structureHash(signedOffer.decode(JSON.parse(local.offer)).bytes))) throw new Error("this refusal answers a different offer");
    if (!(await verifySignature(this.#counterpartyKeys(local), "cello-session-refuse", refusal.bytes, refusal.signature))) throw new Error("this refusal isn't signed by the agent called");
    const sharedSecret = await mlKemDecapsulate(local.mlkem_seed as Uint8Array, refusal.fields.mlKemCiphertext);
    const opened = openSessionContent(refusalKey(sharedSecret), refusal.fields.sealedReason);
    sharedSecret.fill(0);
    const sentence = refusalSentence(opened);
    this.#store.updateSession(agent.signer.id, local.session_id, { state: "closed", fault: "refused", x25519_secret: null, mlkem_seed: null });
    const sessionHex = toHex(local.session_id);
    this.#refusals.set(agent.hex + sessionHex, sentence);
    logEvent("session.was_refused", { agent: agent.hex, session: sessionHex });
    this.#notify(agent, local.session_id, `${toHex(local.counterparty_id)} refused this call: ${sentence}`);
    this.#activation.get(agent.hex + sessionHex)?.();
  }

  // One at a time per agent, so a burst of calls can't all pass the count before any of them is on disk.
  async #acceptOffer(agent: AgentContext, wire: SessionOnWire): Promise<void> {
    const offer = signedOffer.decode(wire.offer, "offer");
    const fields = offer.fields;
    const callerKeys = identityCodec.decode(wire.callerIdentity, "callerIdentity");
    if (!equalBytes(identityId(callerKeys), fields.callerId)) throw new Error("the caller's keys don't match the caller's id");
    if (!equalBytes(fields.serverId, this.#serverId())) throw new Error("this offer names a different server");
    if (!(await verifySignature(callerKeys, "cello-session-offer", offer.bytes, offer.signature))) throw new Error("this offer isn't signed by its caller");
    if (fields.expiresAt <= Date.now()) {
      logEvent("session.offer_expired", { session: toHex(fields.sessionId) });
      return;
    }
    const accept = await this.#lane(agent.hex, "gate", () => this.#admitOffer(agent, wire, offer));
    if (!accept) return;
    await this.#link.call("session.accept", { agent: toB64(agent.signer.id), sessionId: toB64(fields.sessionId), accept });
    logEvent("session.accepted", { agent: agent.hex, session: toHex(fields.sessionId) });
  }

  // Tier first, before any key material exists. The new session is on disk when this returns, so the next call counts it.
  async #admitOffer(agent: AgentContext, wire: SessionOnWire, offer: Signed<OfferFields>): Promise<WireSigned | undefined> {
    const { fields } = offer;
    // A stopped agent's tiers don't get a say, and a refused knock isn't counted against the caller.
    this.#refuseIfStopped(agent, this.#url);
    const refusal = this.governance.admit(agent.signer.id, fields.callerId);
    if (refusal) {
      await this.#refuseOffer(agent, offer, refusal);
      return undefined;
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
      offerHash: structureHash(offer.bytes),
      x25519Public: own.publicKey,
      mlKemCiphertext: ciphertext,
      sealedSalt: sealSessionContent(contentKey, salt),
      sealedName: sealSessionContent(contentKey, new TextEncoder().encode(this.governance.offeredName(agent.signer.id, agent.name))),
    };
    const signature = await agent.signer.sign("cello-session-accept", acceptBytes(acceptFields));
    const accept = signedAccept.encode({ fields: acceptFields, signature });
    this.#store.insertSession({
      agent_id: agent.signer.id,
      session_id: fields.sessionId,
      role: "callee",
      counterparty_id: fields.callerId,
      counterparty_name: "",
      counterparty_keys: JSON.stringify(wire.callerIdentity),
      state: "accepted",
      offer: JSON.stringify(wire.offer),
      accept: JSON.stringify(accept),
      session_key: contentKey,
      own_salt: salt,
    });
    destroySessionEphemeral(own);
    sharedSecret.fill(0);
    return accept;
  }

  // A name it gave itself, opened only by the party it's for. One that doesn't fit the rule is no name at all.
  #takeOfferedName(agent: AgentContext, local: SessionRow, key: Uint8Array, sealed: Uint8Array): void {
    const opened = openSessionContent(key, sealed);
    const name = opened ? validateMoniker(new TextDecoder().decode(opened)) : null;
    if (!name) return;
    this.#store.updateSession(agent.signer.id, local.session_id, { counterparty_name: name });
    const renamed = this.governance.contacts.noteOfferedName(agent.signer.id, local.counterparty_id, name);
    if (renamed) this.#notify(agent, local.session_id, renamed);
  }

  async #answerAccept(agent: AgentContext, local: SessionRow, wireAccept: WireSigned): Promise<void> {
    const accept = signedAccept.decode(wireAccept, "accept");
    const keys = this.#counterpartyKeys(local);
    const offerFields = signedOffer.decode(JSON.parse(local.offer)).fields;
    if (!equalBytes(accept.fields.offerHash, structureHash(signedOffer.decode(JSON.parse(local.offer)).bytes))) throw new Error("this accept answers a different offer");
    if (!(await verifySignature(keys, "cello-session-accept", accept.bytes, accept.signature))) throw new Error("this accept isn't signed by the agent called");
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
    this.#takeOfferedName(agent, local, contentKey, accept.fields.sealedName);
    const confirmFields = { acceptHash: structureHash(accept.bytes), sealedSalt: sealSessionContent(contentKey, ownSalt), sealedName: sealSessionContent(contentKey, new TextEncoder().encode(this.governance.offeredName(agent.signer.id, agent.name))) };
    const signature = await agent.signer.sign("cello-session-confirm", confirmBytes(confirmFields));
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
      const result = await this.#routeFor(agent, local).link.call("session.confirm", { agent: toB64(agent.signer.id), sessionId: toB64(local.session_id), confirm: JSON.parse(local.confirm as string) }) as { assignment: WireSigned };
      assignment = result.assignment;
    }
    await this.#activate(agent, local, JSON.parse(local.confirm as string) as WireSigned, assignment, local.salt as Uint8Array);
  }

  async #finishAsCallee(agent: AgentContext, local: SessionRow, wireConfirm: WireSigned, wireAssignment: WireSigned): Promise<void> {
    const confirm = signedConfirm.decode(wireConfirm, "confirm");
    const keys = this.#counterpartyKeys(local);
    if (!equalBytes(confirm.fields.acceptHash, structureHash(signedAccept.decode(JSON.parse(local.accept as string)).bytes))) throw new Error("this confirm answers a different accept");
    if (!(await verifySignature(keys, "cello-session-confirm", confirm.bytes, confirm.signature))) throw new Error("this confirm isn't signed by the caller");
    const peerSalt = openSessionContent(local.session_key as Uint8Array, confirm.fields.sealedSalt);
    if (!peerSalt) throw new Error("the counterparty's salt didn't decrypt, so the two sides hold different keys");
    this.#takeOfferedName(agent, local, local.session_key as Uint8Array, confirm.fields.sealedName);
    await this.#activate(agent, local, wireConfirm, wireAssignment, deriveSessionSalt(local.own_salt as Uint8Array, peerSalt));
    if (!this.#events.reachable(agent.hex) && this.governance.reach.setting(agent.signer.id, "away.answering") === "true") this.#away.startVisit(agent.signer.id, local.session_id);
  }

  // ---- Away. A greeting goes beside the chain, signed by its sender and sealed to the caller, and the caller screens it like any text. ----

  async #greetIfDue(agent: AgentContext, local: SessionRow): Promise<void> {
    const visit = this.#away.visit(agent.signer.id, local.session_id);
    if (visit?.state !== "due") return;
    // Someone came back while this waited to go, or the agent has been stopped: either way it no longer speaks for anyone.
    if (this.#events.reachable(agent.hex) || this.#stopAt(agent, this.#urlOf(local))) {
      this.#away.setVisit(agent.signer.id, local.session_id, "not_sent");
      return;
    }
    let wire = visit.greeting;
    if (!wire) {
      const text = this.governance.awayText(agent.signer.id, local.counterparty_id, agent.name);
      if (!text) {
        this.#away.setVisit(agent.signer.id, local.session_id, "not_sent");
        return;
      }
      let screened: string;
      try {
        screened = (await this.#screenOutbound(agent, text, {}, `cello-v2 settings --agent ${agent.hex}`)).text;
      } catch (err: unknown) {
        // A worker that's restarting says nothing about the text, so that one tries again at the next catch-up.
        if (err instanceof LocalError && err.code === "screener_unavailable") return;
        if (!(err instanceof LocalError)) throw err;
        this.#away.setVisit(agent.signer.id, local.session_id, "not_sent");
        logEvent("away.greeting_screened_out", { agent: agent.hex, session: toHex(local.session_id), code: err.code });
        this.#notify(agent, local.session_id, `Your away text wasn't sent to ${this.#who(agent, local)}, because your own outbound screen stopped it: ${err.message}`);
        return;
      }
      const fields = {
        offerHash: structureHash(signedOffer.decode(JSON.parse(local.offer)).bytes),
        sealedText: sealSessionContent(greetingKey(local.session_key as Uint8Array), new TextEncoder().encode(screened)),
      };
      const signature = await agent.signer.sign("cello-session-greeting", greetingBytes(fields));
      wire = JSON.stringify(signedGreeting.encode({ fields, signature }));
      this.#away.setVisit(agent.signer.id, local.session_id, "due", wire);
    }
    try {
      await this.#link.call("session.greet", { agent: toB64(agent.signer.id), sessionId: toB64(local.session_id), greeting: JSON.parse(wire) });
    } catch (err: unknown) {
      if (err instanceof ServerUnreachable) return;
      throw err;
    }
    this.#away.setVisit(agent.signer.id, local.session_id, "sent");
    logEvent("away.greeted", { agent: agent.hex, session: toHex(local.session_id) });
  }

  // The server carries this frame and can't be trusted about it, so nothing is kept unless the agent called signed it for this very call.
  async #onGreeting(agent: AgentContext, local: SessionRow, wire: WireSigned): Promise<void> {
    if (this.#away.greeting(agent.signer.id, local.session_id)) return;
    const reject = (why: string): void => {
      this.#away.rejectGreeting(agent.signer.id, local.session_id, local.counterparty_id, why);
      logEvent("away.greeting_rejected", { agent: agent.hex, session: toHex(local.session_id), why });
    };
    let greeting: Signed<{ offerHash: Uint8Array; sealedText: Uint8Array }>;
    try {
      greeting = signedGreeting.decode(wire, "greeting");
    } catch {
      reject("malformed");
      return;
    }
    if (greeting.fields.sealedText.length > MAX_GREETING_BYTES) {
      reject("too_large");
      return;
    }
    const offerHash = structureHash(signedOffer.decode(JSON.parse(local.offer)).bytes);
    if (!equalBytes(greeting.fields.offerHash, offerHash)) {
      reject("answers_a_different_offer");
      return;
    }
    if (!(await verifySignature(this.#counterpartyKeys(local), "cello-session-greeting", greeting.bytes, greeting.signature))) {
      reject("bad_signature");
      return;
    }
    const opened = openSessionContent(greetingKey(local.session_key as Uint8Array), greeting.fields.sealedText);
    if (!opened) {
      reject("does_not_decrypt");
      return;
    }
    this.#away.addGreeting(agent.signer.id, local.session_id, local.counterparty_id, opened);
    this.#screenGreeting(this.#away.greeting(agent.signer.id, local.session_id) as GreetingRow);
  }

  // The same queue, screeners and rules as a message from this sender. What it holds is durable, so a restart screens it again.
  #screenGreeting(row: GreetingRow): void {
    const agentHex = toHex(row.agent_id);
    const agent = this.#agents.get(agentHex);
    if (!agent) return;
    this.#nextChannelJob -= 1;
    const bytes = bodyBytes({ n: new Uint8Array(0), text: new TextDecoder().decode(row.body as Uint8Array), signal: null, est_minutes: null });
    const sessionHex = toHex(row.session_id);
    this.#screening.add({
      entryId: this.#nextChannelJob, agentHex, sessionHex: `greeting:${sessionHex}`, position: 0, senderHex: toHex(row.sender_id), bytes: bytes.length, arrived: Date.now(),
      channelText: {
        bytes,
        done: (verdict) => {
          const detail: VerdictDetail = { delivered: verdict.delivered, findings: verdict.findings, reason: verdict.reason, score: verdict.score, ran: verdict.ran };
          this.#away.setVerdict(row.agent_id, row.session_id, verdict.verdict, JSON.stringify(detail));
          logEvent("screening.greeting_verdict", { agent: agentHex, session: sessionHex, verdict: verdict.verdict, findings: verdict.findings.map((f) => f.what) });
          this.#events.ring(agentHex, { type: "away_greeting", agent: agent.name, session_id: sessionHex, from_id: toHex(row.sender_id) });
        },
      },
    });
  }

  #shownGreeting(agent: AgentContext, row: GreetingRow): Record<string, unknown> {
    const detail = JSON.parse(row.verdict_detail as string) as VerdictDetail;
    const screening = { verdict: row.verdict, findings: detail.findings, ...(detail.score === null ? {} : { score: detail.score }), ...(detail.reason ? { reason: detail.reason } : {}), ran: detail.ran };
    const local = this.#store.session(agent.signer.id, row.session_id) as SessionRow;
    const about = { session_id: toHex(row.session_id), from: this.#who(agent, local), from_id: toHex(row.sender_id), automatic: true, in_the_record: false };
    if (row.verdict === "blocked") return { ...about, blocked: true, screening };
    return { ...about, text: detail.delivered ?? new TextDecoder().decode(row.body as Uint8Array), screening };
  }

  greetings(agentHex: string): unknown {
    const agent = this.#requireAgent(agentHex);
    return { greetings: this.#away.all(agent.signer.id).map((row) => this.#shownGreeting(agent, row)) };
  }

  // Their one message has landed, nobody here has said a word, and nobody has come back. Runs in the session's lane.
  async #closeVisit(agent: AgentContext, sessionId: Uint8Array): Promise<void> {
    const local = this.#store.session(agent.signer.id, sessionId) as SessionRow;
    if (this.#away.visit(agent.signer.id, sessionId)?.state !== "sent") return;
    if (this.#store.lastOwnEntry(agent.signer.id, sessionId)) {
      this.#away.setVisit(agent.signer.id, sessionId, "answered");
      return;
    }
    if (this.#events.reachable(agent.hex) || local.state !== "active") return;
    this.#away.setVisit(agent.signer.id, sessionId, "closed");
    logEvent("away.visit_closed", { agent: agent.hex, session: toHex(sessionId) });
    await this.#closeInLane(agent, toHex(sessionId), true);
    this.#notify(agent, sessionId, `${this.#who(agent, local)} left one message while nobody was reachable as this agent, and the visit was closed and sealed. Call receive to read it.`);
  }

  async #activate(agent: AgentContext, local: SessionRow, wireConfirm: WireSigned, wireAssignment: WireSigned, salt: Uint8Array): Promise<void> {
    const assignment = signedAssignment.decode(wireAssignment, "assignment");
    const expected: Omit<AssignmentFields, "time"> = {
      serverId: this.#serverId(this.#urlOf(local)),
      sessionId: local.session_id,
      callerId: local.role === "caller" ? agent.signer.id : local.counterparty_id,
      calleeId: local.role === "caller" ? local.counterparty_id : agent.signer.id,
      confirmHash: structureHash(signedConfirm.decode(wireConfirm).bytes),
    };
    const matches = (Object.keys(expected) as (keyof typeof expected)[]).every((key) => equalBytes(assignment.fields[key], expected[key]));
    if (!matches || !(await verifySignature(this.#serverIdentity(this.#urlOf(local)), "cello-session-assignment", assignment.bytes, assignment.signature))) {
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
      server: this.#serverIdentity(this.#urlOf(local)),
      participants: [agent.signer.publicIdentity, this.#counterpartyKeys(local)],
    });
    for (const row of this.#store.signedRecord(agent.signer.id, local.session_id, local.verified_position)) {
      const entry = signedEntry.decode(JSON.parse(row.entry));
      verifier.adopt(entry.fields, structureHash(entry.bytes), signedAck.decode(JSON.parse(row.ack as string)).fields.time);
    }
    this.#verifiers.set(key, verifier);
    return verifier;
  }

  async #onEntryPush(agent: AgentContext, item: WitnessedOnWire, route: Route): Promise<void> {
    const sessionId = signedEntry.decode(item.entry).fields.sessionId;
    const local = this.#store.session(agent.signer.id, sessionId);
    if (!local || (local.state !== "active" && local.state !== "closed") || this.#urlOf(local) !== route.url) return;
    const position = signedAck.decode(item.ack).fields.position;
    const verifier = this.#verifier(agent, local);
    if (position <= verifier.position) {
      await this.#checkRepeat(agent, local, item);
      return;
    }
    // A long message's push carries no text, so #settle fetches it.
    if (item.ciphertext !== null && position === verifier.position + 1 && (await this.#ingest(agent, local, item))) {
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
    let long = false;
    for (;;) {
      const before = this.#verifier(agent, local).position;
      const params = { agent: toB64(agent.signer.id), sessionId: toB64(sessionId), after: before };
      const route = this.#routeFor(agent, local);
      const result = await (long ? this.#longCall(agent, route, "entry.fetch", { ...params, long }) : route.link.call("entry.fetch", params)) as { items: WitnessedOnWire[]; tip: number; longNext: boolean };
      long = result.longNext;
      for (const item of result.items) {
        local = this.#store.session(agent.signer.id, sessionId) as SessionRow;
        if (!(await this.#ingest(agent, local, item))) return;
      }
      local = this.#store.session(agent.signer.id, sessionId) as SessionRow;
      const after = this.#verifier(agent, local).position;
      if (after >= result.tip) break;
      if (long) continue;
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
    let landing: WitnessedEntry;
    let entry: Signed<EntryFields>;
    try {
      entry = signedEntry.decode(item.entry, "entry");
      const ack = signedAck.decode(item.ack, "ack");
      landing = witnessed(entry, ack);
    } catch (err: unknown) {
      this.#hold(agent, local, `malformed_frame: ${err instanceof Error ? err.message : String(err)}`, local.verified_position + 1);
      return false;
    }
    const verifier = this.#verifier(agent, local);
    const position = landing.ack.position;
    if (position <= verifier.position) {
      await this.#checkRepeat(agent, local, item);
      return true;
    }
    const fault: ChainFault | null = await verifier.check(landing);
    if (fault) {
      this.#hold(agent, local, fault, position);
      return false;
    }
    const closing = entry.fields.kind === EntryKind.close;
    const fromMe = equalBytes(entry.fields.authorId, agent.signer.id);
    const hash = structureHash(entry.bytes);
    let body: Uint8Array | undefined;
    let unverifiable: Uint8Array | undefined;

    if (fromMe) {
      const own = this.#store.ownEntryByHash(agent.signer.id, local.session_id, hash);
      if (!own) {
        this.#hold(agent, local, "own_entry_unknown", position);
        return false;
      }
      // Your daemon told you this was refused, and the server landed it anyway. It stays out of your record, and you're told.
      if (own.state === "not_sent") {
        this.#store.addEvidence({ agent_id: agent.signer.id, session_id: local.session_id, kind: "refused_entry_landed", position, entry: JSON.stringify(item.entry), ack: JSON.stringify(item.ack), other_ack: null, ciphertext: null });
        logEvent("session.refused_entry_landed", { agent: agent.hex, session: toHex(local.session_id), position });
        this.#notify(agent, local.session_id, `The server is claiming position ${position} for a message you were told was refused: "${parseBody(own.body)?.text.slice(0, 120) ?? ""}". This agent doesn't accept that, the proof is kept (see evidence), and the session stops here. Don't rely on this server for this conversation.`);
        this.#hold(agent, local, "refused_entry_landed", position);
        return false;
      }
      body = own.body;
    } else {
      if (!item.ciphertext) {
        this.#hold(agent, local, "encrypted_text_missing", position);
        return false;
      }
      const ciphertext = fromB64(item.ciphertext, "ciphertext");
      // Text that isn't what the author signed a hash of came from the server, which can send the right text next time.
      if (!equalBytes(ciphertextHash(ciphertext), entry.fields.ciphertextHash)) {
        this.#hold(agent, local, "text_does_not_match_signature", position);
        return false;
      }
      const opened = openSessionContent(local.session_key as Uint8Array, ciphertext);
      if (opened && equalBytes(saltedContentHash(local.salt as Uint8Array, opened), entry.fields.contentHash)) body = opened;
      else {
        // The author signed text that can't be what it says, and those same bytes fail every time. Holding here would let one bad
        // message stop the reader for good, so the bytes are kept as evidence, the words aren't shown, and reading carries on.
        unverifiable = ciphertext;
        body = new Uint8Array(0);
      }
    }

    const ownClosed = local.own_closed === 1 || (closing && fromMe);
    const peerClosed = local.peer_closed === 1 || (closing && !fromMe);
    const nowClosed = ownClosed && peerClosed;
    // The words are this daemon's, not the other side's. A close by hand doesn't carry the mark, so it doesn't get them.
    const closedOnGreeting = closing && !fromMe && local.role === "caller" && parseBody(body as Uint8Array)?.one_message === true && !this.#store.lastPeerEntry(agent.signer.id, local.session_id) && (this.#away.greeting(agent.signer.id, local.session_id)?.verdict ?? "rejected") !== "rejected";
    const counted = !fromMe && !closing && !unverifiable ? this.#countBytes(agent, local, (body as Uint8Array).length, landing.ack.time) : undefined;
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
            // Nobody will read it, and the signed hashes are what the chain and a seal rest on, so past the limit a flood costs no disk for its words.
            body: counted?.withheld ? new Uint8Array(0) : (body as Uint8Array),
          });
          if (unverifiable) {
            this.#store.markWithheld(this.#store.entryIdAt(agent.signer.id, local.session_id, position) as number, JSON.stringify({ delivered: null, findings: [], reason: UNVERIFIABLE_REASON, score: null, ran: { deterministic: false, model: false } }));
            this.#store.addEvidence({ agent_id: agent.signer.id, session_id: local.session_id, kind: "unverifiable_text", position, entry: JSON.stringify(item.entry), ack: JSON.stringify(item.ack), other_ack: null, ciphertext: unverifiable });
          }
          if (counted?.withheld) this.#store.markWithheld(this.#store.entryIdAt(agent.signer.id, local.session_id, position) as number, JSON.stringify({ delivered: null, findings: [], reason: BYTE_LIMIT_REASON, score: null, ran: { deterministic: false, model: false, model_failed_copies: 0 } } satisfies VerdictDetail));
        }
        this.#store.updateSession(agent.signer.id, local.session_id, {
          ...(counted ? { bytes_received: counted.total, bytes_told: counted.told } : {}),
          last_activity_at: landing.ack.time,
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
    if (unverifiable) {
      logEvent("session.unverifiable_text", { agent: agent.hex, session: sessionHex, position });
      this.#notify(agent, local.session_id, `The message at position ${position} from ${this.#who(agent, local)} isn't what its author signed, so it wasn't delivered. The bytes are kept (see evidence), and this agent's signed delivery ack lists it as refused. Later messages can still be read.`);
    }
    if (!fromMe && !counted?.withheld && !unverifiable) {
      const entryId = this.#store.entryIdAt(agent.signer.id, local.session_id, position) as number;
      this.#screening.add({ entryId, agentHex: agent.hex, sessionHex, position, senderHex: toHex(local.counterparty_id), bytes: (body as Uint8Array).length, arrived: Date.now() });
    }
    if (closedOnGreeting) this.#notify(agent, local.session_id, ONE_MESSAGE_LINE);
    // Queued, not awaited: this lane is the one running now.
    if (!fromMe && !closing && local.role === "callee" && this.#away.visit(agent.signer.id, local.session_id)?.state === "sent") {
      this.#background("one-message close", this.#lane(agent.hex, sessionHex, () => this.#closeVisit(agent, local.session_id)));
    }
    if (nowClosed && local.state !== "closed") {
      logEvent("session.closed", { agent: agent.hex, session: sessionHex });
      this.#events.ring(agent.hex, { ...bell, type: "session_closed" });
    }
    const written = counted?.withheld || unverifiable ? null : parseBody(body as Uint8Array);
    const due = !closing && written?.signal === "standby" ? standbyDue(written.est_minutes, landing.ack.time) : undefined;
    if (due !== undefined) this.#armStandbyCheck(due);
    return true;
  }

  // A different signed ack at a position already held. An ack the server didn't sign is dropped, because anyone can send junk.
  // Two it did sign is proof of misbehaviour: it's kept, the operator is told, and the session takes no more messages from this side.
  async #checkRepeat(agent: AgentContext, local: SessionRow, item: WitnessedOnWire): Promise<void> {
    const position = signedAck.decode(item.ack, "ack").fields.position;
    const held = this.#store.ackAt(agent.signer.id, local.session_id, position);
    if (!held) return;
    const proved = await provesTwoAcks(this.#serverIdentity(this.#urlOf(local)), signedAck.decode(JSON.parse(held)), signedAck.decode(item.ack, "ack"));
    if (!proved) return;
    this.#store.addEvidence({ agent_id: agent.signer.id, session_id: local.session_id, kind: "two_acks", position, entry: JSON.stringify(item.entry), ack: held, other_ack: JSON.stringify(item.ack), ciphertext: null });
    if (local.frozen === 1) return;
    this.#store.updateSession(agent.signer.id, local.session_id, { frozen: 1 });
    logEvent("session.frozen", { agent: agent.hex, session: toHex(local.session_id), position });
    this.#notify(agent, local.session_id, `The server signed two different things at position ${position}, which it must never do. This session is frozen: you can still read and seal, and you can't send. The proof is kept (see evidence). Tell whoever runs this server.`);
  }

  evidence(agentHex: string, sessionHex: string): unknown {
    const agent = this.#requireAgent(agentHex);
    const local = this.#requireSession(agent, sessionHex);
    return {
      frozen: local.frozen === 1,
      evidence: this.#store.evidence(agent.signer.id, local.session_id).map((row) => ({
        kind: row.kind,
        position: row.position,
        entry: row.entry === null ? null : JSON.parse(row.entry) as unknown,
        ack: JSON.parse(row.ack) as unknown,
        other_ack: row.other_ack === null ? null : JSON.parse(row.other_ack) as unknown,
        ciphertext: row.ciphertext === null ? null : toB64(row.ciphertext),
      })),
    };
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
      if (confirm) this.#catchUpEverywhere(agent);
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
    const refused = this.#store.unverifiablePositions(agent.signer.id, local.session_id);
    const latest = Math.max(this.#latestFromPeer(agent, local), local.delivered_through);
    // The signed list has a limit, so a flood of bad messages stops the ack there rather than growing it without end.
    const past = refused[MAX_REFUSED_POSITIONS];
    const through = past === undefined ? latest : Math.min(latest, past - 1);
    if (through === 0) return;
    const screened = Math.min(this.#screenedThrough(agent, local), through);
    if (through === local.delivered_through && screened <= local.acked_screened && etaSeconds === 0) return;
    const ack = signedAck.decode(JSON.parse(this.#store.ackAt(agent.signer.id, local.session_id, through) as string)).fields;
    const fields = { serverId: this.#serverId(this.#urlOf(local)), sessionId: local.session_id, readerId: agent.signer.id, throughPosition: through, entryHash: ack.entryHash, root: ack.root, screenedThrough: screened, refused: refusedList(refused.filter((position) => position <= through)) };
    const signature = await agent.signer.sign("cello-delivery-ack", deliveryAckBytes(fields));
    // The rough time goes beside the ack, unsigned: a seal may keep the ack, and this number means nothing an hour later.
    await this.#routeFor(agent, local).link.call("delivery.ack", { agent: toB64(agent.signer.id), deliveryAck: signedDeliveryAck.encode({ fields, signature }), screeningEtaSeconds: etaSeconds });
    this.#store.updateSession(agent.signer.id, local.session_id, { delivered_through: through, acked_screened: screened });
  }

  // How far the reader has screened what it holds. This is only ever used to tell and to pace, so a false one costs a delay.
  async #onPeerDeliveryAck(agent: AgentContext, wire: WireSigned, etaSeconds: unknown): Promise<void> {
    const signed = signedDeliveryAck.decode(wire, "deliveryAck");
    const { fields } = signed;
    const local = this.#store.session(agent.signer.id, fields.sessionId);
    if (!local || !equalBytes(fields.readerId, local.counterparty_id)) return;
    if (!(await verifySignature(this.#counterpartyKeys(local), "cello-delivery-ack", signed.bytes, signed.signature))) return;
    if (fields.screenedThrough > local.peer_screened_through) this.#store.updateSession(agent.signer.id, local.session_id, { peer_screened_through: fields.screenedThrough });
    const position = fields.screenedThrough + 1;
    // Nothing signs the time, so it's only ever a number in a notice, and only a whole one gets that far.
    if (Number.isSafeInteger(etaSeconds) && (etaSeconds as number) > 0 && position > local.peer_eta_told) {
      this.#store.updateSession(agent.signer.id, local.session_id, { peer_eta_told: position });
      this.#notify(agent, local.session_id, `The other side is still screening position ${position}, for about ${etaSeconds as number} more seconds. Its machine has the message, and its agent hasn't been shown it yet.`);
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
  async #screenOutbound(agent: AgentContext, text: string, params: Record<string, unknown>, retry: string): Promise<{ text: string; report: Record<string, unknown> }> {
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
        requirePerson(params, `This sends personal data from ${agent.hex}: ${held}.`, retry);
      }
      logEvent("guard.held_value_sent", { agent: agent.hex, categories: (verdict.held ?? []).map((h) => h.category), by_a_person: params["person_confirmed"] === true });
      return { text: verdict.text, report: { let_through: (verdict.held ?? []).map((h) => h.category) } };
    }
    if (verdict.disposition === "redact") return { text: verdict.text, report: { redacted: verdict.categories, message: "Parts of your message were replaced before sending: the text that went out isn't exactly what you wrote." } };
    return { text, report: {} };
  }

  // ---- This agent's own status ----

  // An agent's own server, or its own keys, stop it everywhere on this daemon. Any other server's word holds only for that server,
  // because a server it merely visited shouldn't be able to switch it off for everyone.
  #stopAt(agent: AgentContext, url: string): AgentStatusRow | undefined {
    for (const row of agent.statuses.values()) {
      if (row.status !== "active" && (row.everywhere === 1 || row.server_url === url)) return row;
    }
    return undefined;
  }

  #refuseIfStopped(agent: AgentContext, url: string): void {
    const stop = this.#stopAt(agent, url);
    if (stop?.status === "retired") throw new LocalError("agent_retired", `${agent.name} is retired, for good. Its record stays readable.`);
    if (stop) throw new LocalError("agent_suspended", `${agent.name} is suspended (reason: ${stop.reason}). Nothing was sent or read. It can still seal what's already witnessed, and only its operator or the portal can lift this.`);
  }

  assertCanAct(agentHex: string): void {
    const agent = this.#requireAgent(agentHex);
    this.#refuseIfStopped(agent, this.#url);
  }

  #setStatus(agent: AgentContext, url: string, status: AgentStatusRow["status"], reason: string, everywhere: boolean): void {
    const row: AgentStatusRow = { server_url: url, status, reason, everywhere: everywhere ? 1 : 0 };
    this.#store.setStatus(agent.signer.id, row);
    agent.statuses.set(url, row);
  }

  // What a server has just said about this agent, whether it pushed that or answered a proof with it.
  #noteStanding(agent: AgentContext, route: Route, standing: Standing): void {
    const known = agent.statuses.get(route.url);
    // Retired is final here too, whatever a server says later.
    if (known?.status === "retired") return;
    if ((known?.status ?? "active") === standing.status && known?.reason === standing.reason) return;
    if (!known && standing.status === "active") return;
    // This agent's own stop hasn't reached that server yet, so that server's "active" is out of date, not a lifting.
    if (standing.status === "active" && this.#store.outbox(route.url).some((row) => equalBytes(row.agent_id, agent.signer.id))) return;
    this.#setStatus(agent, route.url, standing.status, standing.reason, route.home);
    route.longProved.delete(agent.hex);
    logEvent("agent.status_changed", { agent: agent.hex, status: standing.status, reason: standing.reason, server: route.url });
    if (standing.status === "retired") {
      if (route.home) agent.online = false;
      route.online.delete(agent.hex);
      route.wanted.delete(agent.hex);
    }
    this.#events.ring(agent.hex, { type: "agent_status", agent: agent.name });
    // A signed word from anyone but the server itself holds elsewhere too, so it's carried to every other server this agent uses.
    if (standing.record && signedStatusStatement.decode(standing.record.statement).fields.issuer !== StatusIssuer.server) {
      for (const url of this.#serversOf(agent)) {
        if (url !== route.url) this.#store.addToOutbox(agent.signer.id, url, JSON.stringify(standing.record.statement));
      }
      this.#retryOutbox();
    }
    if (standing.status === "active") this.#catchUpEverywhere(agent);
  }

  #serversOf(agent: AgentContext): string[] {
    return [...new Set([this.#url, ...this.#store.sessionsOf(agent.signer.id).map((local) => this.#urlOf(local))])];
  }

  #routeAt(url: string): Route {
    return url === this.#url ? this.#home : this.#visitRoute(url);
  }

  #retryOutbox(): void {
    for (const url of new Set(this.#store.outbox().map((row) => row.server_url))) this.#flushOutbox(this.#routeAt(url));
  }

  // A statement carries its own authority, so it goes on any connection, and needs nothing proved first.
  #flushOutbox(route: Route): void {
    for (const row of this.#store.outbox(route.url)) {
      this.#background("status statement", route.link.call("agent.status", { statement: JSON.parse(row.statement) }).then(
        () => this.#store.removeFromOutbox(row),
        (err: unknown) => {
          if (err instanceof ServerUnreachable) return;
          // A final answer: it's stale, retired already, or that server has never seen this agent.
          this.#store.removeFromOutbox(row);
          logEvent("agent.status_refused", { agent: toHex(row.agent_id), server: route.url, code: err instanceof ServerRefused ? err.code : "failed" });
        },
      ));
    }
  }

  async #whenReady(route: Route, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!route.link.ready && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    return route.link.ready;
  }

  // Durable before anything goes out: this daemon stops at once, and the servers are told as soon as each can be reached.
  async #stopOwn(agent: AgentContext, status: StatusName, reason: ReasonName): Promise<{ told: string[]; not_yet: string[] }> {
    const fields = { agentId: agent.signer.id, status: AgentStatus[status], reason: StatusReason[reason], issuer: StatusIssuer.agent, issuerId: agent.signer.id, issuedAt: Date.now() };
    const statement = signedStatusStatement.encode({ fields, signature: await agent.signer.sign(STATUS_DOMAIN, statusStatementBytes(fields)) });
    const servers = this.#serversOf(agent);
    this.#store.transaction(() => {
      this.#setStatus(agent, this.#url, status, reason, true);
      for (const url of servers) this.#store.addToOutbox(agent.signer.id, url, JSON.stringify(statement));
    });
    logEvent("agent.status_signed", { agent: agent.hex, status, reason });
    this.#events.ring(agent.hex, { type: "agent_status", agent: agent.name });
    const answers = await Promise.all(servers.map(async (url) => {
      const route = this.#routeAt(url);
      route.longProved.delete(agent.hex);
      if (!(await this.#whenReady(route, STATUS_TELL_MS))) return { url, told: false };
      try {
        await route.link.call("agent.status", { statement });
      } catch (err: unknown) {
        if (err instanceof ServerUnreachable) return { url, told: false };
        logEvent("agent.status_refused", { agent: agent.hex, server: url, code: err instanceof ServerRefused ? err.code : "failed" });
      }
      for (const row of this.#store.outbox(url)) if (equalBytes(row.agent_id, agent.signer.id)) this.#store.removeFromOutbox(row);
      return { url, told: true };
    }));
    return { told: answers.filter((a) => a.told).map((a) => a.url), not_yet: answers.filter((a) => !a.told).map((a) => a.url) };
  }

  async suspend(agentHex: string, reason: unknown): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    this.#refuseIfRetired(agent);
    const chosen = reason === undefined ? "owner_request" : reason;
    if (chosen !== "owner_request" && chosen !== "lost_machine" && chosen !== "compromise") throw new LocalError("bad_argument", "reason must be owner_request, lost_machine or compromise");
    const { told, not_yet } = await this.#stopOwn(agent, "suspended", chosen);
    return { agent_id: agent.hex, status: "suspended", reason: chosen, told, not_yet, note: "Only its server's operator, or the portal, can lift this. Sealing what's already witnessed still works." };
  }

  async retire(agentHex: string, reason: unknown): Promise<{ agent_id: string; status: string; reason: string; told: string[]; not_yet: string[]; deferred: boolean }> {
    const agent = this.#requireAgent(agentHex);
    const chosen = reason === undefined ? "owner_request" : reason;
    if (chosen !== "owner_request" && chosen !== "compromise") throw new LocalError("bad_argument", "reason must be owner_request or compromise");
    const { told, not_yet } = await this.#stopOwn(agent, "retired", chosen);
    agent.online = false;
    return { agent_id: agent.hex, status: "retired", reason: chosen, told, not_yet, deferred: not_yet.length > 0 };
  }

  #refuseIfRetired(agent: AgentContext): void {
    for (const row of agent.statuses.values()) {
      if (row.status === "retired") throw new LocalError("agent_retired", `${agent.name} is retired already, for good.`);
    }
  }

  // Retires it, then takes it off this machine's lists and frees its name. Its keys and history stay in the database, as a record.
  async removeAgent(agentHex: string): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    const answer = await this.retire(agentHex, undefined);
    this.#store.markRemoved(agent.signer.id);
    this.#agents.delete(agent.hex);
    for (const route of [this.#home, ...this.#visiting.values()]) route.wanted.delete(agent.hex);
    return { removed: true, name: agent.name, ...answer };
  }

  // Asks each server this agent uses, and checks what comes back with public keys. Only this agent's keys can ask.
  async agentStatus(agentHex: string): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    const servers = await Promise.all(this.#serversOf(agent).map(async (url) => {
      const route = this.#routeAt(url);
      if (!(await this.#whenReady(route, STATUS_TELL_MS))) return { server: url, reachable: false, problem: route.link.problem };
      const server = route.home ? this.#server : route.server;
      if (!server) return { server: url, reachable: false, problem: "still connecting" };
      const clientNonce = new Uint8Array(randomBytes(32));
      const signature = await agent.signer.sign("cello-agent-auth", agentAuthBytes({ serverId: server.id, agentId: agent.signer.id, serverNonce: server.nonce, clientNonce }));
      const answer = await this.#call(() => route.link.call("agent.status.read", { identity: identityCodec.encode(agent.signer.publicIdentity), clientNonce: toB64(clientNonce), signature: signatureCodec.encode(signature) })) as { status: string; reason: string; records: StatusRecordOnWire[] };
      const checked = await checkStatusLog(answer.records, agent.signer.id, this.#serverIdentity(url));
      if (!checked.ok) throw new LocalError("status_log_bad", `${url}: ${checked.message}`);
      return { server: url, reachable: true, status: answer.status, reason: answer.reason, verified: true, log: checked.log };
    }));
    const stop = this.#stopAt(agent, this.#url);
    return { agent_id: agent.hex, status_here: stop?.status ?? "active", servers };
  }

  // ---- Sending ----

  // Waits a while for a long upload. If it's still going, the agent hears so and the upload carries on.
  // When it finishes, the ordinary resend picks up its answer and sends whatever waited behind it.
  #upload(agent: AgentContext, route: Route, local: SessionRow, row: EntryRow, params: unknown): Promise<unknown> {
    const upload = { finished: this.#longCall(agent, route, "entry.append", params), done: false };
    this.#uploads.set(row.id, upload);
    const sessionHex = toHex(local.session_id);
    upload.finished.then(
      () => {
        upload.done = true;
        this.#background("long upload finished", this.#lane(agent.hex, sessionHex, async () => {
          if (this.#uploads.has(row.id)) await this.#settle(agent, this.#store.session(agent.signer.id, local.session_id) as SessionRow);
        }));
      },
      () => { this.#uploads.delete(row.id); },
    );
    return this.#withinPatience(upload.finished);
  }

  async #withinPatience(finished: Promise<unknown>): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const patience = new Promise<typeof STILL_UPLOADING>((resolve) => { timer = setTimeout(() => resolve(STILL_UPLOADING), LONG_SEND_PATIENCE_MS); });
    try {
      return await Promise.race([finished, patience]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #attempt(agent: AgentContext, local: SessionRow, row: EntryRow): Promise<AttemptOutcome> {
    const route = this.#routeFor(agent, local);
    // Connected but not yet proved would be refused, and a refusal means this entry never goes.
    if (!this.#isOnline(agent, route)) return { status: "pending" };
    // Whatever is signed after a long message waits for it: it would be refused for arriving first, as the connections don't keep order between them.
    if (this.#uploads.size > 0) {
      const first = this.#store.pendingEntries(agent.signer.id, local.session_id)[0];
      const earlier = first && first.id !== row.id ? this.#uploads.get(first.id) : undefined;
      if (earlier) return { status: "pending", uploading: true };
    }
    let result: { ack: WireSigned };
    try {
      const params = { agent: toB64(agent.signer.id), entry: JSON.parse(row.entry), ciphertext: toB64(row.ciphertext as Uint8Array) };
      const underWay = this.#uploads.get(row.id);
      if (underWay && !underWay.done) return { status: "pending", uploading: true };
      let answer: unknown;
      if (underWay) answer = await underWay.finished;
      else if ((row.ciphertext as Uint8Array).length > LONG_CIPHERTEXT_BYTES) answer = await this.#upload(agent, route, local, row, params);
      else answer = await route.link.call("entry.append", params);
      if (answer === STILL_UPLOADING) return { status: "pending", uploading: true };
      this.#uploads.delete(row.id);
      result = answer as { ack: WireSigned };
    } catch (err: unknown) {
      if (err instanceof ServerUnreachable) return { status: "pending" };
      if (err instanceof ServerRefused) {
        if (err.code === "agent_suspended" || err.code === "agent_retired") this.#noteStanding(agent, route, { status: err.code === "agent_retired" ? "retired" : "suspended", reason: "none", record: null });
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
    const encodedBody = bodyBytes(body);
    const ciphertext = sealSessionContent(local.session_key as Uint8Array, encodedBody);
    if (ciphertext.length > MAX_CIPHERTEXT_BYTES) throw new LocalError("too_large", `this message is ${encodedBody.length} bytes, over the limit of about 1 MB`);

    const verifier = this.#verifier(agent, local);
    const firstUnread = this.#store.firstUnreadToAnswer(agent.signer.id, local.session_id, local.read_position);
    const readPosition = firstUnread !== undefined ? firstUnread - 1 : verifier.position;
    const readRoot = verifier.rootAt(readPosition);
    if (!readRoot) throw new Error(`no root is held for position ${readPosition}`);

    const last = this.#store.lastOwnEntry(agent.signer.id, local.session_id);
    const lastFields = last ? signedEntry.decode(JSON.parse(last.entry)).fields : undefined;
    const fields: EntryFields = {
      serverId: this.#serverId(this.#urlOf(local)),
      sessionId: local.session_id,
      authorId: agent.signer.id,
      authorSeq: (lastFields?.authorSeq ?? 0) + 1,
      prevOwnHash: last ? last.entry_hash : ZERO_HASH,
      readPosition,
      readRoot,
      kind,
      mode,
      contentHash: saltedContentHash(local.salt as Uint8Array, encodedBody),
      ciphertextHash: ciphertextHash(ciphertext),
      notAfter: Date.now() + SEND_WINDOW_MS,
    };
    const signature = await agent.signer.sign("cello-entry", entryBytes(fields));
    // On disk before it goes anywhere, so a crash after this point can only resend identical bytes.
    this.#store.insertEntry({
      agent_id: agent.signer.id,
      session_id: local.session_id,
      entry_hash: entryHash(fields),
      state: "pending",
      own: 1,
      entry: JSON.stringify(signedEntry.encode({ fields, signature })),
      ciphertext,
      body: encodedBody,
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
    // First, so a stopped agent hears that, and not a rate limit or a screening hold. The lane checks again, after the waits.
    this.#refuseIfStopped(agent, this.#urlOf(this.#requireSession(agent, sessionHex)));
    const rate = this.#rateFor(agent);
    const limited = rate?.peek(agent.hex);
    if (limited?.limited) throw new LocalError("rate_limited", limited.guidance as string);
    if (!SIGNALS.includes(signal)) throw new LocalError("missing_signal", `signal must be one of ${SIGNALS.join(", ")}`);
    if (signal === "standby" && standbyDue(estMinutes, Date.now()) === undefined) throw new LocalError("missing_est_minutes", "standby needs est_minutes, a positive number of minutes until your follow-up");
    const screened = await this.#screenOutbound(agent, text, params, `cello-v2 send ${sessionHex} - --allow-flagged --over --agent ${agent.hex}`);
    // A notice is how "stop" gets through, so it never waits. These waits are outside the lane, so what arrives meanwhile isn't held up.
    const paced = notice ? {} : await this.#paceForReader(agent, this.#requireSession(agent, sessionHex).session_id);
    return this.#lane(agentHex, sessionHex, async () => {
      let local = this.#requireSession(agent, sessionHex);
      this.#refuseIfStopped(agent, this.#urlOf(local));
      if (local.state !== "active") throw new LocalError(local.state === "closed" ? "session_closed" : "session_not_active", `this session is ${local.state}`);
      if (local.own_closed) throw new LocalError("session_closed", "you've already closed this session");
      if (local.frozen === 1) throw new LocalError("session_frozen", "the server signed two different things at one position, so this session takes nothing more from you. You can still read and seal it. The proof is kept: see evidence.");
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
      const body: Body = { n: new Uint8Array(randomBytes(16)), text: screened.text, signal, est_minutes: estMinutes ?? null };
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
    if (outcome.status === "pending" && outcome.uploading) return { sent: false, status: "not_sent_yet", message: "A long message is still uploading on a slow connection. Your message is saved, and it goes by itself. You'll get a notice." };
    if (outcome.status === "pending") return { sent: false, status: "not_sent_yet", message: "The server can't be reached. Your message is saved, and it goes when the server is back. You'll get a notice." };
    if (outcome.code === "not_current") {
      await this.#settle(agent, this.#store.session(agent.signer.id, local.session_id) as SessionRow);
      throw new LocalError("session_not_current", "a message arrived just before yours. Nothing was sent. Call receive, then decide what to say.");
    }
    throw new LocalError(outcome.code, outcome.message);
  }

  async close(agentHex: string, sessionHex: string): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    return this.#lane(agentHex, sessionHex, () => this.#closeInLane(agent, sessionHex));
  }

  async #closeInLane(agent: AgentContext, sessionHex: string, oneMessage = false): Promise<unknown> {
    const local = this.#requireSession(agent, sessionHex);
    if (local.own_closed || local.state === "closed") return { closed: true, state: local.state };
    this.#refuseIfStopped(agent, this.#urlOf(local));
    if (local.state !== "active") throw new LocalError("session_not_active", `this session is ${local.state}`);
    await this.#resendPending(agent, local);
    // Durable before the close goes, so a crash anywhere after this still ends in a seal.
    this.#store.addSealWant(agent.signer.id, local.session_id, SEAL_EVERYTHING_HELD);
    const body: Body = { n: new Uint8Array(randomBytes(16)), text: "", signal: null, est_minutes: null, ...(oneMessage ? { one_message: true as const } : {}) };
    const outcome = await this.#append(agent, this.#store.session(agent.signer.id, local.session_id) as SessionRow, EntryKind.close, EntryMode.notice, body);
    const report = await this.#reportSend(agent, local, outcome) as { sent: boolean };
    const seal = report.sent ? await this.#sealAfterClose(agent, local.session_id) : notSealedYet("the close hasn't reached the server");
    const fresh = this.#store.session(agent.signer.id, local.session_id) as SessionRow;
    return { closed: report.sent, state: fresh.state, peer_closed: fresh.peer_closed === 1, seal, ...report };
  }

  // ---- Sealing ----

  async seal(agentHex: string, sessionHex: string, through: number | undefined): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    if (through !== undefined && (!Number.isSafeInteger(through) || through < 1)) throw new LocalError("bad_argument", "through must be a position, a whole number from 1 up");
    return this.#lane(agentHex, sessionHex, async () => {
      const local = this.#requireSession(agent, sessionHex);
      if (this.#stopAt(agent, this.#urlOf(local))?.status === "retired") this.#refuseIfStopped(agent, this.#urlOf(local));
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
    const route = this.#routeFor(agent, local);
    if (!this.#isOnline(agent, route)) return notSealedYet(route.link.problem ?? "this agent isn't online yet");
    const root = this.#verifier(agent, local).rootAt(through);
    if (!root) throw new Error(`no root is held for position ${through}`);
    const fields = { serverId: this.#serverId(route.url), sessionId, sealerId: agent.signer.id, counterpartyId: local.counterparty_id, throughPosition: through, root };
    const signature = await agent.signer.sign("cello-seal-request", sealRequestBytes(fields));
    let answer: { record: SealRecordOnWire; logProof: string[] | null };
    try {
      answer = await route.link.call("seal.request", {
        agent: toB64(agent.signer.id),
        request: signedSealRequest.encode({ fields, signature }),
        knownLogSize: this.#knownSealLogHead(route.url)?.size ?? 0,
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
      this.#store.addSeal(agent.signer.id, sealId(record.certificate.bytes), sessionId, JSON.stringify(answer.record));
      this.#store.removeSealWant(agent.signer.id, sessionId, wanted);
      this.#store.setConfig(this.#pinKey(CONFIG_SEAL_KEY, route.url), toHex(head.sealKeyId));
      if (head.size > (this.#knownSealLogHead(route.url)?.size ?? 0)) this.#store.setConfig(this.#pinKey(CONFIG_SEAL_LOG_HEAD, route.url), JSON.stringify({ size: head.size, root: toB64(head.root) }));
    });
    logEvent("seal.stored", { agent: agent.hex, session: toHex(sessionId), through });
    return { sealed: true, ...sealSummary(record), statement: describeSeal(record) };
  }

  #knownSealLogHead(url: string): { size: number; root: Uint8Array } | undefined {
    const stored = this.#store.getConfig(this.#pinKey(CONFIG_SEAL_LOG_HEAD, url));
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
    const url = this.#urlOf(local);
    if (!equalBytes(identityId(decoded.server), this.#serverId(url))) throw new LocalError("seal_wrong_server", "this seal names a server other than the one this daemon pinned");
    const sealKeyId = identityId(decoded.sealKey);
    const pinned = this.#store.getConfig(this.#pinKey(CONFIG_SEAL_KEY, url));
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
    this.#checkSealLogHistory(check.record, logProof, url);
    return check.record;
  }

  // Catches a log rewritten since this daemon last saw it. It can't catch two readers being shown different logs: only an outside witness can.
  #checkSealLogHistory(record: SealRecord, logProof: string[] | null, url: string): void {
    const known = this.#knownSealLogHead(url);
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
        body: row.withheld === 1 ? null : row.body,
      })),
      seals: this.#store.seals(agent.signer.id, local.session_id).map((row) => JSON.parse(row.record) as unknown),
      salt: local.salt,
    });
    if (!built.ok) throw new LocalError(built.fault, built.message);
    return { file: built.file, summary: built.summary };
  }

  // ---- What agents and people ask for ----

  async createAgent(name: string): Promise<unknown> {
    if (validateMoniker(name) === null) throw new LocalError("bad_argument", "an agent name is 1 to 64 letters, digits, underscores or dashes");
    if ([...this.#agents.values()].some((a) => a.name === name)) throw new LocalError("agent_name_taken", `this machine already has an agent named ${name}`);
    const seeds = generateIdentitySeeds();
    const signer = await signerFromSeeds(seeds);
    this.#store.insertAgent(signer.id, name, seeds.ed, seeds.pq);
    const agent: AgentContext = { signer, hex: toHex(signer.id), name, registered: false, online: false, statuses: new Map() };
    this.#agents.set(agent.hex, agent);
    this.governance.writeDefaults(signer.id);
    if (this.#server) await this.#bringOnline(agent, this.#server);
    const note = agent.online ? {} : { note: `saved, but not online yet: ${this.#link.problem ?? "the server didn't take it"}. It registers by itself once the server is reachable.` };
    return { name, agent_id: agent.hex, address: formatAddress(agent.hex, this.#url), registered: agent.registered, online: agent.online, ...note };
  }

  // What channels.ts needs from here. It shares an agent's keys and the server link, and nothing about any conversation.
  channelHost(): ChannelHost {
    return {
      signer: (agentHex) => this.#requireAgent(agentHex).signer,
      agents: () => [...this.#agents.keys()],
      online: (agentHex) => this.#agents.get(agentHex)?.online === true,
      call: (method, params) => this.#link.call(method, params),
      callLong: (agentHex, method, params) => this.#longCall(this.#requireAgent(agentHex), this.#home, method, params),
      serverIdentity: () => this.#serverIdentity(),
      ring: (agentHex, bell) => this.#events.ring(agentHex, bell),
      // Channels share the one screening queue, so a channel takes turns with conversations by sender.
      screen: (agentHex, scope, position, senderHex, text) => new Promise((resolve) => {
        this.#nextChannelJob -= 1;
        // The worker reads the shape a message body has. Anything else, it takes as text nobody can read and passes unscanned.
        const bytes = bodyBytes({ n: new Uint8Array(0), text, signal: null, est_minutes: null });
        this.#screening.add({ entryId: this.#nextChannelJob, agentHex, sessionHex: scope, position, senderHex, bytes: bytes.length, arrived: Date.now(), channelText: { bytes, done: resolve } });
      }),
      screenOutbound: async (agentHex, text, params, retry) => {
        const screened = await this.#screenOutbound(this.#requireAgent(agentHex), text, params, retry);
        return screened;
      },
    };
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

  async initiate(agentHex: string, target: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    // First, so a stopped agent is never offered the person's way past a block.
    this.#refuseIfStopped(agent, this.#url);
    // You blocked them, so calling them is a stop sign. A person can drive through it, once.
    const dialled = /^[0-9a-fA-F]{64}/.exec(target)?.[0];
    if (dialled && this.governance.contacts.tierOf(agent.signer.id, parseHex(dialled, 32, "target")) === TIER.BLOCKED) {
      requirePerson(params, `${agent.name} has blocked this agent, and this would call it anyway.`, `cello-v2 initiate-session ${target} --agent ${agent.hex}`);
    }
    let address: ReturnType<typeof parseAddress>;
    try {
      address = parseAddress(target);
    } catch (err: unknown) {
      throw new LocalError(err instanceof PlainTextServer ? err.code : "bad_argument", err instanceof Error ? err.message : String(err));
    }
    const targetId = parseHex(address.id, 32, "target");
    if (equalBytes(targetId, agent.signer.id)) throw new LocalError("bad_argument", "an agent can't start a session with itself");
    const route = await this.#reach(agent, address.server);
    try {
      return await this.#initiateOn(agent, route, targetId);
    } finally {
      this.#doneOpening(route);
    }
  }

  // The callee's server hosts, and each side connects to it directly. No server relays for another.
  async #initiateOn(agent: AgentContext, route: Route, targetId: Uint8Array): Promise<unknown> {
    const agentHex = agent.hex;
    const lookup = await this.#call(() => route.link.call("lookup", { agent: toB64(agent.signer.id), target: toB64(targetId) })) as { identity: unknown };
    const identity = identityCodec.decode(lookup.identity, "identity");
    // The id you typed is the check: a server can't substitute other keys under it.
    if (!equalBytes(identityId(identity), targetId)) throw new LocalError("wrong_identity", "the server returned keys that don't match the id you asked for");

    const sessionId = new Uint8Array(randomBytes(16));
    const sessionHex = toHex(sessionId);
    const own = await generateSessionEphemeral();
    const fields = {
      serverId: this.#serverId(route.url),
      sessionId,
      callerId: agent.signer.id,
      calleeId: targetId,
      x25519Public: own.publicKey,
      mlKemPublic: own.mlKemPublic,
      expiresAt: Date.now() + this.#settings.offer_lifetime_minutes * 60_000,
    };
    const signature = await agent.signer.sign("cello-session-offer", offerBytes(fields));
    const offer = signedOffer.encode({ fields, signature });
    const activated = new Promise<void>((resolve) => this.#activation.set(agent.hex + sessionHex, resolve));
    await this.#lane(agentHex, sessionHex, async () => {
      this.#store.insertSession({
        agent_id: agent.signer.id,
        session_id: sessionId,
        role: "caller",
        counterparty_id: targetId,
        counterparty_name: "",
        counterparty_keys: JSON.stringify(lookup.identity),
        state: "offered",
        offer: JSON.stringify(offer),
        x25519_secret: own.secretKey,
        mlkem_seed: own.mlKemSeed,
        server_url: route.home ? null : route.url,
      });
      await this.#call(() => route.link.call("session.offer", { agent: toB64(agent.signer.id), offer }));
    });
    this.governance.engaged(agent.signer.id, targetId, "initiated");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([activated, new Promise((resolve) => { timer = setTimeout(resolve, INITIATE_WAIT_MS); })]);
    clearTimeout(timer);
    this.#activation.delete(agent.hex + sessionHex);
    const state = (this.#store.session(agent.signer.id, sessionId) as SessionRow).state;
    const refused = this.#refusals.get(agent.hex + sessionHex);
    if (refused) {
      this.#refusals.delete(agent.hex + sessionHex);
      return { session_id: sessionHex, state: "refused", message: refused };
    }
    if (state === "active") return { session_id: sessionHex, state };
    return { session_id: sessionHex, state: "waiting", message: `Nothing has answered yet, so that agent's daemon may be offline. An offline daemon can't send an away greeting, so silence here says nothing about whether anyone will read this. The call stands until ${new Date(fields.expiresAt).toISOString()}, and it connects by itself if that daemon comes back.` };
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
    this.#refuseIfStopped(agent, this.#url);
    if (sessionHex) this.#refuseIfStopped(agent, this.#urlOf(this.#requireSession(agent, sessionHex)));
    // Stopped by one other server only: what's held from that server waits, and the rest reads as usual.
    const sessions = (sessionHex ? [this.#requireSession(agent, sessionHex)] : this.#store.sessionsOf(agent.signer.id)).filter((local) => !this.#stopAt(agent, this.#urlOf(local)));
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
    const wantedSession = sessionHex ? sessions[0]?.session_id : undefined;
    const greetings = this.#away.unread(agent.signer.id).filter((row) => !wantedSession || equalBytes(row.session_id, wantedSession));
    return {
      result: { messages, ...(greetings.length > 0 ? { greetings: greetings.map((row) => this.#shownGreeting(agent, row)) } : {}), notices: notices.map((n) => ({ session_id: n.session_id ? toHex(n.session_id) : null, text: n.text })), ...(screening.length > 0 ? { still_screening: screening } : {}), ...(policies.length > 0 ? { policies } : {}), ...(more ? { more: true } : {}) },
      commit: () => {
        this.#store.transaction(() => {
          for (const read of reads) {
            // Two reads can overlap, so a position only ever moves forward.
            const current = this.#store.session(agent.signer.id, read.sessionId) as SessionRow;
            if (read.through > current.read_position) this.#store.updateSession(agent.signer.id, read.sessionId, { read_position: read.through });
          }
          for (const row of greetings) this.#away.markRead(agent.signer.id, row.session_id);
          if (notices.length > 0) this.#store.clearNotices(agent.signer.id, (notices.at(-1) as { id: number }).id);
        });
      },
    };
  }

  // These four only read. None moves a read position, so looking never counts as reading.
  agents(): unknown {
    return {
      agents: [...this.#agents.values()].map((agent) => ({ name: agent.name, agent_id: agent.hex, address: formatAddress(agent.hex, this.#url), registered: agent.registered, online: agent.online, status: this.#stopAt(agent, this.#url)?.status ?? "active", unread: this.unreadCount(agent.hex) })),
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
        ...(s.role === "callee" && this.#away.visit(agent.signer.id, s.session_id) ? { away_visit: this.#away.visit(agent.signer.id, s.session_id)?.state } : {}),
        hosted_on: this.#urlOf(s),
        state: s.state,
        position: s.verified_position,
        unread: this.#store.unreadCount(agent.signer.id, s.session_id, s.read_position),
        own_closed: s.own_closed === 1,
        peer_closed: s.peer_closed === 1,
        fault: s.fault,
        stopped: this.#store.isStopped(agent.signer.id, s.session_id),
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
      return unread > 0 ? [{ session_id: toHex(s.session_id), from: this.#who(agent, s), from_id: toHex(s.counterparty_id), unread, ready: this.#store.deliverableCount(agent.signer.id, s.session_id, s.read_position), ...(held ? { still_screening: held } : {}) }] : [];
    });
    return { waiting, notices: this.#store.notices(agent.signer.id).length, refused_callers: this.governance.knocks(agent.signer.id, agent.hex) };
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
        from: row.own === 1 ? agent.name : this.#who(agent, local),
        from_id: toHex(row.own === 1 ? agent.signer.id : local.counterparty_id),
        own: row.own === 1,
        ...shownMessage(row, closing),
      };
    });
    return { session_id: toHex(local.session_id), with: this.#who(agent, local), with_id: toHex(local.counterparty_id), state: local.state, read_position: local.read_position, entries, ...(page.more ? { more: true } : {}) };
  }

  // What can be read right now. A message still being screened isn't in it, or a caller would be told to read and find nothing.
  unreadCount(agentHex: string): number {
    const agent = this.#requireAgent(agentHex);
    const messages = this.#store.sessionsOf(agent.signer.id).reduce((sum, s) => sum + this.#store.deliverableCount(agent.signer.id, s.session_id, s.read_position), 0);
    return messages + this.#store.notices(agent.signer.id).length + this.#away.unread(agent.signer.id).length;
  }

  // Checks this agent's own record, using only public keys.
  async verifySession(agentHex: string, sessionHex: string): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    const local = this.#requireSession(agent, sessionHex);
    const items: WitnessedEntry[] = this.#store.signedRecord(agent.signer.id, local.session_id, local.verified_position).map((row) => {
      const entry = signedEntry.decode(JSON.parse(row.entry));
      const ack = signedAck.decode(JSON.parse(row.ack as string));
      return witnessed(entry, ack);
    });
    const report = await verifyTranscript({ sessionId: local.session_id, server: this.#serverIdentity(this.#urlOf(local)), participants: [agent.signer.publicIdentity, this.#counterpartyKeys(local)] }, items);
    return { ok: report.ok, position: report.position, root: toHex(report.root), fault: report.fault ?? null, fault_at: report.faultAt ?? null };
  }

  status(): unknown {
    return {
      server: this.#url,
      connected: this.#link.ready,
      problem: this.#link.problem,
      screening: this.screeningFacts(),
      visiting: [...this.#visiting.values()].map((route) => ({ server: route.url, connected: route.link.ready, problem: route.link.problem, agents: [...route.online].length })),
      agents: [...this.#agents.values()].map((agent) => ({
        name: agent.name,
        agent_id: agent.hex,
        address: formatAddress(agent.hex, this.#url),
        registered: agent.registered,
        online: agent.online,
        status: this.#stopAt(agent, this.#url)?.status ?? "active",
        unread: this.unreadCount(agent.hex),
        sessions: this.#store.sessionsOf(agent.signer.id).map((s) => ({
          session_id: toHex(s.session_id),
          with: this.#who(agent, s),
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

// The owner's node: keys, conversations and recovery. Durable state decides everything.
// After any restart, the same catch-up path runs: resend what's pending, then read from position.
import { randomBytes } from "node:crypto";
import { openSessionContent, sealSessionContent } from "../protocol/aead.ts";
import { ChainVerifier, type ChainFault, type WitnessedEntry, verifyTranscript } from "../protocol/chain.ts";
import { ZERO_HASH, equalBytes, toHex } from "../protocol/encode.ts";
import { type PublicIdentity, type Signer, generateIdentitySeeds, identityId, signerFromSeeds, verifySignature } from "../protocol/identity.ts";
import { deriveSessionSecrets, destroySessionEphemeral, generateSessionEphemeral } from "../protocol/key-agreement.ts";
import { mlKemDecapsulate, mlKemEncapsulate } from "../protocol/ml-kem.ts";
import { deriveSessionSalt, generateSaltContribution, saltedContentHash } from "../protocol/salt.ts";
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
  toB64,
} from "../protocol/wire.ts";
import { type ConnectedServer, ServerLink, ServerRefused, ServerUnreachable } from "./link.ts";
import { logEvent } from "./log.ts";
import type { EntryRow, SessionRow, Store } from "./store.ts";

const OFFER_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const SEND_WINDOW_MS = 10 * 60 * 1000;
const INITIATE_WAIT_MS = 20_000;
const POSITION_CHECK_MS = 30_000;
const AUTH_RETRY_MS = 5_000;
const CONFIG_SERVER_URL = "server_url";
const CONFIG_SERVER_IDENTITY = "server_identity";

export const SIGNALS = ["over", "standby", "wrap"] as const;
export type Signal = (typeof SIGNALS)[number];

export class LocalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalError";
    this.code = code;
  }
}

export interface Doorbell {
  type: "session_started" | "message" | "peer_closed" | "session_closed" | "notice";
  agent: string;
  session_id?: string;
  from?: string;
  from_id?: string;
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

  constructor(store: Store, url: string, events: EngineEvents) {
    this.#store = store;
    this.#events = events;
    this.#url = url;
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
    }
    this.#link.start();
    // Pushes are hints. This catches a lost one, so it costs seconds rather than a conversation.
    this.#positionCheck = setInterval(() => {
      for (const agent of this.#agents.values()) if (agent.online) void this.#catchUpAgent(agent);
    }, POSITION_CHECK_MS);
  }

  stop(): void {
    clearInterval(this.#positionCheck);
    this.#link.stop();
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
      const listed = await this.#link.call("session.list", { agent: toB64(agent.signer.id) }) as { sessions: SessionOnWire[] };
      const seen = new Set<string>();
      for (const wire of listed.sessions) {
        const sessionHex = toHex(signedOffer.decode(wire.offer).fields.sessionId);
        seen.add(sessionHex);
        this.#background("session update", this.#lane(agent.hex, sessionHex, () => this.#onSessionWire(agent, wire)));
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
      const hasWork = wire.tip > local.verified_position || this.#store.pendingEntries(agent.signer.id, sessionId).length > 0 || local.fault !== null || local.delivered_through < this.#latestFromPeer(agent, local);
      if (hasWork) await this.#settle(agent, local);
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
    });
    const sessionHex = toHex(local.session_id);
    logEvent("session.active", { agent: agent.hex, session: sessionHex });
    this.#events.ring(agent.hex, { type: "session_started", agent: agent.name, session_id: sessionHex, from: local.counterparty_name, from_id: toHex(local.counterparty_id) });
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
    for (const row of this.#store.verifiedEntries(agent.signer.id, local.session_id, local.verified_position)) {
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

  #notify(agent: AgentContext, sessionId: Uint8Array, text: string): void {
    this.#store.addNotice(agent.signer.id, sessionId, text);
    this.#events.ring(agent.hex, { type: "notice", agent: agent.name, session_id: toHex(sessionId) });
  }

  // Doesn't stop the conversation for good: it's rechecked at every catch-up, so a bad deploy thaws by itself.
  #hold(agent: AgentContext, local: SessionRow, reason: string, position: number): void {
    this.#verifiers.delete(agent.hex + toHex(local.session_id));
    if (local.fault === reason) return;
    this.#store.updateSession(agent.signer.id, local.session_id, { fault: reason });
    logEvent("session.holding", { agent: agent.hex, session: toHex(local.session_id), reason, position });
    this.#notify(agent, local.session_id, `This session is holding at position ${position}, because something from the server didn't check out (${reason}). Nothing is lost, and it rechecks by itself.`);
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
      if (!this.#store.ownEntryByHash(agent.signer.id, local.session_id, hash)) {
        this.#hold(agent, local, "own_entry_unknown", position);
        return false;
      }
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
        }
        this.#store.updateSession(agent.signer.id, local.session_id, {
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
    const bell = { agent: agent.name, session_id: sessionHex, from: local.counterparty_name, from_id: toHex(local.counterparty_id) };
    if (!fromMe) this.#events.ring(agent.hex, { ...bell, type: closing ? "peer_closed" : "message" });
    if (nowClosed && local.state !== "closed") {
      logEvent("session.closed", { agent: agent.hex, session: sessionHex });
      this.#events.ring(agent.hex, { ...bell, type: "session_closed" });
    }
    return true;
  }

  #latestFromPeer(agent: AgentContext, local: SessionRow): number {
    const rows = this.#store.unreadEntries(agent.signer.id, local.session_id, local.delivered_through);
    return rows.length > 0 ? (rows[rows.length - 1] as EntryRow).position as number : 0;
  }

  // Runs only after the text is stored and decrypted. This signature is what lets the server remove it.
  async #deliver(agent: AgentContext, local: SessionRow): Promise<void> {
    const through = this.#latestFromPeer(agent, local);
    if (through <= local.delivered_through) return;
    const row = this.#store.verifiedEntries(agent.signer.id, local.session_id, through).at(-1) as EntryRow;
    const ack = signedAck.decode(JSON.parse(row.ack as string)).fields;
    const fields = { sessionId: local.session_id, readerId: agent.signer.id, throughPosition: through, entryHash: ack.entryHash, root: ack.root };
    const signature = await agent.signer.sign("cello-v2-delivery-ack", deliveryAckBytes(fields));
    await this.#link.call("delivery.ack", { agent: toB64(agent.signer.id), deliveryAck: signedDeliveryAck.encode({ fields, signature }) });
    this.#store.updateSession(agent.signer.id, local.session_id, { delivered_through: through });
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
    const unread = this.#store.unreadEntries(agent.signer.id, local.session_id, local.read_position);
    const readPosition = unread.length > 0 ? (unread[0] as EntryRow).position as number - 1 : verifier.position;
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
  async send(agentHex: string, sessionHex: string, text: string, signal: Signal, estMinutes: number | undefined, notice: boolean): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    if (!SIGNALS.includes(signal)) throw new LocalError("missing_signal", `signal must be one of ${SIGNALS.join(", ")}`);
    if (signal === "standby" && !(typeof estMinutes === "number" && estMinutes > 0)) throw new LocalError("missing_est_minutes", "standby needs est_minutes, a positive number of minutes until your follow-up");
    return this.#lane(agentHex, sessionHex, async () => {
      let local = this.#requireSession(agent, sessionHex);
      if (local.state !== "active") throw new LocalError(local.state === "closed" ? "session_closed" : "session_not_active", `this session is ${local.state}`);
      if (local.own_closed) throw new LocalError("session_closed", "you've already closed this session");
      if (local.fault) throw new LocalError("session_holding", `this session is holding: ${local.fault}. It rechecks by itself.`);
      if (!notice && this.#store.unreadEntries(agent.signer.id, local.session_id, local.read_position).length > 0) {
        throw new LocalError("session_not_current", "a message has arrived that you haven't read. Nothing was sent. Call receive, then decide what to say.");
      }
      if (this.#store.pendingEntries(agent.signer.id, local.session_id).length > 0) {
        await this.#resendPending(agent, local);
        local = this.#store.session(agent.signer.id, local.session_id) as SessionRow;
        if (this.#store.pendingEntries(agent.signer.id, local.session_id).length > 0) {
          throw new LocalError("previous_send_pending", "your previous message hasn't reached the server yet, so this one wasn't queued. Try again once it has.");
        }
      }
      const body: Body = { n: toB64(new Uint8Array(randomBytes(16))), text, signal, est_minutes: estMinutes ?? null };
      const outcome = await this.#append(agent, local, EntryKind.message, notice ? EntryMode.notice : EntryMode.reply, body);
      return this.#reportSend(agent, local, outcome);
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
      const body: Body = { n: toB64(new Uint8Array(randomBytes(16))), text: "", signal: null, est_minutes: null };
      const outcome = await this.#append(agent, this.#store.session(agent.signer.id, local.session_id) as SessionRow, EntryKind.close, EntryMode.notice, body);
      const report = await this.#reportSend(agent, local, outcome) as { sent: boolean };
      const fresh = this.#store.session(agent.signer.id, local.session_id) as SessionRow;
      return { closed: report.sent, state: fresh.state, peer_closed: fresh.peer_closed === 1, ...report };
    });
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
      expiresAt: Date.now() + OFFER_LIFETIME_MS,
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

  // Moving the read position is what makes these count as read, so an operator's look at a record never does.
  receive(agentHex: string, sessionHex?: string): unknown {
    const agent = this.#requireAgent(agentHex);
    const sessions = sessionHex ? [this.#requireSession(agent, sessionHex)] : this.#store.sessionsOf(agent.signer.id);
    return this.#store.transaction(() => {
      const messages: unknown[] = [];
      for (const local of sessions) {
        const unread = this.#store.unreadEntries(agent.signer.id, local.session_id, local.read_position);
        for (const row of unread) {
          const body = parseBody(row.body);
          const closing = signedEntry.decode(JSON.parse(row.entry)).fields.kind === EntryKind.close;
          messages.push({
            session_id: toHex(local.session_id),
            from: local.counterparty_name,
            from_id: toHex(local.counterparty_id),
            position: row.position,
            ...(closing ? { closed_their_side: true } : { text: body?.text ?? null, signal: body?.signal ?? null }),
            ...(body?.est_minutes ? { est_minutes: body.est_minutes } : {}),
            ...(!closing && !body ? { unreadable: true } : {}),
          });
        }
        if (unread.length > 0) this.#store.updateSession(agent.signer.id, local.session_id, { read_position: (unread.at(-1) as EntryRow).position as number });
      }
      const notices = this.#store.notices(agent.signer.id);
      if (notices.length > 0) this.#store.clearNotices(agent.signer.id, (notices.at(-1) as { id: number }).id);
      return { messages, notices: notices.map((n) => ({ session_id: n.session_id ? toHex(n.session_id) : null, text: n.text })) };
    });
  }

  unreadCount(agentHex: string): number {
    const agent = this.#requireAgent(agentHex);
    const messages = this.#store.sessionsOf(agent.signer.id).reduce((sum, s) => sum + this.#store.unreadEntries(agent.signer.id, s.session_id, s.read_position).length, 0);
    return messages + this.#store.notices(agent.signer.id).length;
  }

  // Checks this agent's own record, using only public keys.
  async verifySession(agentHex: string, sessionHex: string): Promise<unknown> {
    const agent = this.#requireAgent(agentHex);
    const local = this.#requireSession(agent, sessionHex);
    const items: WitnessedEntry[] = this.#store.verifiedEntries(agent.signer.id, local.session_id, local.verified_position).map((row) => {
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
        })),
      })),
    };
  }
}

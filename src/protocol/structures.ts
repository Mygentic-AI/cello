// The exact bytes each party signs. The wire format can change without touching these.
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeCbor, encodeCbor } from "./cbor.ts";
import { HASH_BYTES, SESSION_ID_BYTES } from "./encode.ts";
import { ML_KEM_CIPHERTEXT_BYTES, ML_KEM_PUBLIC_KEY_BYTES } from "./ml-kem.ts";
import type { PublicIdentity } from "./identity.ts";

// A record names its own format in its tag, in slot 0, so a later change to the wire or the format leaves old records verifiable.
// Unknown tags are refused as an unknown format, never as a forgery.
export class UnknownFormat extends RangeError {}

type Slot = "int" | "intOrNull" | "text" | "textOrNull" | number | "bytes";

// Every structure here is a flat array, so this walks every item before cbor-x sees it. That decoder allocates an array's declared
// length before reading it: measured, 8 KB of nested headers costs 1 GB. Floats and tags fail here too, so a signed number is never a float.
function assertFlat(bytes: Uint8Array, arity: number): void {
  const fail = (): never => { throw new RangeError("this isn't a flat CBOR array of the expected length"); };
  const head = (at: number): { major: number; value: number; next: number } => {
    const first = bytes[at] ?? fail();
    const info = first & 0x1f;
    const major = first >> 5;
    if (info < 24) return { major, value: info, next: at + 1 };
    if (info > 27) return fail();
    const width = 2 ** (info - 24);
    if (at + 1 + width > bytes.length) fail();
    let value = 0;
    for (let i = 0; i < width; i++) value = value * 256 + (bytes[at + 1 + i] as number);
    return { major, value, next: at + 1 + width };
  };
  const top = head(0);
  if (top.major !== 4 || top.value !== arity) fail();
  let at = top.next;
  for (let i = 0; i < arity; i++) {
    if (bytes[at] === 0xf6) { at += 1; continue; }
    const item = head(at);
    if (item.major === 0) at = item.next;
    else if (item.major === 2 || item.major === 3) at = item.next + item.value;
    else fail();
    if (at > bytes.length) fail();
  }
  if (at !== bytes.length) fail();
}

// Integers above 2^32-1 go as a CBOR bigint. cbor-x writes a larger plain number as a float64, and two implementations
// that disagree about which they emit produce different signed bytes for the same value.
function toCborInt(name: string, value: number): number | bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} isn't an integer this code can hold exactly: ${value}`);
  return value > 0xffffffff ? BigInt(value) : value;
}

function fromCborInt(name: string, value: unknown): number {
  const asNumber = typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  if (typeof asNumber !== "number" || !Number.isSafeInteger(asNumber) || asNumber < 0) throw new RangeError(`${name} isn't an integer this code can hold exactly`);
  return asNumber;
}

export interface Structure<T> {
  readonly tag: string;
  encode(fields: T): Uint8Array;
  // For bytes from outside. A verifier then checks a signature over these same bytes, never over a re-encoding.
  decode(bytes: Uint8Array): T;
}

const DEFAULT_MAX_BYTES = 8_192;

function structure<T extends object>(tag: string, slots: Record<keyof T & string, Slot>, options: { maxBytes?: number; check?: (fields: T) => void } = {}): Structure<T> {
  const keys = Object.keys(slots) as (keyof T & string)[];
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const width = (key: keyof T & string, value: unknown): Uint8Array => {
    const slot = slots[key];
    if (!(value instanceof Uint8Array) || (typeof slot === "number" && value.length !== slot)) {
      throw new RangeError(`${key} must be ${typeof slot === "number" ? `${slot} ` : ""}bytes, got ${value instanceof Uint8Array ? value.length : "none"}`);
    }
    return value;
  };
  return {
    tag,
    encode(fields) {
      options.check?.(fields);
      const items: unknown[] = [tag];
      for (const key of keys) {
        const slot = slots[key];
        const value = fields[key] as unknown;
        if (slot === "int") items.push(toCborInt(key, value as number));
        else if (slot === "intOrNull") items.push(value === null ? null : toCborInt(key, value as number));
        else if (slot === "text" || slot === "textOrNull") {
          if (typeof value !== "string" && !(slot === "textOrNull" && value === null)) throw new RangeError(`${key} must be text`);
          items.push(value);
        } else items.push(width(key, value));
      }
      return new Uint8Array(encodeCbor(items));
    },
    decode(bytes) {
      if (bytes.length > maxBytes) throw new RangeError(`${tag} can't be over ${maxBytes} bytes`);
      assertFlat(bytes, keys.length + 1);
      const items = decodeCbor(bytes) as unknown[];
      if (items[0] !== tag) throw new UnknownFormat(`this is ${typeof items[0] === "string" ? items[0].slice(0, 64) : "unnamed"}, and ${tag} was expected`);
      const out: Record<string, unknown> = {};
      keys.forEach((key, i) => {
        const slot = slots[key];
        const value = items[i + 1];
        if (slot === "int") out[key] = fromCborInt(key, value);
        else if (slot === "intOrNull") out[key] = value === null ? null : fromCborInt(key, value);
        else if (slot === "text" || slot === "textOrNull") {
          if (typeof value !== "string" && !(slot === "textOrNull" && value === null)) throw new RangeError(`${key} must be text`);
          out[key] = value;
        } else out[key] = new Uint8Array(width(key, value instanceof Uint8Array ? new Uint8Array(value) : value));
      });
      options.check?.(out as T);
      return out as T;
    },
  };
}

const X25519_PUBLIC_KEY_BYTES = 32;
const NONCE_BYTES = 32;
const ED25519_PUBLIC_KEY_WIDTH = 32;
const ML_DSA_PUBLIC_KEY_WIDTH = 1312;

export const EntryKind = { message: 1, close: 2 } as const;
export type EntryKind = (typeof EntryKind)[keyof typeof EntryKind];

// reply: refused if something the author hasn't read has landed. notice: sent regardless.
export const EntryMode = { reply: 1, notice: 2 } as const;
export type EntryMode = (typeof EntryMode)[keyof typeof EntryMode];

export interface EntryFields {
  sessionId: Uint8Array;
  authorId: Uint8Array;
  authorSeq: number;
  prevOwnHash: Uint8Array;
  readPosition: number;
  readRoot: Uint8Array;
  kind: EntryKind;
  mode: EntryMode;
  contentHash: Uint8Array;
  ciphertextHash: Uint8Array;
  notAfter: number;
}

export const entryStructure = structure<EntryFields>("cello-entry-v1", { sessionId: SESSION_ID_BYTES, authorId: HASH_BYTES, authorSeq: "int", prevOwnHash: HASH_BYTES, readPosition: "int", readRoot: HASH_BYTES, kind: "int", mode: "int", contentHash: HASH_BYTES, ciphertextHash: HASH_BYTES, notAfter: "int" }, { check: (e) => {
  if (!Object.values(EntryKind).includes(e.kind)) throw new RangeError(`unknown entry kind: ${e.kind}`);
  if (!Object.values(EntryMode).includes(e.mode)) throw new RangeError(`unknown entry mode: ${e.mode}`);
} });
export const entryBytes = (fields: EntryFields): Uint8Array => entryStructure.encode(fields);

// For an entry this machine is about to sign. A received one is hashed over its bytes as received.
export function entryHash(e: EntryFields): Uint8Array {
  return sha256(entryBytes(e));
}

export function ciphertextHash(ciphertext: Uint8Array): Uint8Array {
  return sha256(ciphertext);
}

export interface AckFields {
  serverId: Uint8Array;
  sessionId: Uint8Array;
  position: number;
  entryHash: Uint8Array;
  root: Uint8Array;
  time: number;
}

export const ackStructure = structure<AckFields>("cello-ack-v1", { serverId: HASH_BYTES, sessionId: SESSION_ID_BYTES, position: "int", entryHash: HASH_BYTES, root: HASH_BYTES, time: "int" });
export const ackBytes = (fields: AckFields): Uint8Array => ackStructure.encode(fields);

// Means: this reader's machine stored and decrypted everything through this position. Says nothing about agreement.
// screenedThrough is how far its screening has got. It says nothing about whether the reader has seen anything, or what it thought.
export interface DeliveryAckFields {
  sessionId: Uint8Array;
  readerId: Uint8Array;
  throughPosition: number;
  entryHash: Uint8Array;
  root: Uint8Array;
  screenedThrough: number;
}

export const deliveryAckStructure = structure<DeliveryAckFields>("cello-delivery-ack-v1", { sessionId: SESSION_ID_BYTES, readerId: HASH_BYTES, throughPosition: "int", entryHash: HASH_BYTES, root: HASH_BYTES, screenedThrough: "int" }, { check: (d) => {
  if (d.screenedThrough > d.throughPosition) throw new RangeError(`a delivery ack can't say it screened through ${d.screenedThrough} when it only covers ${d.throughPosition}`);
} });
export const deliveryAckBytes = (fields: DeliveryAckFields): Uint8Array => deliveryAckStructure.encode(fields);

const MAX_NAME_BYTES = 64;

export interface RegisterFields {
  serverId: Uint8Array;
  identity: PublicIdentity;
}

const registerStructure = structure<{ serverId: Uint8Array; ed: Uint8Array; pq: Uint8Array }>("cello-register-v1", { serverId: HASH_BYTES, ed: ED25519_PUBLIC_KEY_WIDTH, pq: ML_DSA_PUBLIC_KEY_WIDTH });
export const registerBytes = (r: RegisterFields): Uint8Array => registerStructure.encode({ serverId: r.serverId, ed: r.identity.ed, pq: r.identity.pq });

export interface AgentAuthFields {
  serverId: Uint8Array;
  agentId: Uint8Array;
  serverNonce: Uint8Array;
  clientNonce: Uint8Array;
}

export const agentAuthStructure = structure<AgentAuthFields>("cello-agent-auth-v1", { serverId: HASH_BYTES, agentId: HASH_BYTES, serverNonce: NONCE_BYTES, clientNonce: NONCE_BYTES });
export const agentAuthBytes = (fields: AgentAuthFields): Uint8Array => agentAuthStructure.encode(fields);

export interface ServerAuthFields {
  serverId: Uint8Array;
  clientNonce: Uint8Array;
  serverNonce: Uint8Array;
}

export const serverAuthStructure = structure<ServerAuthFields>("cello-server-auth-v1", { serverId: HASH_BYTES, clientNonce: NONCE_BYTES, serverNonce: NONCE_BYTES });
export const serverAuthBytes = (fields: ServerAuthFields): Uint8Array => serverAuthStructure.encode(fields);

export interface OfferFields {
  serverId: Uint8Array;
  sessionId: Uint8Array;
  callerId: Uint8Array;
  calleeId: Uint8Array;
  x25519Public: Uint8Array;
  mlKemPublic: Uint8Array;
  expiresAt: number;
}

export const offerStructure = structure<OfferFields>("cello-session-offer-v1", { serverId: HASH_BYTES, sessionId: SESSION_ID_BYTES, callerId: HASH_BYTES, calleeId: HASH_BYTES, x25519Public: X25519_PUBLIC_KEY_BYTES, mlKemPublic: ML_KEM_PUBLIC_KEY_BYTES, expiresAt: "int" });
export const offerBytes = (fields: OfferFields): Uint8Array => offerStructure.encode(fields);

export interface AcceptFields {
  offerHash: Uint8Array;
  x25519Public: Uint8Array;
  mlKemCiphertext: Uint8Array;
  sealedSalt: Uint8Array;
  // What this agent calls itself, for the other party's eyes alone. The server holds no names.
  sealedName: Uint8Array;
}

export const acceptStructure = structure<AcceptFields>("cello-session-accept-v1", { offerHash: HASH_BYTES, x25519Public: X25519_PUBLIC_KEY_BYTES, mlKemCiphertext: ML_KEM_CIPHERTEXT_BYTES, sealedSalt: "bytes", sealedName: "bytes" });
export const acceptBytes = (fields: AcceptFields): Uint8Array => acceptStructure.encode(fields);

// A callee's definite no. The reason is sealed to the caller's key from the offer, so the server learns only that it was refused,
// which it could already tell from no answer. A reason could otherwise give away a tier.
export interface RefuseFields {
  offerHash: Uint8Array;
  mlKemCiphertext: Uint8Array;
  sealedReason: Uint8Array;
}

export const refuseStructure = structure<RefuseFields>("cello-session-refuse-v1", { offerHash: HASH_BYTES, mlKemCiphertext: ML_KEM_CIPHERTEXT_BYTES, sealedReason: "bytes" }, { maxBytes: 500_000 });
export const refuseBytes = (fields: RefuseFields): Uint8Array => refuseStructure.encode(fields);

// A callee's away greeting. Outside the chain, so it's no part of what the parties said. It's signed so the caller knows who wrote it,
// and the signature covers only ciphertext, because a hash of so short a text would let the server guess it.
export interface GreetingFields {
  offerHash: Uint8Array;
  sealedText: Uint8Array;
}

export const greetingStructure = structure<GreetingFields>("cello-session-greeting-v1", { offerHash: HASH_BYTES, sealedText: "bytes" }, { maxBytes: 500_000 });
export const greetingBytes = (fields: GreetingFields): Uint8Array => greetingStructure.encode(fields);

export interface ConfirmFields {
  acceptHash: Uint8Array;
  sealedSalt: Uint8Array;
  sealedName: Uint8Array;
}

export const confirmStructure = structure<ConfirmFields>("cello-session-confirm-v1", { acceptHash: HASH_BYTES, sealedSalt: "bytes", sealedName: "bytes" });
export const confirmBytes = (fields: ConfirmFields): Uint8Array => confirmStructure.encode(fields);

// The server's statement that this session exists here, with these two parties, from this setup.
export interface AssignmentFields {
  serverId: Uint8Array;
  sessionId: Uint8Array;
  callerId: Uint8Array;
  calleeId: Uint8Array;
  confirmHash: Uint8Array;
  time: number;
}

export const assignmentStructure = structure<AssignmentFields>("cello-session-assignment-v1", { serverId: HASH_BYTES, sessionId: SESSION_ID_BYTES, callerId: HASH_BYTES, calleeId: HASH_BYTES, confirmHash: HASH_BYTES, time: "int" });
export const assignmentBytes = (fields: AssignmentFields): Uint8Array => assignmentStructure.encode(fields);

// The sealer's statement that it holds this root at this position, and asks for it to be sealed.
export interface SealRequestFields {
  serverId: Uint8Array;
  sessionId: Uint8Array;
  sealerId: Uint8Array;
  throughPosition: number;
  root: Uint8Array;
}

export const sealRequestStructure = structure<SealRequestFields>("cello-seal-request-v1", { serverId: HASH_BYTES, sessionId: SESSION_ID_BYTES, sealerId: HASH_BYTES, throughPosition: "int", root: HASH_BYTES });
export const sealRequestBytes = (fields: SealRequestFields): Uint8Array => sealRequestStructure.encode(fields);

// Signed by the seal key, and neutral on agreement: it attests that this conversation took place.
// throughPosition is N, witnessed through. receivedThrough is M, covered by the counterparty's own delivery ack.
export interface SealCertificateFields {
  sealKeyId: Uint8Array;
  serverId: Uint8Array;
  sessionId: Uint8Array;
  sealerId: Uint8Array;
  counterpartyId: Uint8Array;
  requestHash: Uint8Array;
  root: Uint8Array;
  throughPosition: number;
  tip: number;
  closed: number;
  receivedThrough: number;
  // ZERO_HASH when the counterparty has acknowledged nothing.
  deliveryAckHash: Uint8Array;
  time: number;
}

export const sealCertificateStructure = structure<SealCertificateFields>("cello-seal-certificate-v1", { sealKeyId: HASH_BYTES, serverId: HASH_BYTES, sessionId: SESSION_ID_BYTES, sealerId: HASH_BYTES, counterpartyId: HASH_BYTES, requestHash: HASH_BYTES, root: HASH_BYTES, throughPosition: "int", tip: "int", closed: "int", receivedThrough: "int", deliveryAckHash: HASH_BYTES, time: "int" }, { check: (c) => {
  if (c.closed !== 0 && c.closed !== 1) throw new RangeError(`closed must be 0 or 1, got ${c.closed}`);
} });
export const sealCertificateBytes = (fields: SealCertificateFields): Uint8Array => sealCertificateStructure.encode(fields);

// The seal log's state after an append. A witness outside the operator would countersign exactly this.
export interface SealLogHeadFields {
  sealKeyId: Uint8Array;
  size: number;
  root: Uint8Array;
  time: number;
}

export const sealLogHeadStructure = structure<SealLogHeadFields>("cello-seal-log-head-v1", { sealKeyId: HASH_BYTES, size: "int", root: HASH_BYTES, time: "int" });
export const sealLogHeadBytes = (fields: SealLogHeadFields): Uint8Array => sealLogHeadStructure.encode(fields);

// The server's identity saying this seal key is its own.
export interface SealKeyBindingFields {
  serverId: Uint8Array;
  sealKeyId: Uint8Array;
}

export const sealKeyBindingStructure = structure<SealKeyBindingFields>("cello-seal-key-binding-v1", { serverId: HASH_BYTES, sealKeyId: HASH_BYTES });
export const sealKeyBindingBytes = (fields: SealKeyBindingFields): Uint8Array => sealKeyBindingStructure.encode(fields);

export function structureHash(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

// ---- An agent's status ----

export const AgentStatus = { active: 1, suspended: 2, retired: 3 } as const;
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

export const StatusReason = { none: 0, owner_request: 1, lost_machine: 2, compromise: 3 } as const;
export type StatusReason = (typeof StatusReason)[keyof typeof StatusReason];

// Who signed. agent: the identity's own keys. portal: a key a server is configured to trust. server: that server's operator, good on that server only.
export const StatusIssuer = { agent: 1, portal: 2, server: 3 } as const;
export type StatusIssuer = (typeof StatusIssuer)[keyof typeof StatusIssuer];

// Names no server, so the same bytes are good on any server that trusts the issuer.
export interface StatusStatementFields {
  agentId: Uint8Array;
  status: AgentStatus;
  reason: StatusReason;
  issuer: StatusIssuer;
  issuerId: Uint8Array;
  issuedAt: number;
}

export const statusStatementStructure = structure<StatusStatementFields>("cello-agent-status-v1", { agentId: HASH_BYTES, status: "int", reason: "int", issuer: "int", issuerId: HASH_BYTES, issuedAt: "int" }, { check: (s) => {
  if (!Object.values(AgentStatus).includes(s.status)) throw new RangeError(`unknown agent status: ${s.status}`);
  if (!Object.values(StatusReason).includes(s.reason)) throw new RangeError(`unknown status reason: ${s.reason}`);
  if (!Object.values(StatusIssuer).includes(s.issuer)) throw new RangeError(`unknown status issuer: ${s.issuer}`);
} });
export const statusStatementBytes = (fields: StatusStatementFields): Uint8Array => statusStatementStructure.encode(fields);

// The server saying when it took a statement. Each links to the one before for that agent, so a reader sees the whole history in order.
export interface StatusWitnessFields {
  serverId: Uint8Array;
  agentId: Uint8Array;
  seq: number;
  prevHash: Uint8Array;
  statementHash: Uint8Array;
  time: number;
}

export const statusWitnessStructure = structure<StatusWitnessFields>("cello-agent-status-witness-v1", { serverId: HASH_BYTES, agentId: HASH_BYTES, seq: "int", prevHash: HASH_BYTES, statementHash: HASH_BYTES, time: "int" });
export const statusWitnessBytes = (fields: StatusWitnessFields): Uint8Array => statusWitnessStructure.encode(fields);

export const ChannelVisibility = { public: 1, private: 2 } as const;
export type ChannelVisibility = (typeof ChannelVisibility)[keyof typeof ChannelVisibility];

export const ChannelPosting = { admin: 1, posters: 2, members: 3 } as const;
export type ChannelPosting = (typeof ChannelPosting)[keyof typeof ChannelPosting];

// Signed by the channel key and by its admin, and it never changes.
export interface ChannelRecordFields {
  channelId: Uint8Array;
  adminId: Uint8Array;
  visibility: number;
}

export const channelRecordStructure = structure<ChannelRecordFields>("cello-channel-record-v1", { channelId: HASH_BYTES, adminId: HASH_BYTES, visibility: "int" });
export const channelRecordBytes = (fields: ChannelRecordFields): Uint8Array => channelRecordStructure.encode(fields);

// The channel's settings, signed by the channel key. Readers refuse a poster this doesn't allow.
export interface ChannelInfoFields {
  channelId: Uint8Array;
  revision: number;
  posting: number;
  retentionMs: number;
  generation: number;
  x25519Public: Uint8Array;
  mlKemPublic: Uint8Array;
  // Named posters' ids, one after another.
  posters: Uint8Array;
  name: Uint8Array;
}

export const channelInfoStructure = structure<ChannelInfoFields>("cello-channel-info-v1", { channelId: HASH_BYTES, revision: "int", posting: "int", retentionMs: "int", generation: "int", x25519Public: X25519_PUBLIC_KEY_BYTES, mlKemPublic: ML_KEM_PUBLIC_KEY_BYTES, posters: "bytes", name: "bytes" }, { maxBytes: 2_000_000, check: (i) => {
  if (i.posters.length % HASH_BYTES !== 0) throw new RangeError("the poster list must be whole ids");
  if (i.name.length === 0 || i.name.length > MAX_NAME_BYTES) throw new RangeError(`a channel name must be 1 to ${MAX_NAME_BYTES} bytes`);
} });
export const channelInfoBytes = (fields: ChannelInfoFields): Uint8Array => channelInfoStructure.encode(fields);

// The poster's signature covers its channel, key generation and own counter, so the server can't re-post an old "Approved" as new.
// The channel's number isn't here: the server assigns it, and says so in the ack.
export interface ChannelPostFields {
  channelId: Uint8Array;
  generation: number;
  authorId: Uint8Array;
  authorSeq: number;
  publishedAt: number;
  titleHash: Uint8Array;
  bodyHash: Uint8Array;
}

export const channelPostStructure = structure<ChannelPostFields>("cello-channel-post-v1", { channelId: HASH_BYTES, generation: "int", authorId: HASH_BYTES, authorSeq: "int", publishedAt: "int", titleHash: HASH_BYTES, bodyHash: HASH_BYTES });
export const channelPostBytes = (fields: ChannelPostFields): Uint8Array => channelPostStructure.encode(fields);

export interface ChannelPostAckFields {
  serverId: Uint8Array;
  channelId: Uint8Array;
  position: number;
  postHash: Uint8Array;
  time: number;
}

export const channelPostAckStructure = structure<ChannelPostAckFields>("cello-channel-post-ack-v1", { serverId: HASH_BYTES, channelId: HASH_BYTES, position: "int", postHash: HASH_BYTES, time: "int" });
export const channelPostAckBytes = (fields: ChannelPostAckFields): Uint8Array => channelPostAckStructure.encode(fields);

// The first position the server holds, under its signature. A number below it aged out. An absent number above it is a gap.
export interface ChannelStateFields {
  serverId: Uint8Array;
  channelId: Uint8Array;
  firstHeld: number;
  tip: number;
  time: number;
}

export const channelStateStructure = structure<ChannelStateFields>("cello-channel-state-v1", { serverId: HASH_BYTES, channelId: HASH_BYTES, firstHeld: "int", tip: "int", time: "int" });
export const channelStateBytes = (fields: ChannelStateFields): Uint8Array => channelStateStructure.encode(fields);

// Signed by a joiner's own identity, so nobody can swap in a key of theirs and be handed the group key.
export interface ChannelMemberKeyFields {
  channelId: Uint8Array;
  agentId: Uint8Array;
  x25519Public: Uint8Array;
  mlKemPublic: Uint8Array;
  requestedAt: number;
}

export const channelMemberKeyStructure = structure<ChannelMemberKeyFields>("cello-channel-member-key-v1", { channelId: HASH_BYTES, agentId: HASH_BYTES, x25519Public: X25519_PUBLIC_KEY_BYTES, mlKemPublic: ML_KEM_PUBLIC_KEY_BYTES, requestedAt: "int" });
export const channelMemberKeyBytes = (fields: ChannelMemberKeyFields): Uint8Array => channelMemberKeyStructure.encode(fields);

// The admin's signed, hash-chained list of members and the member key each one signed for.
// The server holds it and can't change it, which is what stops the server adding itself to a private channel.
export interface ChannelRosterFields {
  channelId: Uint8Array;
  revision: number;
  generation: number;
  prevHash: Uint8Array;
  membersHash: Uint8Array;
}

export const channelRosterStructure = structure<ChannelRosterFields>("cello-channel-roster-v1", { channelId: HASH_BYTES, revision: "int", generation: "int", prevHash: HASH_BYTES, membersHash: HASH_BYTES });
export const channelRosterBytes = (fields: ChannelRosterFields): Uint8Array => channelRosterStructure.encode(fields);

// One generation's group key, sealed to one member. Signed, because anyone can seal to a public key:
// without this, a hostile server could hand a member a key of its own and read everything they post.
export interface ChannelKeyEntryFields {
  channelId: Uint8Array;
  generation: number;
  memberId: Uint8Array;
  rosterHash: Uint8Array;
  sealedHash: Uint8Array;
}

export const channelKeyEntryStructure = structure<ChannelKeyEntryFields>("cello-channel-key-entry-v1", { channelId: HASH_BYTES, generation: "int", memberId: HASH_BYTES, rosterHash: HASH_BYTES, sealedHash: HASH_BYTES });
export const channelKeyEntryBytes = (fields: ChannelKeyEntryFields): Uint8Array => channelKeyEntryStructure.encode(fields);

// What a session's message says, encrypted to the other party and hashed into the signed entry.
// A close carries a flag instead of text. Minutes go as whole seconds, because a signed number is never a float.
export interface Body {
  n: Uint8Array;
  text: string;
  signal: "over" | "standby" | "wrap" | null;
  est_minutes: number | null;
  one_message?: true;
}

const bodyStructure = structure<{ n: Uint8Array; text: string; signal: string | null; estSeconds: number | null; oneMessage: number }>("cello-body-v1", { n: "bytes", text: "text", signal: "textOrNull", estSeconds: "intOrNull", oneMessage: "int" }, { maxBytes: 1_100_000 });

export function bodyBytes(b: Body): Uint8Array {
  return bodyStructure.encode({ n: b.n, text: b.text, signal: b.signal, estSeconds: b.est_minutes === null ? null : Math.ceil(b.est_minutes * 60), oneMessage: b.one_message ? 1 : 0 });
}

// Null for anything that isn't exactly what a CELLO client writes.
export function readBodyBytes(bytes: Uint8Array): Body | null {
  try {
    const b = bodyStructure.decode(bytes);
    if (b.signal !== null && b.signal !== "over" && b.signal !== "standby" && b.signal !== "wrap") return null;
    if (b.oneMessage !== 0 && b.oneMessage !== 1) return null;
    return { n: b.n, text: b.text, signal: b.signal, est_minutes: b.estSeconds === null ? null : b.estSeconds / 60, ...(b.oneMessage === 1 ? { one_message: true as const } : {}) };
  } catch {
    return null;
  }
}

const identityStructure = structure<{ ed: Uint8Array; pq: Uint8Array }>("cello-identity-v1", { ed: ED25519_PUBLIC_KEY_WIDTH, pq: ML_DSA_PUBLIC_KEY_WIDTH });
export const identityBytes = (pub: { ed: Uint8Array; pq: Uint8Array }): Uint8Array => identityStructure.encode({ ed: pub.ed, pq: pub.pq });

// One roster member: what they signed, exactly as they signed it, with their keys and signature.
const rosterMemberStructure = structure<{ ed: Uint8Array; pq: Uint8Array; memberKey: Uint8Array; signatureEd: Uint8Array; signaturePq: Uint8Array }>("cello-channel-member-v1", { ed: ED25519_PUBLIC_KEY_WIDTH, pq: ML_DSA_PUBLIC_KEY_WIDTH, memberKey: "bytes", signatureEd: "bytes", signaturePq: "bytes" });
export const rosterMemberBytes = (m: { ed: Uint8Array; pq: Uint8Array; memberKey: Uint8Array; signatureEd: Uint8Array; signaturePq: Uint8Array }): Uint8Array => rosterMemberStructure.encode(m);
const rosterMembersTag = "cello-channel-members-v1";
// A list of any length, so it's hashed as its members' hashes: tag, then each 32-byte hash, in order.
export function rosterMembersBytes(memberHashes: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(encodeCbor([rosterMembersTag, ...memberHashes]));
}

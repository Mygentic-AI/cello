// The exact bytes each party signs. The wire format can change without touching these.
import { sha256 } from "@noble/hashes/sha2.js";
import { HASH_BYTES, SESSION_ID_BYTES, encodeFields, exact, u64, u8 } from "./encode.ts";
import { ML_KEM_CIPHERTEXT_BYTES, ML_KEM_PUBLIC_KEY_BYTES } from "./ml-kem.ts";
import type { PublicIdentity } from "./identity.ts";

export const PROTOCOL_VERSION = 1;

const VERSION = u8(PROTOCOL_VERSION);
const X25519_PUBLIC_KEY_BYTES = 32;
const NONCE_BYTES = 32;

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

export function entryBytes(e: EntryFields): Uint8Array {
  if (!Object.values(EntryKind).includes(e.kind)) throw new RangeError(`unknown entry kind: ${e.kind}`);
  if (!Object.values(EntryMode).includes(e.mode)) throw new RangeError(`unknown entry mode: ${e.mode}`);
  return encodeFields([
    VERSION,
    exact("session id", e.sessionId, SESSION_ID_BYTES),
    exact("author id", e.authorId, HASH_BYTES),
    u64(e.authorSeq),
    exact("previous own hash", e.prevOwnHash, HASH_BYTES),
    u64(e.readPosition),
    exact("read root", e.readRoot, HASH_BYTES),
    u8(e.kind),
    u8(e.mode),
    exact("content hash", e.contentHash, HASH_BYTES),
    exact("ciphertext hash", e.ciphertextHash, HASH_BYTES),
    u64(e.notAfter),
  ]);
}

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

export function ackBytes(a: AckFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("server id", a.serverId, HASH_BYTES),
    exact("session id", a.sessionId, SESSION_ID_BYTES),
    u64(a.position),
    exact("entry hash", a.entryHash, HASH_BYTES),
    exact("root", a.root, HASH_BYTES),
    u64(a.time),
  ]);
}

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

export function deliveryAckBytes(d: DeliveryAckFields): Uint8Array {
  if (d.screenedThrough > d.throughPosition) throw new RangeError(`a delivery ack can't say it screened through ${d.screenedThrough} when it only covers ${d.throughPosition}`);
  return encodeFields([
    VERSION,
    exact("session id", d.sessionId, SESSION_ID_BYTES),
    exact("reader id", d.readerId, HASH_BYTES),
    u64(d.throughPosition),
    exact("entry hash", d.entryHash, HASH_BYTES),
    exact("root", d.root, HASH_BYTES),
    u64(d.screenedThrough),
  ]);
}

const MAX_NAME_BYTES = 64;

export interface RegisterFields {
  serverId: Uint8Array;
  identity: PublicIdentity;
}

export function registerBytes(r: RegisterFields): Uint8Array {
  return encodeFields([VERSION, exact("server id", r.serverId, HASH_BYTES), r.identity.ed, r.identity.pq]);
}

export interface AgentAuthFields {
  serverId: Uint8Array;
  agentId: Uint8Array;
  serverNonce: Uint8Array;
  clientNonce: Uint8Array;
}

export function agentAuthBytes(a: AgentAuthFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("server id", a.serverId, HASH_BYTES),
    exact("agent id", a.agentId, HASH_BYTES),
    exact("server nonce", a.serverNonce, NONCE_BYTES),
    exact("client nonce", a.clientNonce, NONCE_BYTES),
  ]);
}

export interface ServerAuthFields {
  serverId: Uint8Array;
  clientNonce: Uint8Array;
  serverNonce: Uint8Array;
}

export function serverAuthBytes(s: ServerAuthFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("server id", s.serverId, HASH_BYTES),
    exact("client nonce", s.clientNonce, NONCE_BYTES),
    exact("server nonce", s.serverNonce, NONCE_BYTES),
  ]);
}

export interface OfferFields {
  serverId: Uint8Array;
  sessionId: Uint8Array;
  callerId: Uint8Array;
  calleeId: Uint8Array;
  x25519Public: Uint8Array;
  mlKemPublic: Uint8Array;
  expiresAt: number;
}

export function offerBytes(o: OfferFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("server id", o.serverId, HASH_BYTES),
    exact("session id", o.sessionId, SESSION_ID_BYTES),
    exact("caller id", o.callerId, HASH_BYTES),
    exact("callee id", o.calleeId, HASH_BYTES),
    exact("X25519 public key", o.x25519Public, X25519_PUBLIC_KEY_BYTES),
    exact("ML-KEM public key", o.mlKemPublic, ML_KEM_PUBLIC_KEY_BYTES),
    u64(o.expiresAt),
  ]);
}

export interface AcceptFields {
  offerHash: Uint8Array;
  x25519Public: Uint8Array;
  mlKemCiphertext: Uint8Array;
  sealedSalt: Uint8Array;
  // What this agent calls itself, for the other party's eyes alone. The server holds no names.
  sealedName: Uint8Array;
}

export function acceptBytes(a: AcceptFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("offer hash", a.offerHash, HASH_BYTES),
    exact("X25519 public key", a.x25519Public, X25519_PUBLIC_KEY_BYTES),
    exact("ML-KEM ciphertext", a.mlKemCiphertext, ML_KEM_CIPHERTEXT_BYTES),
    a.sealedSalt,
    a.sealedName,
  ]);
}

// A callee's definite no. The reason is sealed to the caller's key from the offer, so the server learns only that it was refused,
// which it could already tell from no answer. A reason could otherwise give away a tier.
export interface RefuseFields {
  offerHash: Uint8Array;
  mlKemCiphertext: Uint8Array;
  sealedReason: Uint8Array;
}

export function refuseBytes(r: RefuseFields): Uint8Array {
  return encodeFields([VERSION, exact("offer hash", r.offerHash, HASH_BYTES), exact("ML-KEM ciphertext", r.mlKemCiphertext, ML_KEM_CIPHERTEXT_BYTES), r.sealedReason]);
}

export interface ConfirmFields {
  acceptHash: Uint8Array;
  sealedSalt: Uint8Array;
  sealedName: Uint8Array;
}

export function confirmBytes(c: ConfirmFields): Uint8Array {
  return encodeFields([VERSION, exact("accept hash", c.acceptHash, HASH_BYTES), c.sealedSalt, c.sealedName]);
}

// The server's statement that this session exists here, with these two parties, from this setup.
export interface AssignmentFields {
  serverId: Uint8Array;
  sessionId: Uint8Array;
  callerId: Uint8Array;
  calleeId: Uint8Array;
  confirmHash: Uint8Array;
  time: number;
}

export function assignmentBytes(a: AssignmentFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("server id", a.serverId, HASH_BYTES),
    exact("session id", a.sessionId, SESSION_ID_BYTES),
    exact("caller id", a.callerId, HASH_BYTES),
    exact("callee id", a.calleeId, HASH_BYTES),
    exact("confirm hash", a.confirmHash, HASH_BYTES),
    u64(a.time),
  ]);
}

// The sealer's statement that it holds this root at this position, and asks for it to be sealed.
export interface SealRequestFields {
  serverId: Uint8Array;
  sessionId: Uint8Array;
  sealerId: Uint8Array;
  throughPosition: number;
  root: Uint8Array;
}

export function sealRequestBytes(r: SealRequestFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("server id", r.serverId, HASH_BYTES),
    exact("session id", r.sessionId, SESSION_ID_BYTES),
    exact("sealer id", r.sealerId, HASH_BYTES),
    u64(r.throughPosition),
    exact("root", r.root, HASH_BYTES),
  ]);
}

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

export function sealCertificateBytes(c: SealCertificateFields): Uint8Array {
  if (c.closed !== 0 && c.closed !== 1) throw new RangeError(`closed must be 0 or 1, got ${c.closed}`);
  return encodeFields([
    VERSION,
    exact("seal key id", c.sealKeyId, HASH_BYTES),
    exact("server id", c.serverId, HASH_BYTES),
    exact("session id", c.sessionId, SESSION_ID_BYTES),
    exact("sealer id", c.sealerId, HASH_BYTES),
    exact("counterparty id", c.counterpartyId, HASH_BYTES),
    exact("request hash", c.requestHash, HASH_BYTES),
    exact("root", c.root, HASH_BYTES),
    u64(c.throughPosition),
    u64(c.tip),
    u8(c.closed),
    u64(c.receivedThrough),
    exact("delivery ack hash", c.deliveryAckHash, HASH_BYTES),
    u64(c.time),
  ]);
}

// The seal log's state after an append. A witness outside the operator would countersign exactly this.
export interface SealLogHeadFields {
  sealKeyId: Uint8Array;
  size: number;
  root: Uint8Array;
  time: number;
}

export function sealLogHeadBytes(h: SealLogHeadFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("seal key id", h.sealKeyId, HASH_BYTES),
    u64(h.size),
    exact("root", h.root, HASH_BYTES),
    u64(h.time),
  ]);
}

// The server's identity saying this seal key is its own.
export interface SealKeyBindingFields {
  serverId: Uint8Array;
  sealKeyId: Uint8Array;
}

export function sealKeyBindingBytes(b: SealKeyBindingFields): Uint8Array {
  return encodeFields([VERSION, exact("server id", b.serverId, HASH_BYTES), exact("seal key id", b.sealKeyId, HASH_BYTES)]);
}

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

export function statusStatementBytes(s: StatusStatementFields): Uint8Array {
  if (!Object.values(AgentStatus).includes(s.status)) throw new RangeError(`unknown agent status: ${s.status}`);
  if (!Object.values(StatusReason).includes(s.reason)) throw new RangeError(`unknown status reason: ${s.reason}`);
  if (!Object.values(StatusIssuer).includes(s.issuer)) throw new RangeError(`unknown status issuer: ${s.issuer}`);
  return encodeFields([
    VERSION,
    exact("agent id", s.agentId, HASH_BYTES),
    u8(s.status),
    u8(s.reason),
    u8(s.issuer),
    exact("issuer id", s.issuerId, HASH_BYTES),
    u64(s.issuedAt),
  ]);
}

// The server saying when it took a statement. Each links to the one before for that agent, so a reader sees the whole history in order.
export interface StatusWitnessFields {
  serverId: Uint8Array;
  agentId: Uint8Array;
  seq: number;
  prevHash: Uint8Array;
  statementHash: Uint8Array;
  time: number;
}

export function statusWitnessBytes(w: StatusWitnessFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("server id", w.serverId, HASH_BYTES),
    exact("agent id", w.agentId, HASH_BYTES),
    u64(w.seq),
    exact("previous hash", w.prevHash, HASH_BYTES),
    exact("statement hash", w.statementHash, HASH_BYTES),
    u64(w.time),
  ]);
}

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

export function channelRecordBytes(r: ChannelRecordFields): Uint8Array {
  return encodeFields([VERSION, exact("channel id", r.channelId, HASH_BYTES), exact("admin id", r.adminId, HASH_BYTES), u8(r.visibility)]);
}

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

export function channelInfoBytes(i: ChannelInfoFields): Uint8Array {
  if (i.posters.length % HASH_BYTES !== 0) throw new RangeError("the poster list must be whole ids");
  if (i.name.length === 0 || i.name.length > MAX_NAME_BYTES) throw new RangeError(`a channel name must be 1 to ${MAX_NAME_BYTES} bytes`);
  return encodeFields([
    VERSION,
    exact("channel id", i.channelId, HASH_BYTES),
    u64(i.revision),
    u8(i.posting),
    u64(i.retentionMs),
    u64(i.generation),
    exact("X25519 public key", i.x25519Public, X25519_PUBLIC_KEY_BYTES),
    exact("ML-KEM public key", i.mlKemPublic, ML_KEM_PUBLIC_KEY_BYTES),
    i.posters,
    i.name,
  ]);
}

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

export function channelPostBytes(p: ChannelPostFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("channel id", p.channelId, HASH_BYTES),
    u64(p.generation),
    exact("author id", p.authorId, HASH_BYTES),
    u64(p.authorSeq),
    u64(p.publishedAt),
    exact("title hash", p.titleHash, HASH_BYTES),
    exact("body hash", p.bodyHash, HASH_BYTES),
  ]);
}

export interface ChannelPostAckFields {
  serverId: Uint8Array;
  channelId: Uint8Array;
  position: number;
  postHash: Uint8Array;
  time: number;
}

export function channelPostAckBytes(a: ChannelPostAckFields): Uint8Array {
  return encodeFields([VERSION, exact("server id", a.serverId, HASH_BYTES), exact("channel id", a.channelId, HASH_BYTES), u64(a.position), exact("post hash", a.postHash, HASH_BYTES), u64(a.time)]);
}

// The first position the server holds, under its signature. A number below it aged out. An absent number above it is a gap.
export interface ChannelStateFields {
  serverId: Uint8Array;
  channelId: Uint8Array;
  firstHeld: number;
  tip: number;
  time: number;
}

export function channelStateBytes(s: ChannelStateFields): Uint8Array {
  return encodeFields([VERSION, exact("server id", s.serverId, HASH_BYTES), exact("channel id", s.channelId, HASH_BYTES), u64(s.firstHeld), u64(s.tip), u64(s.time)]);
}

// Signed by a joiner's own identity, so nobody can swap in a key of theirs and be handed the group key.
export interface ChannelMemberKeyFields {
  channelId: Uint8Array;
  agentId: Uint8Array;
  x25519Public: Uint8Array;
  mlKemPublic: Uint8Array;
  requestedAt: number;
}

export function channelMemberKeyBytes(m: ChannelMemberKeyFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("channel id", m.channelId, HASH_BYTES),
    exact("agent id", m.agentId, HASH_BYTES),
    exact("X25519 public key", m.x25519Public, X25519_PUBLIC_KEY_BYTES),
    exact("ML-KEM public key", m.mlKemPublic, ML_KEM_PUBLIC_KEY_BYTES),
    u64(m.requestedAt),
  ]);
}

// The admin's signed, hash-chained list of members and the member key each one signed for.
// The server holds it and can't change it, which is what stops the server adding itself to a private channel.
export interface ChannelRosterFields {
  channelId: Uint8Array;
  revision: number;
  generation: number;
  prevHash: Uint8Array;
  membersHash: Uint8Array;
}

export function channelRosterBytes(r: ChannelRosterFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("channel id", r.channelId, HASH_BYTES),
    u64(r.revision),
    u64(r.generation),
    exact("previous roster hash", r.prevHash, HASH_BYTES),
    exact("members hash", r.membersHash, HASH_BYTES),
  ]);
}

// One generation's group key, sealed to one member. Signed, because anyone can seal to a public key:
// without this, a hostile server could hand a member a key of its own and read everything they post.
export interface ChannelKeyEntryFields {
  channelId: Uint8Array;
  generation: number;
  memberId: Uint8Array;
  rosterHash: Uint8Array;
  sealedHash: Uint8Array;
}

export function channelKeyEntryBytes(e: ChannelKeyEntryFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("channel id", e.channelId, HASH_BYTES),
    u64(e.generation),
    exact("member id", e.memberId, HASH_BYTES),
    exact("roster hash", e.rosterHash, HASH_BYTES),
    exact("sealed hash", e.sealedHash, HASH_BYTES),
  ]);
}

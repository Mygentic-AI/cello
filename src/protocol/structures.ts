// The exact bytes each party signs. The wire format can change without touching these.
import { sha256 } from "@noble/hashes/sha2.js";
import { HASH_BYTES, SESSION_ID_BYTES, encodeFields, exact, u64, u8 } from "./encode.ts";
import { ML_KEM_CIPHERTEXT_BYTES, ML_KEM_PUBLIC_KEY_BYTES } from "./ml-kem.ts";
import type { PublicIdentity } from "./identity.ts";

export const PROTOCOL_VERSION = 1;

const VERSION = u8(PROTOCOL_VERSION);
const X25519_PUBLIC_KEY_BYTES = 32;
const NONCE_BYTES = 32;
const MAX_NAME_BYTES = 64;

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
export interface DeliveryAckFields {
  sessionId: Uint8Array;
  readerId: Uint8Array;
  throughPosition: number;
  entryHash: Uint8Array;
  root: Uint8Array;
}

export function deliveryAckBytes(d: DeliveryAckFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("session id", d.sessionId, SESSION_ID_BYTES),
    exact("reader id", d.readerId, HASH_BYTES),
    u64(d.throughPosition),
    exact("entry hash", d.entryHash, HASH_BYTES),
    exact("root", d.root, HASH_BYTES),
  ]);
}

export interface RegisterFields {
  serverId: Uint8Array;
  identity: PublicIdentity;
  name: string;
}

export function registerBytes(r: RegisterFields): Uint8Array {
  const name = new TextEncoder().encode(r.name);
  if (name.length === 0 || name.length > MAX_NAME_BYTES) throw new RangeError(`a name must be 1 to ${MAX_NAME_BYTES} bytes`);
  return encodeFields([VERSION, exact("server id", r.serverId, HASH_BYTES), r.identity.ed, r.identity.pq, name]);
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
}

export function acceptBytes(a: AcceptFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("offer hash", a.offerHash, HASH_BYTES),
    exact("X25519 public key", a.x25519Public, X25519_PUBLIC_KEY_BYTES),
    exact("ML-KEM ciphertext", a.mlKemCiphertext, ML_KEM_CIPHERTEXT_BYTES),
    a.sealedSalt,
  ]);
}

export interface ConfirmFields {
  acceptHash: Uint8Array;
  sealedSalt: Uint8Array;
}

export function confirmBytes(c: ConfirmFields): Uint8Array {
  return encodeFields([VERSION, exact("accept hash", c.acceptHash, HASH_BYTES), c.sealedSalt]);
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

// Channels. Each poster has their own numbered lane, and a number means nothing in any other lane, generation or channel.
export const ChannelVisibility = { public: 1, private: 2 } as const;
export type ChannelVisibility = (typeof ChannelVisibility)[keyof typeof ChannelVisibility];

export const ChannelPosting = { admin: 1, posters: 2, members: 3 } as const;
export type ChannelPosting = (typeof ChannelPosting)[keyof typeof ChannelPosting];

export const ChannelVerdict = { approved: 1, refused: 2, ejected: 3 } as const;
export type ChannelVerdict = (typeof ChannelVerdict)[keyof typeof ChannelVerdict];

// The pointer the server holds. Signed by the channel key and by its admin, and it never changes.
export interface ChannelRecordFields {
  channelId: Uint8Array;
  adminId: Uint8Array;
  visibility: number;
  // JSON of the store list. The reader needs the exact bytes, so it's kept as bytes.
  stores: Uint8Array;
}

export function channelRecordBytes(r: ChannelRecordFields): Uint8Array {
  return encodeFields([VERSION, exact("channel id", r.channelId, HASH_BYTES), exact("admin id", r.adminId, HASH_BYTES), u8(r.visibility), r.stores]);
}

export interface ChannelInfoFields {
  channelId: Uint8Array;
  revision: number;
  posting: number;
  retentionMs: number;
  hardCapMs: number;
  generation: number;
  // When this generation began. Nothing new may go under an older key from then on.
  generationAt: number;
  x25519Public: Uint8Array;
  mlKemPublic: Uint8Array;
  // Revoked posters' ids, one after another.
  revoked: Uint8Array;
  name: Uint8Array;
}

export function channelInfoBytes(i: ChannelInfoFields): Uint8Array {
  if (i.revoked.length % HASH_BYTES !== 0) throw new RangeError("the revoked list must be whole ids");
  if (i.name.length === 0 || i.name.length > MAX_NAME_BYTES) throw new RangeError(`a channel name must be 1 to ${MAX_NAME_BYTES} bytes`);
  return encodeFields([
    VERSION,
    exact("channel id", i.channelId, HASH_BYTES),
    u64(i.revision),
    u8(i.posting),
    u64(i.retentionMs),
    u64(i.hardCapMs),
    u64(i.generation),
    u64(i.generationAt),
    exact("X25519 public key", i.x25519Public, X25519_PUBLIC_KEY_BYTES),
    exact("ML-KEM public key", i.mlKemPublic, ML_KEM_PUBLIC_KEY_BYTES),
    i.revoked,
    i.name,
  ]);
}

// The signature covers where the post belongs, so it can't be re-posted under another number, lane, generation or channel.
export interface ChannelPostFields {
  channelId: Uint8Array;
  cap: Uint8Array;
  generation: number;
  laneId: Uint8Array;
  seq: number;
  publishedAt: number;
  titleHash: Uint8Array;
  bodyHash: Uint8Array;
}

export function channelPostBytes(p: ChannelPostFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("channel id", p.channelId, HASH_BYTES),
    exact("path capability", p.cap, HASH_BYTES),
    u64(p.generation),
    exact("lane id", p.laneId, HASH_BYTES),
    u64(p.seq),
    u64(p.publishedAt),
    exact("title hash", p.titleHash, HASH_BYTES),
    exact("body hash", p.bodyHash, HASH_BYTES),
  ]);
}

// Only this signature moves a reader's position. A store reports no floor of its own.
export interface ChannelHeadFields {
  channelId: Uint8Array;
  cap: Uint8Array;
  generation: number;
  laneId: Uint8Array;
  floor: number;
  lastSeq: number;
  signedAt: number;
}

export function channelHeadBytes(h: ChannelHeadFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("channel id", h.channelId, HASH_BYTES),
    exact("path capability", h.cap, HASH_BYTES),
    u64(h.generation),
    exact("lane id", h.laneId, HASH_BYTES),
    u64(h.floor),
    u64(h.lastSeq),
    u64(h.signedAt),
  ]);
}

export interface ChannelPassFields {
  channelId: Uint8Array;
  posterId: Uint8Array;
  expiresAt: number;
}

export function channelPassBytes(p: ChannelPassFields): Uint8Array {
  return encodeFields([VERSION, exact("channel id", p.channelId, HASH_BYTES), exact("poster id", p.posterId, HASH_BYTES), u64(p.expiresAt)]);
}

// A generation's group key, sealed once per member. A later revision of one generation adds members.
export interface ChannelBundleFields {
  channelId: Uint8Array;
  generation: number;
  revision: number;
  entriesHash: Uint8Array;
}

export function channelBundleBytes(b: ChannelBundleFields): Uint8Array {
  return encodeFields([VERSION, exact("channel id", b.channelId, HASH_BYTES), u64(b.generation), u64(b.revision), exact("entries hash", b.entriesHash, HASH_BYTES)]);
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

export interface ChannelAnswerFields {
  channelId: Uint8Array;
  slot: Uint8Array;
  verdict: number;
  answeredAt: number;
}

export function channelAnswerBytes(a: ChannelAnswerFields): Uint8Array {
  return encodeFields([VERSION, exact("channel id", a.channelId, HASH_BYTES), exact("slot", a.slot, HASH_BYTES), u8(a.verdict), u64(a.answeredAt)]);
}

// The server's word that a registered agent asked to join. It names a slot, so the store learns nothing about who.
export interface ChannelTicketFields {
  serverId: Uint8Array;
  channelId: Uint8Array;
  slot: Uint8Array;
  expiresAt: number;
}

export function channelTicketBytes(t: ChannelTicketFields): Uint8Array {
  return encodeFields([VERSION, exact("server id", t.serverId, HASH_BYTES), exact("channel id", t.channelId, HASH_BYTES), exact("slot", t.slot, HASH_BYTES), u64(t.expiresAt)]);
}

// A store's word that it took this post by this time.
export interface ChannelStoreAckFields {
  storeId: Uint8Array;
  channelId: Uint8Array;
  cap: Uint8Array;
  laneId: Uint8Array;
  seq: number;
  postHash: Uint8Array;
  time: number;
}

export function channelStoreAckBytes(a: ChannelStoreAckFields): Uint8Array {
  return encodeFields([
    VERSION,
    exact("store id", a.storeId, HASH_BYTES),
    exact("channel id", a.channelId, HASH_BYTES),
    exact("path capability", a.cap, HASH_BYTES),
    exact("lane id", a.laneId, HASH_BYTES),
    u64(a.seq),
    exact("post hash", a.postHash, HASH_BYTES),
    u64(a.time),
  ]);
}

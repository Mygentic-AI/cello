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

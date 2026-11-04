// How signed things travel: JSON frames over WebSockets, with bytes as base64url.
// Nothing signed depends on this encoding, so it can change without touching a signature.
import type { DualSignature, PublicIdentity } from "./identity.ts";
import { PROTOCOL_VERSION } from "./structures.ts";
import type { AcceptFields, AckFields, AssignmentFields, ConfirmFields, DeliveryAckFields, EntryFields, OfferFields, SealCertificateFields, SealLogHeadFields, SealRequestFields, StatusStatementFields, StatusWitnessFields } from "./structures.ts";

export { PROTOCOL_VERSION };

export const MAX_CIPHERTEXT_BYTES = 1_100_000;
export const MAX_FRAME_BYTES = 2_000_000;
// Encrypted text over this travels on a daemon's second connection, so moving it can't hold up short messages.
// The server never pushes it, and hands it over only to a fetch that says long: true.
export const LONG_CIPHERTEXT_BYTES = 8_000;

// Every refusal a server can give. Each names a cause the person affected can act on.
export const ERROR_CODES = [
  "bad_request",
  "unsupported_version",
  "not_authenticated",
  "bad_signature",
  "agent_already_connected",
  "unknown_agent",
  "unknown_session",
  "not_participant",
  "wrong_session_state",
  "offer_expired",
  "session_conflict",
  "session_closed",
  "not_current",
  "entry_expired",
  "bad_chain",
  "bad_read_position",
  "bad_ciphertext",
  "too_large",
  "nothing_to_seal",
  "seal_beyond_tip",
  "seal_root_mismatch",
  "seal_log_inconsistent",
  "unknown_channel",
  "channel_conflict",
  "not_a_member",
  "not_allowed_to_post",
  "generation_stale",
  "post_conflict",
  "replayed_post",
  "over_quota",
  "ejected",
  "bad_roster",
  "rate_limited",
  "federation_closed",
  "too_many_pending",
  "visitor_budget_spent",
  "agent_suspended",
  "agent_retired",
  "agent_unavailable",
  "conversation_stopped",
  "status_not_allowed",
  "status_stale",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class WireError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "WireError";
    this.code = code;
  }
}

export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64(value: unknown, name: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) throw new WireError("bad_request", `${name} isn't base64url`);
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export function readInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new WireError("bad_request", `${name} isn't a non-negative integer`);
  return value;
}

function readObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WireError("bad_request", `${name} isn't an object`);
  return value as Record<string, unknown>;
}

export function readString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new WireError("bad_request", `${name} isn't a string`);
  return value;
}

type FieldKind = "bytes" | "int";

export interface Codec<T> {
  encode(value: T): Record<string, string | number>;
  decode(value: unknown, name?: string): T;
}

export function codec<T>(shape: Record<keyof T & string, FieldKind>): Codec<T> {
  const keys = Object.keys(shape) as (keyof T & string)[];
  return {
    encode(value) {
      const out: Record<string, string | number> = {};
      for (const key of keys) {
        const field = value[key];
        out[key] = shape[key] === "bytes" ? toB64(field as Uint8Array) : (field as number);
      }
      return out;
    },
    decode(value, name = "frame") {
      const raw = readObject(value, name);
      const out: Record<string, Uint8Array | number> = {};
      for (const key of keys) {
        out[key] = shape[key] === "bytes" ? fromB64(raw[key], `${name}.${key}`) : readInt(raw[key], `${name}.${key}`);
      }
      return out as T;
    },
  };
}

export const identityCodec = codec<PublicIdentity>({ ed: "bytes", pq: "bytes" });
export const signatureCodec = codec<DualSignature>({ ed: "bytes", pq: "bytes" });

export const entryCodec = codec<Omit<EntryFields, "kind" | "mode"> & { kind: number; mode: number }>({
  sessionId: "bytes",
  authorId: "bytes",
  authorSeq: "int",
  prevOwnHash: "bytes",
  readPosition: "int",
  readRoot: "bytes",
  kind: "int",
  mode: "int",
  contentHash: "bytes",
  ciphertextHash: "bytes",
  notAfter: "int",
}) as Codec<EntryFields>;



export const ackCodec = codec<AckFields>({ serverId: "bytes", sessionId: "bytes", position: "int", entryHash: "bytes", root: "bytes", time: "int" });
export const deliveryAckCodec = codec<DeliveryAckFields>({ sessionId: "bytes", readerId: "bytes", throughPosition: "int", entryHash: "bytes", root: "bytes", screenedThrough: "int" });
export const offerCodec = codec<OfferFields>({ serverId: "bytes", sessionId: "bytes", callerId: "bytes", calleeId: "bytes", x25519Public: "bytes", mlKemPublic: "bytes", expiresAt: "int" });
export const acceptCodec = codec<AcceptFields>({ offerHash: "bytes", x25519Public: "bytes", mlKemCiphertext: "bytes", sealedSalt: "bytes" });
export const confirmCodec = codec<ConfirmFields>({ acceptHash: "bytes", sealedSalt: "bytes" });
export const assignmentCodec = codec<AssignmentFields>({ serverId: "bytes", sessionId: "bytes", callerId: "bytes", calleeId: "bytes", confirmHash: "bytes", time: "int" });
export const sealRequestCodec = codec<SealRequestFields>({ serverId: "bytes", sessionId: "bytes", sealerId: "bytes", throughPosition: "int", root: "bytes" });
export const sealCertificateCodec = codec<SealCertificateFields>({
  sealKeyId: "bytes",
  serverId: "bytes",
  sessionId: "bytes",
  sealerId: "bytes",
  counterpartyId: "bytes",
  requestHash: "bytes",
  root: "bytes",
  throughPosition: "int",
  tip: "int",
  closed: "int",
  receivedThrough: "int",
  deliveryAckHash: "bytes",
  time: "int",
});
export const statusStatementCodec = codec<StatusStatementFields>({ agentId: "bytes", status: "int", reason: "int", issuer: "int", issuerId: "bytes", issuedAt: "int" } as never) as Codec<StatusStatementFields>;
export const statusWitnessCodec = codec<StatusWitnessFields>({ serverId: "bytes", agentId: "bytes", seq: "int", prevHash: "bytes", statementHash: "bytes", time: "int" });
export const sealLogHeadCodec = codec<SealLogHeadFields>({ sealKeyId: "bytes", size: "int", root: "bytes", time: "int" });

export interface Signed<T> {
  fields: T;
  signature: DualSignature;
}

export function signedCodec<T>(inner: Codec<T>): { encode(value: Signed<T>): WireSigned; decode(value: unknown, name?: string): Signed<T> } {
  return {
    encode: (value) => ({ fields: inner.encode(value.fields), signature: signatureCodec.encode(value.signature) }),
    decode(value, name = "frame") {
      const raw = readObject(value, name);
      return { fields: inner.decode(raw["fields"], `${name}.fields`), signature: signatureCodec.decode(raw["signature"], `${name}.signature`) };
    },
  };
}

export interface WireSigned {
  fields: Record<string, string | number>;
  signature: Record<string, string | number>;
}

// A landed entry as it travels. The ciphertext is absent once the reader has confirmed storing it,
// for an author catching up on their own entries, and from a push of a long message.
export interface WitnessedOnWire {
  entry: WireSigned;
  ack: WireSigned;
  ciphertext: string | null;
}

export const signedEntry = signedCodec(entryCodec);
export const signedAck = signedCodec(ackCodec);
export const signedDeliveryAck = signedCodec(deliveryAckCodec);
export const signedOffer = signedCodec(offerCodec);
export const signedAccept = signedCodec(acceptCodec);
export const signedConfirm = signedCodec(confirmCodec);
export const signedAssignment = signedCodec(assignmentCodec);
export const signedSealRequest = signedCodec(sealRequestCodec);
export const signedSealCertificate = signedCodec(sealCertificateCodec);
export const signedSealLogHead = signedCodec(sealLogHeadCodec);
export const signedStatusStatement = signedCodec(statusStatementCodec);
export const signedStatusWitness = signedCodec(statusWitnessCodec);

// The state of one session as the server holds it. A daemon needs nothing else to catch up.
export interface SessionOnWire {
  offer: WireSigned;
  accept: WireSigned | null;
  confirm: WireSigned | null;
  assignment: WireSigned | null;
  callerIdentity: Record<string, string | number>;
  calleeIdentity: Record<string, string | number>;
  callerName: string;
  calleeName: string;
  state: SessionState;
  tip: number;
  // One side can't take part for now. It says no more than that, because a counterparty is told only that the conversation has stopped.
  stopped: boolean;
}

export type SessionState = "offered" | "accepted" | "active" | "closed";

export type PushKind = "session" | "entry" | "delivery" | "channel" | "status";

export interface RequestFrame { v: number; id: number; method: string; params: unknown }
export type ResponseFrame =
  | { v: number; id: number; ok: true; result: unknown }
  | { v: number; id: number; ok: false; error: { code: ErrorCode; message: string; tip?: number } };
export interface PushFrame { v: number; push: PushKind; agent: string; data: unknown }

export function readObjectField(value: unknown, name: string): Record<string, unknown> {
  return readObject(value, name);
}

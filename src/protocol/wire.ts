// How signed things travel: JSON frames over WebSockets, with bytes as base64url.
// Nothing signed depends on this envelope: signed things travel as the exact CBOR bytes that were signed, in a base64url string.
import type { DualSignature, PublicIdentity } from "./identity.ts";
import { UnknownFormat, type Structure, acceptStructure, ackStructure, assignmentStructure, confirmStructure, deliveryAckStructure, encryptionKeyStructure, entryStructure, greetingStructure, offerStructure, refuseStructure, sealCertificateStructure, sealLogHeadStructure, sealRequestStructure, statusStatementStructure, statusWitnessStructure } from "./structures.ts";

// The version of these frames. It's no part of any signed record: those carry their own format in their tag.
export const PROTOCOL_VERSION = 1;

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
  "signal_required",
  "signal_malformed",
  "signal_unknown_format",
  "signal_expiry_too_long",
  "signal_forged",
  "signal_wrong_subject",
  "signal_expired",
  "signal_not_email",
  "signal_not_from_issuer",
  "issuer_unknown",
  "issuer_list_not_configured",
  "issuer_list_expired",
  "issuer_list_invalid",
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

export interface Signed<T> {
  fields: T;
  signature: DualSignature;
  // The exact bytes the signature covers. For anything from outside, these are the bytes as received, and a verifier checks over them.
  bytes: Uint8Array;
}

export interface WireSigned {
  bytes: string;
  signature: Record<string, string | number>;
}

export function readStructure<T>(structure: Structure<T>, bytes: Uint8Array, name: string): T {
  try {
    return structure.decode(bytes);
  } catch (err: unknown) {
    if (err instanceof UnknownFormat) throw new WireError("unsupported_version", `${name}: ${err.message}`);
    throw new WireError("bad_request", `${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function signedCodec<T>(structure: Structure<T>): { encode(value: { fields: T; signature: DualSignature; bytes?: Uint8Array }): WireSigned; decode(value: unknown, name?: string): Signed<T> } {
  return {
    encode: (value) => ({ bytes: toB64(value.bytes ?? structure.encode(value.fields)), signature: signatureCodec.encode(value.signature) }),
    decode(value, name = "frame") {
      const raw = readObject(value, name);
      const bytes = fromB64(raw["bytes"], `${name}.bytes`);
      return { fields: readStructure(structure, bytes, name), signature: signatureCodec.decode(raw["signature"], `${name}.signature`), bytes };
    },
  };
}

// A landed entry as it travels. The ciphertext is absent once the reader has confirmed storing it,
// for an author catching up on their own entries, and from a push of a long message.
export interface WitnessedOnWire {
  entry: WireSigned;
  ack: WireSigned;
  ciphertext: string | null;
}

export const signedEntry = signedCodec(entryStructure);
export const signedAck = signedCodec(ackStructure);
export const signedDeliveryAck = signedCodec(deliveryAckStructure);
export const signedOffer = signedCodec(offerStructure);
export const signedAccept = signedCodec(acceptStructure);
export const signedConfirm = signedCodec(confirmStructure);
export const signedRefuse = signedCodec(refuseStructure);
export const signedGreeting = signedCodec(greetingStructure);
export const signedAssignment = signedCodec(assignmentStructure);
export const signedSealRequest = signedCodec(sealRequestStructure);
export const signedSealCertificate = signedCodec(sealCertificateStructure);
export const signedSealLogHead = signedCodec(sealLogHeadStructure);
export const signedStatusStatement = signedCodec(statusStatementStructure);
export const signedStatusWitness = signedCodec(statusWitnessStructure);
export const signedEncryptionKey = signedCodec(encryptionKeyStructure);

// The longest away greeting a server carries or a caller opens: the longest text a setting allows, in the widest encoding.
export const MAX_GREETING_BYTES = 400_100;

// The state of one session as the server holds it. A daemon needs nothing else to catch up.
export interface SessionOnWire {
  offer: WireSigned;
  accept: WireSigned | null;
  confirm: WireSigned | null;
  assignment: WireSigned | null;
  refusal: WireSigned | null;
  greeting: WireSigned | null;
  callerIdentity: Record<string, string | number>;
  calleeIdentity: Record<string, string | number>;
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

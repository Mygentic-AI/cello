
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeCbor, decodeCbor } from "./cbor.ts";

export const TRUST_SIGNAL_DOMAIN = "CELLO-TSIG-v1";

export type SignalSubjectKind = "account" | "agent";

export type SignalIssuerKind = "portal" | "agent";

export interface TrustSignalEnvelope {
  subject_kind: SignalSubjectKind;
  subject: string;
  issuer_kind: SignalIssuerKind;
  issuer_pubkey: string;
  type: string;
  schema_version: number;
  payload: Uint8Array;
  issued_at: number;
  same_operator: boolean;
  expires_at: number | null;
  supersedes_hash: Uint8Array | null;
}

export const CO_OWNERSHIP_NOTE =
  "[endorsed by an agent with the same owner — does not count toward endorsement minimums]";

const PREIMAGE_FIELDS = [
  "subject_kind",
  "subject",
  "issuer_kind",
  "issuer_pubkey",
  "type",
  "schema_version",
  "payload",
  "issued_at",
  "expires_at",
  "supersedes_hash",
  "same_operator",
] as const;

const MAX_EPOCH_SECONDS = 100_000_000_000; // ~year 5138

const CBOR_UINT32_MAX = 0xffff_ffff;

const SIGNAL_HASH_BYTES = 32;
const SUPERSEDES_HASH_BYTES = 32;

function asCborInteger(value: number): number | bigint {
  return value > CBOR_UINT32_MAX ? BigInt(value) : value;
}

function requireHashableInteger(name: string, value: unknown, max: number, hint: string): number | bigint {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`trust-signal envelope: ${name} must be a finite integer, got ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`trust-signal envelope: ${name} must be an integer — no floating point is hashable across implementations, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`trust-signal envelope: ${name} must not be negative, got ${value}`);
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`trust-signal envelope: ${name} exceeds Number.MAX_SAFE_INTEGER (${value}) — it cannot be hashed exactly`);
  }
  if (value >= max) {
    throw new Error(`trust-signal envelope: ${name} is out of range (${value}) — ${hint}`);
  }
  return asCborInteger(value);
}

const requireEpochSeconds = (name: string, value: unknown): number | bigint =>
  requireHashableInteger(
    name,
    value,
    MAX_EPOCH_SECONDS,
    "this looks like a millisecond timestamp; the contract is epoch SECONDS",
  );

function requireNfcString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`trust-signal envelope: ${name} must be a non-empty string, got ${String(value)}`);
  }
  if (value.normalize("NFC") !== value) {
    throw new Error(
      `trust-signal envelope: ${name} must be Unicode NFC-normalized — the same logical string hashes ` +
      `differently in NFD ("é" is c3a9 in NFC, 65cc81 in NFD), so a non-NFC value would produce a ` +
      `signal no other implementation can reproduce. Normalize it before minting.`,
    );
  }
  return value;
}

function toPreimage(envelope: TrustSignalEnvelope): unknown[] {
  if (envelope === null || typeof envelope !== "object") {
    throw new Error(`trust-signal envelope: expected an object, got ${String(envelope)}`);
  }

  const known = new Set<string>(PREIMAGE_FIELDS);
  for (const key of Object.keys(envelope)) {
    if (!known.has(key)) {
      throw new Error(
        `trust-signal envelope: unknown envelope field "${key}". The preimage is a CLOSED set (spec §4) — ` +
        `an unhashed field riding inside a verified signal is unauthenticated data. ` +
        `Note status/class/verified_at are deliberately NOT hashed (they are mutable after minting) ` +
        `and do not belong on this object.`,
      );
    }
  }
  for (const field of PREIMAGE_FIELDS) {
    if (!(field in envelope)) {
      throw new Error(`trust-signal envelope: missing mandatory field "${field}" (the preimage is a closed set — spec §4)`);
    }
  }

  const { subject_kind, subject, issuer_kind, issuer_pubkey, type, schema_version, payload, expires_at, supersedes_hash } = envelope;

  if (subject_kind !== "account" && subject_kind !== "agent") {
    throw new Error(`trust-signal envelope: subject_kind must be "account" or "agent", got ${String(subject_kind)}`);
  }
  if (issuer_kind !== "portal" && issuer_kind !== "agent") {
    throw new Error(`trust-signal envelope: issuer_kind must be "portal" or "agent", got ${String(issuer_kind)}`);
  }
  requireNfcString("subject", subject);
  requireNfcString("type", type);
  requireNfcString("issuer_pubkey", issuer_pubkey);
  if (!/^[0-9a-f]+$/.test(issuer_pubkey) || issuer_pubkey.length % 2 !== 0) {
    throw new Error(
      `trust-signal envelope: issuer_pubkey must be LOWERCASE hex with an even length, got "${issuer_pubkey}". ` +
      `Hex has a case, and "AABB" and "aabb" are the same key but different preimage bytes — which would ` +
      `mint two different hashes for one signal.`,
    );
  }
  const schemaVersion = requireHashableInteger(
    "schema_version",
    schema_version,
    CBOR_UINT32_MAX + 1,
    "a schema version is a small counter, not an identifier",
  );
  if (!(payload instanceof Uint8Array)) {
    throw new Error(
      `trust-signal envelope: payload must be raw bytes (Uint8Array), got ${payload === null ? "null" : typeof payload}. ` +
      `An object payload would be map-encoded, and CBOR maps are not deterministic under this encoder — ` +
      `serialize the payload yourself and pass the bytes.`,
    );
  }

  const issuedAt = requireEpochSeconds("issued_at", envelope.issued_at);
  const expiresAt = expires_at === null ? null : requireEpochSeconds("expires_at", expires_at);

  if (supersedes_hash !== null) {
    if (!(supersedes_hash instanceof Uint8Array)) {
      throw new Error(`trust-signal envelope: supersedes_hash must be 32 raw bytes or null, got ${typeof supersedes_hash}`);
    }
    if (supersedes_hash.length !== SUPERSEDES_HASH_BYTES) {
      throw new Error(`trust-signal envelope: supersedes_hash must be exactly ${SUPERSEDES_HASH_BYTES} bytes, got ${supersedes_hash.length}`);
    }
  }

  return [
    TRUST_SIGNAL_DOMAIN,
    subject_kind,
    subject,
    issuer_kind,
    issuer_pubkey,
    type,
    schemaVersion,
    payload,
    issuedAt,
    expiresAt,
    supersedes_hash,
    envelope.same_operator === true,
  ];
}

export function encodeTrustSignalEnvelope(envelope: TrustSignalEnvelope): Uint8Array {
  return encodeCbor(toPreimage(envelope));
}

export function hashTrustSignalEnvelope(envelope: TrustSignalEnvelope): Uint8Array {
  return sha256(encodeTrustSignalEnvelope(envelope));
}

export function verifyTrustSignalHash(envelope: TrustSignalEnvelope, expected: Uint8Array): boolean {
  if (!(expected instanceof Uint8Array) || expected.length !== SIGNAL_HASH_BYTES) return false;
  const actual = hashTrustSignalEnvelope(envelope);
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= (actual[i] as number) ^ (expected[i] as number);
  return diff === 0;
}

export function decodeTrustSignalEnvelope(bytes: Uint8Array): TrustSignalEnvelope {
  const arr = decodeCbor(bytes);
  if (!Array.isArray(arr) || arr.length !== 12) {
    throw new Error(
      `trust-signal envelope must be a 12-element CBOR array (the fixed preimage), got ` +
      `${Array.isArray(arr) ? `${arr.length} elements` : typeof arr}`,
    );
  }
  const [domain, subject_kind, subject, issuer_kind, issuer_pubkey, type, schema_version, payload, issued_at, expires_at, supersedes_hash, same_operator] =
    arr as unknown[];
  if (domain !== TRUST_SIGNAL_DOMAIN) {
    throw new Error(`trust-signal envelope domain tag is '${String(domain)}', expected '${TRUST_SIGNAL_DOMAIN}' — not a trust-signal envelope`);
  }
  const asBytes = (v: unknown, field: string): Uint8Array => {
    if (v instanceof Uint8Array) return new Uint8Array(v);
    throw new Error(`trust-signal envelope: ${field} must be raw bytes, got ${v === null ? "null" : typeof v}`);
  };
  const env: TrustSignalEnvelope = {
    subject_kind: subject_kind as SignalSubjectKind,
    subject: subject as string,
    issuer_kind: issuer_kind as SignalIssuerKind,
    issuer_pubkey: issuer_pubkey as string,
    type: type as string,
    schema_version: Number(schema_version),
    payload: asBytes(payload, "payload"),
    issued_at: Number(issued_at),
    expires_at: expires_at === null || expires_at === undefined ? null : Number(expires_at),
    supersedes_hash: supersedes_hash === null || supersedes_hash === undefined ? null : asBytes(supersedes_hash, "supersedes_hash"),
    same_operator: same_operator === true,
  };
  const reencoded = encodeTrustSignalEnvelope(env);
  if (reencoded.length !== bytes.length) {
    throw new Error("trust-signal envelope bytes are not canonical — re-encoding does not reproduce the input");
  }
  for (let i = 0; i < reencoded.length; i++) {
    if (reencoded[i] !== bytes[i]) {
      throw new Error("trust-signal envelope bytes are not canonical — re-encoding does not reproduce the input");
    }
  }
  return env;
}

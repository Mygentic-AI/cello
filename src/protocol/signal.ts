
// The trust signal: a fixed-order CBOR array the issuer signs, hashed for its name, with both signatures outside the hash.
// Field order is the wire format. The field set is closed, and optional fields are explicit nulls in fixed slots.
// status, class and verified_at stay out because they change after minting. No floats: times are integer seconds.
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeCbor, decodeCbor } from "./cbor.ts";
import { ED25519_PUBLIC_KEY_BYTES, ED25519_SIGNATURE_BYTES, type DualSignature, type PublicIdentity, type Signer, identityId, verifySignature } from "./identity.ts";
import { ML_DSA_PUBLIC_KEY_BYTES, ML_DSA_SIGNATURE_BYTES } from "./ml-dsa.ts";
import { equalBytes, toHex } from "./encode.ts";
import { UnknownFormat, assertFlat } from "./structures.ts";

export const TRUST_SIGNAL_DOMAIN = "cello-signal-v1";
export const SIGNED_SIGNAL_DOMAIN = "cello-signed-signal-v1";

// Each issuer picks per signal: a date at most this far from issue, or null for permanent. Fixed seconds, so every implementation draws the line in one place.
export const MAX_SIGNAL_LIFETIME_SECONDS = 365 * 86_400;
// Read before decoding, so a hostile length costs nothing. A public signal's own smaller cap belongs to the server.
export const MAX_SIGNAL_BYTES = 65_536;
export const SIGNAL_ID_BYTES = 16;
const ENVELOPE_ARITY = 14;
const SIGNED_ARITY = 4;

export class ExpiryTooLong extends RangeError {}

export type SignalSubjectKind = "account" | "agent";

export type SignalIssuerKind = "portal" | "agent";

export interface TrustSignalEnvelope {
  subject_kind: SignalSubjectKind;
  // The agent's key: its 64-hex id, which covers both its public keys.
  subject: string;
  issuer_kind: SignalIssuerKind;
  // Lowercase hex of the issuer's Ed25519 key then its ML-DSA-44 key. One flat text slot, since nested CBOR is refused.
  issuer_pubkey: string;
  type: string;
  schema_version: number;
  payload: Uint8Array;
  issued_at: number;
  same_operator: boolean;
  expires_at: number | null;
  supersedes_hash: Uint8Array | null;
  issuer_address: string;
  signal_id: Uint8Array;
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
  "issuer_address",
  "signal_id",
] as const;

const MAX_EPOCH_SECONDS = 100_000_000_000; // ~year 5138

const CBOR_UINT32_MAX = 0xffff_ffff;

const ISSUER_PUBKEY_HEX_LENGTH = 2 * (ED25519_PUBLIC_KEY_BYTES + ML_DSA_PUBLIC_KEY_BYTES);
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

  const { subject_kind, subject, issuer_kind, issuer_pubkey, type, schema_version, payload, expires_at, supersedes_hash, issuer_address, signal_id } = envelope;

  if (subject_kind !== "account" && subject_kind !== "agent") {
    throw new Error(`trust-signal envelope: subject_kind must be "account" or "agent", got ${String(subject_kind)}`);
  }
  if (issuer_kind !== "portal" && issuer_kind !== "agent") {
    throw new Error(`trust-signal envelope: issuer_kind must be "portal" or "agent", got ${String(issuer_kind)}`);
  }
  requireNfcString("subject", subject);
  if (!/^[0-9a-f]{64}$/.test(subject)) {
    throw new Error(`trust-signal envelope: subject must be the agent's key, 64 lowercase hex characters, got "${subject}"`);
  }
  requireNfcString("issuer_address", issuer_address);
  if (!(signal_id instanceof Uint8Array) || signal_id.length !== SIGNAL_ID_BYTES) {
    throw new Error(`trust-signal envelope: signal_id must be exactly ${SIGNAL_ID_BYTES} raw bytes`);
  }
  requireNfcString("type", type);
  requireNfcString("issuer_pubkey", issuer_pubkey);
  if (!/^[0-9a-f]+$/.test(issuer_pubkey) || issuer_pubkey.length !== ISSUER_PUBKEY_HEX_LENGTH) {
    throw new Error(
      `trust-signal envelope: issuer_pubkey must be both public keys in LOWERCASE hex, ${ISSUER_PUBKEY_HEX_LENGTH} characters. ` +
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
  if (expires_at !== null) {
    if (expires_at <= envelope.issued_at) throw new RangeError(`trust-signal envelope: expires_at (${expires_at}) must be after issued_at (${envelope.issued_at})`);
    if (expires_at - envelope.issued_at > MAX_SIGNAL_LIFETIME_SECONDS) throw new ExpiryTooLong("a signal's expiry can be at most one year from issue, or none at all");
  }

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
    issuer_address,
    signal_id,
  ];
}

export function encodeTrustSignalEnvelope(envelope: TrustSignalEnvelope): Uint8Array {
  return new Uint8Array(encodeCbor(toPreimage(envelope)));
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
  if (bytes.length > MAX_SIGNAL_BYTES) throw new RangeError(`trust-signal envelope can't be over ${MAX_SIGNAL_BYTES} bytes`);
  assertFlat(bytes, ENVELOPE_ARITY, { booleans: true });
  const arr = decodeCbor(bytes);
  const [domain, subject_kind, subject, issuer_kind, issuer_pubkey, type, schema_version, payload, issued_at, expires_at, supersedes_hash, same_operator, issuer_address, signal_id] =
    arr as unknown[];
  if (domain !== TRUST_SIGNAL_DOMAIN) {
    throw new UnknownFormat(`trust-signal envelope domain tag is '${String(domain)}', expected '${TRUST_SIGNAL_DOMAIN}' — not a trust-signal envelope`);
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
    issuer_address: issuer_address as string,
    signal_id: asBytes(signal_id, "signal_id"),
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

export function issuerPubkeyField(pub: PublicIdentity): string {
  return toHex(pub.ed) + toHex(pub.pq);
}

export function issuerKeys(envelope: TrustSignalEnvelope): PublicIdentity {
  const all = Buffer.from(envelope.issuer_pubkey, "hex");
  return { ed: new Uint8Array(all.subarray(0, ED25519_PUBLIC_KEY_BYTES)), pq: new Uint8Array(all.subarray(ED25519_PUBLIC_KEY_BYTES)) };
}

// The file a signal travels as. The envelope stays bytes in a slot, so signature and hash cover it exactly as received.
export async function signSignal(envelope: TrustSignalEnvelope, signer: Signer): Promise<Uint8Array> {
  if (envelope.issuer_pubkey !== issuerPubkeyField(signer.publicIdentity)) throw new Error("this signer's keys aren't the ones the signal names as its issuer");
  const bytes = encodeTrustSignalEnvelope(envelope);
  const signature = await signer.sign("cello-signal", bytes);
  const file = new Uint8Array(encodeCbor([SIGNED_SIGNAL_DOMAIN, bytes, signature.ed, signature.pq]));
  if (file.length > MAX_SIGNAL_BYTES) throw new RangeError(`a signal can't be over ${MAX_SIGNAL_BYTES} bytes`);
  return file;
}

export interface SignedSignal {
  envelope: TrustSignalEnvelope;
  envelopeBytes: Uint8Array;
  signature: DualSignature;
  // The signal's name: the hash of the envelope, without the signatures.
  hash: Uint8Array;
}

export function readSignedSignal(file: Uint8Array): SignedSignal {
  if (file.length > MAX_SIGNAL_BYTES) throw new RangeError(`a signal can't be over ${MAX_SIGNAL_BYTES} bytes`);
  assertFlat(file, SIGNED_ARITY);
  const [domain, envelopeBytes, ed, pq] = decodeCbor(file) as unknown[];
  if (domain !== SIGNED_SIGNAL_DOMAIN) throw new UnknownFormat(`this is ${typeof domain === "string" ? domain.slice(0, 64) : "unnamed"}, and ${SIGNED_SIGNAL_DOMAIN} was expected`);
  if (!(envelopeBytes instanceof Uint8Array) || !(ed instanceof Uint8Array) || !(pq instanceof Uint8Array) || ed.length !== ED25519_SIGNATURE_BYTES || pq.length !== ML_DSA_SIGNATURE_BYTES) {
    throw new RangeError("a signal needs an envelope and both issuer signatures");
  }
  const held = new Uint8Array(envelopeBytes);
  const envelope = decodeTrustSignalEnvelope(held);
  const reencoded = new Uint8Array(encodeCbor([SIGNED_SIGNAL_DOMAIN, held, new Uint8Array(ed), new Uint8Array(pq)]));
  if (!equalBytes(reencoded, file)) throw new RangeError("this signal's bytes aren't canonical");
  return { envelope, envelopeBytes: held, signature: { ed: new Uint8Array(ed), pq: new Uint8Array(pq) }, hash: sha256(held) };
}

export type SignalFault = "malformed" | "unknown_format" | "expiry_too_long" | "forged" | "wrong_subject" | "expired";
export type SignalCheck = { ok: true; signal: SignedSignal; issuerId: Uint8Array } | { ok: false; fault: SignalFault; message: string };

// For daemon, server and reader alike. Whether the issuer counts is a separate question: see issuer-list.ts.
export async function checkSignal(file: Uint8Array, expected: { subject: string; now: number }): Promise<SignalCheck> {
  let signal: SignedSignal;
  try {
    signal = readSignedSignal(file);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof UnknownFormat) return { ok: false, fault: "unknown_format", message };
    if (err instanceof ExpiryTooLong) return { ok: false, fault: "expiry_too_long", message };
    return { ok: false, fault: "malformed", message };
  }
  const keys = issuerKeys(signal.envelope);
  if (!(await verifySignature(keys, "cello-signal", signal.envelopeBytes, signal.signature))) return { ok: false, fault: "forged", message: "the issuer's signatures don't verify over this signal" };
  if (signal.envelope.subject !== expected.subject) return { ok: false, fault: "wrong_subject", message: `this signal names ${signal.envelope.subject}, not ${expected.subject}` };
  if (signal.envelope.expires_at !== null && signal.envelope.expires_at <= expected.now) return { ok: false, fault: "expired", message: `this signal expired at ${signal.envelope.expires_at}` };
  return { ok: true, signal, issuerId: identityId(keys) };
}

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  mlKemGenerateSeed,
  mlKemKeypairFromSeed,
  ML_KEM_CIPHERTEXT_BYTES,
  ML_KEM_PUBLIC_KEY_BYTES,
  ML_KEM_SHARED_SECRET_BYTES,
} from "./ml-kem.ts";

const X25519_KEY_BYTES = 32;
export const SESSION_KEY_BYTES = 32;
export const SESSION_PQ_TRANSCRIPT_BYTES = ML_KEM_CIPHERTEXT_BYTES + ML_KEM_PUBLIC_KEY_BYTES;

const ENC = new TextEncoder();
const INFO_CONTENT_KEY = ENC.encode("cello-v2/session/content-key");

export interface SessionEphemeral {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  mlKemSeed: Uint8Array;
  mlKemPublic: Uint8Array;
}

export interface SessionSecrets {
  contentKey: Uint8Array;
}

export async function generateSessionEphemeral(): Promise<SessionEphemeral> {
  const secretKey = x25519.utils.randomSecretKey();
  const mlKemSeed = mlKemGenerateSeed();
  const { publicKey: mlKemPublic } = await mlKemKeypairFromSeed(mlKemSeed);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey), mlKemSeed, mlKemPublic };
}

export function destroySessionEphemeral(e: SessionEphemeral): void {
  e.secretKey.fill(0);
  e.mlKemSeed.fill(0);
}

function isAllZero(b: Uint8Array): boolean {
  let acc = 0;
  for (const x of b) acc |= x;
  return acc === 0;
}

function lexLess(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x < y;
  }
  return a.length < b.length;
}

export function deriveSessionSecrets(opts: {
  ownEphemeralSecret: Uint8Array;
  peerEphemeralPublic: Uint8Array;
  sessionId: Uint8Array;
  extraSharedSecret: Uint8Array;
  pqTranscript: Uint8Array;
}): SessionSecrets {
  if (!(opts.extraSharedSecret instanceof Uint8Array) || opts.extraSharedSecret.length !== ML_KEM_SHARED_SECRET_BYTES) {
    throw new Error(`key agreement: the ML-KEM shared secret must be ${ML_KEM_SHARED_SECRET_BYTES} bytes`);
  }
  if (!(opts.pqTranscript instanceof Uint8Array) || opts.pqTranscript.length !== SESSION_PQ_TRANSCRIPT_BYTES) {
    throw new Error(`key agreement: the transcript must be ${SESSION_PQ_TRANSCRIPT_BYTES} bytes (ciphertext, then ML-KEM public key)`);
  }
  if (opts.peerEphemeralPublic.length !== X25519_KEY_BYTES) {
    throw new Error(`key agreement: the peer X25519 public key must be ${X25519_KEY_BYTES} bytes`);
  }
  if (opts.ownEphemeralSecret.length !== X25519_KEY_BYTES) {
    throw new Error(`key agreement: our X25519 secret must be ${X25519_KEY_BYTES} bytes`);
  }
  if ((opts.peerEphemeralPublic[31] as number) & 0x80) {
    throw new Error("key agreement: the peer X25519 public key is non-canonical (bit 255 set, RFC 7748 section 5)");
  }
  if (opts.sessionId.length === 0) {
    throw new Error("key agreement: the session id must not be empty");
  }

  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(opts.ownEphemeralSecret, opts.peerEphemeralPublic);
  } catch (err: unknown) {
    throw new Error("key agreement: the peer X25519 public key is invalid or a small-order point (RFC 7748 section 6.1)", { cause: err });
  }

  if (isAllZero(shared)) {
    throw new Error("key agreement: the X25519 shared secret is all zeros (RFC 7748 section 6.1)");
  }

  const ownPublic = x25519.getPublicKey(opts.ownEphemeralSecret);
  if (Buffer.compare(Buffer.from(ownPublic), Buffer.from(opts.peerEphemeralPublic)) === 0) {
    throw new Error("key agreement: the peer sent back our own X25519 public key");
  }
  const [first, second] = lexLess(ownPublic, opts.peerEphemeralPublic)
    ? [ownPublic, opts.peerEphemeralPublic]
    : [opts.peerEphemeralPublic, ownPublic];

  const extra = opts.extraSharedSecret;
  const ikm = new Uint8Array(shared.length + extra.length);
  ikm.set(shared, 0);
  ikm.set(extra, shared.length);

  const transcript = opts.pqTranscript;
  const info = (label: Uint8Array): Uint8Array => {
    const out = new Uint8Array(label.length + first.length + second.length + transcript.length);
    out.set(label, 0);
    out.set(first, label.length);
    out.set(second, label.length + first.length);
    out.set(transcript, label.length + first.length + second.length);
    return out;
  };

  const contentKey = hkdf(sha256, ikm, opts.sessionId, info(INFO_CONTENT_KEY), SESSION_KEY_BYTES);
  ikm.fill(0);
  shared.fill(0);
  return { contentKey };
}

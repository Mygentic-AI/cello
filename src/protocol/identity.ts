// Identities and signatures. Everything is signed twice, Ed25519 and ML-DSA-44, and both must verify.
// An identity is the hash of both public keys, so post-quantum protection doesn't stop at an Ed25519 root.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, webcrypto } from "node:crypto";
import {
  ML_DSA_ALGORITHM,
  ML_DSA_PUBLIC_KEY_BYTES,
  ML_DSA_SEED_BYTES,
  ML_DSA_SIGNATURE_BYTES,
  mlDsaGenerateSeed,
  mlDsaProviderFromSeed,
} from "./ml-dsa.ts";
import { encodeFields, exact } from "./encode.ts";

export const ED25519_SEED_BYTES = 32;
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

// Each signed artifact has its own context, so a signature can't be moved from one kind to another.
export const CONTEXTS = [
  "cello-v2-register",
  "cello-v2-agent-auth",
  "cello-v2-visit",
  "cello-v2-server-auth",
  "cello-v2-session-offer",
  "cello-v2-session-accept",
  "cello-v2-session-refuse",
  "cello-v2-session-confirm",
  "cello-v2-session-assignment",
  "cello-v2-entry",
  "cello-v2-ack",
  "cello-v2-delivery-ack",
  "cello-v2-seal-request",
  "cello-v2-seal-certificate",
  "cello-v2-seal-log-head",
  "cello-v2-seal-key-binding",
  "cello-v2-agent-status",
  "cello-v2-agent-status-witness",
  "cello-v2-channel-record",
  "cello-v2-channel-info",
  "cello-v2-channel-post",
  "cello-v2-channel-post-ack",
  "cello-v2-channel-state",
  "cello-v2-channel-member-key",
  "cello-v2-channel-roster",
  "cello-v2-channel-key-entry",
] as const;

export type SigningContext = (typeof CONTEXTS)[number];

export interface PublicIdentity {
  ed: Uint8Array;
  pq: Uint8Array;
}

export interface DualSignature {
  ed: Uint8Array;
  pq: Uint8Array;
}

export interface IdentitySeeds {
  ed: Uint8Array;
  pq: Uint8Array;
}

export interface Signer {
  readonly publicIdentity: PublicIdentity;
  readonly id: Uint8Array;
  sign(context: SigningContext, bytes: Uint8Array): Promise<DualSignature>;
}

function frame(context: SigningContext, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(CONTEXTS as readonly string[]).includes(context)) throw new Error(`unknown signing context: ${String(context)}`);
  const ctx = new TextEncoder().encode(context);
  const framed = new Uint8Array(ctx.length + 1 + bytes.length);
  framed.set(ctx, 0);
  framed[ctx.length] = 0x00;
  framed.set(bytes, ctx.length + 1);
  return framed;
}

export function identityId(pub: PublicIdentity): Uint8Array {
  exact("Ed25519 public key", pub.ed, ED25519_PUBLIC_KEY_BYTES);
  exact("ML-DSA public key", pub.pq, ML_DSA_PUBLIC_KEY_BYTES);
  return sha256(encodeFields([new TextEncoder().encode("cello-v2/identity"), pub.ed, pub.pq]));
}

export function generateIdentitySeeds(): IdentitySeeds {
  return { ed: new Uint8Array(randomBytes(ED25519_SEED_BYTES)), pq: mlDsaGenerateSeed() };
}

export async function signerFromSeeds(seeds: IdentitySeeds): Promise<Signer> {
  exact("Ed25519 seed", seeds.ed, ED25519_SEED_BYTES);
  exact("ML-DSA seed", seeds.pq, ML_DSA_SEED_BYTES);
  const edSeed = seeds.ed.slice();
  const pqProvider = await mlDsaProviderFromSeed(seeds.pq);
  const publicIdentity: PublicIdentity = { ed: ed25519.getPublicKey(edSeed), pq: await pqProvider.getPublicKey() };
  return {
    publicIdentity,
    id: identityId(publicIdentity),
    async sign(context, bytes) {
      const framed = frame(context, bytes);
      return { ed: ed25519.sign(framed, edSeed), pq: await pqProvider.sign(framed) };
    },
  };
}

// Never throws: every bad input is a refusal, and the caller names its own reason.
export async function verifySignature(
  pub: PublicIdentity,
  context: SigningContext,
  bytes: Uint8Array,
  signature: DualSignature,
): Promise<boolean> {
  if (pub.ed?.length !== ED25519_PUBLIC_KEY_BYTES || pub.pq?.length !== ML_DSA_PUBLIC_KEY_BYTES) return false;
  if (signature.ed?.length !== ED25519_SIGNATURE_BYTES || signature.pq?.length !== ML_DSA_SIGNATURE_BYTES) return false;
  try {
    const framed = frame(context, bytes);
    if (!ed25519.verify(signature.ed, framed, pub.ed, { zip215: false })) return false;
    const key = await webcrypto.subtle.importKey("raw-public", new Uint8Array(pub.pq), ML_DSA_ALGORITHM, false, ["verify"]);
    return await webcrypto.subtle.verify(ML_DSA_ALGORITHM, key, new Uint8Array(signature.pq), framed);
  } catch {
    return false;
  }
}

// Mistakes here wouldn't show by themselves: a broken check still lets every honest message through.
import assert from "node:assert/strict";
import { test } from "node:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "node:crypto";
import { openSessionContent, sealSessionContent } from "../src/protocol/aead.ts";
import { generateIdentitySeeds, identityId, signerFromSeeds, verifySignature } from "../src/protocol/identity.ts";
import { type SessionEphemeral, deriveSessionSecrets, generateSessionEphemeral } from "../src/protocol/key-agreement.ts";
import { mlKemDecapsulate, mlKemEncapsulate } from "../src/protocol/ml-kem.ts";
import { deriveSessionSalt, generateSaltContribution, saltedContentHash } from "../src/protocol/salt.ts";
import { toHex } from "../src/protocol/encode.ts";

const bytes = new TextEncoder().encode("the signed bytes");
const flip = (b: Uint8Array): Uint8Array => { const c = b.slice(); c[0] = (c[0] as number) ^ 1; return c; };

test("a signature verifies only with both halves intact, the same bytes, the same context and the same key", async () => {
  const signer = await signerFromSeeds(generateIdentitySeeds());
  const other = await signerFromSeeds(generateIdentitySeeds());
  const sig = await signer.sign("cello-entry", bytes);
  const pub = signer.publicIdentity;

  assert.equal(await verifySignature(pub, "cello-entry", bytes, sig), true);
  assert.equal(await verifySignature(pub, "cello-entry", bytes, { ...sig, ed: flip(sig.ed) }), false);
  assert.equal(await verifySignature(pub, "cello-entry", bytes, { ...sig, pq: flip(sig.pq) }), false);
  assert.equal(await verifySignature(pub, "cello-entry", bytes, { ed: sig.ed, pq: new Uint8Array(0) }), false);
  assert.equal(await verifySignature(pub, "cello-entry", flip(bytes), sig), false);
  assert.equal(await verifySignature(pub, "cello-ack", bytes, sig), false);
  assert.equal(await verifySignature(other.publicIdentity, "cello-entry", bytes, sig), false);
  // A classical signature from the real key beside a post-quantum one from another key must not pass.
  const mixed = { ed: sig.ed, pq: (await other.sign("cello-entry", bytes)).pq };
  assert.equal(await verifySignature(pub, "cello-entry", bytes, mixed), false);
});

test("an identity covers both public keys, so neither key can be swapped", async () => {
  const a = await signerFromSeeds(generateIdentitySeeds());
  const b = await signerFromSeeds(generateIdentitySeeds());
  const idA = toHex(a.id);
  assert.notEqual(toHex(identityId({ ed: b.publicIdentity.ed, pq: a.publicIdentity.pq })), idA);
  assert.notEqual(toHex(identityId({ ed: a.publicIdentity.ed, pq: b.publicIdentity.pq })), idA);
  assert.equal(toHex(identityId(a.publicIdentity)), idA);
});

async function agree(alice: SessionEphemeral, bob: SessionEphemeral, sessionId: Uint8Array) {
  const { ciphertext, sharedSecret } = await mlKemEncapsulate(alice.mlKemPublic);
  const transcript = new Uint8Array([...ciphertext, ...alice.mlKemPublic]);
  const bobKey = deriveSessionSecrets({ ownEphemeralSecret: bob.secretKey, peerEphemeralPublic: alice.publicKey, sessionId, extraSharedSecret: sharedSecret, pqTranscript: transcript }).contentKey;
  const aliceSecret = await mlKemDecapsulate(alice.mlKemSeed, ciphertext);
  const aliceKey = deriveSessionSecrets({ ownEphemeralSecret: alice.secretKey, peerEphemeralPublic: bob.publicKey, sessionId, extraSharedSecret: aliceSecret, pqTranscript: transcript }).contentKey;
  return { aliceKey, bobKey, sharedSecret, transcript };
}

test("both sides derive one key, and it depends on the post-quantum secret and its transcript", async () => {
  const alice = await generateSessionEphemeral();
  const bob = await generateSessionEphemeral();
  const sessionId = new Uint8Array(randomBytes(16));
  const { aliceKey, bobKey, sharedSecret, transcript } = await agree(alice, bob, sessionId);
  assert.equal(toHex(aliceKey), toHex(bobKey));

  const base = { ownEphemeralSecret: bob.secretKey, peerEphemeralPublic: alice.publicKey, sessionId };
  assert.notEqual(toHex(deriveSessionSecrets({ ...base, extraSharedSecret: flip(sharedSecret), pqTranscript: transcript }).contentKey), toHex(bobKey));
  assert.notEqual(toHex(deriveSessionSecrets({ ...base, extraSharedSecret: sharedSecret, pqTranscript: flip(transcript) }).contentKey), toHex(bobKey));
  assert.throws(() => deriveSessionSecrets({ ...base, extraSharedSecret: new Uint8Array(0), pqTranscript: transcript }), /ML-KEM shared secret/);
});

test("a small-order or reflected peer key is refused rather than used", async () => {
  const bob = await generateSessionEphemeral();
  const base = { ownEphemeralSecret: bob.secretKey, sessionId: new Uint8Array(16), extraSharedSecret: new Uint8Array(32), pqTranscript: new Uint8Array(2272) };
  assert.throws(() => deriveSessionSecrets({ ...base, peerEphemeralPublic: new Uint8Array(32) }), /small-order|all zeros/);
  assert.throws(() => deriveSessionSecrets({ ...base, peerEphemeralPublic: x25519.getPublicKey(bob.secretKey) }), /our own/);
});

test("encrypted text opens only with the right key and unaltered bytes", () => {
  const key = new Uint8Array(randomBytes(32));
  const sealed = sealSessionContent(key, bytes);
  assert.equal(new TextDecoder().decode(openSessionContent(key, sealed) as Uint8Array), "the signed bytes");
  assert.equal(openSessionContent(new Uint8Array(randomBytes(32)), sealed), null);
  const altered = sealed.slice();
  altered[altered.length - 1] = (altered[altered.length - 1] as number) ^ 1;
  assert.equal(openSessionContent(key, altered), null);
});

test("the salt needs both sides, comes out the same for both, and hides the content hash", () => {
  const a = generateSaltContribution();
  const b = generateSaltContribution();
  const salt = deriveSessionSalt(a, b);
  assert.equal(toHex(salt), toHex(deriveSessionSalt(b, a)));
  assert.throws(() => deriveSessionSalt(a, new Uint8Array(32)), /all zeros/);
  assert.throws(() => deriveSessionSalt(a, a.slice()), /our own/);
  assert.notEqual(toHex(saltedContentHash(salt, bytes)), toHex(saltedContentHash(deriveSessionSalt(a, generateSaltContribution()), bytes)));
});

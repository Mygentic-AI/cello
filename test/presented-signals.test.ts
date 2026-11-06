// What a sealed set must and must not do. An honest run only shows that a set opens, so these try a wrong key, a tampered box, another use's
// secret, a hostile plaintext, and the two sizes, and check that "nothing sent" and "sent but unreadable" stay different.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { sealSessionContent } from "../src/protocol/aead.ts";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { signerFromSeeds } from "../src/protocol/identity.ts";
import { mlKemEncapsulate, mlKemGenerateSeed, mlKemKeypairFromSeed } from "../src/protocol/ml-kem.ts";
import { MAX_PRESENTED_BYTES, MAX_PRESENTED_SIGNALS, PRESENTED_SIGNALS_LABEL, PresentedTooMany, checkEncryptionKey, decodePresented, encodePresented, openFromKey, openUnderSession, sealToKey, sealUnderSession } from "../src/protocol/presented-signals.ts";
import { type OfferFields, encryptionKeyBytes, offerBytes, offerStructure, acceptStructure } from "../src/protocol/structures.ts";
import { signedEncryptionKey } from "../src/protocol/wire.ts";

const fill = (byte: number, length: number): Uint8Array => new Uint8Array(length).fill(byte);
const file = (n: number, size = 5_400): Uint8Array => new Uint8Array(randomBytes(size)).fill(n, 0, 4);
const ann = await signerFromSeeds({ ed: fill(1, 32), pq: fill(2, 32) });
const mallory = await signerFromSeeds({ ed: fill(3, 32), pq: fill(4, 32) });
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

test("a set sealed to a key opens with that key's seed, whole and in order", async () => {
  const seed = mlKemGenerateSeed();
  const { publicKey } = await mlKemKeypairFromSeed(seed);
  const files = [file(1), file(2), file(3)];
  const sealed = await sealToKey(publicKey, files);
  assert.equal(sealed.signalsCiphertext.length, 1088);
  const opened = await openFromKey([seed], sealed.signalsCiphertext, sealed.sealedSignals);
  assert.notEqual(opened, "unreadable");
  assert.deepEqual((opened as Uint8Array[]).map(hex), files.map(hex));
});

test("nothing sent is empty and says so, and is not the same as a box that won't open", async () => {
  const seed = mlKemGenerateSeed();
  const { publicKey } = await mlKemKeypairFromSeed(seed);
  const none = await sealToKey(publicKey, []);
  assert.equal(none.signalsCiphertext.length + none.sealedSignals.length, 0);
  assert.deepEqual(await openFromKey([seed], none.signalsCiphertext, none.sealedSignals), []);
  assert.deepEqual(sealUnderSession(fill(9, 32), []).length, 0);
  assert.deepEqual(openUnderSession(fill(9, 32), new Uint8Array(0)), []);
  assert.equal(await openFromKey([seed], new Uint8Array(1088), fill(5, 80)), "unreadable");
  assert.equal(openUnderSession(fill(9, 32), fill(5, 80)), "unreadable");
});

test("the wrong key, a tampered box, or a set sealed under another use's secret does not open", async () => {
  const seed = mlKemGenerateSeed();
  const other = mlKemGenerateSeed();
  const { publicKey } = await mlKemKeypairFromSeed(seed);
  const sealed = await sealToKey(publicKey, [file(1)]);
  assert.equal(await openFromKey([other], sealed.signalsCiphertext, sealed.sealedSignals), "unreadable");
  const tampered = new Uint8Array(sealed.sealedSignals);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
  assert.equal(await openFromKey([seed], sealed.signalsCiphertext, tampered), "unreadable");
  // The secret a refusal is sealed with is derived under another label, so a box made with it is no set.
  const { ciphertext, sharedSecret } = await mlKemEncapsulate(publicKey);
  const refusalKey = new Uint8Array(createHash("sha256").update("cello-session-refusal").update(sharedSecret).digest());
  const wrongUse = sealSessionContent(refusalKey, encodePresented([file(1)]));
  assert.equal(await openFromKey([seed], ciphertext, wrongUse), "unreadable");
});

test("an offer sealed to a key since replaced still opens, because older seeds are tried too", async () => {
  const oldSeed = mlKemGenerateSeed();
  const newSeed = mlKemGenerateSeed();
  const { publicKey } = await mlKemKeypairFromSeed(oldSeed);
  const sealed = await sealToKey(publicKey, [file(7)]);
  assert.notEqual(await openFromKey([newSeed, oldSeed], sealed.signalsCiphertext, sealed.sealedSignals), "unreadable");
  assert.equal(await openFromKey([newSeed], sealed.signalsCiphertext, sealed.sealedSignals), "unreadable");
});

test("a set under the session key opens only with that key", () => {
  const sealed = sealUnderSession(fill(1, 32), [file(4), file(5)]);
  assert.equal((openUnderSession(fill(1, 32), sealed) as Uint8Array[]).length, 2);
  assert.equal(openUnderSession(fill(2, 32), sealed), "unreadable");
});

test("the limits: a ninth signal and a box over 64 KiB are refused by name, and the bounds themselves pass", async () => {
  const { publicKey } = await mlKemKeypairFromSeed(mlKemGenerateSeed());
  const small = Array.from({ length: MAX_PRESENTED_SIGNALS }, (_, i) => file(i, 100));
  await sealToKey(publicKey, small);
  await assert.rejects(sealToKey(publicKey, [...small, file(99, 100)]), PresentedTooMany);
  assert.throws(() => sealUnderSession(fill(1, 32), [...small, file(99, 100)]), PresentedTooMany);
  const big = [file(1, 20_000), file(2, 20_000), file(3, 20_000), file(4, 20_000)];
  await assert.rejects(sealToKey(publicKey, big), PresentedTooMany);
  assert.throws(() => sealUnderSession(fill(1, 32), big), PresentedTooMany);
  assert.ok(MAX_PRESENTED_BYTES === 65_536 && MAX_PRESENTED_SIGNALS === 8);
});

test("a hostile plaintext is not a set: wrong label, nested, not bytes, too many", () => {
  const bytes = (value: unknown): Uint8Array => new Uint8Array(encodeCbor(value));
  assert.ok(decodePresented(bytes([PRESENTED_SIGNALS_LABEL, new Uint8Array(3)])));
  assert.equal(decodePresented(bytes(["cello-something-else", new Uint8Array(3)])), null);
  assert.equal(decodePresented(bytes([PRESENTED_SIGNALS_LABEL, "text"])), null);
  assert.equal(decodePresented(bytes([PRESENTED_SIGNALS_LABEL, [new Uint8Array(3)]])), null);
  assert.equal(decodePresented(bytes([PRESENTED_SIGNALS_LABEL, ...Array.from({ length: 9 }, () => new Uint8Array(3))])), null);
  assert.equal(decodePresented(bytes({ label: PRESENTED_SIGNALS_LABEL })), null);
  assert.equal(decodePresented(new Uint8Array([0xff, 0x00, 0x01])), null);
});

test("an offer carries both sealed fields or neither, and neither field can be oversize", () => {
  const base: OfferFields = { serverId: fill(1, 32), sessionId: fill(2, 16), callerId: fill(3, 32), calleeId: fill(4, 32), x25519Public: fill(5, 32), mlKemPublic: fill(6, 1184), expiresAt: 2_000_000_000_000, signalsCiphertext: new Uint8Array(0), sealedSignals: new Uint8Array(0) };
  assert.ok(offerBytes(base));
  assert.ok(offerBytes({ ...base, signalsCiphertext: fill(7, 1088), sealedSignals: fill(8, 500) }));
  assert.throws(() => offerBytes({ ...base, signalsCiphertext: fill(7, 1088) }), RangeError);
  assert.throws(() => offerBytes({ ...base, sealedSignals: fill(8, 500) }), RangeError);
  assert.throws(() => offerBytes({ ...base, signalsCiphertext: fill(7, 1000), sealedSignals: fill(8, 500) }), RangeError);
  assert.throws(() => offerBytes({ ...base, signalsCiphertext: fill(7, 1088), sealedSignals: fill(8, MAX_PRESENTED_BYTES + 1) }), RangeError);
  // The same checks hold for bytes that arrive from outside.
  const good = offerBytes({ ...base, signalsCiphertext: fill(7, 1088), sealedSignals: fill(8, 500) });
  assert.deepEqual(offerStructure.decode(good).sealedSignals.length, 500);
  assert.throws(() => offerStructure.decode(new Uint8Array(70_001)), RangeError);
  assert.throws(() => acceptStructure.decode(new Uint8Array(70_001)), RangeError);
});

test("a published key is accepted only if it names the agent and that agent signed it", async () => {
  const { publicKey } = await mlKemKeypairFromSeed(mlKemGenerateSeed());
  const make = async (signer: typeof ann, agentId: Uint8Array) => {
    const fields = { agentId, mlKemPublic: publicKey, revision: 1, issuedAt: 1_800_000_000_000 };
    return signedEncryptionKey.encode({ fields, signature: await signer.sign("cello-agent-encryption-key", encryptionKeyBytes(fields)) });
  };
  assert.deepEqual((await checkEncryptionKey(await make(ann, ann.id), ann.publicIdentity, ann.id)).revision, 1);
  await assert.rejects(checkEncryptionKey(await make(mallory, ann.id), ann.publicIdentity, ann.id), /isn't signed by the agent/);
  await assert.rejects(checkEncryptionKey(await make(mallory, mallory.id), mallory.publicIdentity, ann.id), /names a different agent/);
  await assert.rejects(checkEncryptionKey({ bytes: "AA", signature: {} }, ann.publicIdentity, ann.id));
});

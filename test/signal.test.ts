// Forgeries a working run would never show: a signal must fail by name when it's altered, copied, or claims too long a life.
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { toHex } from "../src/protocol/encode.ts";
import { signerFromSeeds } from "../src/protocol/identity.ts";
import { MAX_SIGNAL_LIFETIME_SECONDS, SIGNED_SIGNAL_DOMAIN, TRUST_SIGNAL_DOMAIN, type TrustSignalEnvelope, checkSignal, decodeTrustSignalEnvelope, encodeTrustSignalEnvelope, hashTrustSignalEnvelope, issuerKeys, issuerPubkeyField, readSignedSignal, signSignal } from "../src/protocol/signal.ts";

const fill = (byte: number, length: number): Uint8Array => new Uint8Array(length).fill(byte);
const issuer = await signerFromSeeds({ ed: fill(1, 32), pq: fill(2, 32) });
const stranger = await signerFromSeeds({ ed: fill(3, 32), pq: fill(4, 32) });
const AGENT = "ab".repeat(32);
const OTHER_AGENT = "cd".repeat(32);
const ISSUED = 1_800_000_000;
const NOW = ISSUED + 10;

const envelope = (over: Partial<TrustSignalEnvelope> = {}): TrustSignalEnvelope => ({
  subject_kind: "account", subject: AGENT, issuer_kind: "issuer", issuer_pubkey: issuerPubkeyField(issuer.publicIdentity), type: "email", schema_version: 1,
  payload: new Uint8Array([1, 2, 3]), issued_at: ISSUED, expires_at: ISSUED + 86_400, supersedes_hash: null, same_operator: false, issuer_address: "trust.celloprotocol.com", signal_id: fill(9, 16), ...over,
});
const fault = async (file: Uint8Array, subject = AGENT, now = NOW): Promise<string> => {
  const check = await checkSignal(file, { subject, now });
  return check.ok ? "ok" : check.fault;
};
// Builds what a dishonest issuer could send, skipping the encoder's checks.
const rawEnvelope = (env: TrustSignalEnvelope): Uint8Array => new Uint8Array(encodeCbor([TRUST_SIGNAL_DOMAIN, env.subject_kind, env.subject, env.issuer_kind, env.issuer_pubkey, env.type, env.schema_version, env.payload, env.issued_at, env.expires_at, env.supersedes_hash, env.same_operator, env.issuer_address, env.signal_id]));
const rawFile = async (bytes: Uint8Array, signer = issuer): Promise<Uint8Array> => {
  const signature = await signer.sign("cello-signal", bytes);
  return new Uint8Array(encodeCbor([SIGNED_SIGNAL_DOMAIN, bytes, signature.ed, signature.pq]));
};

test("a good signal checks out, names its issuer's two keys, and its hash is its name", async () => {
  const file = await signSignal(envelope(), issuer);
  const check = await checkSignal(file, { subject: AGENT, now: NOW });
  assert.ok(check.ok);
  assert.deepEqual(check.issuerId, issuer.id);
  assert.deepEqual(issuerKeys(check.signal.envelope), issuer.publicIdentity);
  assert.equal(check.signal.envelope.issuer_address, "trust.celloprotocol.com");
  assert.deepEqual(check.signal.hash, hashTrustSignalEnvelope(envelope()));
});

test("the signatures sit outside the hash: signing twice gives one name", async () => {
  const [a, b] = [readSignedSignal(await signSignal(envelope(), issuer)), readSignedSignal(await signSignal(envelope(), issuer))];
  assert.notDeepEqual(a?.signature.pq, b?.signature.pq);
  assert.deepEqual(a?.hash, b?.hash);
});

test("forged: altering any signed field, or either signature, is refused", async () => {
  const file = await signSignal(envelope(), issuer);
  const good = readSignedSignal(file);
  for (const [name, altered] of Object.entries({ same_operator: { same_operator: true }, subject_kind: { subject_kind: "agent" }, address: { issuer_address: "evil.example" }, id: { signal_id: fill(8, 16) }, payload: { payload: new Uint8Array([9]) }, later: { expires_at: ISSUED + 90_000 } } as Record<string, Partial<TrustSignalEnvelope>>)) {
    const swapped = new Uint8Array(encodeCbor([SIGNED_SIGNAL_DOMAIN, encodeTrustSignalEnvelope(envelope(altered)), good.signature.ed, good.signature.pq]));
    assert.equal(await fault(swapped), "forged", name);
  }
  const edOnly = await stranger.sign("cello-signal", good.envelopeBytes);
  assert.equal(await fault(new Uint8Array(encodeCbor([SIGNED_SIGNAL_DOMAIN, good.envelopeBytes, good.signature.ed, edOnly.pq]))), "forged", "a good Ed25519 beside a bad ML-DSA");
  assert.equal(await fault(new Uint8Array(encodeCbor([SIGNED_SIGNAL_DOMAIN, good.envelopeBytes, edOnly.ed, good.signature.pq]))), "forged", "a good ML-DSA beside a bad Ed25519");
});

test("forged: a stranger can't sign as the issuer, and naming the stranger makes it the stranger's claim", async () => {
  assert.equal(await fault(await rawFile(rawEnvelope(envelope()), stranger)), "forged");
  await assert.rejects(signSignal(envelope(), stranger), /aren't the ones/);
  const own = await signSignal(envelope({ issuer_pubkey: issuerPubkeyField(stranger.publicIdentity) }), stranger);
  const check = await checkSignal(own, { subject: AGENT, now: NOW });
  assert.ok(check.ok);
  assert.deepEqual(check.issuerId, stranger.id);
  assert.notDeepEqual(check.issuerId, issuer.id);
});

test("forged: swapping just one of the issuer's two keys in the field is refused", async () => {
  const mixed = toHex(issuer.publicIdentity.ed) + toHex(stranger.publicIdentity.pq);
  assert.equal(await fault(await rawFile(rawEnvelope(envelope({ issuer_pubkey: mixed })))), "forged");
});

test("copied or wrong subject: another agent presenting this signal gets nowhere", async () => {
  const file = await signSignal(envelope(), issuer);
  assert.equal(await fault(file, OTHER_AGENT), "wrong_subject");
  const good = readSignedSignal(file);
  const copied = new Uint8Array(encodeCbor([SIGNED_SIGNAL_DOMAIN, encodeTrustSignalEnvelope(envelope({ subject: OTHER_AGENT })), good.signature.ed, good.signature.pq]));
  assert.equal(await fault(copied, OTHER_AGENT), "forged", "its signatures moved onto a copy naming the thief");
  assert.throws(() => encodeTrustSignalEnvelope(envelope({ subject: "an-account-id" })), /agent's key/);
});

test("a signature made for something else can't pass as a signal", async () => {
  const bytes = encodeTrustSignalEnvelope(envelope());
  const signature = await issuer.sign("cello-register", bytes);
  assert.equal(await fault(new Uint8Array(encodeCbor([SIGNED_SIGNAL_DOMAIN, bytes, signature.ed, signature.pq]))), "forged");
});

test("expiry: a year or none passes, a second more is refused, even when the issuer really signed it", async () => {
  assert.equal(await fault(await signSignal(envelope({ expires_at: ISSUED + MAX_SIGNAL_LIFETIME_SECONDS }), issuer)), "ok");
  assert.equal(await fault(await signSignal(envelope({ expires_at: null }), issuer)), "ok", "permanent");
  assert.throws(() => encodeTrustSignalEnvelope(envelope({ expires_at: ISSUED + MAX_SIGNAL_LIFETIME_SECONDS + 1 })), /at most one year/);
  assert.equal(await fault(await rawFile(rawEnvelope(envelope({ expires_at: ISSUED + MAX_SIGNAL_LIFETIME_SECONDS + 1 })))), "expiry_too_long");
  assert.equal(await fault(await rawFile(rawEnvelope(envelope({ expires_at: ISSUED + 50 * 365 * 86_400 })))), "expiry_too_long", "fifty years");
  assert.throws(() => encodeTrustSignalEnvelope(envelope({ expires_at: ISSUED })), /after issued_at/);
  assert.equal(await fault(await signSignal(envelope(), issuer), AGENT, ISSUED + 86_400), "expired", "expired at its own moment");
});

test("the old envelope's rules still hold", () => {
  assert.throws(() => encodeTrustSignalEnvelope({ ...envelope(), extra: 1 } as TrustSignalEnvelope), /unknown envelope field/);
  const missing: Partial<TrustSignalEnvelope> = envelope();
  delete missing.signal_id;
  assert.throws(() => encodeTrustSignalEnvelope(missing as TrustSignalEnvelope), /missing mandatory field/);
  assert.throws(() => encodeTrustSignalEnvelope(envelope({ issuer_kind: "portal" as "issuer" })), /issuer_kind/);
  assert.throws(() => encodeTrustSignalEnvelope(envelope({ issued_at: 1.5 })), /no floating point/);
  assert.throws(() => encodeTrustSignalEnvelope(envelope({ issued_at: 1_800_000_000_000, expires_at: null })), /millisecond/);
  assert.throws(() => encodeTrustSignalEnvelope(envelope({ type: "é" })), /NFC/);
  assert.throws(() => encodeTrustSignalEnvelope(envelope({ issuer_pubkey: issuerPubkeyField(issuer.publicIdentity).toUpperCase() })), /LOWERCASE/);
  assert.throws(() => encodeTrustSignalEnvelope(envelope({ payload: {} as Uint8Array })), /raw bytes/);
  const late = 4_920_000_000;
  const hex = toHex(encodeTrustSignalEnvelope(envelope({ issued_at: late, expires_at: null })));
  assert.ok(hex.includes(`1b${late.toString(16).padStart(16, "0")}`), "above 2^32 it's a uint64");
  assert.deepEqual(decodeTrustSignalEnvelope(encodeTrustSignalEnvelope(envelope())), envelope(), "round trip, null slots included");
  assert.deepEqual(encodeTrustSignalEnvelope(envelope()).subarray(1, 2 + TRUST_SIGNAL_DOMAIN.length).subarray(1), new TextEncoder().encode(TRUST_SIGNAL_DOMAIN), "the domain tag is slot 0");
});

test("the old word \"portal\" is refused even when the issuer really signed it", async () => {
  assert.equal(await fault(await rawFile(rawEnvelope(envelope({ issuer_kind: "portal" as "issuer" })))), "malformed");
});

test("malformed bytes are refused by name before the decoder can spend anything", async () => {
  const good = encodeTrustSignalEnvelope(envelope());
  for (const [name, bytes] of Object.entries({ nested: new Uint8Array([0x8e, 0x99, 0xff, 0xff]), indefinite: new Uint8Array([0x9f, 0xb0]), map: new Uint8Array([0xa1, 0x9f]), empty: new Uint8Array(0), trailing: new Uint8Array([...good, 0]), long: new Uint8Array(70_000) })) {
    assert.throws(() => decodeTrustSignalEnvelope(bytes), RangeError, name);
    assert.equal(await fault(bytes), "malformed", name);
  }
  // A float where an integer belongs.
  const asFloat = Buffer.from(toHex(good).replace(`1a${ISSUED.toString(16).padStart(8, "0")}`, "fb41dad27508000000"), "hex");
  assert.throws(() => decodeTrustSignalEnvelope(new Uint8Array(asFloat)), RangeError);
  const otherTag = new Uint8Array(encodeCbor(["cello-other-v1", good, new Uint8Array(64), new Uint8Array(2420)]));
  assert.equal(await fault(otherTag), "unknown_format");
});

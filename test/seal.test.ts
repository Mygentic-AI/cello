// A bad proof or a forged number wouldn't show against an honest server, so these lie on purpose.
// The forgeries are signed with a key the reader trusts: that's a stolen seal key, the worst case for M.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ZERO_HASH, toHex } from "../src/protocol/encode.ts";
import { type Signer, generateIdentitySeeds, signerFromSeeds } from "../src/protocol/identity.ts";
import { RunningMerkle, consistencyPath, verifyConsistency, verifyInclusion } from "../src/protocol/merkle.ts";
import { type SealRecordOnWire, SEAL_RECORD_FORMAT, checkSealRecord, describeSeal, encodeHashes, sealId } from "../src/protocol/seal.ts";
import { type SealCertificateFields, deliveryAckBytes, sealCertificateBytes, sealKeyBindingBytes, sealLogHeadBytes, sealRequestBytes, structureHash } from "../src/protocol/structures.ts";
import { identityCodec, signatureCodec, signedDeliveryAck, signedSealCertificate, signedSealLogHead, signedSealRequest } from "../src/protocol/wire.ts";

const hashOf = (n: number): Uint8Array => structureHash(Uint8Array.of(n));

test("consistency and inclusion proofs hold for every tree size, and fail when anything is changed", () => {
  const hashes = Array.from({ length: 33 }, (_, i) => hashOf(i));
  const roots: Uint8Array[] = [];
  const paths: Uint8Array[][] = [];
  const running = new RunningMerkle();
  for (const hash of hashes) {
    paths.push(running.nextLeafPath());
    roots.push(running.append(hash));
  }
  const rootAt = (size: number): Uint8Array => roots[size - 1] as Uint8Array;
  for (let n = 1; n <= hashes.length; n++) {
    assert.ok(verifyInclusion(hashes[n - 1] as Uint8Array, n - 1, n, rootAt(n), paths[n - 1] as Uint8Array[]), `the newest leaf of ${n}`);
    for (let m = 1; m <= n; m++) {
      const path = consistencyPath(hashes.slice(0, n), m);
      assert.ok(verifyConsistency(m, n, rootAt(m), rootAt(n), path), `${m} to ${n}`);
      if (m === n) continue;
      assert.equal(verifyConsistency(m, n, hashOf(99), rootAt(n), path), false, `wrong first root ${m} to ${n}`);
      assert.equal(verifyConsistency(m, n, rootAt(m), hashOf(99), path), false, `wrong second root ${m} to ${n}`);
      if (path.length > 0) assert.equal(verifyConsistency(m, n, rootAt(m), rootAt(n), [hashOf(99), ...path.slice(1)]), false, `changed proof ${m} to ${n}`);
      assert.equal(verifyConsistency(m, n, rootAt(m), rootAt(n), [...path, hashOf(99)]), false, `longer proof ${m} to ${n}`);
    }
  }
  // A history rewritten at position 3 can't be shown to extend the one the counterparty signed.
  const rewritten = hashes.slice(0, 8);
  rewritten[2] = hashOf(200);
  const other = new RunningMerkle();
  let otherRoot = other.root();
  for (const hash of rewritten) otherRoot = other.append(hash);
  assert.equal(verifyConsistency(5, 8, rootAt(5), otherRoot, consistencyPath(rewritten, 5)), false);
});

interface Cast { sealKey: Signer; server: Signer; alice: Signer; bob: Signer }

async function cast(): Promise<Cast> {
  const [sealKey, server, alice, bob] = await Promise.all([1, 2, 3, 4].map(() => signerFromSeeds(generateIdentitySeeds()))) as [Signer, Signer, Signer, Signer];
  return { sealKey, server, alice, bob };
}

const sessionId = new Uint8Array(16).fill(7);
const hashes = Array.from({ length: 8 }, (_, i) => hashOf(i));

function rootOf(size: number): Uint8Array {
  const tree = new RunningMerkle();
  for (const hash of hashes.slice(0, size)) tree.append(hash);
  return tree.root();
}

async function record(c: Cast, n: number, ackThrough: number | null, certificate: Partial<SealCertificateFields> = {}): Promise<SealRecordOnWire> {
  const request = { serverId: c.server.id, sessionId, sealerId: c.alice.id, throughPosition: n, root: certificate.root ?? rootOf(n) };
  const requestBytes = sealRequestBytes(request);
  const ack = ackThrough === null ? null : { sessionId, readerId: c.bob.id, throughPosition: ackThrough, entryHash: hashes[ackThrough - 1] as Uint8Array, root: rootOf(ackThrough) };
  const fields: SealCertificateFields = {
    sealKeyId: c.sealKey.id,
    serverId: c.server.id,
    sessionId,
    sealerId: c.alice.id,
    counterpartyId: c.bob.id,
    requestHash: structureHash(requestBytes),
    root: request.root,
    throughPosition: n,
    tip: 8,
    closed: 0,
    receivedThrough: ack ? Math.min(ack.throughPosition, n) : 0,
    deliveryAckHash: ack ? structureHash(deliveryAckBytes(ack)) : ZERO_HASH,
    time: 1000,
    ...certificate,
  };
  const leaf = sealId(fields);
  const log = new RunningMerkle();
  const path = log.nextLeafPath();
  const head = { sealKeyId: c.sealKey.id, size: 1, root: log.append(leaf), time: 1000 };
  const proof = ack === null || ack.throughPosition === n ? [] : ack.throughPosition < n ? consistencyPath(hashes.slice(0, n), ack.throughPosition) : consistencyPath(hashes.slice(0, ack.throughPosition), n);
  return {
    format: SEAL_RECORD_FORMAT,
    certificate: signedSealCertificate.encode({ fields, signature: await c.sealKey.sign("cello-v2-seal-certificate", sealCertificateBytes(fields)) }),
    request: signedSealRequest.encode({ fields: request, signature: await c.alice.sign("cello-v2-seal-request", requestBytes) }),
    deliveryAck: ack ? signedDeliveryAck.encode({ fields: ack, signature: await c.bob.sign("cello-v2-delivery-ack", deliveryAckBytes(ack)) }) : null,
    deliveryProof: encodeHashes(proof),
    sealer: identityCodec.encode(c.alice.publicIdentity),
    counterparty: identityCodec.encode(c.bob.publicIdentity),
    sealKey: identityCodec.encode(c.sealKey.publicIdentity),
    server: identityCodec.encode(c.server.publicIdentity),
    sealKeyBinding: signatureCodec.encode(await c.server.sign("cello-v2-seal-key-binding", sealKeyBindingBytes({ serverId: c.server.id, sealKeyId: c.sealKey.id }))),
    log: { index: 0, head: signedSealLogHead.encode({ fields: head, signature: await c.sealKey.sign("cello-v2-seal-log-head", sealLogHeadBytes(head)) }), path: encodeHashes(path) },
  };
}

async function faultOf(raw: unknown, c: Cast): Promise<string | null> {
  const check = await checkSealRecord(raw, c.sealKey.id);
  return check.ok ? null : check.fault;
}

test("an honest record passes, however M and N fall", async () => {
  const c = await cast();
  for (const [n, ack, m] of [[5, 3, 3], [5, 5, 5], [5, 7, 5], [5, null, 0], [8, 1, 1], [1, 8, 1]] as const) {
    const check = await checkSealRecord(await record(c, n, ack), c.sealKey.id);
    assert.ok(check.ok, `N=${n} ack=${ack}: ${check.ok ? "" : check.message}`);
    assert.equal(check.record.certificate.fields.receivedThrough, m);
  }
});

test("the statement separates what's proven from what rests on the server, and stays neutral", async () => {
  const c = await cast();
  const check = await checkSealRecord(await record(c, 5, 3), c.sealKey.id);
  assert.ok(check.ok);
  const statement = describeSeal(check.record);
  assert.match(statement["proven_without_trusting_the_server"] as string, /Positions 1 to 3/);
  assert.match(statement["rests_on_the_server"] as string, /Positions 4 to 5/);
  assert.match(statement["how_much_this_covers"] as string, /partial seal.*server says.*8 positions.*covers 5/);
  // The session's size and whether it closed carry no counterparty signature, so neither may read as proven.
  assert.match(statement["rests_on_the_server"] as string, /how many positions the session had, and whether it had closed/);
  assert.match(statement["how_much_this_covers"] as string, /The server says the session hadn't closed/);
  assert.match(statement["who_signed"] as string, /session_id/);
  assert.match(statement["seal_log"] as string, /could rewrite it/);
  assert.match(statement["meaning"] as string, /says nothing about whether the parties agreed/);
});

test("a stolen seal key still can't raise M", async () => {
  const c = await cast();
  // The thief signs a certificate claiming more was received than the counterparty's ack says.
  const inflated = await record(c, 5, 3, { receivedThrough: 5 });
  assert.equal(await faultOf(inflated, c), "delivery_ack_mismatch");

  // Or claims a number with no ack behind it at all.
  const unbacked = await record(c, 5, null, { receivedThrough: 2 });
  assert.equal(await faultOf(unbacked, c), "delivery_ack_mismatch");

  // Or signs an ack as someone else: the sealer, posing as the counterparty.
  const honest = await record(c, 5, 3);
  const ackFields = signedDeliveryAck.decode(honest.deliveryAck).fields;
  const selfSigned = await record(c, 5, 3);
  selfSigned.deliveryAck = signedDeliveryAck.encode({ fields: ackFields, signature: await c.alice.sign("cello-v2-delivery-ack", deliveryAckBytes(ackFields)) });
  assert.equal(await faultOf(selfSigned, c), "bad_delivery_ack_signature");

  // A sealer and a thief together seal a rewritten history over a real ack. It can't be linked to what was signed.
  const rewritten = await record(c, 5, 3, { root: hashOf(250) });
  assert.equal(await faultOf(rewritten, c), "delivery_proof_failed");

  // Or a certificate that isn't what the sealer asked for.
  const unasked = await record(c, 5, 3, { requestHash: hashOf(251) });
  assert.equal(await faultOf(unasked, c), "seal_request_mismatch");
});

test("every part of a record is checked", async () => {
  const c = await cast();
  const edits: [string, (r: SealRecordOnWire) => Promise<void> | void, string][] = [
    ["a changed N", (r) => { (r.certificate.fields as { throughPosition: number }).throughPosition = 4; }, "bad_seal_signature"],
    ["a changed M", (r) => { (r.certificate.fields as { receivedThrough: number }).receivedThrough = 5; }, "bad_seal_signature"],
    ["a changed tip", (r) => { (r.certificate.fields as { tip: number }).tip = 5; }, "bad_seal_signature"],
    ["a changed closed", (r) => { (r.certificate.fields as { closed: number }).closed = 1; }, "bad_seal_signature"],
    ["a closed that isn't 0 or 1", (r) => { (r.certificate.fields as { closed: number }).closed = 2; }, "malformed_record"],
    ["a swapped seal key", (r) => { r.sealKey = identityCodec.encode(c.alice.publicIdentity); }, "wrong_seal_key"],
    ["another server's name", (r) => { r.server = identityCodec.encode(c.alice.publicIdentity); }, "bad_seal_key_binding"],
    ["a wrong binding", async (r) => { r.sealKeyBinding = signatureCodec.encode(await c.alice.sign("cello-v2-seal-key-binding", sealKeyBindingBytes({ serverId: c.server.id, sealKeyId: c.sealKey.id }))); }, "bad_seal_key_binding"],
    ["a swapped sealer", (r) => { r.sealer = identityCodec.encode(c.bob.publicIdentity); }, "wrong_sealer_keys"],
    ["a swapped counterparty", (r) => { r.counterparty = identityCodec.encode(c.alice.publicIdentity); }, "wrong_counterparty_keys"],
    ["a request not signed by the sealer", async (r) => { const fields = signedSealRequest.decode(r.request).fields; r.request = signedSealRequest.encode({ fields, signature: await c.bob.sign("cello-v2-seal-request", sealRequestBytes(fields)) }); }, "bad_seal_request"],
    ["a removed ack", (r) => { r.deliveryAck = null; }, "delivery_ack_mismatch"],
    ["a broken link", (r) => { r.deliveryProof = encodeHashes([hashOf(1)]); }, "delivery_proof_failed"],
    ["a changed log head", (r) => { (r.log.head.fields as { size: number }).size = 2; }, "bad_log_head_signature"],
    ["a wrong log index", (r) => { r.log.index = 5; }, "log_proof_failed"],
    ["a broken log path", (r) => { r.log.path = encodeHashes([hashOf(1)]); }, "log_proof_failed"],
    ["a wrong format", (r) => { (r as { format: string }).format = "x"; }, "malformed_record"],
  ];
  for (const [name, edit, fault] of edits) {
    const raw = await record(c, 5, 3);
    await edit(raw);
    assert.equal(await faultOf(raw, c), fault, name);
  }
  assert.equal(await faultOf({ nonsense: true }, c), "malformed_record");
  assert.equal(await faultOf(null, c), "malformed_record");
});

test("a record checked against the wrong key fails, even though it's internally perfect", async () => {
  const c = await cast();
  const raw = await record(c, 5, 3);
  const check = await checkSealRecord(raw, c.alice.id);
  assert.ok(!check.ok);
  assert.equal(check.fault, "wrong_seal_key");
  assert.match(check.message, new RegExp(toHex(c.sealKey.id)));
});

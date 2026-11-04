// A forged file or a wrong statement wouldn't show against honest parties, so these lie on purpose.
// Some forgeries use stolen server and seal keys: the worst case for what the file claims is bound.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ZERO_HASH } from "../src/protocol/encode.ts";
import { type Signer, generateIdentitySeeds, signerFromSeeds } from "../src/protocol/identity.ts";
import { RunningMerkle, consistencyPath } from "../src/protocol/merkle.ts";
import { saltedContentHash } from "../src/protocol/salt.ts";
import { type SealRecordOnWire, SEAL_RECORD_FORMAT, encodeHashes, sealId } from "../src/protocol/seal.ts";
import { EntryKind, EntryMode, type EntryFields, type SealCertificateFields, ackBytes, ciphertextHash, deliveryAckBytes, entryBytes, entryHash, sealCertificateBytes, sealKeyBindingBytes, sealLogHeadBytes, sealRequestBytes, structureHash } from "../src/protocol/structures.ts";
import { type HeldEntry, type TranscriptOnWire, type TranscriptRequest, buildTranscript, checkTranscript, readBody } from "../src/protocol/transcript.ts";
import { fromB64, identityCodec, signatureCodec, signedAck, signedDeliveryAck, signedEntry, signedSealCertificate, signedSealLogHead, signedSealRequest, toB64 } from "../src/protocol/wire.ts";

interface Cast { sealKey: Signer; server: Signer; alice: Signer; bob: Signer; carol: Signer }

async function cast(): Promise<Cast> {
  const [sealKey, server, alice, bob, carol] = await Promise.all([1, 2, 3, 4, 5].map(() => signerFromSeeds(generateIdentitySeeds()))) as [Signer, Signer, Signer, Signer, Signer];
  return { sealKey, server, alice, bob, carol };
}

const SESSION = new Uint8Array(16).fill(7);
const SALT = new Uint8Array(randomBytes(32));

function bodyOf(text: string, signal: string | null = "over"): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ n: toB64(new Uint8Array(randomBytes(16))), text, signal, est_minutes: null }));
}

interface Line { author: Signer; body: Uint8Array; kind?: EntryKind }
interface Chain { held: HeldEntry[]; hashes: Uint8Array[] }

async function chainOf(c: Cast, lines: readonly Line[], sessionId = SESSION, salt = SALT): Promise<Chain> {
  const tree = new RunningMerkle();
  const roots = [tree.root()];
  const heads = new Map<Signer, { seq: number; hash: Uint8Array }>();
  const held: HeldEntry[] = [];
  const hashes: Uint8Array[] = [];
  for (const line of lines) {
    const head = heads.get(line.author);
    const position = held.length + 1;
    const fields: EntryFields = {
      sessionId,
      authorId: line.author.id,
      authorSeq: (head?.seq ?? 0) + 1,
      prevOwnHash: head?.hash ?? ZERO_HASH,
      readPosition: position - 1,
      readRoot: roots[position - 1] as Uint8Array,
      kind: line.kind ?? EntryKind.message,
      mode: EntryMode.reply,
      contentHash: saltedContentHash(salt, line.body),
      ciphertextHash: ciphertextHash(line.body),
      notAfter: 2_000_000_000_000,
    };
    const hash = entryHash(fields);
    const root = tree.append(hash);
    roots.push(root);
    heads.set(line.author, { seq: fields.authorSeq, hash });
    hashes.push(hash);
    const ack = { serverId: c.server.id, sessionId, position, entryHash: hash, root, time: 1_000 + position };
    held.push({
      position,
      entry: signedEntry.encode({ fields, signature: await line.author.sign("cello-v2-entry", entryBytes(fields)) }),
      ack: signedAck.encode({ fields: ack, signature: await c.server.sign("cello-v2-ack", ackBytes(ack)) }),
      body: line.body,
    });
  }
  return { held, hashes };
}

function rootOf(hashes: readonly Uint8Array[], size: number): Uint8Array {
  const tree = new RunningMerkle();
  for (const hash of hashes.slice(0, size)) tree.append(hash);
  return tree.root();
}

interface SealOptions {
  n?: number;
  ackThrough?: number | null;
  tip?: number;
  closed?: number;
  time?: number;
  // What the counterparty really signed, when the chain in the seal is a rewritten one.
  ackedHashes?: readonly Uint8Array[];
  ackEntryHash?: Uint8Array;
}

async function sealOf(c: Cast, chain: Chain, options: SealOptions = {}, sessionId = SESSION): Promise<SealRecordOnWire> {
  const n = options.n ?? chain.hashes.length;
  const ackThrough = options.ackThrough === undefined ? n : options.ackThrough;
  const hashes = chain.hashes;
  const acked = options.ackedHashes ?? hashes;
  const request = { serverId: c.server.id, sessionId, sealerId: c.alice.id, throughPosition: n, root: rootOf(hashes, n) };
  const requestBytes = sealRequestBytes(request);
  const ack = ackThrough === null ? null : { sessionId, readerId: c.bob.id, throughPosition: ackThrough, entryHash: options.ackEntryHash ?? acked[ackThrough - 1] as Uint8Array, root: rootOf(acked, ackThrough), screenedThrough: 0 };
  const fields: SealCertificateFields = {
    sealKeyId: c.sealKey.id,
    serverId: c.server.id,
    sessionId,
    sealerId: c.alice.id,
    counterpartyId: c.bob.id,
    requestHash: structureHash(requestBytes),
    root: request.root,
    throughPosition: n,
    tip: options.tip ?? n,
    closed: options.closed ?? 1,
    receivedThrough: ack ? Math.min(ack.throughPosition, n) : 0,
    deliveryAckHash: ack ? structureHash(deliveryAckBytes(ack)) : ZERO_HASH,
    time: options.time ?? 5_000,
  };
  const log = new RunningMerkle();
  const path = log.nextLeafPath();
  const head = { sealKeyId: c.sealKey.id, size: 1, root: log.append(sealId(fields)), time: 5_000 };
  const proof = ack === null || ack.throughPosition === n ? [] : consistencyPath(hashes.slice(0, Math.max(n, ack.throughPosition)), Math.min(n, ack.throughPosition));
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

function request(chain: Chain, seals: readonly SealRecordOnWire[], choice: Partial<TranscriptRequest>): TranscriptRequest {
  return { session: "s", sealCommand: "cello-v2 seal s --agent Alice", entries: chain.held, seals, salt: SALT, reveal: undefined, all: false, sealId: undefined, ...choice };
}

async function exported(chain: Chain, seal: SealRecordOnWire, choice: Partial<TranscriptRequest> = { all: true }): Promise<TranscriptOnWire> {
  const built = await buildTranscript(request(chain, [seal], choice));
  assert.ok(built.ok, built.ok ? "" : `${built.fault}: ${built.message}`);
  return built.file;
}

async function faultOf(c: Cast, raw: unknown): Promise<string | null> {
  const check = await checkTranscript(raw, c.sealKey.id);
  return check.ok ? null : check.fault;
}

type Message = { position: number; author: string; kind: string; basis: string; text?: string; signal?: string; unreadable?: boolean; body_base64url?: string; text_on_a_close?: string };

async function reportOf(c: Cast, raw: unknown): Promise<{ messages: Message[]; revealed_positions: number[]; hidden_positions: number[]; statement: Record<string, string> }> {
  const check = await checkTranscript(raw, c.sealKey.id);
  assert.ok(check.ok, check.ok ? "" : `${check.fault}: ${check.message}`);
  return check.report as never;
}

function conversation(c: Cast): Line[] {
  return [
    { author: c.alice, body: bodyOf("Bob, what's your offer?") },
    { author: c.bob, body: bodyOf("I offer $1M") },
    { author: c.alice, body: bodyOf("Thinking about it") },
    { author: c.bob, body: bodyOf("I withdraw") },
    { author: c.alice, body: bodyOf("", null), kind: EntryKind.close },
  ];
}

test("everything revealed: each message says who wrote it and what it rests on, and stays neutral", async () => {
  const c = await cast();
  const chain = await chainOf(c, conversation(c));
  const report = await reportOf(c, await exported(chain, await sealOf(c, chain, { ackThrough: 3 })));
  assert.deepEqual(report.messages.map((m) => [m.position, m.author, m.kind, m.basis]), [
    [1, "sealer", "message", "counterparty_signature"],
    [2, "counterparty", "message", "counterparty_signature"],
    [3, "sealer", "message", "counterparty_signature"],
    [4, "counterparty", "message", "sender_signature_and_server"],
    [5, "sealer", "close", "sender_signature_and_server"],
  ]);
  assert.deepEqual([report.messages[1]?.text, report.messages[1]?.signal], ["I offer $1M", "over"]);
  assert.equal(report.messages[4]?.text, undefined, "a close has no text to show");
  assert.deepEqual(report.hidden_positions, []);
  const { statement } = report;
  assert.match(statement["meaning"] as string, /says nothing about whether they're true, or whether either party agreed/);
  assert.match(statement["bound_by_the_counterparty_signature"] as string, /Positions 1-3:.*through position 3/);
  assert.match(statement["rests_on_the_sender_and_the_server"] as string, /Positions 4: the counterparty's signature on the entry stands behind the words/);
  assert.match(statement["rests_on_the_sender_and_the_server"] as string, /Positions 5: only the signature of the person who made this file/);
  assert.match(statement["who_chose"] as string, /one party.*chose what to reveal/);
  assert.match(statement["hidden"] as string, /Nothing is hidden/);
  assert.match(statement["ciphertext"] as string, /isn't checked here/);
  assert.doesNotMatch(JSON.stringify(statement), /proves? (that )?.*(true|agreed)\b/i);
});

test("a partial reveal shows only what was chosen, and warns that the rest may change the meaning", async () => {
  const c = await cast();
  const chain = await chainOf(c, conversation(c));
  const file = await exported(chain, await sealOf(c, chain), { reveal: "2" });
  assert.doesNotMatch(Buffer.concat(file.revealed.map((r) => Buffer.from(fromB64(r.body, "body")))).toString(), /withdraw/);
  assert.doesNotMatch(JSON.stringify(file), /withdraw/);
  const report = await reportOf(c, file);
  assert.deepEqual(report.revealed_positions, [2]);
  assert.deepEqual(report.hidden_positions, [1, 3, 4, 5]);
  assert.match(report.statement["hidden"] as string, /Positions 1, 3-5 are hidden.*may change the meaning.*Bob withdraws/);
});

test("what comes after a seal counts as not shown, even when nothing inside it is hidden", async () => {
  const c = await cast();
  const chain = await chainOf(c, conversation(c));
  const seal = await sealOf(c, chain, { n: 2, ackThrough: 2, tip: 5, closed: 0 });
  const sealedPart = { ...chain, held: chain.held.slice(0, 2) };
  const statement = (await reportOf(c, await exported(sealedPart, seal))).statement;
  assert.match(statement["hidden"] as string, /3 more positions came after.*hadn't closed.*may change the meaning/);
  assert.doesNotMatch(statement["hidden"] as string, /Nothing is hidden/);
});

test("each forgery fails by name", async () => {
  const c = await cast();
  const chain = await chainOf(c, conversation(c));
  const seal = await sealOf(c, chain, { ackThrough: 3 });
  const good = await exported(chain, seal);
  const forged = (edit: (f: TranscriptOnWire) => void): TranscriptOnWire => {
    const copy = structuredClone(good);
    edit(copy);
    return copy;
  };
  const expect = async (fault: string, edit: (f: TranscriptOnWire) => void): Promise<void> => assert.equal(await faultOf(c, forged(edit)), fault);
  const bytes = (position: number): Uint8Array => fromB64(good.revealed[position - 1]?.body, "body");

  assert.equal(await faultOf(c, good), null);

  // A body that doesn't match.
  await expect("body_does_not_match", (f) => { (f.revealed[1] as { body: string }).body = toB64(bodyOf("I offer $9M")); });
  // The same text under a different random value isn't what was signed either.
  await expect("body_does_not_match", (f) => { (f.revealed[1] as { body: string }).body = toB64(new TextEncoder().encode(new TextDecoder().decode(bytes(2)).replace(/"n":"[^"]+"/, `"n":"${toB64(new Uint8Array(16))}"`))); });
  // Even one byte of re-encoding: canonical bytes are what's hashed.
  await expect("body_does_not_match", (f) => { (f.revealed[1] as { body: string }).body = toB64(new TextEncoder().encode(`${new TextDecoder().decode(bytes(2))} `)); });

  // A position swapped: two bodies, and two entries.
  await expect("body_does_not_match", (f) => { (f.revealed[1] as { position: number }).position = 4; (f.revealed[3] as { position: number }).position = 2; });
  await expect("bad_position", (f) => { f.entries.splice(1, 0, ...f.entries.splice(1, 2).reverse()); });

  // A body attributed to the wrong author, three ways. The file carries no author beside a body.
  await expect("malformed_transcript", (f) => { (f.revealed[0] as unknown as Record<string, string>)["author"] = "someone else"; });
  await expect("ack_wrong_entry", (f) => { (f.entries[0]?.entry.fields as Record<string, string>)["authorId"] = toB64(c.bob.id); });
  await expect("not_participant", (f) => { (f.entries[0]?.entry.fields as Record<string, string>)["authorId"] = toB64(c.carol.id); });

  // An entry from another session, with the same parties.
  const elsewhere = await chainOf(c, conversation(c), new Uint8Array(16).fill(8));
  await expect("wrong_session", (f) => { f.entries[0] = { entry: elsewhere.held[0]?.entry as never, ack: elsewhere.held[0]?.ack as never }; });
  // Or a whole seal from another session.
  const sealFromElsewhere = await sealOf(c, elsewhere, {}, new Uint8Array(16).fill(8));
  await expect("wrong_session", (f) => { f.seal = sealFromElsewhere; });

  // A truncated chain, and one that runs past the seal.
  await expect("truncated_chain", (f) => { f.entries.pop(); });
  await expect("truncated_chain", (f) => { f.entries = []; });
  const shorter = await sealOf(c, chain, { n: 2, ackThrough: 2, tip: 5 });
  await expect("entries_beyond_seal", (f) => { f.seal = shorter; });

  // A body beyond what's sealed, or shown twice.
  await expect("reveal_out_of_range", (f) => { (f.revealed[0] as { position: number }).position = 6; });
  await expect("reveal_out_of_range", (f) => { (f.revealed[0] as { position: number }).position = 0; });
  await expect("duplicate_reveal", (f) => { f.revealed.push({ ...f.revealed[0] as { position: number; body: string } }); });

  // A wrong salt can't open anything. A bad seal is still caught by the seal's own checks.
  await expect("body_does_not_match", (f) => { f.salt = toB64(new Uint8Array(32).fill(1)); });
  await expect("bad_seal_signature", (f) => { (f.seal.certificate.fields as Record<string, number>)["receivedThrough"] = 5; });
  await expect("malformed_entry", (f) => { (f.entries[0]?.entry.fields as Record<string, number>)["kind"] = 9; });

  // Things nobody can read.
  await expect("malformed_transcript", (f) => { (f as unknown as Record<string, string>)["format"] = "cello-v2-seal"; });
  await expect("malformed_transcript", (f) => { (f as unknown as Record<string, number>)["salt"] = 1; });
  await expect("malformed_transcript", (f) => { (f as unknown as Record<string, string>)["verified"] = "yes"; });
  assert.equal(await faultOf(c, "not an object"), "malformed_transcript");
  assert.equal((await checkTranscript(good, c.carol.id) as { fault: string }).fault, "wrong_seal_key");
});

test("a seal for a different root is refused", async () => {
  const c = await cast();
  const chain = await chainOf(c, conversation(c));
  const other = await chainOf(c, conversation(c));
  // Same session, same length and parties, so only the root differs.
  const seal = await sealOf(c, chain, { ackThrough: null });
  const file = structuredClone(await exported(chain, seal));
  file.entries = other.held.map((row) => ({ entry: row.entry, ack: row.ack as never }));
  file.revealed = [];
  assert.equal(await faultOf(c, file), "root_mismatch");
});

test("a counterparty's delivery ack must sit on this chain", async () => {
  const c = await cast();
  const chain = await chainOf(c, conversation(c));
  const seal = await sealOf(c, chain, { ackThrough: 3, ackEntryHash: new Uint8Array(32).fill(3) });
  const built = await buildTranscript(request(chain, [seal], { all: true }));
  assert.deepEqual(built.ok ? null : [built.fault, /delivery_ack_off_chain/.test(built.message)], ["export_failed_own_check", true]);
});

test("stolen server and seal keys can't touch what the counterparty signed, and can't write as it", async () => {
  const c = await cast();
  const lines = conversation(c);
  const honest = await chainOf(c, lines);

  // Alice holds the server's and seal's keys and rewrites Bob's offer inside M, signing it herself.
  const swapped = await chainOf(c, lines.map((line, i) => (i === 1 ? { author: c.alice, body: bodyOf("I offer $9M") } : line)));
  const inside = await sealOf(c, swapped, { ackThrough: 3, ackedHashes: honest.hashes });
  const built = await buildTranscript(request(swapped, [inside], { all: true }));
  assert.ok(!built.ok);
  assert.match(built.message, /delivery_proof_failed/, "her rewrite doesn't link to what Bob signed");

  // Above M she can rewrite her own words, and the file must say that's all that stands behind them.
  const rewritten = await chainOf(c, lines.map((line, i) => (i === 4 ? { author: c.alice, body: bodyOf("I never said this to Bob") } : line)));
  const above = await sealOf(c, rewritten, { ackThrough: 3, ackedHashes: honest.hashes });
  const report = await reportOf(c, await exported(rewritten, above));
  assert.deepEqual([report.messages[4]?.text, report.messages[4]?.author, report.messages[4]?.basis], ["I never said this to Bob", "sealer", "sender_signature_and_server"]);
  assert.match(report.statement["rests_on_the_sender_and_the_server"] as string, /Positions 5: only the signature of the person who made this file and the server's word.*Nothing shows the counterparty ever received them/);

  // Words with Bob's name on them need Bob's key, even above M.
  const asBob = structuredClone(await exported(rewritten, above));
  (asBob.entries[4]?.entry.fields as Record<string, string>)["authorId"] = toB64(c.bob.id);
  assert.equal(await faultOf(c, asBob), "ack_wrong_entry");
});

test("the salt: an exact length, and guesses about a hidden body need its random value", async () => {
  const c = await cast();
  const chain = await chainOf(c, conversation(c));
  const seal = await sealOf(c, chain);
  const file = await exported(chain, seal, { reveal: "1" });

  // HMAC pads a short key with zeros, so these two are one key. Only the length check tells them apart.
  const padded = new Uint8Array(33);
  padded.set(SALT);
  const body = chain.held[0]?.body as Uint8Array;
  assert.deepEqual(saltedContentHash(padded, body), saltedContentHash(SALT, body));
  assert.equal(await faultOf(c, { ...file, salt: toB64(padded) }), "bad_salt");

  // The holder knows the salt, the words and the signal of hidden position 2, and still can't confirm them.
  const hidden = chain.held[1] as HeldEntry;
  const target = signedEntry.decode(hidden.entry).fields.contentHash;
  const salt = fromB64(file.salt, "salt");
  const guess = (n: string): Uint8Array => saltedContentHash(salt, new TextEncoder().encode(JSON.stringify({ n, text: "I offer $1M", signal: "over", est_minutes: null })));
  assert.notDeepEqual(guess(toB64(new Uint8Array(16))), target);
  // With the random value the same guess does match, which is what shows this test can fail.
  assert.deepEqual(guess((JSON.parse(new TextDecoder().decode(hidden.body as Uint8Array)) as { n: string }).n), target);
});

test("a hidden body with no random value can be guessed at, so it's refused until it's shown", async () => {
  const c = await cast();
  const noValue = new TextEncoder().encode(JSON.stringify({ text: "yes", signal: "over", est_minutes: null }));
  const shortValue = new TextEncoder().encode(JSON.stringify({ n: "AAAA", text: "no", signal: "over", est_minutes: null }));
  const chain = await chainOf(c, [
    { author: c.alice, body: bodyOf("Do you accept?") },
    { author: c.bob, body: noValue },
    { author: c.bob, body: shortValue },
    { author: c.bob, body: new Uint8Array([0xff, 0xfe]) },
  ]);
  const seal = await sealOf(c, chain);
  const refused = await buildTranscript(request(chain, [seal], { reveal: "1" }));
  assert.deepEqual(refused.ok ? null : refused.fault, "hidden_body_guessable");
  assert.match(refused.ok ? "" : refused.message, /Positions 2-4 have no random value.*Nothing was written/);
  assert.equal((await buildTranscript(request(chain, [seal], { reveal: "1-4" }))).ok, true);
  // Every body this client writes has a value, a close included.
  assert.equal(readBody(bodyOf("", null))?.hasRandomValue, true);
});

test("a body that can't be parsed is still a body its author signed, and it's shown as it is", async () => {
  const c = await cast();
  const repeated = new TextEncoder().encode(`{"n":"${toB64(new Uint8Array(16))}","text":"yes","text":"no","signal":"over"}`);
  const closeWithWords = new TextEncoder().encode(JSON.stringify({ n: toB64(new Uint8Array(16)), text: "and another thing", signal: null, est_minutes: null }));
  const raw = [
    new Uint8Array([0xff, 0xfe, 0x00]),
    new TextEncoder().encode("not json"),
    repeated,
    new TextEncoder().encode(JSON.stringify({ n: toB64(new Uint8Array(16)), text: "x", signal: "agreed", est_minutes: null })),
    new TextEncoder().encode(JSON.stringify(["a list"])),
  ];
  const chain = await chainOf(c, [
    ...raw.map((body) => ({ author: c.bob, body })),
    { author: c.bob, body: closeWithWords, kind: EntryKind.close },
    { author: c.bob, body: new Uint8Array([0xff]), kind: EntryKind.close },
  ]);
  const { messages } = await reportOf(c, await exported(chain, await sealOf(c, chain)));
  for (const [i, body] of raw.entries()) {
    assert.deepEqual([messages[i]?.unreadable, messages[i]?.text, messages[i]?.body_base64url], [true, undefined, toB64(body)], `body ${i}`);
  }
  assert.deepEqual([messages[5]?.kind, messages[5]?.text, messages[5]?.text_on_a_close], ["close", undefined, "and another thing"]);
  assert.deepEqual([messages[6]?.kind, messages[6]?.unreadable], ["close", true]);
});

test("exporting needs an explicit choice and a seal that covers it", async () => {
  const c = await cast();
  const chain = await chainOf(c, conversation(c));
  const whole = await sealOf(c, chain, { ackThrough: 3 });
  const part = await sealOf(c, chain, { n: 3, ackThrough: 3, tip: 5, time: 9_000 });
  const faultFor = async (seals: SealRecordOnWire[], choice: Partial<TranscriptRequest>): Promise<string | null> => {
    const built = await buildTranscript(request(chain, seals, choice));
    return built.ok ? null : built.fault;
  };
  assert.equal(await faultFor([whole], {}), "no_reveal_chosen");
  assert.equal(await faultFor([whole], { all: true, reveal: "1" }), "bad_argument");
  for (const reveal of ["", "x", "0", "3-1", "1,,2", "1-", "-1", "1, 2"]) assert.equal(await faultFor([whole], { reveal }), "bad_argument", `"${reveal}"`);

  const none = await buildTranscript(request(chain, [], { all: true }));
  assert.deepEqual(none.ok ? null : none.fault, "no_seal_covers");
  assert.match(none.ok ? "" : none.message, /Run: cello-v2 seal s --agent Alice/);
  assert.equal(await faultFor([part], { all: true }), "no_seal_covers", "all can't quietly mean less than everything held");
  assert.equal(await faultFor([part], { reveal: "4" }), "no_seal_covers");
  assert.equal(await faultFor([whole], { reveal: "1-99999999999" }), "no_seal_covers");
  assert.equal(await faultFor([whole], { reveal: "1", sealId: "00".repeat(32) }), "unknown_seal");

  // The seal that covers most is the default, whatever the order they're held in, and another can be named.
  const pick = async (choice: Partial<TranscriptRequest>): Promise<number> => {
    const built = await buildTranscript(request(chain, [part, whole], choice));
    assert.ok(built.ok, built.ok ? "" : built.message);
    return built.file.entries.length;
  };
  assert.equal(await pick({ reveal: "1" }), 5);
  const partId = Buffer.from(sealId(signedSealCertificate.decode(part.certificate).fields)).toString("hex");
  assert.equal(await pick({ reveal: "1", sealId: partId }), 3);
  assert.equal(await pick({ all: true, sealId: partId }), 3, "all with a named seal means all that seal covers");

  // A corrupt stored seal is named, wherever it sits and however the seal is chosen.
  assert.equal(await faultFor([{} as SealRecordOnWire], { all: true }), "stored_seal_unreadable");
  assert.equal(await faultFor([whole, {} as SealRecordOnWire], { all: true }), "stored_seal_unreadable");
  assert.equal(await faultFor([{} as SealRecordOnWire], { all: true, sealId: partId }), "stored_seal_unreadable");

  // A record that can't back up its seal is refused rather than exported.
  assert.equal(await faultFor([whole], { all: true, salt: null }), "salt_missing");
  const gap = await buildTranscript(request({ ...chain, held: chain.held.filter((row) => row.position !== 2) }, [whole], { reveal: "1" }));
  assert.deepEqual(gap.ok ? null : gap.fault, "record_incomplete");
  const noAck = await buildTranscript(request({ ...chain, held: chain.held.map((row) => (row.position === 2 ? { ...row, ack: null } : row)) }, [whole], { reveal: "1" }));
  assert.deepEqual(noAck.ok ? null : noAck.fault, "record_incomplete");
  const wrongSalt = await buildTranscript(request(chain, [whole], { all: true, salt: new Uint8Array(32).fill(1) }));
  assert.deepEqual(wrongSalt.ok ? null : wrongSalt.fault, "export_failed_own_check");
});

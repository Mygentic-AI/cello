// The chain check is the product's core claim, and a hole in it would pass every honest conversation.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { type WitnessedEntry, verifyTranscript } from "../src/protocol/chain.ts";
import { ZERO_HASH, toHex } from "../src/protocol/encode.ts";
import { type Signer, generateIdentitySeeds, signerFromSeeds } from "../src/protocol/identity.ts";
import { EMPTY_ROOT, RunningMerkle, leafHash, nodeHash } from "../src/protocol/merkle.ts";
import { type EntryFields, EntryKind, EntryMode, ackBytes, entryBytes, entryHash } from "../src/protocol/structures.ts";

const hashOf = (label: string): Uint8Array => new Uint8Array(createHash("sha256").update(label).digest());

// RFC 6962 section 2.1, written the slow way to check the fast one.
function slowRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return EMPTY_ROOT;
  if (leaves.length === 1) return leaves[0] as Uint8Array;
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return nodeHash(slowRoot(leaves.slice(0, k)), slowRoot(leaves.slice(k)));
}

test("the running root matches RFC 6962 at every size, and survives being stored", () => {
  let merkle = new RunningMerkle();
  const leaves: Uint8Array[] = [];
  assert.equal(toHex(merkle.root()), toHex(EMPTY_ROOT));
  for (let i = 0; i < 70; i++) {
    const entry = hashOf(`entry ${i}`);
    leaves.push(leafHash(entry));
    const root = merkle.append(entry);
    assert.equal(toHex(root), toHex(slowRoot(leaves)), `size ${i + 1}`);
    merkle = RunningMerkle.fromBytes(merkle.size, merkle.toBytes());
    assert.equal(toHex(merkle.root()), toHex(root));
  }
});

interface Fixture { sessionId: Uint8Array; alice: Signer; bob: Signer; server: Signer; items: WitnessedEntry[] }

async function buildConversation(): Promise<Fixture> {
  const [alice, bob, server] = await Promise.all([1, 2, 3].map(() => signerFromSeeds(generateIdentitySeeds()))) as [Signer, Signer, Signer];
  const sessionId = new Uint8Array(randomBytes(16));
  const merkle = new RunningMerkle();
  const roots = [EMPTY_ROOT];
  const heads = new Map<string, { seq: number; hash: Uint8Array }>();
  const items: WitnessedEntry[] = [];
  for (const [i, author] of [alice, bob, alice, alice, bob].entries()) {
    const head = heads.get(toHex(author.id));
    const fields: EntryFields = {
      sessionId,
      authorId: author.id,
      authorSeq: (head?.seq ?? 0) + 1,
      prevOwnHash: head?.hash ?? ZERO_HASH,
      readPosition: i,
      readRoot: roots[i] as Uint8Array,
      kind: i === 4 ? EntryKind.close : EntryKind.message,
      mode: EntryMode.reply,
      contentHash: hashOf(`content ${i}`),
      ciphertextHash: hashOf(`ciphertext ${i}`),
      notAfter: 2_000_000_000_000,
    };
    const hash = entryHash(fields);
    const root = merkle.append(hash);
    roots.push(root);
    heads.set(toHex(author.id), { seq: fields.authorSeq, hash });
    const ack = { serverId: server.id, sessionId, position: i + 1, entryHash: hash, root, time: 1_000 + i };
    items.push({
      fields,
      signature: await author.sign("cello-v2-entry", entryBytes(fields)),
      ack,
      ackSignature: await server.sign("cello-v2-ack", ackBytes(ack)),
    });
  }
  return { sessionId, alice, bob, server, items };
}

const fixture = await buildConversation();
const parties = { sessionId: fixture.sessionId, server: fixture.server.publicIdentity, participants: [fixture.alice.publicIdentity, fixture.bob.publicIdentity] };

test("an untouched conversation checks out", async () => {
  const report = await verifyTranscript(parties, fixture.items);
  assert.deepEqual([report.ok, report.position, report.fault], [true, 5, undefined]);
});

// Re-signs what a tamperer could re-sign, so each case reaches the check it is aimed at.
async function resignAsServer(item: WitnessedEntry): Promise<WitnessedEntry> {
  return { ...item, ackSignature: await fixture.server.sign("cello-v2-ack", ackBytes(item.ack)) };
}

async function faultWhen(change: (items: WitnessedEntry[]) => Promise<void> | void): Promise<string | undefined> {
  const items = fixture.items.map((item) => ({ ...item }));
  await change(items);
  return (await verifyTranscript(parties, items)).fault;
}

test("each tampering is caught, and named", async () => {
  const at = (items: WitnessedEntry[], i: number): WitnessedEntry => items[i] as WitnessedEntry;

  assert.equal(await faultWhen((x) => { const i = at(x, 2); x[2] = { ...i, fields: { ...i.fields, contentHash: new Uint8Array(5) } }; }), "malformed_entry");
  assert.equal(await faultWhen((x) => { const i = at(x, 2); x[2] = { ...i, ack: { ...i.ack, position: -1 } }; }), "malformed_entry");
  assert.equal(await faultWhen((x) => { x.splice(1, 1); }), "bad_position");
  assert.equal(await faultWhen((x) => { const a = at(x, 1); x[1] = at(x, 2); x[2] = a; }), "bad_position");

  // The server changes a message's text hash and re-signs its ack over the new hash. Only the author's signature can catch that.
  assert.equal(await faultWhen(async (x) => {
    const item = at(x, 0);
    const fields = { ...item.fields, contentHash: hashOf("other words") };
    const merkle = new RunningMerkle();
    const ack = { ...item.ack, entryHash: entryHash(fields), root: merkle.append(entryHash(fields)) };
    x[0] = await resignAsServer({ ...item, fields, ack });
  }), "bad_entry_signature");

  // The server forges a message from Bob, signing with its own key.
  assert.equal(await faultWhen(async (x) => {
    const item = at(x, 1);
    x[1] = { ...item, signature: await fixture.server.sign("cello-v2-entry", entryBytes(item.fields)) };
  }), "bad_entry_signature");

  // An outsider's entry.
  assert.equal(await faultWhen(async (x) => {
    const item = at(x, 0);
    x[0] = { ...item, fields: { ...item.fields, authorId: fixture.server.id } };
  }), "not_participant");

  assert.equal(await faultWhen((x) => { const i = at(x, 2); x[2] = { ...i, ack: { ...i.ack, entryHash: hashOf("another entry") } }; }), "ack_wrong_entry");
  assert.equal(await faultWhen((x) => { const i = at(x, 0); x[0] = { ...i, ack: { ...i.ack, root: hashOf("another root") } }; }), "ack_wrong_root");
  assert.equal(await faultWhen((x) => { const i = at(x, 0); x[0] = { ...i, ack: { ...i.ack, time: 9 } }; }), "bad_ack_signature");
  assert.equal(await faultWhen((x) => { const i = at(x, 0); x[0] = { ...i, ack: { ...i.ack, sessionId: new Uint8Array(16) } }; }), "ack_wrong_session");
  assert.equal(await faultWhen((x) => { const i = at(x, 0); x[0] = { ...i, ack: { ...i.ack, serverId: fixture.alice.id } }; }), "ack_wrong_server");
  assert.equal(await faultWhen((x) => { const i = at(x, 0); x[0] = { ...i, fields: { ...i.fields, sessionId: new Uint8Array(16) } }; }), "wrong_session");
});

test("an author can't skip or fork their own chain, or claim to have read what doesn't exist", async () => {
  const at = (items: WitnessedEntry[], i: number): WitnessedEntry => items[i] as WitnessedEntry;
  const rebuilt = async (i: number, change: Partial<EntryFields>, x: WitnessedEntry[]) => {
    const item = at(x, i);
    const fields = { ...item.fields, ...change };
    const author = toHex(fields.authorId) === toHex(fixture.alice.id) ? fixture.alice : fixture.bob;
    x[i] = { ...item, fields, signature: await author.sign("cello-v2-entry", entryBytes(fields)), ack: { ...item.ack, entryHash: entryHash(fields) } };
  };
  assert.equal(await faultWhen((x) => rebuilt(2, { authorSeq: 3 }, x)), "bad_author_seq");
  assert.equal(await faultWhen((x) => rebuilt(2, { prevOwnHash: hashOf("a fork") }, x)), "bad_author_chain");
  assert.equal(await faultWhen((x) => rebuilt(2, { readPosition: 3 }, x)), "read_beyond_tip");
  assert.equal(await faultWhen((x) => rebuilt(2, { readRoot: hashOf("not what was read") }, x)), "bad_read_root");
});

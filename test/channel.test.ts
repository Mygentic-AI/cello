// A forged post or a swapped member key looks fine against an honest server, so these lie on purpose.
import assert from "node:assert/strict";
import { x25519 } from "@noble/curves/ed25519.js";
import { test } from "node:test";
import {
  type OpenKeys,
  type RosterMemberFile,
  channelPostCodec,
  checkPost,
  hashBlob,
  inRoster,
  namedToPost,
  openKeyEntry,
  openSealed,
  readKeyEntry,
  readRecord,
  readRoster,
  rosterFollows,
  sealKeyEntry,
  sealTo,
  signMemberKey,
  signRecord,
  signRoster,
} from "../src/protocol/channel.ts";
import { type Signer, generateIdentitySeeds, signerFromSeeds } from "../src/protocol/identity.ts";
import { mlKemGenerateSeed, mlKemKeypairFromSeed } from "../src/protocol/ml-kem.ts";
import { ChannelPosting, ChannelVisibility, type ChannelInfoFields, type ChannelPostFields, channelMemberKeyBytes, channelPostBytes } from "../src/protocol/structures.ts";
import { channelMemberKeyCodec } from "../src/protocol/channel.ts";
import { identityCodec, signatureCodec, toB64 } from "../src/protocol/wire.ts";

const ENC = new TextEncoder();
const newSigner = (): Promise<Signer> => signerFromSeeds(generateIdentitySeeds());

async function memberKeys(): Promise<OpenKeys> {
  const x25519Secret = x25519.utils.randomSecretKey();
  const mlKemSeed = mlKemGenerateSeed();
  return { x25519Secret, mlKemSeed, x25519Public: x25519.getPublicKey(x25519Secret), mlKemPublic: (await mlKemKeypairFromSeed(mlKemSeed)).publicKey };
}

async function makePost(signer: Signer, channel: Uint8Array, seq: number, over: Partial<ChannelPostFields> = {}): Promise<Record<string, unknown>> {
  const title = ENC.encode("title");
  const body = ENC.encode("Approved");
  const fields: ChannelPostFields = { channelId: channel, generation: 1, authorId: signer.id, authorSeq: seq, publishedAt: 1000, titleHash: hashBlob(title), bodyHash: hashBlob(body), ...over };
  const signature = await signer.sign("cello-channel-post", channelPostBytes(fields));
  return { post: channelPostCodec.encode({ fields, signature }), title: toB64(title), body: toB64(body) };
}

test("a record proves itself: another channel's id or someone else's signature is refused", async () => {
  const channel = await newSigner();
  const admin = await newSigner();
  const file = await signRecord(channel, admin, ChannelVisibility.public);
  assert.ok(await readRecord(file, channel.id));
  assert.equal(await readRecord(file, (await newSigner()).id), null, "another channel's id");
  const stranger = await newSigner();
  assert.equal(await readRecord({ ...file, adminSignature: signatureCodec.encode(await stranger.sign("cello-channel-record", new Uint8Array(1))) }, channel.id), null, "someone else's signature");
  assert.equal(await readRecord({ ...file, admin: identityCodec.encode(stranger.publicIdentity) }, channel.id), null, "someone else claiming to be its admin");
});

test("a post's signature covers its channel, generation and number, and its author's identity", async () => {
  const channel = await newSigner();
  const author = await newSigner();
  const good = await makePost(author, channel.id, 3);
  assert.equal(typeof await checkPost(good, author.publicIdentity, channel.id), "object");
  const stranger = await newSigner();
  assert.equal(await checkPost(good, stranger.publicIdentity, channel.id), "bad_signature", "another identity");
  assert.equal(await checkPost(await makePost(stranger, channel.id, 3, { authorId: author.id }), author.publicIdentity, channel.id), "bad_signature", "signed by someone else");
  assert.equal(await checkPost(good, author.publicIdentity, (await newSigner()).id), "bad_post", "another channel");
  assert.equal(await checkPost({ ...good, body: toB64(ENC.encode("Refused")) }, author.publicIdentity, channel.id), "bad_post", "a different body");
  for (const change of [{ authorSeq: 9 }, { generation: 2 }, { publishedAt: 5000 }] as Partial<ChannelPostFields>[]) {
    const signed = channelPostCodec.decode(good["post"]);
    const moved = { ...good, post: channelPostCodec.encode({ fields: { ...signed.fields, ...change }, signature: signed.signature }) };
    assert.equal(await checkPost(moved, author.publicIdentity, channel.id), "bad_signature", JSON.stringify(Object.keys(change)));
  }
});

test("the signed settings say who may post", () => {
  const admin = new Uint8Array(32).fill(1);
  const named = new Uint8Array(32).fill(2);
  const other = new Uint8Array(32).fill(3);
  const info = (posting: number): ChannelInfoFields => ({ channelId: admin, revision: 1, posting, retentionMs: 1, generation: 1, x25519Public: new Uint8Array(32), mlKemPublic: new Uint8Array(1184), posters: named, name: ENC.encode("c") });
  assert.deepEqual([admin, named, other].map((id) => namedToPost(info(ChannelPosting.admin), admin, id)), [true, false, false]);
  assert.deepEqual([admin, named, other].map((id) => namedToPost(info(ChannelPosting.posters), admin, id)), [true, true, false]);
  assert.deepEqual([admin, named, other].map((id) => namedToPost(info(ChannelPosting.members), admin, id)), [true, true, true]);
});

test("the roster keeps a server out: a swapped member key, an added member or a replayed roster all show", async () => {
  const channel = await newSigner();
  const alice = await newSigner();
  const mallory = await newSigner();
  const aliceKeys = await memberKeys();
  const malloryKeys = await memberKeys();
  const honest = await signMemberKey(alice, channel.id, aliceKeys, 1);
  const first = await signRoster(channel, null, 1, [honest]);
  const checked = await readRoster(first, channel.publicIdentity);
  assert.ok(checked);
  assert.equal(rosterFollows(null, checked), true);
  assert.ok(inRoster(checked, alice.id));

  // Alice's identity with Mallory's key, signed by Mallory: what it would take to be handed the group key.
  const fields = { channelId: channel.id, agentId: alice.id, x25519Public: malloryKeys.x25519Public, mlKemPublic: malloryKeys.mlKemPublic, requestedAt: 1 };
  const swapped: RosterMemberFile = { identity: identityCodec.encode(alice.publicIdentity), memberKey: channelMemberKeyCodec.encode({ fields, signature: await mallory.sign("cello-channel-member-key", channelMemberKeyBytes(fields)) }) };
  assert.equal(await readRoster(await signRoster(channel, null, 1, [swapped]), channel.publicIdentity), null, "a member key its member didn't sign");
  assert.equal(await readRoster({ ...first, members: [swapped] }, channel.publicIdentity), null, "members changed under the channel key's signature");
  assert.equal(await readRoster({ ...first, members: [honest, await signMemberKey(mallory, channel.id, malloryKeys, 1)] }, channel.publicIdentity), null, "a member added under the signature");
  assert.equal(await readRoster(await signRoster(mallory, null, 1, [honest]), channel.publicIdentity), null, "a roster the channel key didn't sign");
  assert.equal(await readRoster(await signRoster(channel, null, 1, [await signMemberKey(alice, (await newSigner()).id, aliceKeys, 1)]), channel.publicIdentity), null, "a member key signed for another channel");

  // Key order must not matter: the database reorders stored JSON.
  const reordered = JSON.parse(JSON.stringify({ members: first.members.map((m) => ({ memberKey: { signature: m.memberKey.signature, bytes: m.memberKey.bytes }, identity: m.identity })), roster: first.roster })) as unknown;
  assert.ok(await readRoster(reordered, channel.publicIdentity), "the same roster with its JSON keys reordered");

  const second = await readRoster(await signRoster(channel, { revision: checked.fields.revision, hash: checked.hash }, 1, []), channel.publicIdentity);
  assert.ok(second);
  assert.equal(rosterFollows(checked, second), true, "the next roster follows");
  assert.equal(rosterFollows(second, checked), false, "the older roster replayed");
  const skipped = await readRoster(await signRoster(channel, { revision: 7, hash: checked.hash }, 1, []), channel.publicIdentity);
  assert.ok(skipped);
  assert.equal(rosterFollows(checked, skipped), false, "a skipped revision");
});

test("a group key opens only for its member and generation, and only if the channel key signed it", async () => {
  const channel = await newSigner();
  const alice = await newSigner();
  const bob = await newSigner();
  const aliceKeys = await memberKeys();
  const roster = await readRoster(await signRoster(channel, null, 1, [await signMemberKey(alice, channel.id, aliceKeys, 1)]), channel.publicIdentity);
  assert.ok(roster);
  const member = inRoster(roster, alice.id);
  assert.ok(member);
  const groupKey = new Uint8Array(32).fill(7);
  const entry = await sealKeyEntry(channel, roster, member, 4, groupKey);
  assert.deepEqual(await openKeyEntry(entry, channel.publicIdentity, alice.id, aliceKeys, 4), groupKey);
  assert.equal(await openKeyEntry(entry, channel.publicIdentity, alice.id, aliceKeys, 5), null, "another generation");
  assert.equal(await openKeyEntry(entry, channel.publicIdentity, bob.id, aliceKeys, 4), null, "someone else's entry");
  assert.equal(await openKeyEntry(entry, channel.publicIdentity, alice.id, await memberKeys(), 4), null, "the wrong keys");

  // A server can seal to Alice's public key too. Without the channel key's signature she refuses it, so she can't be tricked into posting under a key it knows.
  const server = await newSigner();
  const forged = await sealKeyEntry(server, roster, member, 4, new Uint8Array(32).fill(9));
  assert.equal(await readKeyEntry(forged, channel.publicIdentity), null);
  assert.equal(await openKeyEntry(forged, channel.publicIdentity, alice.id, aliceKeys, 4), null);
  assert.equal(await readKeyEntry({ ...entry, sealed: await sealTo(aliceKeys, new Uint8Array(32).fill(9)) }, channel.publicIdentity), null, "a sealed key swapped under the signature");
});

test("sealing opens only with the keys it was sealed to", async () => {
  const keys = await memberKeys();
  const sealed = await sealTo(keys, ENC.encode("a join request"));
  assert.equal(new TextDecoder().decode(await openSealed(keys, sealed) ?? new Uint8Array()), "a join request");
  assert.equal(await openSealed(await memberKeys(), sealed), null);
  assert.equal(await openSealed(keys, "not sealed"), null);
});

// What a channel's signed things hold, and how anyone checks them with keys they already have.
// The server and every reader run these same checks, because a reader doesn't trust the server with a member list or a key.
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { openSessionContent, sealSessionContent } from "./aead.ts";
import { HASH_BYTES, ZERO_HASH, encodeFields, equalBytes } from "./encode.ts";
import { type DualSignature, type PublicIdentity, type Signer, identityId, verifySignature } from "./identity.ts";
import { deriveSessionSecrets } from "./key-agreement.ts";
import { mlKemDecapsulate, mlKemEncapsulate } from "./ml-kem.ts";
import {
  ChannelPosting,
  ChannelVisibility,
  type ChannelInfoFields,
  type ChannelKeyEntryFields,
  type ChannelMemberKeyFields,
  type ChannelPostAckFields,
  type ChannelPostFields,
  type ChannelRecordFields,
  type ChannelRosterFields,
  type ChannelStateFields,
  channelInfoBytes,
  channelKeyEntryBytes,
  channelMemberKeyBytes,
  channelPostAckBytes,
  channelPostBytes,
  channelRecordBytes,
  channelRosterBytes,
  channelStateBytes,
} from "./structures.ts";
import { type WireSigned, codec, fromB64, identityCodec, signatureCodec, signedCodec, toB64 } from "./wire.ts";

const ENC = new TextEncoder();

export const channelRecordCodec = codec<ChannelRecordFields>({ channelId: "bytes", adminId: "bytes", visibility: "int" });
export const channelInfoCodec = signedCodec(codec<ChannelInfoFields>({
  channelId: "bytes", revision: "int", posting: "int", retentionMs: "int", generation: "int", x25519Public: "bytes", mlKemPublic: "bytes", posters: "bytes", name: "bytes",
}));
export const channelPostCodec = signedCodec(codec<ChannelPostFields>({ channelId: "bytes", generation: "int", authorId: "bytes", authorSeq: "int", publishedAt: "int", titleHash: "bytes", bodyHash: "bytes" }));
export const channelPostAckCodec = signedCodec(codec<ChannelPostAckFields>({ serverId: "bytes", channelId: "bytes", position: "int", postHash: "bytes", time: "int" }));
export const channelStateCodec = signedCodec(codec<ChannelStateFields>({ serverId: "bytes", channelId: "bytes", firstHeld: "int", tip: "int", time: "int" }));
export const channelMemberKeyCodec = signedCodec(codec<ChannelMemberKeyFields>({ channelId: "bytes", agentId: "bytes", x25519Public: "bytes", mlKemPublic: "bytes", requestedAt: "int" }));
export const channelRosterCodec = signedCodec(codec<ChannelRosterFields>({ channelId: "bytes", revision: "int", generation: "int", prevHash: "bytes", membersHash: "bytes" }));
export const channelKeyEntryCodec = signedCodec(codec<ChannelKeyEntryFields>({ channelId: "bytes", generation: "int", memberId: "bytes", rosterHash: "bytes", sealedHash: "bytes" }));

function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[name];
}

// Bad input from the other side is a refusal, not a crash: every read below answers null for it.
function tryRead<T>(work: () => T): T | null {
  try {
    return work();
  } catch {
    return null;
  }
}

export function hashBlob(blob: Uint8Array): Uint8Array {
  return sha256(blob);
}

export function postHash(fields: ChannelPostFields): Uint8Array {
  return sha256(channelPostBytes(fields));
}

export interface ChannelRecordFile {
  fields: Record<string, string | number>;
  channel: Record<string, string | number>;
  admin: Record<string, string | number>;
  channelSignature: Record<string, string | number>;
  adminSignature: Record<string, string | number>;
}

export interface ChannelRecord {
  fields: ChannelRecordFields;
  channel: PublicIdentity;
  admin: PublicIdentity;
}

export async function signRecord(channel: Signer, admin: Signer, visibility: number): Promise<ChannelRecordFile> {
  const fields: ChannelRecordFields = { channelId: channel.id, adminId: admin.id, visibility };
  const bytes = channelRecordBytes(fields);
  return {
    fields: channelRecordCodec.encode(fields),
    channel: identityCodec.encode(channel.publicIdentity),
    admin: identityCodec.encode(admin.publicIdentity),
    channelSignature: signatureCodec.encode(await channel.sign("cello-v2-channel-record", bytes)),
    adminSignature: signatureCodec.encode(await admin.sign("cello-v2-channel-record", bytes)),
  };
}

// Self-certifying: a channel's id is the hash of the key that signed this, so whoever served it can't have changed it.
export async function readRecord(raw: unknown, expectedChannelId?: Uint8Array): Promise<ChannelRecord | null> {
  const parsed = tryRead(() => ({
    fields: channelRecordCodec.decode(field(raw, "fields")),
    channel: identityCodec.decode(field(raw, "channel")),
    admin: identityCodec.decode(field(raw, "admin")),
    channelSignature: signatureCodec.decode(field(raw, "channelSignature")),
    adminSignature: signatureCodec.decode(field(raw, "adminSignature")),
  }));
  if (!parsed) return null;
  if (parsed.fields.visibility !== ChannelVisibility.public && parsed.fields.visibility !== ChannelVisibility.private) return null;
  const bytes = tryRead(() => channelRecordBytes(parsed.fields));
  const ids = tryRead(() => ({ channel: identityId(parsed.channel), admin: identityId(parsed.admin) }));
  if (!bytes || !ids) return null;
  if (!equalBytes(ids.channel, parsed.fields.channelId) || !equalBytes(ids.admin, parsed.fields.adminId)) return null;
  if (expectedChannelId && !equalBytes(parsed.fields.channelId, expectedChannelId)) return null;
  if (!(await verifySignature(parsed.channel, "cello-v2-channel-record", bytes, parsed.channelSignature))) return null;
  if (!(await verifySignature(parsed.admin, "cello-v2-channel-record", bytes, parsed.adminSignature))) return null;
  return { fields: parsed.fields, channel: parsed.channel, admin: parsed.admin };
}

export async function signInfo(channel: Signer, fields: ChannelInfoFields): Promise<WireSigned> {
  return channelInfoCodec.encode({ fields, signature: await channel.sign("cello-v2-channel-info", channelInfoBytes(fields)) });
}

export async function readInfo(raw: unknown, record: ChannelRecord): Promise<ChannelInfoFields | null> {
  const signed = tryRead(() => channelInfoCodec.decode(raw));
  if (!signed || !equalBytes(signed.fields.channelId, record.fields.channelId)) return null;
  if (!(Object.values(ChannelPosting) as number[]).includes(signed.fields.posting)) return null;
  if (signed.fields.retentionMs < 1 || signed.fields.generation < 1) return null;
  const bytes = tryRead(() => channelInfoBytes(signed.fields));
  if (!bytes || !(await verifySignature(record.channel, "cello-v2-channel-info", bytes, signed.signature))) return null;
  return signed.fields;
}

export function idsIn(list: Uint8Array): Uint8Array[] {
  const ids: Uint8Array[] = [];
  for (let at = 0; at + HASH_BYTES <= list.length; at += HASH_BYTES) ids.push(list.subarray(at, at + HASH_BYTES));
  return ids;
}

export function includesId(list: Uint8Array, id: Uint8Array): boolean {
  return idsIn(list).some((held) => equalBytes(held, id));
}

// Who the channel's own signed settings let post. Being a member is a separate check, which only the caller can make.
export function namedToPost(info: ChannelInfoFields, adminId: Uint8Array, authorId: Uint8Array): boolean {
  if (equalBytes(adminId, authorId)) return true;
  if (info.posting === ChannelPosting.posters) return includesId(info.posters, authorId);
  return info.posting === ChannelPosting.members;
}

export interface PostOnWire {
  post: WireSigned;
  title: string;
  body: string;
}

export interface CheckedPost {
  fields: ChannelPostFields;
  signature: DualSignature;
  title: Uint8Array;
  body: Uint8Array;
}

export type PostFault = "bad_post" | "bad_signature";

// The author's own signature, and that these are the title and body it signed. Rights and size are the server's next check.
export async function checkPost(raw: unknown, author: PublicIdentity, channelId: Uint8Array): Promise<CheckedPost | PostFault> {
  const parsed = tryRead(() => {
    const signed = channelPostCodec.decode(field(raw, "post"));
    return { signed, title: fromB64(field(raw, "title"), "title"), body: fromB64(field(raw, "body"), "body") };
  });
  if (!parsed) return "bad_post";
  const { fields, signature } = parsed.signed;
  if (!equalBytes(fields.channelId, channelId) || fields.authorSeq < 1 || fields.generation < 1) return "bad_post";
  if (!equalBytes(hashBlob(parsed.title), fields.titleHash) || !equalBytes(hashBlob(parsed.body), fields.bodyHash)) return "bad_post";
  const authorId = tryRead(() => identityId(author));
  if (!authorId || !equalBytes(authorId, fields.authorId)) return "bad_signature";
  const bytes = tryRead(() => channelPostBytes(fields));
  if (!bytes || !(await verifySignature(author, "cello-v2-channel-post", bytes, signature))) return "bad_signature";
  return { fields, signature, title: parsed.title, body: parsed.body };
}

export async function readPostAck(raw: unknown, server: PublicIdentity, channelId: Uint8Array): Promise<ChannelPostAckFields | null> {
  const signed = tryRead(() => channelPostAckCodec.decode(raw));
  if (!signed || !equalBytes(signed.fields.channelId, channelId)) return null;
  const serverId = tryRead(() => identityId(server));
  const bytes = tryRead(() => channelPostAckBytes(signed.fields));
  if (!serverId || !bytes || !equalBytes(serverId, signed.fields.serverId)) return null;
  return await verifySignature(server, "cello-v2-channel-post-ack", bytes, signed.signature) ? signed.fields : null;
}

export async function readState(raw: unknown, server: PublicIdentity, channelId: Uint8Array): Promise<ChannelStateFields | null> {
  const signed = tryRead(() => channelStateCodec.decode(raw));
  if (!signed || !equalBytes(signed.fields.channelId, channelId)) return null;
  const serverId = tryRead(() => identityId(server));
  const bytes = tryRead(() => channelStateBytes(signed.fields));
  if (!serverId || !bytes || !equalBytes(serverId, signed.fields.serverId) || signed.fields.firstHeld < 1) return null;
  return await verifySignature(server, "cello-v2-channel-state", bytes, signed.signature) ? signed.fields : null;
}

// One member as the roster lists them: their identity, and the member key they signed for themselves.
export interface RosterMemberFile {
  identity: Record<string, string | number>;
  memberKey: WireSigned;
}

export interface RosterFile {
  roster: WireSigned;
  members: RosterMemberFile[];
}

export interface SealKeys { x25519Public: Uint8Array; mlKemPublic: Uint8Array }
export interface OpenKeys extends SealKeys { x25519Secret: Uint8Array; mlKemSeed: Uint8Array }

export interface RosterMember { agentId: Uint8Array; keys: SealKeys }

export interface CheckedRoster {
  fields: ChannelRosterFields;
  hash: Uint8Array;
  members: RosterMember[];
}

// Over the fields rather than their JSON, because a database is free to reorder a JSON object's keys.
function membersHash(members: readonly RosterMemberFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const member of members) {
    const identity = identityCodec.decode(member.identity);
    const signed = channelMemberKeyCodec.decode(member.memberKey);
    parts.push(identity.ed, identity.pq, channelMemberKeyBytes(signed.fields), signed.signature.ed, signed.signature.pq);
  }
  return sha256(encodeFields(parts));
}

export async function signMemberKey(member: Signer, channelId: Uint8Array, keys: SealKeys, requestedAt: number): Promise<RosterMemberFile> {
  const fields: ChannelMemberKeyFields = { channelId, agentId: member.id, x25519Public: keys.x25519Public, mlKemPublic: keys.mlKemPublic, requestedAt };
  return {
    identity: identityCodec.encode(member.publicIdentity),
    memberKey: channelMemberKeyCodec.encode({ fields, signature: await member.sign("cello-v2-channel-member-key", channelMemberKeyBytes(fields)) }),
  };
}

// Null unless the identity signed this member key, for this channel, itself.
export async function readMemberKey(raw: unknown, channelId: Uint8Array): Promise<{ agentId: Uint8Array; keys: SealKeys; requestedAt: number } | null> {
  const identity = tryRead(() => identityCodec.decode(field(raw, "identity")));
  const signed = tryRead(() => channelMemberKeyCodec.decode(field(raw, "memberKey")));
  if (!identity || !signed) return null;
  const agentId = tryRead(() => identityId(identity));
  const bytes = tryRead(() => channelMemberKeyBytes(signed.fields));
  if (!agentId || !bytes) return null;
  if (!equalBytes(agentId, signed.fields.agentId) || !equalBytes(signed.fields.channelId, channelId)) return null;
  if (!(await verifySignature(identity, "cello-v2-channel-member-key", bytes, signed.signature))) return null;
  return { agentId, keys: { x25519Public: signed.fields.x25519Public, mlKemPublic: signed.fields.mlKemPublic }, requestedAt: signed.fields.requestedAt };
}

// Chained to the roster before it, or to nothing for the first.
export async function signRoster(channel: Signer, previous: { revision: number; hash: Uint8Array } | null, generation: number, members: RosterMemberFile[]): Promise<RosterFile> {
  const fields: ChannelRosterFields = { channelId: channel.id, revision: (previous?.revision ?? 0) + 1, generation, prevHash: previous?.hash ?? ZERO_HASH, membersHash: membersHash(members) };
  return { roster: channelRosterCodec.encode({ fields, signature: await channel.sign("cello-v2-channel-roster", channelRosterBytes(fields)) }), members };
}

// Checks the channel key's signature, and that each listed member signed their own key. Null for anything else.
export async function readRoster(raw: unknown, channel: PublicIdentity): Promise<CheckedRoster | null> {
  const signed = tryRead(() => channelRosterCodec.decode(field(raw, "roster")));
  const list = field(raw, "members");
  if (!signed || !Array.isArray(list)) return null;
  const channelId = tryRead(() => identityId(channel));
  if (!channelId || !equalBytes(signed.fields.channelId, channelId)) return null;
  const bytes = tryRead(() => channelRosterBytes(signed.fields));
  if (!bytes || !(await verifySignature(channel, "cello-v2-channel-roster", bytes, signed.signature))) return null;
  const hashed = tryRead(() => membersHash(list as RosterMemberFile[]));
  if (!hashed || !equalBytes(hashed, signed.fields.membersHash)) return null;
  const members: RosterMember[] = [];
  for (const entry of list as unknown[]) {
    const checked = await readMemberKey(entry, channelId);
    if (!checked) return null;
    members.push({ agentId: checked.agentId, keys: checked.keys });
  }
  return { fields: signed.fields, hash: sha256(bytes), members };
}

export function rosterFollows(previous: { fields: ChannelRosterFields; hash: Uint8Array } | null, next: { fields: ChannelRosterFields }): boolean {
  if (!previous) return next.fields.revision === 1 && equalBytes(next.fields.prevHash, ZERO_HASH);
  return next.fields.revision === previous.fields.revision + 1 && equalBytes(next.fields.prevHash, previous.hash) && next.fields.generation >= previous.fields.generation;
}

export function inRoster(roster: { members: readonly RosterMember[] }, agentId: Uint8Array): RosterMember | undefined {
  return roster.members.find((member) => equalBytes(member.agentId, agentId));
}

export interface KeyEntryFile { entry: WireSigned; sealed: string }

const SEAL_DOMAIN = ENC.encode("cello-v2/channel-seal");

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Both key agreements, as in a session, so post-quantum protection covers group keys and join requests too.
export async function sealTo(to: SealKeys, plaintext: Uint8Array): Promise<string> {
  const ephemeral = x25519.utils.randomSecretKey();
  const { ciphertext, sharedSecret } = await mlKemEncapsulate(to.mlKemPublic);
  const { contentKey } = deriveSessionSecrets({
    ownEphemeralSecret: ephemeral,
    peerEphemeralPublic: to.x25519Public,
    sessionId: SEAL_DOMAIN,
    extraSharedSecret: sharedSecret,
    pqTranscript: concat(ciphertext, to.mlKemPublic),
  });
  const box = sealSessionContent(contentKey, plaintext);
  const eph = x25519.getPublicKey(ephemeral);
  contentKey.fill(0);
  ephemeral.fill(0);
  return JSON.stringify({ eph: toB64(eph), kem: toB64(ciphertext), box: toB64(box) });
}

export async function openSealed(keys: OpenKeys, sealed: string): Promise<Uint8Array | null> {
  const parts = tryRead(() => {
    const raw = JSON.parse(sealed) as unknown;
    return { eph: fromB64(field(raw, "eph"), "eph"), kem: fromB64(field(raw, "kem"), "kem"), box: fromB64(field(raw, "box"), "box") };
  });
  if (!parts) return null;
  try {
    const sharedSecret = await mlKemDecapsulate(keys.mlKemSeed, parts.kem);
    const { contentKey } = deriveSessionSecrets({
      ownEphemeralSecret: keys.x25519Secret,
      peerEphemeralPublic: parts.eph,
      sessionId: SEAL_DOMAIN,
      extraSharedSecret: sharedSecret,
      pqTranscript: concat(parts.kem, keys.mlKemPublic),
    });
    return openSessionContent(contentKey, parts.box);
  } catch {
    return null;
  }
}

// The only way a group key gets sealed: to a member of a roster that has passed readRoster.
export async function sealKeyEntry(channel: Signer, roster: CheckedRoster, member: RosterMember, generation: number, groupKey: Uint8Array): Promise<KeyEntryFile> {
  const sealed = await sealTo(member.keys, ENC.encode(JSON.stringify({ generation, key: toB64(groupKey) })));
  const fields: ChannelKeyEntryFields = { channelId: channel.id, generation, memberId: member.agentId, rosterHash: roster.hash, sealedHash: sha256(ENC.encode(sealed)) };
  return { entry: channelKeyEntryCodec.encode({ fields, signature: await channel.sign("cello-v2-channel-key-entry", channelKeyEntryBytes(fields)) }), sealed };
}

// What the server needs to see of an entry to file it, with no key to open it. Null if the channel key didn't sign it.
export async function readKeyEntry(raw: unknown, channel: PublicIdentity): Promise<{ fields: ChannelKeyEntryFields; sealed: string } | null> {
  const signed = tryRead(() => channelKeyEntryCodec.decode(field(raw, "entry")));
  const sealed = field(raw, "sealed");
  if (!signed || typeof sealed !== "string") return null;
  const channelId = tryRead(() => identityId(channel));
  if (!channelId || !equalBytes(signed.fields.channelId, channelId)) return null;
  if (!equalBytes(signed.fields.sealedHash, sha256(ENC.encode(sealed)))) return null;
  const bytes = tryRead(() => channelKeyEntryBytes(signed.fields));
  if (!bytes || !(await verifySignature(channel, "cello-v2-channel-key-entry", bytes, signed.signature))) return null;
  return { fields: signed.fields, sealed };
}

// Null unless the channel key signed this for this member and generation, and it opens with this member's key.
export async function openKeyEntry(raw: unknown, channel: PublicIdentity, memberId: Uint8Array, keys: OpenKeys, generation: number): Promise<Uint8Array | null> {
  const entry = await readKeyEntry(raw, channel);
  if (!entry || !equalBytes(entry.fields.memberId, memberId) || entry.fields.generation !== generation) return null;
  const opened = await openSealed(keys, entry.sealed);
  if (!opened) return null;
  const value = tryRead(() => JSON.parse(new TextDecoder().decode(opened)) as unknown);
  if (field(value, "generation") !== generation) return null;
  const key = tryRead(() => fromB64(field(value, "key"), "key"));
  return key?.length === 32 ? key : null;
}

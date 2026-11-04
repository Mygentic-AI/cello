// Channels as files: what each file holds, and how anyone checks it with keys they already have.
// The store's gatekeeper and every reader run these same checks, because a reader trusts no store.
import { sha256 } from "@noble/hashes/sha2.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { openSessionContent, sealSessionContent } from "./aead.ts";
import { HASH_BYTES, encodeFields, equalBytes, toHex } from "./encode.ts";
import { type DualSignature, type PublicIdentity, type Signer, identityId, verifySignature } from "./identity.ts";
import { deriveSessionSecrets } from "./key-agreement.ts";
import { mlKemDecapsulate, mlKemEncapsulate } from "./ml-kem.ts";
import {
  ChannelPosting,
  type ChannelAnswerFields,
  type ChannelBundleFields,
  type ChannelHeadFields,
  type ChannelInfoFields,
  type ChannelMemberKeyFields,
  type ChannelPassFields,
  type ChannelPostFields,
  type ChannelRecordFields,
  type ChannelStoreAckFields,
  type ChannelTicketFields,
  channelAnswerBytes,
  channelBundleBytes,
  channelHeadBytes,
  channelInfoBytes,
  channelMemberKeyBytes,
  channelPassBytes,
  channelPostBytes,
  channelRecordBytes,
  channelStoreAckBytes,
  channelTicketBytes,
} from "./structures.ts";
import { type WireSigned, codec, fromB64, identityCodec, signatureCodec, signedCodec, toB64 } from "./wire.ts";

// Decision 3: the body cap.
export const MAX_POST_BODY_BYTES = 256 * 1024;
export const MAX_POST_TITLE_BYTES = 200;
// Decision 4: R is the publisher's own retention, and C is the hard cap after which a store may drop a whole lane.
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const HARD_CAP_MS = 30 * 24 * 60 * 60 * 1000;
export const STORE_QUOTA_BYTES_PER_ADMIN = 1024 * 1024 * 1024;
export const PASS_LEASE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_JOINS = 256;
export const MAX_FUTURE_SKEW_MS = 60_000;
export const POSTS_PER_MINUTE_PER_LANE = 60;
const MAX_SEALED_OVERHEAD = 64;
export const MAX_POST_REQUEST_BYTES = Math.ceil((MAX_POST_BODY_BYTES + MAX_POST_TITLE_BYTES + 2 * MAX_SEALED_OVERHEAD) * 4 / 3) + 64 * 1024;

const ENC = new TextEncoder();

// Decision 1: the store list lives in the signed record, so a reader needs no directory to tell it where else to look.
export interface StoreEntry { read: string; write: string; ack: string }

export const channelRecordCodec = codec<ChannelRecordFields>({ channelId: "bytes", adminId: "bytes", visibility: "int", stores: "bytes" });
export const channelInfoCodec = signedCodec(codec<ChannelInfoFields>({
  channelId: "bytes", revision: "int", posting: "int", retentionMs: "int", hardCapMs: "int", generation: "int", generationAt: "int", x25519Public: "bytes", mlKemPublic: "bytes", revoked: "bytes", name: "bytes",
}));
export const channelPostCodec = signedCodec(codec<ChannelPostFields>({ channelId: "bytes", cap: "bytes", generation: "int", laneId: "bytes", seq: "int", publishedAt: "int", titleHash: "bytes", bodyHash: "bytes" }));
export const channelHeadCodec = signedCodec(codec<ChannelHeadFields>({ channelId: "bytes", cap: "bytes", generation: "int", laneId: "bytes", floor: "int", lastSeq: "int", signedAt: "int" }));
export const channelPassCodec = signedCodec(codec<ChannelPassFields>({ channelId: "bytes", posterId: "bytes", expiresAt: "int" }));
export const channelBundleCodec = signedCodec(codec<ChannelBundleFields>({ channelId: "bytes", generation: "int", revision: "int", entriesHash: "bytes" }));
export const channelMemberKeyCodec = signedCodec(codec<ChannelMemberKeyFields>({ channelId: "bytes", agentId: "bytes", x25519Public: "bytes", mlKemPublic: "bytes", requestedAt: "int" }));
export const channelAnswerCodec = signedCodec(codec<ChannelAnswerFields>({ channelId: "bytes", slot: "bytes", verdict: "int", answeredAt: "int" }));
export const channelTicketCodec = signedCodec(codec<ChannelTicketFields>({ serverId: "bytes", channelId: "bytes", slot: "bytes", expiresAt: "int" }));
export const channelStoreAckCodec = signedCodec(codec<ChannelStoreAckFields>({ storeId: "bytes", channelId: "bytes", cap: "bytes", laneId: "bytes", seq: "int", postHash: "bytes", time: "int" }));

function domainHash(domain: string, ...parts: Uint8Array[]): Uint8Array {
  return sha256(encodeFields([ENC.encode(domain), ...parts]));
}

// Decision 6: on a private channel, a file's path comes from the group key, so only someone holding the key can find it.
// A new generation means a new key, so an ejected member can't find the new path either.
export function capOf(groupKey: Uint8Array): Uint8Array {
  return domainHash("cello.channel.path.v1", groupKey);
}

export function slotOf(channelId: Uint8Array, agentId: Uint8Array): Uint8Array {
  return domainHash("cello.channel.slot.v1", channelId, agentId);
}

// What a reader names when it asks for a gap, so the server can't tell which private channel it is.
export function tagOf(cap: Uint8Array): Uint8Array {
  return domainHash("cello.channel.tag.v1", cap);
}

export function hashBlob(blob: Uint8Array): Uint8Array {
  return sha256(blob);
}

export function postHash(fields: ChannelPostFields): Uint8Array {
  return sha256(channelPostBytes(fields));
}

// A channel file on disk is JSON. Anything that doesn't parse is treated as if it weren't there, and named by the caller.
export function encodeFile(value: unknown): Uint8Array {
  return ENC.encode(JSON.stringify(value));
}

export function decodeFile(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[name];
}

// A bad file from a store is a refusal, not a crash: every read below returns null for it.
function tryRead<T>(work: () => T): T | null {
  try {
    return work();
  } catch {
    return null;
  }
}

export interface ChannelRecord {
  fields: ChannelRecordFields;
  channel: PublicIdentity;
  admin: PublicIdentity;
  stores: StoreEntry[];
}

export interface ChannelRecordFile {
  fields: Record<string, string | number>;
  channel: Record<string, string | number>;
  admin: Record<string, string | number>;
  channelSignature: Record<string, string | number>;
  adminSignature: Record<string, string | number>;
}

export async function signRecord(channel: Signer, admin: Signer, visibility: number, stores: StoreEntry[]): Promise<ChannelRecordFile> {
  const fields: ChannelRecordFields = { channelId: channel.id, adminId: admin.id, visibility, stores: encodeFile(stores) };
  const bytes = channelRecordBytes(fields);
  return {
    fields: channelRecordCodec.encode(fields),
    channel: identityCodec.encode(channel.publicIdentity),
    admin: identityCodec.encode(admin.publicIdentity),
    channelSignature: signatureCodec.encode(await channel.sign("cello-v2-channel-record", bytes)),
    adminSignature: signatureCodec.encode(await admin.sign("cello-v2-channel-record", bytes)),
  };
}

function isStoreEntry(value: unknown): value is StoreEntry {
  return typeof field(value, "read") === "string" && typeof field(value, "write") === "string" && typeof field(value, "ack") === "string";
}

// Self-certifying: the channel's id is the hash of the key that signed this, so whoever served it can't have changed it.
export async function readRecord(raw: unknown, expectedChannelId?: Uint8Array): Promise<ChannelRecord | null> {
  const parsed = tryRead(() => ({
    fields: channelRecordCodec.decode(field(raw, "fields")),
    channel: identityCodec.decode(field(raw, "channel")),
    admin: identityCodec.decode(field(raw, "admin")),
    channelSignature: signatureCodec.decode(field(raw, "channelSignature")),
    adminSignature: signatureCodec.decode(field(raw, "adminSignature")),
  }));
  if (!parsed) return null;
  const bytes = tryRead(() => channelRecordBytes(parsed.fields));
  const ids = tryRead(() => ({ channel: identityId(parsed.channel), admin: identityId(parsed.admin) }));
  if (!bytes || !ids) return null;
  if (!equalBytes(ids.channel, parsed.fields.channelId) || !equalBytes(ids.admin, parsed.fields.adminId)) return null;
  if (expectedChannelId && !equalBytes(parsed.fields.channelId, expectedChannelId)) return null;
  if (!(await verifySignature(parsed.channel, "cello-v2-channel-record", bytes, parsed.channelSignature))) return null;
  if (!(await verifySignature(parsed.admin, "cello-v2-channel-record", bytes, parsed.adminSignature))) return null;
  const stores = decodeFile(parsed.fields.stores);
  if (!Array.isArray(stores) || stores.length === 0 || !stores.every(isStoreEntry)) return null;
  return { fields: parsed.fields, channel: parsed.channel, admin: parsed.admin, stores };
}

export async function signInfo(channel: Signer, fields: ChannelInfoFields): Promise<WireSigned> {
  return channelInfoCodec.encode({ fields, signature: await channel.sign("cello-v2-channel-info", channelInfoBytes(fields)) });
}

export async function readInfo(raw: unknown, record: ChannelRecord): Promise<ChannelInfoFields | null> {
  const signed = tryRead(() => channelInfoCodec.decode(raw));
  if (!signed || !equalBytes(signed.fields.channelId, record.fields.channelId)) return null;
  const bytes = tryRead(() => channelInfoBytes(signed.fields));
  if (!bytes || !(await verifySignature(record.channel, "cello-v2-channel-info", bytes, signed.signature))) return null;
  return signed.fields;
}

export function isRevoked(info: ChannelInfoFields, agentId: Uint8Array): boolean {
  for (let at = 0; at < info.revoked.length; at += HASH_BYTES) {
    if (equalBytes(info.revoked.subarray(at, at + HASH_BYTES), agentId)) return true;
  }
  return false;
}

export type LaneFault = "not_allowed_to_post" | "bad_pass" | "pass_expired" | "poster_revoked" | "bad_signature";

export interface LaneAttachment {
  author: Record<string, string | number> | null;
  pass: WireSigned | null;
}

// The admin lane is signed by the channel key. A poster's lane is signed by the poster, with the channel key's pass attached.
async function laneIdentity(record: ChannelRecord, info: ChannelInfoFields, laneId: Uint8Array, attached: LaneAttachment, at: number): Promise<PublicIdentity | LaneFault> {
  if (equalBytes(laneId, record.fields.channelId)) return record.channel;
  if (info.posting === ChannelPosting.admin) return "not_allowed_to_post";
  if (!attached.author || !attached.pass) return "not_allowed_to_post";
  const author = tryRead(() => identityCodec.decode(attached.author));
  const pass = tryRead(() => channelPassCodec.decode(attached.pass));
  if (!author || !pass) return "bad_pass";
  const authorId = tryRead(() => identityId(author));
  if (!authorId || !equalBytes(authorId, laneId)) return "bad_pass";
  if (!equalBytes(pass.fields.channelId, record.fields.channelId) || !equalBytes(pass.fields.posterId, laneId)) return "bad_pass";
  const bytes = tryRead(() => channelPassBytes(pass.fields));
  if (!bytes || !(await verifySignature(record.channel, "cello-v2-channel-pass", bytes, pass.signature))) return "bad_pass";
  if (at > pass.fields.expiresAt) return "pass_expired";
  if (isRevoked(info, laneId)) return "poster_revoked";
  return author;
}

export interface PostFile extends LaneAttachment {
  post: WireSigned;
  title: string;
  body: string;
}

export interface CheckedPost {
  fields: ChannelPostFields;
  signature: DualSignature;
  title: Uint8Array;
  body: Uint8Array;
  file: PostFile;
}

export async function checkPost(raw: unknown, record: ChannelRecord, info: ChannelInfoFields): Promise<CheckedPost | LaneFault | "bad_post"> {
  const parsed = tryRead(() => {
    const signed = channelPostCodec.decode(field(raw, "post"));
    return { signed, title: fromB64(field(raw, "title"), "title"), body: fromB64(field(raw, "body"), "body") };
  });
  if (!parsed) return "bad_post";
  const { fields, signature } = parsed.signed;
  if (!equalBytes(fields.channelId, record.fields.channelId) || fields.seq < 1 || fields.generation < 1) return "bad_post";
  if (parsed.body.length > MAX_POST_BODY_BYTES + MAX_SEALED_OVERHEAD || parsed.title.length > MAX_POST_TITLE_BYTES + MAX_SEALED_OVERHEAD) return "bad_post";
  if (!equalBytes(hashBlob(parsed.title), fields.titleHash) || !equalBytes(hashBlob(parsed.body), fields.bodyHash)) return "bad_post";
  const file: PostFile = {
    post: channelPostCodec.encode(parsed.signed),
    title: toB64(parsed.title),
    body: toB64(parsed.body),
    author: (field(raw, "author") ?? null) as PostFile["author"],
    pass: (field(raw, "pass") ?? null) as PostFile["pass"],
  };
  const identity = await laneIdentity(record, info, fields.laneId, file, fields.publishedAt);
  if (typeof identity === "string") return identity;
  const bytes = tryRead(() => channelPostBytes(fields));
  if (!bytes || !(await verifySignature(identity, "cello-v2-channel-post", bytes, signature))) return "bad_signature";
  return { fields, signature, title: parsed.title, body: parsed.body, file };
}

export interface HeadFile extends LaneAttachment {
  head: WireSigned;
}

export async function checkHead(raw: unknown, record: ChannelRecord, info: ChannelInfoFields): Promise<{ fields: ChannelHeadFields; file: HeadFile } | LaneFault | "bad_head"> {
  const signed = tryRead(() => channelHeadCodec.decode(field(raw, "head")));
  if (!signed) return "bad_head";
  const { fields } = signed;
  if (!equalBytes(fields.channelId, record.fields.channelId) || fields.floor < 1 || fields.floor > fields.lastSeq + 1) return "bad_head";
  const file: HeadFile = {
    head: channelHeadCodec.encode(signed),
    author: (field(raw, "author") ?? null) as HeadFile["author"],
    pass: (field(raw, "pass") ?? null) as HeadFile["pass"],
  };
  const identity = await laneIdentity(record, info, fields.laneId, file, fields.signedAt);
  if (typeof identity === "string") return identity;
  const bytes = tryRead(() => channelHeadBytes(fields));
  if (!bytes || !(await verifySignature(identity, "cello-v2-channel-head", bytes, signed.signature))) return "bad_signature";
  return { fields, file };
}

// Which of two signed heads to keep. A store replaying an old head can't lower anything.
export function newerHead(a: ChannelHeadFields, b: ChannelHeadFields): boolean {
  if (a.lastSeq !== b.lastSeq) return a.lastSeq > b.lastSeq;
  if (a.floor !== b.floor) return a.floor > b.floor;
  return a.signedAt > b.signedAt;
}

export async function signPass(channel: Signer, posterId: Uint8Array, expiresAt: number): Promise<WireSigned> {
  const fields: ChannelPassFields = { channelId: channel.id, posterId, expiresAt };
  return channelPassCodec.encode({ fields, signature: await channel.sign("cello-v2-channel-pass", channelPassBytes(fields)) });
}

export async function readPass(raw: unknown, record: ChannelRecord): Promise<ChannelPassFields | null> {
  const signed = tryRead(() => channelPassCodec.decode(raw));
  if (!signed || !equalBytes(signed.fields.channelId, record.fields.channelId)) return null;
  const bytes = tryRead(() => channelPassBytes(signed.fields));
  if (!bytes || !(await verifySignature(record.channel, "cello-v2-channel-pass", bytes, signed.signature))) return null;
  return signed.fields;
}

export interface BundleFile {
  bundle: WireSigned;
  // One sealed entry per member, by slot. Being absent from a later generation is how a member learns it's been ejected.
  entries: Record<string, string>;
}

function entriesHash(entries: Record<string, string>): Uint8Array {
  const sorted = Object.keys(entries).sort().map((slot) => [slot, entries[slot]]);
  return sha256(encodeFile(sorted));
}

export async function signBundle(channel: Signer, generation: number, revision: number, entries: Record<string, string>): Promise<BundleFile> {
  const fields: ChannelBundleFields = { channelId: channel.id, generation, revision, entriesHash: entriesHash(entries) };
  return { bundle: channelBundleCodec.encode({ fields, signature: await channel.sign("cello-v2-channel-bundle", channelBundleBytes(fields)) }), entries };
}

export async function readBundle(raw: unknown, record: ChannelRecord): Promise<{ fields: ChannelBundleFields; entries: Record<string, string> } | null> {
  const signed = tryRead(() => channelBundleCodec.decode(field(raw, "bundle")));
  const entries = field(raw, "entries");
  if (!signed || typeof entries !== "object" || entries === null || Array.isArray(entries)) return null;
  if (!Object.values(entries).every((entry) => typeof entry === "string")) return null;
  const typed = entries as Record<string, string>;
  if (!equalBytes(signed.fields.channelId, record.fields.channelId) || !equalBytes(signed.fields.entriesHash, entriesHash(typed))) return null;
  const bytes = tryRead(() => channelBundleBytes(signed.fields));
  if (!bytes || !(await verifySignature(record.channel, "cello-v2-channel-bundle", bytes, signed.signature))) return null;
  return { fields: signed.fields, entries: typed };
}

export async function signAnswer(channel: Signer, slot: Uint8Array, verdict: number, answeredAt: number): Promise<WireSigned> {
  const fields: ChannelAnswerFields = { channelId: channel.id, slot, verdict, answeredAt };
  return channelAnswerCodec.encode({ fields, signature: await channel.sign("cello-v2-channel-answer", channelAnswerBytes(fields)) });
}

export async function readAnswer(raw: unknown, record: ChannelRecord): Promise<ChannelAnswerFields | null> {
  const signed = tryRead(() => channelAnswerCodec.decode(raw));
  if (!signed || !equalBytes(signed.fields.channelId, record.fields.channelId)) return null;
  const bytes = tryRead(() => channelAnswerBytes(signed.fields));
  if (!bytes || !(await verifySignature(record.channel, "cello-v2-channel-answer", bytes, signed.signature))) return null;
  return signed.fields;
}

export async function readTicket(raw: unknown, server: PublicIdentity): Promise<ChannelTicketFields | null> {
  const signed = tryRead(() => channelTicketCodec.decode(raw));
  if (!signed) return null;
  const bytes = tryRead(() => channelTicketBytes(signed.fields));
  const serverId = tryRead(() => identityId(server));
  if (!bytes || !serverId || !equalBytes(signed.fields.serverId, serverId)) return null;
  return await verifySignature(server, "cello-v2-channel-ticket", bytes, signed.signature) ? signed.fields : null;
}

export async function readStoreAck(raw: unknown, store: PublicIdentity): Promise<ChannelStoreAckFields | null> {
  const signed = tryRead(() => channelStoreAckCodec.decode(raw));
  if (!signed) return null;
  const bytes = tryRead(() => channelStoreAckBytes(signed.fields));
  return bytes && await verifySignature(store, "cello-v2-channel-store-ack", bytes, signed.signature) ? signed.fields : null;
}

// A joiner's request, sealed to the channel. Its identity is inside, so the store can't see who is asking.
export interface JoinRequest {
  identity: Record<string, string | number>;
  memberKey: WireSigned;
  note: string;
  leaving: boolean;
}

export async function readJoinRequest(raw: unknown, channelId: Uint8Array): Promise<{ agentId: Uint8Array; identity: PublicIdentity; memberKey: ChannelMemberKeyFields; note: string; leaving: boolean } | null> {
  const identity = tryRead(() => identityCodec.decode(field(raw, "identity")));
  const signed = tryRead(() => channelMemberKeyCodec.decode(field(raw, "memberKey")));
  const note = field(raw, "note");
  if (!identity || !signed || typeof note !== "string") return null;
  const agentId = tryRead(() => identityId(identity));
  const bytes = tryRead(() => channelMemberKeyBytes(signed.fields));
  if (!agentId || !bytes) return null;
  if (!equalBytes(agentId, signed.fields.agentId) || !equalBytes(signed.fields.channelId, channelId)) return null;
  if (!(await verifySignature(identity, "cello-v2-channel-member-key", bytes, signed.signature))) return null;
  return { agentId, identity, memberKey: signed.fields, note, leaving: field(raw, "leaving") === true };
}

export interface SealKeys { x25519Public: Uint8Array; mlKemPublic: Uint8Array }
export interface OpenKeys { x25519Secret: Uint8Array; mlKemSeed: Uint8Array; x25519Public: Uint8Array; mlKemPublic: Uint8Array }

const SEAL_DOMAIN = ENC.encode("cello-v2/channel-seal");

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

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export const channelPaths = {
  info: (channel: Uint8Array) => `meta/${toHex(channel)}/info`,
  bundle: (channel: Uint8Array, generation: number) => `meta/${toHex(channel)}/keys/${generation}`,
  joins: (channel: Uint8Array) => `meta/${toHex(channel)}/joins`,
  heads: (cap: Uint8Array) => `meta/${toHex(cap)}/heads`,
  post: (cap: Uint8Array, lane: Uint8Array, seq: number) => `posts/${toHex(cap)}/${toHex(lane)}/${seq}`,
  lane: (cap: Uint8Array, lane: Uint8Array) => `posts/${toHex(cap)}/${toHex(lane)}/`,
  ack: (cap: Uint8Array, lane: Uint8Array, seq: number) => `acks/${toHex(cap)}/${toHex(lane)}/${seq}`,
  join: (channel: Uint8Array, slot: Uint8Array) => `slots/${toHex(channel)}/join/${toHex(slot)}`,
  answer: (channel: Uint8Array, slot: Uint8Array) => `slots/${toHex(channel)}/answer/${toHex(slot)}`,
  pass: (channel: Uint8Array, slot: Uint8Array) => `slots/${toHex(channel)}/pass/${toHex(slot)}`,
};

export interface HeadsFile { lanes: Record<string, HeadFile> }
export interface JoinsFile { slots: string[] }

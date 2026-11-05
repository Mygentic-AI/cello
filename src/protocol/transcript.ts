// A provable transcript: a seal, the signed chain it covers, and the plaintext of the positions one party chose to show.
// Anyone can check one with public keys only. It shows what was passed, never that it's true or agreed.
// Bodies travel as their exact bytes, because the signed hash is over those bytes and JSON can't be re-encoded safely.
import { type ChainFault, ChainVerifier, type WitnessedEntry, witnessed } from "./chain.ts";
import { equalBytes, toHex } from "./encode.ts";
import { SESSION_SALT_BYTES, saltedContentHash } from "./salt.ts";
import { type SealCheck, type SealFault, type SealRecord, type SealRecordOnWire, checkSealRecord, decodeSealRecord, describeSeal, readableTime, sealId, sealSummary } from "./seal.ts";
import { EntryKind, readBodyBytes, structureHash } from "./structures.ts";
import { type WireSigned, fromB64, readInt, readObjectField, signedAck, signedEntry, toB64 } from "./wire.ts";

export const TRANSCRIPT_FORMAT = "cello-transcript";

export interface TranscriptOnWire {
  format: typeof TRANSCRIPT_FORMAT;
  seal: SealRecordOnWire;
  // Every position the seal covers, in order. Hidden positions show their author, kind and time, and never their words.
  entries: { entry: WireSigned; ack: WireSigned }[];
  salt: string;
  revealed: { position: number; body: string }[];
}

export type TranscriptFault =
  | SealFault
  | ChainFault
  | "malformed_transcript"
  | "truncated_chain"
  | "entries_beyond_seal"
  | "root_mismatch"
  | "delivery_ack_off_chain"
  | "bad_salt"
  | "reveal_out_of_range"
  | "duplicate_reveal"
  | "body_does_not_match";

const CHAIN_FAULT_MESSAGES: Record<ChainFault, string> = {
  wrong_session: "An entry belongs to a different session from the one this seal covers",
  entry_wrong_server: "An entry's author named a different server to witness it",
  not_participant: "An entry's author isn't one of this session's two parties",
  bad_entry_signature: "An entry wasn't signed by its author",
  bad_author_seq: "An author's entries are out of sequence, so one is missing or repeated",
  bad_author_chain: "An entry doesn't follow its author's previous entry",
  read_beyond_tip: "An entry claims to have read further than the chain had reached",
  bad_read_root: "An entry names a history other than this one as what its author had read",
  bad_position: "An entry is out of place in the order",
  ack_wrong_server: "An entry's ack is from a different server from the one this seal names",
  ack_wrong_session: "An entry's ack is for a different session",
  ack_wrong_entry: "An entry isn't the one its ack witnessed, so it has been changed or given a different author",
  ack_wrong_root: "An entry's ack names a different history",
  bad_ack_signature: "An entry's ack wasn't signed by the server",
};

export type TranscriptCheck =
  | { ok: true; record: SealRecord; report: Record<string, unknown> }
  | { ok: false; fault: TranscriptFault; message: string };

function fail(fault: TranscriptFault, message: string): TranscriptCheck {
  return { ok: false, fault, message };
}

// A field nobody checks has no place in a file people read as proof, such as a claimed author next to a body.
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new RangeError(`${name} has a field nothing checks: ${extra}`);
}

function readList(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new RangeError(`${name} isn't a list`);
  return value;
}

interface DecodedTranscript {
  seal: unknown;
  items: WitnessedEntry[];
  salt: Uint8Array;
  revealed: { position: number; body: Uint8Array }[];
}

function decodeTranscript(raw: unknown): DecodedTranscript {
  const value = readObjectField(raw, "transcript");
  if (value["format"] !== TRANSCRIPT_FORMAT) throw new RangeError(`this isn't a ${TRANSCRIPT_FORMAT} file`);
  onlyKeys(value, ["format", "seal", "entries", "salt", "revealed"], "the file");
  return {
    seal: value["seal"],
    items: readList(value["entries"], "entries").map((item, i) => {
      const fields = readObjectField(item, `entries[${i}]`);
      onlyKeys(fields, ["entry", "ack"], `entries[${i}]`);
      const entry = signedEntry.decode(fields["entry"], `entries[${i}].entry`);
      const ack = signedAck.decode(fields["ack"], `entries[${i}].ack`);
      return witnessed(entry, ack);
    }),
    salt: fromB64(value["salt"], "salt"),
    revealed: readList(value["revealed"], "revealed").map((item, i) => {
      const fields = readObjectField(item, `revealed[${i}]`);
      onlyKeys(fields, ["position", "body"], `revealed[${i}]`);
      return { position: readInt(fields["position"], `revealed[${i}].position`), body: fromB64(fields["body"], `revealed[${i}].body`) };
    }),
  };
}

export interface ReadBody {
  text: string;
  signal: string | null;
  estMinutes: number | null;
  // Whether it has a value long enough to stop a holder of the salt testing guesses about it.
  // Only its length can be seen. Its author could still have chosen one that isn't random, and that exposes only the author's own words.
  hasRandomValue: boolean;
}

const RANDOM_VALUE_BYTES = 16;

// Null for anything that isn't exactly what a CELLO client writes.
export function readBody(bytes: Uint8Array): ReadBody | null {
  const body = readBodyBytes(bytes);
  if (!body) return null;
  return { text: body.text, signal: body.signal, estMinutes: body.est_minutes, hasRandomValue: body.n.length >= RANDOM_VALUE_BYTES };
}

// "1-3, 5", so a statement stays readable however long the conversation.
function listPositions(positions: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < positions.length) {
    let last = i;
    while (positions[last + 1] === (positions[last] as number) + 1) last++;
    parts.push(last === i ? `${positions[i]}` : `${positions[i]}-${positions[last]}`);
    i = last + 1;
  }
  return parts.join(", ");
}

function describeMessage(item: WitnessedEntry, body: Uint8Array, record: SealRecord): Record<string, unknown> {
  const cert = record.certificate.fields;
  const closing = item.fields.kind === EntryKind.close;
  const read = readBody(body);
  const words = !read
    ? { unreadable: true, body_base64url: toB64(body) }
    // A client never shows a close's text to its agent, so text here wasn't passed in the usual way, and it's marked.
    : closing
      ? (read.text ? { text_on_a_close: read.text } : {})
      : { text: read.text, signal: read.signal, ...(read.estMinutes !== null ? { est_minutes: read.estMinutes } : {}) };
  return {
    position: item.ack.position,
    author: equalBytes(item.fields.authorId, cert.sealerId) ? "sealer" : "counterparty",
    author_id: toHex(item.fields.authorId),
    kind: closing ? "close" : "message",
    ...words,
    author_had_read_through: item.fields.readPosition,
    witnessed_at: readableTime(item.ack.time),
    basis: item.ack.position <= cert.receivedThrough ? "counterparty_signature" : "sender_signature_and_server",
  };
}

// What this file shows and doesn't, for a person to read. Neutral on agreement and truth, always.
function describeTranscript(record: SealRecord, items: readonly WitnessedEntry[], revealed: readonly number[], hidden: readonly number[]): Record<string, unknown> {
  const cert = record.certificate.fields;
  const m = cert.receivedThrough;
  const authorOf = (position: number): Uint8Array => (items[position - 1] as WitnessedEntry).fields.authorId;
  const bound = revealed.filter((p) => p <= m);
  const beyond = revealed.filter((p) => p > m);
  const fromSealer = beyond.filter((p) => equalBytes(authorOf(p), cert.sealerId));
  const fromCounterparty = beyond.filter((p) => !equalBytes(authorOf(p), cert.sealerId));
  const more = cert.tip - cert.throughPosition;
  const missing = [
    ...(hidden.length > 0 ? [`Positions ${listPositions(hidden)} are hidden. Their signed hashes are in the chain, so they exist and can't be altered unseen, but this file doesn't show what they said.`] : []),
    ...(more > 0 ? [`The server says ${more} more position${more === 1 ? "" : "s"} came after what this seal covers, and this file shows nothing of them.`] : []),
    ...(cert.closed === 1 ? [] : ["The server says the session hadn't closed when this was sealed, so more may have followed."]),
  ];
  // The seal's own statement says it shows nothing of what was said, which isn't so for this file.
  const seal = Object.fromEntries(Object.entries(describeSeal(record)).filter(([key]) => key !== "contents"));
  return {
    meaning: "These are messages that were passed between these two keys. This says nothing about whether they're true, or whether either party agreed.",
    bound_by_the_counterparty_signature: bound.length > 0
      ? `Positions ${listPositions(bound)}: each body matches its signed entry, and the counterparty's own signature says its machine stored and decrypted everything through position ${m}, in this order. That rests on its key, not on the server. Received means stored and decrypted, not read.`
      : "No revealed position is covered by the counterparty's signature.",
    rests_on_the_sender_and_the_server: [
      ...(fromCounterparty.length > 0 ? [`Positions ${listPositions(fromCounterparty)}: the counterparty's signature on the entry stands behind the words. Their place in the order rests on the server.`] : []),
      ...(fromSealer.length > 0 ? [`Positions ${listPositions(fromSealer)}: only the signature of the person who made this file and the server's word stand behind these. Nothing shows the counterparty ever received them.`] : []),
      ...(beyond.length === 0 ? ["No revealed position rests on these alone. The times shown still rest on the server."] : ["The times shown rest on the server."]),
    ].join(" "),
    who_chose: `This file comes from one party, the sealer ${toHex(cert.sealerId)}, who chose what to reveal. The other party may hold its own copy.`,
    hidden: missing.length > 0
      ? `${missing.join(" ")} What isn't shown may change the meaning: "Bob offers $1M" can be followed by a hidden "Bob withdraws".`
      : "Nothing is hidden: every position in this session is revealed.",
    how_bodies_were_checked: "Each revealed body was hashed with the session salt and matched against its author's signed entry. Nothing signs the salt itself, and it needs nothing to: finding another salt or body that gives the same hash would mean breaking SHA-256.",
    ciphertext: "This file holds no ciphertext or key, so each entry's signed ciphertext hash isn't checked here. It's carried unchanged, because the entry's signature covers it. Only a recipient's machine can check it. It does that before signing a delivery ack, which is why the counterparty's signature means more than the sender's.",
    seal,
  };
}

async function findTranscript(decoded: DecodedTranscript, record: SealRecord): Promise<TranscriptCheck> {
  const cert = record.certificate.fields;
  const n = cert.throughPosition;
  const { items, salt } = decoded;
  if (items.length < n) return fail("truncated_chain", `This seal covers ${n} positions, and the file holds only ${items.length}`);
  if (items.length > n) return fail("entries_beyond_seal", `This seal covers ${n} positions, and the file holds ${items.length}, so some of them no seal stands behind`);

  const verifier = new ChainVerifier({ sessionId: cert.sessionId, server: record.server, participants: [record.sealer, record.counterparty] });
  for (const item of items) {
    const fault = await verifier.check(item);
    if (fault) return fail(fault, `${CHAIN_FAULT_MESSAGES[fault]}: at place ${verifier.position + 1} in the file`);
  }
  if (!equalBytes(verifier.root, cert.root)) return fail("root_mismatch", "This chain's root isn't the one the seal covers, so the seal is for a different history");

  const ack = record.deliveryAck?.fields;
  if (ack && ack.throughPosition <= n) {
    const onChain = equalBytes(verifier.rootAt(ack.throughPosition) as Uint8Array, ack.root) && equalBytes(structureHash((items[ack.throughPosition - 1] as WitnessedEntry).bytes), ack.entryHash);
    if (!onChain) return fail("delivery_ack_off_chain", `What the counterparty signed at position ${ack.throughPosition} isn't this chain`);
  }

  // HMAC pads a short key with zeros, so only this exact length stops two different salts acting as one.
  if (salt.length !== SESSION_SALT_BYTES) return fail("bad_salt", `A session salt is ${SESSION_SALT_BYTES} bytes, and this one is ${salt.length}`);
  const bodies = new Map<number, Uint8Array>();
  for (const { position, body } of decoded.revealed) {
    if (position < 1 || position > n) return fail("reveal_out_of_range", `Position ${position} is revealed, and this seal covers 1 to ${n}`);
    if (bodies.has(position)) return fail("duplicate_reveal", `Position ${position} is revealed twice`);
    if (!equalBytes(saltedContentHash(salt, body), (items[position - 1] as WitnessedEntry).fields.contentHash)) {
      return fail("body_does_not_match", `The body given for position ${position} isn't what its author signed`);
    }
    bodies.set(position, body);
  }

  const revealed = [...bodies.keys()].sort((a, b) => a - b);
  const hidden = items.map((item) => item.ack.position).filter((position) => !bodies.has(position));
  return {
    ok: true,
    record,
    report: {
      ...sealSummary(record),
      revealed_positions: revealed,
      hidden_positions: hidden,
      messages: revealed.map((position) => describeMessage(items[position - 1] as WitnessedEntry, bodies.get(position) as Uint8Array, record)),
      statement: describeTranscript(record, items, revealed, hidden),
    },
  };
}

// Never throws on a bad file: every bad input is a named fault.
export async function checkTranscript(raw: unknown, sealKeyId: Uint8Array): Promise<TranscriptCheck> {
  let decoded: DecodedTranscript;
  try {
    decoded = decodeTranscript(raw);
  } catch (err: unknown) {
    return fail("malformed_transcript", `This file isn't a readable transcript: ${err instanceof Error ? err.message : String(err)}`);
  }
  const seal: SealCheck = await checkSealRecord(decoded.seal, sealKeyId);
  if (!seal.ok) return seal;
  return findTranscript(decoded, seal.record);
}

// ---- Making one ----

export interface HeldEntry {
  position: number;
  entry: WireSigned;
  ack: WireSigned | null;
  // Null when this party never kept the words, because they arrived past its byte limit. The signed entry and ack are still here.
  body: Uint8Array | null;
}

export interface TranscriptRequest {
  session: string;
  // What to run to get a seal, for the message when none covers this.
  sealCommand: string;
  entries: readonly HeldEntry[];
  seals: readonly unknown[];
  salt: Uint8Array | null;
  reveal: string | undefined;
  all: boolean;
  sealId: string | undefined;
}

export type TranscriptExport =
  | { ok: true; file: TranscriptOnWire; summary: Record<string, unknown> }
  | { ok: false; fault: string; message: string };

// Ranges, so a typed 1-99999999999 is refused for being beyond the seal rather than expanded first.
function parsePositions(text: string): [number, number][] | null {
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(text)) return null;
  const ranges = text.split(",").map((part): [number, number] => {
    const [first, last] = part.split("-").map(Number) as [number, number | undefined];
    return [first, last ?? first];
  });
  return ranges.every(([first, last]) => Number.isSafeInteger(last) && first >= 1 && first <= last) ? ranges : null;
}

function chooseSeal(seals: readonly SealRecordOnWire[], wanted: string | undefined): SealRecordOnWire | undefined {
  if (wanted !== undefined) return seals.find((seal) => toHex(sealId(decodeSealRecord(seal).certificate.bytes)) === wanted.toLowerCase());
  // Sorting one seal compares nothing, so this reads every one, and a corrupt one can't slip through unnoticed.
  for (const seal of seals) decodeSealRecord(seal);
  const reach = (seal: SealRecordOnWire): [number, number, number] => {
    const cert = decodeSealRecord(seal).certificate.fields;
    return [cert.throughPosition, cert.receivedThrough, cert.time];
  };
  // The furthest one, then the one the counterparty has confirmed most of, then the newest.
  return [...seals].sort((a, b) => {
    const [x, y] = [reach(a), reach(b)];
    return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]);
  })[0];
}

// Builds the file and checks it as a stranger would, so nobody is handed a file that fails in front of its reader.
export async function buildTranscript(request: TranscriptRequest): Promise<TranscriptExport> {
  const refuse = (fault: string, message: string): TranscriptExport => ({ ok: false, fault, message });
  const { reveal, all, entries, session, sealCommand, salt } = request;
  if (all && reveal !== undefined) return refuse("bad_argument", "Choose either reveal or all, not both");
  if (!all && reveal === undefined) return refuse("no_reveal_chosen", "Nothing is revealed by default. Name the positions to show with reveal, such as 1,3,5-7, or show everything with all");
  const ranges = reveal === undefined ? null : parsePositions(reveal);
  if (reveal !== undefined && !ranges) return refuse("bad_argument", `reveal must be positions such as 1,3,5-7, and "${reveal}" isn't`);

  let seal: SealRecordOnWire | undefined;
  try {
    seal = chooseSeal(request.seals as SealRecordOnWire[], request.sealId);
  } catch (err: unknown) {
    return refuse("stored_seal_unreadable", `A seal this agent holds for this session can't be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (request.sealId !== undefined && !seal) return refuse("unknown_seal", "This agent holds no seal with that id for this session");
  const held = entries.at(-1)?.position ?? 0;
  const seek = `Run: ${sealCommand}`;
  if (!seal) return refuse("no_seal_covers", `This agent holds no seal for session ${session}, and a transcript needs one. ${seek}`);
  const n = decodeSealRecord(seal).certificate.fields.throughPosition;
  const highest = ranges ? Math.max(...ranges.map(([, last]) => last)) : request.sealId === undefined ? held : n;
  if (highest > n) return refuse("no_seal_covers", `The seal covers positions 1 to ${n}, and this needs position ${highest}. ${seek}`);

  const covered = entries.filter((row) => row.position <= n);
  if (covered.length !== n || covered.some((row, i) => row.position !== i + 1 || !row.ack)) return refuse("record_incomplete", `This agent's record doesn't hold every position from 1 to ${n}, so it can't be exported`);
  if (!salt) return refuse("salt_missing", "This agent's record doesn't hold the session's salt, so no message can be shown to match its hash");

  const shown = new Set<number>();
  for (const [first, last] of ranges ?? [[1, n]] as const) for (let p = first; p <= last; p++) shown.add(p);
  const notKept = covered.filter((row) => row.body === null).map((row) => row.position);
  const askedNotKept = ranges ? notKept.filter((p) => shown.has(p)) : [];
  if (askedNotKept.length > 0) return refuse("body_not_kept", `Positions ${listPositions(askedNotKept)} arrived past this conversation's byte limit, so their words were never kept and can't be shown. Nothing was written.`);

  // The salt goes in the file, and it's the same one for the whole session. Only each body's random value still protects a hidden one.
  // Words not kept can't be checked for one. They're the sender's own, sent past a limit, and nobody here read them.
  const guessable = covered.filter((row) => row.body !== null && !shown.has(row.position) && !readBody(row.body)?.hasRandomValue).map((row) => row.position);
  if (guessable.length > 0) {
    return refuse("hidden_body_guessable", `Positions ${listPositions(guessable)} have no random value in them, because the other party's software didn't add one. With the salt in this file, anyone could test guesses about what they say. Nothing was written. Reveal those positions too if you're content to show them.`);
  }

  const file: TranscriptOnWire = {
    format: TRANSCRIPT_FORMAT,
    seal,
    entries: covered.map((row) => ({ entry: row.entry, ack: row.ack as WireSigned })),
    salt: toB64(salt),
    revealed: covered.flatMap((row) => (row.body !== null && shown.has(row.position) ? [{ position: row.position, body: toB64(row.body) }] : [])),
  };
  const cert = decodeSealRecord(seal).certificate.fields;
  const check = await checkTranscript(file, cert.sealKeyId);
  if (!check.ok) return refuse("export_failed_own_check", `This agent's record doesn't pass the check a reader would run, so nothing was written. ${check.fault}: ${check.message}`);
  const revealedPositions = file.revealed.map((row) => row.position);
  return {
    ok: true,
    file,
    summary: {
      session_id: toHex(cert.sessionId),
      seal_id: toHex(sealId(decodeSealRecord(seal).certificate.bytes)),
      seal_key: toHex(cert.sealKeyId),
      witnessed_through: n,
      received_through: cert.receivedThrough,
      revealed_positions: revealedPositions,
      hidden_positions: check.report["hidden_positions"],
      not_kept_positions: notKept,
      warning: `This file holds the plaintext of positions ${listPositions(revealedPositions)}. Anyone you give it to can read them. It also holds the session's salt.`,
    },
  };
}

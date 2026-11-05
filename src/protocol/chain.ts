// Checks a session's history: every signature, each author's chain, the order, and the running root.
// It needs only the parties' and the server's public keys, so a record can be checked without the server.
import { ZERO_HASH, equalBytes, toHex } from "./encode.ts";
import { type DualSignature, type PublicIdentity, identityId, verifySignature } from "./identity.ts";
import { EMPTY_ROOT, RunningMerkle } from "./merkle.ts";
import { type AckFields, type EntryFields, EntryKind, structureHash } from "./structures.ts";
import type { Signed } from "./wire.ts";

export interface WitnessedEntry {
  fields: EntryFields;
  signature: DualSignature;
  // The bytes each signature covers, as received. Verifying over these means a later encoder can't turn an old record into a forgery.
  bytes: Uint8Array;
  ack: AckFields;
  ackSignature: DualSignature;
  ackBytes: Uint8Array;
}

export function witnessed(entry: Signed<EntryFields>, ack: Signed<AckFields>): WitnessedEntry {
  return { fields: entry.fields, signature: entry.signature, bytes: entry.bytes, ack: ack.fields, ackSignature: ack.signature, ackBytes: ack.bytes };
}

export type ChainFault =
  | "wrong_session"
  | "entry_wrong_server"
  | "not_participant"
  | "bad_entry_signature"
  | "entry_after_close"
  | "entry_expired"
  | "ack_time_backwards"
  | "bad_author_seq"
  | "bad_author_chain"
  | "read_beyond_tip"
  | "bad_read_root"
  | "bad_position"
  | "ack_wrong_server"
  | "ack_wrong_session"
  | "ack_wrong_entry"
  | "ack_wrong_root"
  | "bad_ack_signature";

export interface ChainParties {
  sessionId: Uint8Array;
  server: PublicIdentity;
  participants: readonly PublicIdentity[];
}

export interface AuthorHead {
  seq: number;
  hash: Uint8Array;
}

// Checks what an author signed against the author's own chain. The server runs this before assigning a position.
export function authorChainFault(fields: EntryFields, head: AuthorHead | undefined): "bad_author_seq" | "bad_author_chain" | null {
  const expectedSeq = (head?.seq ?? 0) + 1;
  if (fields.authorSeq !== expectedSeq) return "bad_author_seq";
  if (!equalBytes(fields.prevOwnHash, head?.hash ?? ZERO_HASH)) return "bad_author_chain";
  return null;
}

export class ChainVerifier {
  readonly #parties: ChainParties;
  readonly #serverId: Uint8Array;
  readonly #keysById = new Map<string, PublicIdentity>();
  readonly #authors = new Map<string, AuthorHead>();
  readonly #roots: Uint8Array[] = [EMPTY_ROOT];
  readonly #merkle = new RunningMerkle();
  readonly #closed = new Set<string>();
  #lastAckTime = 0;

  constructor(parties: ChainParties) {
    this.#parties = parties;
    this.#serverId = identityId(parties.server);
    for (const identity of parties.participants) this.#keysById.set(toHex(identityId(identity)), identity);
  }

  get position(): number {
    return this.#merkle.size;
  }

  get root(): Uint8Array {
    return this.#merkle.root();
  }

  get lastAckTime(): number {
    return this.#lastAckTime;
  }

  hasClosed(authorId: Uint8Array): boolean {
    return this.#closed.has(toHex(authorId));
  }

  rootAt(position: number): Uint8Array | undefined {
    return this.#roots[position];
  }

  authorHead(authorId: Uint8Array): AuthorHead | undefined {
    return this.#authors.get(toHex(authorId));
  }

  // Runs every check, and advances only if all of them pass.
  async check(item: WitnessedEntry): Promise<ChainFault | null> {
    const { fields, signature, bytes, ack, ackSignature, ackBytes } = item;
    if (!equalBytes(fields.sessionId, this.#parties.sessionId)) return "wrong_session";
    if (!equalBytes(fields.serverId, this.#serverId)) return "entry_wrong_server";
    const author = this.#keysById.get(toHex(fields.authorId));
    if (!author) return "not_participant";
    const hash = structureHash(bytes);

    if (ack.position !== this.position + 1) return "bad_position";
    if (!equalBytes(ack.serverId, this.#serverId)) return "ack_wrong_server";
    if (!equalBytes(ack.sessionId, this.#parties.sessionId)) return "ack_wrong_session";
    if (!equalBytes(ack.entryHash, hash)) return "ack_wrong_entry";

    if (this.#closed.has(toHex(fields.authorId))) return "entry_after_close";
    // The author's not_after binds the server, whose ack carries the time. A refused message can't be landed later,
    // and the time can't be pushed back to get under it, because acks never go backwards.
    if (ack.time < this.#lastAckTime) return "ack_time_backwards";
    if (ack.time > fields.notAfter) return "entry_expired";

    const chainFault = authorChainFault(fields, this.#authors.get(toHex(fields.authorId)));
    if (chainFault) return chainFault;
    if (fields.readPosition > this.position) return "read_beyond_tip";
    const readRoot = this.#roots[fields.readPosition];
    if (!readRoot || !equalBytes(fields.readRoot, readRoot)) return "bad_read_root";

    const next = RunningMerkle.fromBytes(this.position, this.#merkle.toBytes());
    if (!equalBytes(ack.root, next.append(hash))) return "ack_wrong_root";

    if (!(await verifySignature(author, "cello-entry", bytes, signature))) return "bad_entry_signature";
    if (!(await verifySignature(this.#parties.server, "cello-ack", ackBytes, ackSignature))) return "bad_ack_signature";

    this.adopt(fields, hash, ack.time);
    return null;
  }

  // Rebuilds state from rows this machine already checked and stored, without repeating the signature work.
  adopt(fields: EntryFields, hash: Uint8Array, ackTime: number): void {
    const root = this.#merkle.append(hash);
    this.#roots.push(root);
    this.#authors.set(toHex(fields.authorId), { seq: fields.authorSeq, hash });
    if (fields.kind === EntryKind.close) this.#closed.add(toHex(fields.authorId));
    this.#lastAckTime = ackTime;
  }
}

export interface ChainReport {
  ok: boolean;
  position: number;
  root: Uint8Array;
  fault?: ChainFault;
  faultAt?: number;
}

export async function verifyTranscript(parties: ChainParties, items: readonly WitnessedEntry[]): Promise<ChainReport> {
  const verifier = new ChainVerifier(parties);
  for (const item of items) {
    const fault = await verifier.check(item);
    if (fault) return { ok: false, position: verifier.position, root: verifier.root, fault, faultAt: item.ack.position };
  }
  return { ok: true, position: verifier.position, root: verifier.root };
}


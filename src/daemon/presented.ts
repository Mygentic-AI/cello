// What this daemon holds so signals can travel sealed with a call: each agent's encryption keys, and the signals the other side presented.
// Both live in the encrypted database. A key's seed is as private as the agent's own seeds beside it.
import { mlKemGenerateSeed, mlKemKeypairFromSeed } from "../protocol/ml-kem.ts";
import { encryptionKeyBytes } from "../protocol/structures.ts";
import { type WireSigned, signedEncryptionKey } from "../protocol/wire.ts";
import type { Signer } from "../protocol/identity.ts";
import { logEvent } from "./log.ts";
import type { Store } from "./store.ts";

export function ensurePresentedSchema(db: Store): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS encryption_keys (
  agent_id   BLOB NOT NULL REFERENCES agents(agent_id),
  revision   INTEGER NOT NULL,
  kem_seed   BLOB NOT NULL,
  signed     TEXT NOT NULL,
  published  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, revision)
);
-- The signals one side showed with a call, kept as the signed files they came as, so each is checked again whenever it is read.
-- side is who presented them: caller or callee.
CREATE TABLE IF NOT EXISTS presented_signals (
  agent_id    BLOB NOT NULL,
  session_id  BLOB NOT NULL,
  side        TEXT NOT NULL CHECK (side IN ('caller', 'callee')),
  ord         INTEGER NOT NULL,
  file        BLOB NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, session_id, side, ord)
);
-- What came with a call that couldn't be used at all, so "nothing was sent" and "something was sent that didn't open" read differently.
CREATE TABLE IF NOT EXISTS presented_unreadable (
  agent_id   BLOB NOT NULL,
  session_id BLOB NOT NULL,
  side       TEXT NOT NULL CHECK (side IN ('caller', 'callee')),
  PRIMARY KEY (agent_id, session_id, side)
);`);
}

interface KeyRow { agent_id: Uint8Array; revision: number; kem_seed: Uint8Array; signed: string; published: number; created_at: number }

export class EncryptionKeys {
  readonly #db: ReturnType<Store["raw"]>;

  constructor(store: Store) {
    this.#db = store.raw();
  }

  latest(agentId: Uint8Array): KeyRow | undefined {
    return this.#db.get("SELECT * FROM encryption_keys WHERE agent_id = ? ORDER BY revision DESC LIMIT 1", [agentId]) as KeyRow | undefined;
  }

  // Newest first, because a caller may have sealed to a key since replaced, and an old one is kept to open what was sealed to it.
  seeds(agentId: Uint8Array): Uint8Array[] {
    return (this.#db.all("SELECT kem_seed FROM encryption_keys WHERE agent_id = ? ORDER BY revision DESC", [agentId]) as { kem_seed: Uint8Array }[]).map((row) => new Uint8Array(row.kem_seed));
  }

  // The agent's first key, or the next revision. Not published until the server has taken it.
  async make(agent: { signer: Signer }): Promise<KeyRow> {
    const previous = this.latest(agent.signer.id);
    const revision = (previous?.revision ?? 0) + 1;
    const seed = mlKemGenerateSeed();
    const { publicKey } = await mlKemKeypairFromSeed(seed);
    const fields = { agentId: agent.signer.id, mlKemPublic: publicKey, revision, issuedAt: Date.now() };
    const signature = await agent.signer.sign("cello-agent-encryption-key", encryptionKeyBytes(fields));
    const signed = JSON.stringify(signedEncryptionKey.encode({ fields, signature }));
    this.#db.run("INSERT INTO encryption_keys (agent_id, revision, kem_seed, signed, published, created_at) VALUES (?, ?, ?, ?, 0, ?)", [agent.signer.id, revision, seed, signed, Date.now()]);
    logEvent("encryption_key.made", { revision });
    return this.latest(agent.signer.id) as KeyRow;
  }

  // The latest key if the server doesn't hold it yet, making the first one if the agent has none.
  async unpublished(agent: { signer: Signer }): Promise<{ revision: number; wire: WireSigned } | null> {
    const row = this.latest(agent.signer.id) ?? await this.make(agent);
    return row.published === 1 ? null : { revision: row.revision, wire: JSON.parse(row.signed) as WireSigned };
  }

  markPublished(agentId: Uint8Array, revision: number): void {
    this.#db.run("UPDATE encryption_keys SET published = 1 WHERE agent_id = ? AND revision = ?", [agentId, revision]);
  }
}

export class PresentedStore {
  readonly #db: ReturnType<Store["raw"]>;

  constructor(store: Store) {
    this.#db = store.raw();
  }

  // One write per session and side: a repeat leaves what was kept.
  put(agentId: Uint8Array, sessionId: Uint8Array, side: "caller" | "callee", files: readonly Uint8Array[] | "unreadable"): void {
    if (files === "unreadable") {
      this.#db.run("INSERT OR IGNORE INTO presented_unreadable (agent_id, session_id, side) VALUES (?, ?, ?)", [agentId, sessionId, side]);
      return;
    }
    if (this.#db.get("SELECT 1 AS one FROM presented_signals WHERE agent_id = ? AND session_id = ? AND side = ?", [agentId, sessionId, side])) return;
    files.forEach((file, ord) => {
      this.#db.run("INSERT OR IGNORE INTO presented_signals (agent_id, session_id, side, ord, file, received_at) VALUES (?, ?, ?, ?, ?, ?)", [agentId, sessionId, side, ord, file, Date.now()]);
    });
  }

  files(agentId: Uint8Array, sessionId: Uint8Array, side: "caller" | "callee"): Uint8Array[] {
    return (this.#db.all("SELECT file FROM presented_signals WHERE agent_id = ? AND session_id = ? AND side = ? ORDER BY ord", [agentId, sessionId, side]) as { file: Uint8Array }[]).map((row) => new Uint8Array(row.file));
  }

  unreadable(agentId: Uint8Array, sessionId: Uint8Array, side: "caller" | "callee"): boolean {
    return this.#db.get("SELECT 1 AS one FROM presented_unreadable WHERE agent_id = ? AND session_id = ? AND side = ?", [agentId, sessionId, side]) !== undefined;
  }
}

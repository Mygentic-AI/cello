// What the agent's human operator said back, through a notifier. It's kept apart from messages, in its own table and its own
// part of a read, because it's the one thing an agent reads that is an instruction. Nothing another party sends can land here.
import type { Store } from "./store.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS operator_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    BLOB NOT NULL REFERENCES agents(agent_id),
  -- The session the operator was answering about, when the notification named one.
  session_id  BLOB,
  text        TEXT NOT NULL,
  -- The notifier's name, so the agent knows which route it came by.
  via         TEXT NOT NULL,
  -- The notifier's own id for it, so the same one is never stored twice.
  source_id   TEXT NOT NULL UNIQUE,
  received_at INTEGER NOT NULL
);
`;

export interface OperatorMessage { id: number; session_id: Uint8Array | null; text: string; via: string; received_at: number }

export class OperatorInbox {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
    store.exec(SCHEMA);
  }

  // False when this one was already stored.
  add(agentId: Uint8Array, sessionId: Uint8Array | null, text: string, via: string, sourceId: string): boolean {
    if (this.#store.prepare("SELECT 1 FROM operator_messages WHERE source_id = ?").get(sourceId)) return false;
    this.#store.prepare("INSERT INTO operator_messages (agent_id, session_id, text, via, source_id, received_at) VALUES (?, ?, ?, ?, ?, ?)").run(agentId, sessionId, text, via, sourceId, Date.now());
    return true;
  }

  unread(agentId: Uint8Array): OperatorMessage[] {
    return this.#store.prepare("SELECT id, session_id, text, via, received_at FROM operator_messages WHERE agent_id = ? ORDER BY id").all(agentId) as OperatorMessage[];
  }

  // A read counts only once its answer is written, so what was read is cleared then and not before.
  clear(agentId: Uint8Array, throughId: number): void {
    this.#store.prepare("DELETE FROM operator_messages WHERE agent_id = ? AND id <= ?").run(agentId, throughId);
  }
}

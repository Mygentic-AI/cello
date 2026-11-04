// Answering a call nobody can pick up. Both halves live in the encrypted database and neither touches the chain:
// a greeting isn't something the parties said, so it stays out of the transcript and the seal.
import type { Store } from "./store.ts";

const SCHEMA = `
-- The callee's side: one row per call answered while nobody was reachable.
CREATE TABLE IF NOT EXISTS away_visits (
  agent_id   BLOB NOT NULL REFERENCES agents(agent_id),
  session_id BLOB NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('due', 'sent', 'not_sent', 'closed', 'answered')),
  -- Signed once, so a retry after a crash sends the same bytes.
  greeting   TEXT,
  PRIMARY KEY (agent_id, session_id)
);
-- The caller's side: what the other agent's greeting said, and what screening made of it. Nothing shows it until it has a verdict.
CREATE TABLE IF NOT EXISTS greetings (
  agent_id       BLOB NOT NULL REFERENCES agents(agent_id),
  session_id     BLOB NOT NULL,
  sender_id      BLOB NOT NULL,
  body           BLOB,
  verdict        TEXT CHECK (verdict IS NULL OR verdict IN ('allow', 'flagged', 'blocked', 'rejected')),
  verdict_detail TEXT,
  received_at    INTEGER NOT NULL,
  read_at        INTEGER,
  PRIMARY KEY (agent_id, session_id)
);
`;

export type VisitState = "due" | "sent" | "not_sent" | "closed" | "answered";
export interface GreetingRow { agent_id: Uint8Array; session_id: Uint8Array; sender_id: Uint8Array; body: Uint8Array | null; verdict: string | null; verdict_detail: string | null; received_at: number; read_at: number | null }

export const ONE_MESSAGE_LINE = "This inbox only accepts one message per visit. Closing.";

export class Away {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
    store.exec(SCHEMA);
  }

  startVisit(agentId: Uint8Array, sessionId: Uint8Array): void {
    this.#store.prepare("INSERT OR IGNORE INTO away_visits (agent_id, session_id, state) VALUES (?, ?, 'due')").run(agentId, sessionId);
  }

  visit(agentId: Uint8Array, sessionId: Uint8Array): { state: VisitState; greeting: string | null } | undefined {
    return this.#store.prepare("SELECT state, greeting FROM away_visits WHERE agent_id = ? AND session_id = ?").get(agentId, sessionId) as { state: VisitState; greeting: string | null } | undefined;
  }

  setVisit(agentId: Uint8Array, sessionId: Uint8Array, state: VisitState, greeting?: string): void {
    this.#store.prepare("UPDATE away_visits SET state = ?, greeting = COALESCE(?, greeting) WHERE agent_id = ? AND session_id = ?").run(state, greeting ?? null, agentId, sessionId);
  }

  greeting(agentId: Uint8Array, sessionId: Uint8Array): GreetingRow | undefined {
    return this.#store.prepare("SELECT * FROM greetings WHERE agent_id = ? AND session_id = ?").get(agentId, sessionId) as GreetingRow | undefined;
  }

  addGreeting(agentId: Uint8Array, sessionId: Uint8Array, senderId: Uint8Array, body: Uint8Array): void {
    this.#store.prepare("INSERT OR IGNORE INTO greetings (agent_id, session_id, sender_id, body, received_at) VALUES (?, ?, ?, ?, ?)").run(agentId, sessionId, senderId, body, Date.now());
  }

  // One that fails its checks is kept as a fact with no text, so a bad frame isn't checked again at every catch-up.
  rejectGreeting(agentId: Uint8Array, sessionId: Uint8Array, senderId: Uint8Array, why: string): void {
    this.#store.prepare("INSERT OR IGNORE INTO greetings (agent_id, session_id, sender_id, verdict, verdict_detail, received_at) VALUES (?, ?, ?, 'rejected', ?, ?)").run(agentId, sessionId, senderId, why, Date.now());
  }

  setVerdict(agentId: Uint8Array, sessionId: Uint8Array, verdict: string, detail: string): void {
    this.#store.prepare("UPDATE greetings SET verdict = ?, verdict_detail = ? WHERE agent_id = ? AND session_id = ?").run(verdict, detail, agentId, sessionId);
  }

  unscreened(): GreetingRow[] {
    return this.#store.prepare("SELECT * FROM greetings WHERE verdict IS NULL").all() as unknown as GreetingRow[];
  }

  unread(agentId: Uint8Array): GreetingRow[] {
    return this.#store.prepare("SELECT * FROM greetings WHERE agent_id = ? AND read_at IS NULL AND verdict IN ('allow', 'flagged', 'blocked') ORDER BY received_at").all(agentId) as unknown as GreetingRow[];
  }

  all(agentId: Uint8Array): GreetingRow[] {
    return this.#store.prepare("SELECT * FROM greetings WHERE agent_id = ? AND verdict IN ('allow', 'flagged', 'blocked') ORDER BY received_at").all(agentId) as unknown as GreetingRow[];
  }

  markRead(agentId: Uint8Array, sessionId: Uint8Array): void {
    this.#store.prepare("UPDATE greetings SET read_at = ? WHERE agent_id = ? AND session_id = ? AND read_at IS NULL").run(Date.now(), agentId, sessionId);
  }
}

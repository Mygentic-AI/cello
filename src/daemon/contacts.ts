// What one agent knows of the agents it deals with. Keyed on ids, and it never reaches the server.
import type { Store } from "./store.ts";
import { TIER, type Tier } from "./tiers.ts";
import { fingerprint, validateMoniker } from "./who-label.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  agent_id   BLOB NOT NULL REFERENCES agents(agent_id),
  contact_id BLOB NOT NULL,
  tier       INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 4),
  moniker    TEXT,
  last_offered_moniker TEXT,
  away_message TEXT,
  provenance TEXT,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (agent_id, contact_id)
);
CREATE TABLE IF NOT EXISTS contact_rename_notices (
  agent_id     BLOB NOT NULL,
  contact_id   BLOB NOT NULL,
  offered_name TEXT NOT NULL,
  noticed_at   INTEGER NOT NULL,
  PRIMARY KEY (agent_id, contact_id)
);
`;

export interface ContactRow {
  agent_id: Uint8Array;
  contact_id: Uint8Array;
  tier: number;
  moniker: string | null;
  last_offered_moniker: string | null;
  away_message: string | null;
  provenance: string | null;
  added_at: number;
}

export class Contacts {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
    store.exec(SCHEMA);
  }

  get(agentId: Uint8Array, contactId: Uint8Array): ContactRow | undefined {
    return this.#store.prepare("SELECT * FROM contacts WHERE agent_id = ? AND contact_id = ?").get(agentId, contactId) as ContactRow | undefined;
  }

  list(agentId: Uint8Array): ContactRow[] {
    return this.#store.prepare("SELECT * FROM contacts WHERE agent_id = ? ORDER BY added_at, contact_id").all(agentId) as ContactRow[];
  }

  // No row means a stranger. A database that can't be read throws, so a session start fails closed.
  tierOf(agentId: Uint8Array, contactId: Uint8Array): Tier {
    return (this.get(agentId, contactId)?.tier ?? TIER.UNKNOWN) as Tier;
  }

  // A set of named columns on one contact's row, made if there's none yet. A new row is a stranger unless the update says otherwise.
  put(agentId: Uint8Array, contactId: Uint8Array, update: Partial<Pick<ContactRow, "tier" | "moniker" | "last_offered_moniker" | "away_message" | "provenance">>): void {
    const keys = Object.keys(update) as (keyof typeof update)[];
    const columns = ["agent_id", "contact_id", "added_at", ...(keys.includes("tier") ? [] : ["tier"]), ...keys];
    const values = [agentId, contactId, Date.now(), ...(keys.includes("tier") ? [] : [TIER.UNKNOWN]), ...keys.map((k) => update[k])];
    const set = keys.map((k) => `${k} = excluded.${k}`).join(", ");
    const conflict = set ? `DO UPDATE SET ${set}` : "DO NOTHING";
    this.#store.prepare(`INSERT INTO contacts (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT (agent_id, contact_id) ${conflict}`).run(...values);
  }

  remove(agentId: Uint8Array, contactId: Uint8Array): void {
    this.#store.prepare("DELETE FROM contacts WHERE agent_id = ? AND contact_id = ?").run(agentId, contactId);
  }

  // Remembers a name it offers. Only says so if a person named it something else, and only once for each name.
  noteOfferedName(agentId: Uint8Array, contactId: Uint8Array, offered: string): string | undefined {
    if (validateMoniker(offered) === null) return undefined;
    const row = this.get(agentId, contactId);
    if (row?.last_offered_moniker === offered) return undefined;
    if (row) this.put(agentId, contactId, { last_offered_moniker: offered });
    if (!row?.moniker || row.moniker === offered) return undefined;
    this.#store.prepare("INSERT INTO contact_rename_notices (agent_id, contact_id, offered_name, noticed_at) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id, contact_id) DO UPDATE SET offered_name = excluded.offered_name, noticed_at = excluded.noticed_at").run(agentId, contactId, offered, Date.now());
    return `The agent you call ${row.moniker} now calls itself ${offered}. Your name for it hasn't changed.`;
  }

  // Your own name for it always wins. A name it gave itself is never applied by itself, and always says it's self-declared.
  who(agentId: Uint8Array, contactId: Uint8Array, contactHex: string, offered: string | null): { who: string; named_by: "you" | "itself" | "nobody" } {
    const moniker = this.get(agentId, contactId)?.moniker;
    if (moniker) return { who: moniker, named_by: "you" };
    if (offered) return { who: `${offered} (self-declared)`, named_by: "itself" };
    return { who: fingerprint(contactHex), named_by: "nobody" };
  }
}

// The security guards, one set per agent, with its running values written when the agent is created.
// Each change is judged by which way it goes. Tightening is free, and loosening asks a person. The first change to a key
// is judged against the baseline, not the running default, so turning off a check that was never on still asks.
import { LocalError } from "./errors.ts";
import type { Direction } from "./reach.ts";
import type { Store } from "./store.ts";
import { SCRIPTS, isScript } from "../screener/language.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guards (
  agent_id   BLOB NOT NULL REFERENCES agents(agent_id),
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, key)
);
-- Every change to anything that protects this agent, so a weakening shows afterwards, whoever made it.
CREATE TABLE IF NOT EXISTS guard_changes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id  BLOB NOT NULL REFERENCES agents(agent_id),
  key       TEXT NOT NULL,
  from_json TEXT,
  to_json   TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('loosen', 'tighten', 'neutral')),
  confirmed INTEGER NOT NULL,
  at        INTEGER NOT NULL
);
`;

const moreLoose = (from: unknown, to: unknown): Direction => {
  const a = new Set(from as string[]);
  const b = new Set(to as string[]);
  if ([...b].some((v) => !a.has(v))) return "loosen";
  return [...a].some((v) => !b.has(v)) ? "tighten" : "neutral";
};
const offLoosens = (from: unknown, to: unknown): Direction => (from && !to ? "loosen" : !from && to ? "tighten" : "neutral");
const onLoosens = (from: unknown, to: unknown): Direction => (!from && to ? "loosen" : from && !to ? "tighten" : "neutral");

interface Guard { default: unknown; baseline: unknown; describes: string; classify(from: unknown, to: unknown): Direction; coerce(raw: string): unknown }

const bool = (key: string) => (raw: string): boolean => {
  if (raw === "true" || raw === "false") return raw === "true";
  throw new LocalError("bad_argument", `${key} is true or false, not ${raw}`);
};

export const GUARDS: Record<string, Guard> = {
  autonomous_override: { default: false, baseline: false, classify: onLoosens, coerce: bool("autonomous_override"), describes: "whether the agent may send a flagged value with no person present" },
  pii_whitelist: {
    default: [],
    baseline: [],
    classify: moreLoose,
    coerce: (raw) => raw.split(",").map((v) => v.trim()).filter(Boolean),
    describes: "values, such as your own email, that pass without being held. Comma-separated, and an empty string clears it",
  },
  pii_check_email: { default: false, baseline: true, classify: offLoosens, coerce: bool("pii_check_email"), describes: "hold outbound messages with an email address" },
  pii_check_phone: { default: false, baseline: true, classify: offLoosens, coerce: bool("pii_check_phone"), describes: "hold outbound messages with what looks like a phone number. Lists of numbers, such as versions, can look like one" },
  language_allow: {
    default: ["latin"],
    baseline: ["latin"],
    classify: moreLoose,
    coerce: (raw) => {
      const list = raw.split(",").map((v) => v.trim()).filter(Boolean);
      if (list.length === 0) throw new LocalError("bad_argument", `language_allow can't be empty: with language_enforce on, that would refuse every language, including yours. Pass the scripts you read. They are: ${SCRIPTS.join(", ")}`);
      const unknown = list.filter((v) => !isScript(v));
      if (unknown.length > 0) throw new LocalError("bad_argument", `not a script: ${unknown.join(", ")}. language_allow takes scripts, not languages: Greek is greek, Japanese is kana, Chinese is han. They are: ${SCRIPTS.join(", ")}`);
      return list;
    },
    describes: "which scripts count as your languages. Only used when language_enforce is on",
  },
  language_enforce: { default: false, baseline: true, classify: offLoosens, coerce: bool("language_enforce"), describes: "refuse mail outside your languages, instead of delivering it with a note" },
  rate_max_per_window: {
    default: 0,
    baseline: 0,
    classify: (from, to) => {
      const looseness = (v: unknown): number => (v === 0 ? Infinity : v as number);
      return looseness(to) > looseness(from) ? "loosen" : looseness(to) < looseness(from) ? "tighten" : "neutral";
    },
    coerce: (raw) => {
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isInteger(value) || value < 0) throw new LocalError("bad_argument", "rate_max_per_window is a whole number. 0 means no cap");
      return value;
    },
    describes: "how many outbound messages are allowed per window. 0 means no cap",
  },
  rate_window_ms: {
    default: 60_000,
    baseline: 60_000,
    classify: (from, to) => ((to as number) < (from as number) ? "loosen" : (to as number) > (from as number) ? "tighten" : "neutral"),
    coerce: (raw) => {
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) throw new LocalError("bad_argument", "rate_window_ms is a positive whole number of milliseconds");
      return value;
    },
    describes: "the window the outbound cap applies to, in milliseconds. A shorter one lets more through",
  },
};

export interface GuardPlan { key: string; value: unknown; was: unknown; direction: Direction }
export interface ChangeRow { key: string; from_json: string | null; to_json: string; direction: string; confirmed: number; at: number }

export class Guards {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
    store.exec(SCHEMA);
  }

  writeDefaults(agentId: Uint8Array): void {
    for (const [key, guard] of Object.entries(GUARDS)) {
      this.#store.prepare("INSERT OR IGNORE INTO guards (agent_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)").run(agentId, key, JSON.stringify(guard.default), Date.now());
    }
  }

  // Read when it's needed, so a change holds from the next message.
  value<T>(agentId: Uint8Array, key: string): T {
    const row = this.#store.prepare("SELECT value_json FROM guards WHERE agent_id = ? AND key = ?").get(agentId, key) as { value_json: string } | undefined;
    if (!row) throw new LocalError("guard_missing", `this agent has no guard named ${key}`);
    return JSON.parse(row.value_json) as T;
  }

  list(agentId: Uint8Array): unknown[] {
    return Object.entries(GUARDS).map(([key, guard]) => {
      const last = this.#store.prepare("SELECT direction, confirmed, at FROM guard_changes WHERE agent_id = ? AND key = ? ORDER BY id DESC LIMIT 1").get(agentId, key) as { direction: string; confirmed: number; at: number } | undefined;
      return { key, describes: guard.describes, value: this.value(agentId, key), last_change: last ? { direction: last.direction, by_a_person: last.confirmed === 1, at: new Date(last.at).toISOString() } : null };
    });
  }

  plan(agentId: Uint8Array, key: string, raw: string): GuardPlan {
    const guard = GUARDS[key];
    if (!guard) throw new LocalError("unknown_guard", `there's no guard named ${key}. They are: ${Object.keys(GUARDS).join(", ")}`);
    const value = guard.coerce(raw);
    const changedBefore = this.#store.prepare("SELECT 1 FROM guard_changes WHERE agent_id = ? AND key = ? LIMIT 1").get(agentId, key) !== undefined;
    const was = this.value(agentId, key);
    return { key, value, was, direction: guard.classify(changedBefore ? was : guard.baseline, value) };
  }

  apply(agentId: Uint8Array, plan: GuardPlan, confirmed: boolean): void {
    this.#store.transaction(() => {
      this.#store.prepare("UPDATE guards SET value_json = ?, updated_at = ? WHERE agent_id = ? AND key = ?").run(JSON.stringify(plan.value), Date.now(), agentId, plan.key);
      this.record(agentId, plan.key, plan.was, plan.value, plan.direction, confirmed);
    });
  }

  record(agentId: Uint8Array, key: string, from: unknown, to: unknown, direction: Direction, confirmed: boolean): void {
    this.#store.prepare("INSERT INTO guard_changes (agent_id, key, from_json, to_json, direction, confirmed, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(agentId, key, from === undefined ? null : JSON.stringify(from), JSON.stringify(to), direction, confirmed ? 1 : 0, Date.now());
  }

  changes(agentId: Uint8Array, limit: number): ChangeRow[] {
    return this.#store.prepare("SELECT key, from_json, to_json, direction, confirmed, at FROM guard_changes WHERE agent_id = ? ORDER BY id DESC LIMIT ?").all(agentId, limit) as ChangeRow[];
  }
}

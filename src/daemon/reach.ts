// How reachable an agent is to each tier, and its other per-agent settings. Every default is written to the database when
// the agent is created, so moving the database moves all of it. Blocked is fixed at nothing, and takes no settings.
import { LocalError } from "./errors.ts";
import type { Store } from "./store.ts";
import { SETTABLE_TIERS, type SettableTier, TIER, tierName } from "./tiers.ts";

const MIB = 1024 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tier_settings (
  agent_id      BLOB NOT NULL REFERENCES agents(agent_id),
  tier          TEXT NOT NULL CHECK (tier IN ('unknown', 'known', 'whitelisted', 'vip')),
  max_sessions  INTEGER NOT NULL CHECK (max_sessions >= 1),
  max_bytes     INTEGER NOT NULL CHECK (max_bytes >= 1),
  not_accepting INTEGER NOT NULL DEFAULT 0,
  away_text     TEXT,
  -- A byte count starts again after this many minutes of quiet. 0 means it never does.
  bytes_reset_minutes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, tier)
);
CREATE TABLE IF NOT EXISTS agent_settings (
  agent_id   BLOB NOT NULL REFERENCES agents(agent_id),
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, key)
);
CREATE TABLE IF NOT EXISTS refused_callers (
  agent_id         BLOB NOT NULL REFERENCES agents(agent_id),
  contact_id       BLOB NOT NULL,
  first_refused_at INTEGER NOT NULL,
  last_refused_at  INTEGER NOT NULL,
  times            INTEGER NOT NULL,
  last_reason      TEXT NOT NULL,
  last_alarm_at    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, contact_id)
);
`;

const TIER_DEFAULTS: Record<SettableTier, { max_sessions: number; max_bytes: number; bytes_reset_minutes: number }> = {
  unknown: { max_sessions: 3, max_bytes: 25 * MIB, bytes_reset_minutes: 0 },
  known: { max_sessions: 5, max_bytes: 100 * MIB, bytes_reset_minutes: 120 },
  whitelisted: { max_sessions: 20, max_bytes: 500 * MIB, bytes_reset_minutes: 120 },
  vip: { max_sessions: 50, max_bytes: 2048 * MIB, bytes_reset_minutes: 120 },
};

export const CALLING_RAISES_KEY = "contacts.calling_raises_to_known";

// loosensWhen: which way needs a person. Text settings go neither way. A switch loosens when it's turned on.
interface AgentSetting { default: string; kind: "number" | "text" | "switch"; neutral?: boolean; min?: number; max?: number; loosensWhen?: "higher" | "lower"; description: string }

export const AGENT_SETTINGS: Record<string, AgentSetting> = {
  // Ruled off on 4 November: a lure could get itself raised just by persuading an agent to dial it.
  [CALLING_RAISES_KEY]: { default: "false", kind: "switch", description: "Whether this agent calling a stranger raises it to known. Replying to one always does." },
  "limits.stranger_pool": { default: "50", kind: "number", min: 1, max: 100_000, loosensWhen: "higher", description: "Open sessions all strangers together can have with this agent." },
  "limits.quiet_minutes": { default: "120", kind: "number", min: 1, max: 5_256_000, loosensWhen: "lower", description: "A session stops counting toward its caller's limit after this long with nothing new. It stays open." },
  "limits.cap_alarm_minutes": { default: "10", kind: "number", min: 0, max: 100_000, description: "The shortest gap between two notices that one caller keeps hitting a limit." },
  "away.answering": { default: "true", kind: "switch", neutral: true, description: "Whether a call nobody is reachable for gets a greeting, and its first message ends the visit. Off, such a call just waits." },
  "away.default": { default: "", kind: "text", description: "This agent's own away text, for any tier without its own." },
  "away.system.stranger": { default: "Dispatched.", kind: "text", description: "The away text of last resort, for a stranger." },
  "away.system.known": { default: "{name} is currently away. Leave a message (send with signal: wrap to close) and it will be read when they return.", kind: "text", description: "The away text of last resort, for a known caller. {name} is this agent's name." },
  "away.max_chars": { default: "2048", kind: "number", min: 1, max: 100_000, description: "The longest away text allowed." },
  "policy.text_max": { default: "2000", kind: "number", min: 1, max: 100_000, description: "The longest written policy allowed." },
  "policy.every_n": { default: "10", kind: "number", min: 1, max: 100_000, description: "A conduct policy rides on a delivery again after this many messages, unless the policy says otherwise." },
  "policy.proposal_hours": { default: "24", kind: "number", min: 1, max: 100_000, description: "How long a proposed policy waits for approval before it's dropped." },
};

export interface TierRow { tier: SettableTier; max_sessions: number; max_bytes: number; not_accepting: number; away_text: string | null; bytes_reset_minutes: number }

export interface Limits { max_sessions: number; max_bytes: number; shut: boolean; bytes_reset_minutes: number }

const FIELDS = ["max_sessions", "max_bytes", "not_accepting", "bytes_reset_minutes"] as const;
type Field = (typeof FIELDS)[number];

// Which way a change goes. Only "loosen" needs a person.
export type Direction = "loosen" | "tighten" | "neutral";

const byMagnitude = (from: number, to: number): Direction => (to > from ? "loosen" : to < from ? "tighten" : "neutral");

// 0 never resets, the tightest. Otherwise a shorter wait gives the sender room back sooner.
function resetDirection(from: number, to: number): Direction {
  const wait = (minutes: number): number => (minutes === 0 ? Infinity : minutes);
  return wait(to) < wait(from) ? "loosen" : wait(to) > wait(from) ? "tighten" : "neutral";
}

export interface SettingChange { direction: Direction; from: string; to: string; apply(): void }

function parseKey(key: string): { tier: SettableTier; field: Field } | { tier: SettableTier; field: "away" } | undefined {
  const parts = key.split(".");
  if (parts[0] === "bounds" && parts.length === 3 && SETTABLE_TIERS.includes(parts[1] as SettableTier) && FIELDS.includes(parts[2] as Field)) return { tier: parts[1] as SettableTier, field: parts[2] as Field };
  if (parts[0] === "away" && parts[1] === "tier" && parts.length === 3 && SETTABLE_TIERS.includes(parts[2] as SettableTier)) return { tier: parts[2] as SettableTier, field: "away" };
  return undefined;
}

export class Reach {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
    store.exec(SCHEMA);
  }

  writeDefaults(agentId: Uint8Array): void {
    const now = Date.now();
    this.#store.transaction(() => {
      for (const tier of SETTABLE_TIERS) {
        const d = TIER_DEFAULTS[tier];
        this.#store.prepare("INSERT OR IGNORE INTO tier_settings (agent_id, tier, max_sessions, max_bytes, bytes_reset_minutes) VALUES (?, ?, ?, ?, ?)").run(agentId, tier, d.max_sessions, d.max_bytes, d.bytes_reset_minutes);
      }
      for (const [key, setting] of Object.entries(AGENT_SETTINGS)) {
        this.#store.prepare("INSERT OR IGNORE INTO agent_settings (agent_id, key, value, updated_at) VALUES (?, ?, ?, ?)").run(agentId, key, setting.default, now);
      }
    });
  }

  tiers(agentId: Uint8Array): TierRow[] {
    return this.#store.prepare("SELECT tier, max_sessions, max_bytes, not_accepting, away_text, bytes_reset_minutes FROM tier_settings WHERE agent_id = ? ORDER BY max_sessions").all(agentId) as TierRow[];
  }

  #row(agentId: Uint8Array, tier: SettableTier): TierRow {
    const row = this.#store.prepare("SELECT tier, max_sessions, max_bytes, not_accepting, away_text, bytes_reset_minutes FROM tier_settings WHERE agent_id = ? AND tier = ?").get(agentId, tier) as TierRow | undefined;
    if (!row) throw new LocalError("settings_missing", `this agent has no settings for the ${tier} tier`);
    return row;
  }

  // What holds for a caller at this tier right now. A shut tier and a block are both nothing at all, whatever numbers are stored.
  limitsFor(agentId: Uint8Array, tier: number): Limits {
    if (tier === TIER.BLOCKED) return { max_sessions: 0, max_bytes: 0, shut: true, bytes_reset_minutes: 0 };
    const row = this.#row(agentId, tierName(tier) as SettableTier);
    if (row.not_accepting === 1) return { max_sessions: 0, max_bytes: 0, shut: true, bytes_reset_minutes: 0 };
    return { max_sessions: row.max_sessions, max_bytes: row.max_bytes, shut: false, bytes_reset_minutes: row.bytes_reset_minutes };
  }

  setting(agentId: Uint8Array, key: string): string {
    const row = this.#store.prepare("SELECT value FROM agent_settings WHERE agent_id = ? AND key = ?").get(agentId, key) as { value: string } | undefined;
    if (!row) throw new LocalError("settings_missing", `this agent has no setting named ${key}`);
    return row.value;
  }

  number(agentId: Uint8Array, key: string): number {
    return Number(this.setting(agentId, key));
  }

  settings(agentId: Uint8Array): { key: string; value: string; default: string; description: string }[] {
    return Object.entries(AGENT_SETTINGS).map(([key, s]) => ({ key, value: this.setting(agentId, key), default: s.default, description: s.description }));
  }

  // Works out what a change would do, and does nothing until apply is called. A clear goes back to the default, and is judged the same.
  plan(agentId: Uint8Array, key: string, raw: string | null): SettingChange {
    const parsed = parseKey(key);
    if (parsed) return this.#planTier(agentId, parsed.tier, parsed.field, key, raw);
    const setting = AGENT_SETTINGS[key];
    if (!setting) throw new LocalError("bad_setting", `there's no setting named ${key}. They're listed by: cello-v2 settings --agent <name>`);
    const to = raw ?? setting.default;
    const from = this.setting(agentId, key);
    const write = (): void => { this.#store.prepare("UPDATE agent_settings SET value = ?, updated_at = ? WHERE agent_id = ? AND key = ?").run(to, Date.now(), agentId, key); };
    if (setting.kind === "switch") {
      if (to !== "true" && to !== "false") throw new LocalError("bad_setting", `${key} must be exactly "true" or "false"`);
      return { direction: from === to || setting.neutral ? "neutral" : to === "true" ? "loosen" : "tighten", from, to, apply: write };
    }
    if (setting.kind === "number") {
      const value = Number(to);
      if (!Number.isInteger(value) || value < (setting.min as number) || value > (setting.max as number)) throw new LocalError("bad_setting", `${key} must be a whole number from ${setting.min as number} to ${setting.max as number}, not ${to}`);
    } else if (key.startsWith("away.") && to.length > this.number(agentId, "away.max_chars")) {
      throw new LocalError("bad_setting", `an away message must be ${this.setting(agentId, "away.max_chars")} characters or fewer`);
    }
    const by = byMagnitude(Number(from), Number(to));
    const direction: Direction = setting.loosensWhen === "higher" ? by : setting.loosensWhen === "lower" ? (by === "loosen" ? "tighten" : by === "tighten" ? "loosen" : "neutral") : "neutral";
    return { direction, from, to, apply: write };
  }

  #planTier(agentId: Uint8Array, tier: SettableTier, field: Field | "away", key: string, raw: string | null): SettingChange {
    const row = this.#row(agentId, tier);
    const write = (column: string, value: unknown): void => { this.#store.prepare(`UPDATE tier_settings SET ${column} = ? WHERE agent_id = ? AND tier = ?`).run(value, agentId, tier); };
    if (field === "away") {
      const text = raw === null || raw.trim() === "" ? null : raw;
      if (text && text.length > this.number(agentId, "away.max_chars")) throw new LocalError("bad_setting", `an away message must be ${this.setting(agentId, "away.max_chars")} characters or fewer`);
      return { direction: "neutral", from: row.away_text ?? "", to: text ?? "", apply: () => write("away_text", text) };
    }
    if (field === "not_accepting") {
      const to = raw ?? "false";
      if (to !== "true" && to !== "false") throw new LocalError("bad_setting", `${key} must be exactly "true" (shut this tier) or "false" (re-open it)`);
      const was = row.not_accepting === 1;
      const shut = to === "true";
      return { direction: was && !shut ? "loosen" : !was && shut ? "tighten" : "neutral", from: String(was), to, apply: () => write("not_accepting", shut ? 1 : 0) };
    }
    const to = raw ?? String(TIER_DEFAULTS[tier][field]);
    if (field === "bytes_reset_minutes") {
      if (!/^(0|[1-9][0-9]*)$/.test(to) || Number(to) > Number.MAX_SAFE_INTEGER) throw new LocalError("bad_setting", `${key} must be a whole number of minutes, or 0 for never`);
      return { direction: resetDirection(row[field], Number(to)), from: String(row[field]), to, apply: () => write(field, Number(to)) };
    }
    if (!/^[1-9][0-9]*$/.test(to) || Number(to) > Number.MAX_SAFE_INTEGER) {
      throw new LocalError("bad_setting", `a limit must be a positive whole number. To shut this tier, set bounds.${tier}.not_accepting to true, and every caller it refuses is told the agent isn't accepting connections.`);
    }
    return { direction: byMagnitude(row[field], Number(to)), from: String(row[field]), to, apply: () => write(field, Number(to)) };
  }

  // Says whether the owner is due a notice about this caller. The cooldown is stored here, so a restart doesn't repeat one.
  // A refusal that tells nobody doesn't start the clock, or the owner would miss the limit that follows it.
  addRefusal(agentId: Uint8Array, contactId: Uint8Array, reason: string, tells: boolean, cooldownMs: number): boolean {
    const now = Date.now();
    const last = (this.#store.prepare("SELECT last_alarm_at FROM refused_callers WHERE agent_id = ? AND contact_id = ?").get(agentId, contactId) as { last_alarm_at: number } | undefined)?.last_alarm_at ?? 0;
    const due = tells && now - last >= cooldownMs;
    this.#store.prepare("INSERT INTO refused_callers (agent_id, contact_id, first_refused_at, last_refused_at, times, last_reason, last_alarm_at) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT (agent_id, contact_id) DO UPDATE SET last_refused_at = excluded.last_refused_at, times = times + 1, last_reason = excluded.last_reason, last_alarm_at = excluded.last_alarm_at").run(agentId, contactId, now, now, reason, due ? now : last);
    return due;
  }

  offeredName(agentId: Uint8Array): string | undefined {
    return (this.#store.prepare("SELECT value FROM agent_settings WHERE agent_id = ? AND key = 'self.offered_name'").get(agentId) as { value: string } | undefined)?.value;
  }

  setOfferedName(agentId: Uint8Array, name: string): void {
    this.#store.prepare("INSERT INTO agent_settings (agent_id, key, value, updated_at) VALUES (?, 'self.offered_name', ?, ?) ON CONFLICT (agent_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(agentId, name, Date.now());
  }

  refusals(agentId: Uint8Array): { contact_id: Uint8Array; first_refused_at: number; last_refused_at: number; times: number; last_reason: string }[] {
    return this.#store.prepare("SELECT contact_id, first_refused_at, last_refused_at, times, last_reason FROM refused_callers WHERE agent_id = ? ORDER BY last_refused_at DESC").all(agentId) as never;
  }

  forgetRefusal(agentId: Uint8Array, contactId: Uint8Array): void {
    this.#store.prepare("DELETE FROM refused_callers WHERE agent_id = ? AND contact_id = ?").run(agentId, contactId);
  }
}

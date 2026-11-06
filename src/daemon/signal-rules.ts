// Rules that judge a call by the signals the other side showed with it. Deterministic: no model, no network, no payload.
// One kind of rule, two directions. Inbound judges who called this agent, by the set they sent. Outbound judges who this agent called, by the set that came back.
// Ported from v1's signal floor, with one change that matters: only a signal from an issuer that counts here counts toward a rule. An issuer
// nobody recognises can say anything, so its signals stay visible and never satisfy a requirement.
import type { Store } from "./store.ts";
import { type TierName, SETTABLE_TIERS } from "./tiers.ts";

export type RuleDirection = "inbound" | "outbound";
export type RuleScope = "default" | "tier" | "contact";
export const RULE_DIRECTIONS: readonly RuleDirection[] = ["inbound", "outbound"];
export const RULE_SCOPES: readonly RuleScope[] = ["default", "tier", "contact"];
export const ISSUER_KINDS = ["issuer", "agent"] as const;

export interface SignalRule {
  // Every one of these types must be shown.
  require_types: string[];
  // At least one shown signal must come from this kind of issuer.
  require_issuer_kind: (typeof ISSUER_KINDS)[number] | null;
  // At least this many shown signals. Signals from the agent's own operator never count toward a rule.
  min_count: number;
}

export const NO_RULE: SignalRule = { require_types: [], require_issuer_kind: null, min_count: 0 };
export const isNoRule = (rule: SignalRule): boolean => rule.require_types.length === 0 && rule.require_issuer_kind === null && rule.min_count === 0;

export interface RuleRow extends SignalRule { direction: RuleDirection; scope: RuleScope; target: string; updated_at: number }

export function ensureRulesSchema(db: Store): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS signal_rules (
  agent_id            BLOB NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  scope               TEXT NOT NULL CHECK (scope IN ('default', 'tier', 'contact')),
  target              TEXT NOT NULL DEFAULT '',
  require_types       TEXT NOT NULL,
  require_issuer_kind TEXT CHECK (require_issuer_kind IS NULL OR require_issuer_kind IN ('issuer', 'agent')),
  min_count           INTEGER NOT NULL CHECK (min_count >= 0),
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (agent_id, direction, scope, target)
);`);
}

// Strictness is a partial order: one rule is at least as strict as another if everything the other asks, it asks too. Two rules that ask for different
// things don't compare, and swapping one for the other counts as weakening, because something that used to be required no longer is.
export function atLeastAsStrict(a: SignalRule, b: SignalRule): boolean {
  if (a.min_count < b.min_count) return false;
  if (b.require_issuer_kind !== null && a.require_issuer_kind !== b.require_issuer_kind) return false;
  return b.require_types.every((type) => a.require_types.includes(type));
}

export interface Evaluation {
  pass: boolean;
  missing_types?: string[];
  missing_issuer_kind?: boolean;
  counted?: number;
  // Shown signals that were left out of the count, and why, so a person can see why a call that looked fine was refused.
  not_counted_unrecognised?: number;
  not_counted_same_operator?: number;
}

interface Shown { type: string; issuer_kind: string; counts_as_verified: boolean; same_operator: boolean }

export function evaluate(rule: SignalRule, shown: readonly Shown[]): Evaluation {
  const recognised = shown.filter((s) => s.counts_as_verified);
  const unrecognised = shown.length - recognised.length;
  const countable = recognised.filter((s) => !s.same_operator);
  const base = { counted: countable.length, ...(unrecognised > 0 ? { not_counted_unrecognised: unrecognised } : {}), ...(recognised.length !== countable.length ? { not_counted_same_operator: recognised.length - countable.length } : {}) };
  if (rule.min_count > 0 && countable.length < rule.min_count) return { pass: false, ...base };
  // The same signals count toward all three demands: one from the agent's own operator can't satisfy a type or a kind of issuer any more than a minimum.
  if (rule.require_issuer_kind !== null && !countable.some((s) => s.issuer_kind === rule.require_issuer_kind)) return { pass: false, missing_issuer_kind: true, ...base };
  const present = new Set(countable.map((s) => s.type));
  const missing = rule.require_types.filter((type) => !present.has(type));
  if (missing.length > 0) return { pass: false, missing_types: missing, ...base };
  return { pass: true, ...base };
}

const HEX64 = /^[0-9a-f]{64}$/;

export class SignalRules {
  readonly #db: ReturnType<Store["raw"]>;

  constructor(store: Store) {
    ensureRulesSchema(store);
    this.#db = store.raw();
  }

  get(agentId: Uint8Array, direction: RuleDirection, scope: RuleScope, target: string): RuleRow | undefined {
    const row = this.#db.get("SELECT * FROM signal_rules WHERE agent_id = ? AND direction = ? AND scope = ? AND target = ?", [agentId, direction, scope, target]) as (Omit<RuleRow, "require_types"> & { require_types: string }) | undefined;
    return row ? { ...row, require_types: JSON.parse(row.require_types) as string[] } : undefined;
  }

  list(agentId: Uint8Array): RuleRow[] {
    return (this.#db.all("SELECT * FROM signal_rules WHERE agent_id = ? ORDER BY direction, scope, target", [agentId]) as (Omit<RuleRow, "require_types"> & { require_types: string })[]).map((row) => ({ ...row, require_types: JSON.parse(row.require_types) as string[] }));
  }

  put(agentId: Uint8Array, direction: RuleDirection, scope: RuleScope, target: string, rule: SignalRule): void {
    this.#db.run(
      `INSERT INTO signal_rules (agent_id, direction, scope, target, require_types, require_issuer_kind, min_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, direction, scope, target) DO UPDATE SET require_types = excluded.require_types, require_issuer_kind = excluded.require_issuer_kind, min_count = excluded.min_count, updated_at = excluded.updated_at`,
      [agentId, direction, scope, target, JSON.stringify([...new Set(rule.require_types)].sort()), rule.require_issuer_kind, rule.min_count, Date.now()],
    );
  }

  clear(agentId: Uint8Array, direction: RuleDirection, scope: RuleScope, target: string): boolean {
    const had = this.get(agentId, direction, scope, target) !== undefined;
    this.#db.run("DELETE FROM signal_rules WHERE agent_id = ? AND direction = ? AND scope = ? AND target = ?", [agentId, direction, scope, target]);
    return had;
  }

  // Most specific first: this contact, then its tier, then the agent's default. No rule anywhere means nothing is required.
  resolve(agentId: Uint8Array, direction: RuleDirection, tier: TierName, contactHex: string | null, without?: { scope: RuleScope; target: string }): { rule: SignalRule; level: RuleScope | "none" } {
    const skip = (scope: RuleScope, target: string): boolean => without?.scope === scope && without.target === target;
    if (contactHex !== null && !skip("contact", contactHex)) {
      const contact = this.get(agentId, direction, "contact", contactHex);
      if (contact) return { rule: contact, level: "contact" };
    }
    if (!skip("tier", tier)) {
      const byTier = this.get(agentId, direction, "tier", tier);
      if (byTier) return { rule: byTier, level: "tier" };
    }
    if (!skip("default", "")) {
      const fallback = this.get(agentId, direction, "default", "");
      if (fallback) return { rule: fallback, level: "default" };
    }
    return { rule: NO_RULE, level: "none" };
  }

  // Whether putting `next` at this key (or clearing it, with null) would let through something that is stopped now, for anyone it covers.
  // The people it covers: every tier for the default, one tier for a tier, one contact for a contact (at the tier it has now).
  weakens(agentId: Uint8Array, direction: RuleDirection, scope: RuleScope, target: string, next: SignalRule | null, contactTier: TierName): boolean {
    const subjects: { tier: TierName; contact: string | null }[] = scope === "default" ? SETTABLE_TIERS.map((tier) => ({ tier, contact: null })) : scope === "tier" ? [{ tier: target as TierName, contact: null }] : [{ tier: contactTier, contact: target }];
    return subjects.some((subject) => {
      const before = this.resolve(agentId, direction, subject.tier, subject.contact).rule;
      const after = next !== null ? this.#resolveWith(agentId, direction, subject, scope, target, next) : this.resolve(agentId, direction, subject.tier, subject.contact, { scope, target }).rule;
      return !atLeastAsStrict(after, before);
    });
  }

  #resolveWith(agentId: Uint8Array, direction: RuleDirection, subject: { tier: TierName; contact: string | null }, scope: RuleScope, target: string, next: SignalRule): SignalRule {
    // The changed key wins at its own level, and the levels above it still lose to anything more specific.
    if (subject.contact !== null && (scope !== "contact" || target !== subject.contact)) {
      const contact = this.get(agentId, direction, "contact", subject.contact);
      if (contact) return contact;
    }
    if (scope === "contact") return next;
    if (scope === "tier" && target === subject.tier) return next;
    const byTier = this.get(agentId, direction, "tier", subject.tier);
    if (byTier) return byTier;
    return scope === "default" ? next : (this.get(agentId, direction, "default", "") ?? NO_RULE);
  }

  static checkTarget(scope: RuleScope, target: string | undefined): string {
    if (scope === "default") return "";
    if (scope === "tier") {
      if (target === undefined || !(SETTABLE_TIERS as readonly string[]).includes(target)) throw new RangeError(`a tier rule needs a tier: ${SETTABLE_TIERS.join(", ")}`);
      return target;
    }
    if (target === undefined || !HEX64.test(target.toLowerCase())) throw new RangeError("a contact rule needs the contact's agent_id, 64 hex characters");
    return target.toLowerCase();
  }
}

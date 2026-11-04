import { toHex } from "../protocol/encode.ts";
import { logEvent } from "./log.ts";
import type { Reach } from "./reach.ts";
import type { Store } from "./store.ts";
import { SETTABLE_TIERS as SETTABLE_TIER_NAMES } from "./tiers.ts";

export type PolicyType = "admission" | "conduct";
export type PolicyScope = "default" | "tier" | "contact";
export type PolicyLevel = "contact" | "tier" | "default";
export interface ResolvedPolicy { type: PolicyType; level: PolicyLevel; text: string; everyN: number }
export interface PolicyRow {
  scope: PolicyScope; target: string; type: PolicyType; mode: "text" | "none";
  text: string | null; every_n: number; updated_at: number;
}
export type PolicyValue = { mode: "text"; text: string } | { mode: "none" };

export const POLICY_SCOPES: readonly PolicyScope[] = ["default", "tier", "contact"];
export const POLICY_TYPES: readonly PolicyType[] = ["admission", "conduct"];

export class PolicyValidationError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
    this.name = "PolicyValidationError";
  }
}

export function ensurePolicySchema(db: Store): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_policies (
      agent_id   BLOB    NOT NULL,
      scope      TEXT    NOT NULL CHECK (scope IN ('default','tier','contact','channel','channel_default')),
      target     TEXT    NOT NULL DEFAULT '',
      type       TEXT    NOT NULL CHECK (type IN ('admission','conduct')),
      mode       TEXT    NOT NULL CHECK (mode IN ('text','none')),
      text       TEXT,
      every_n    INTEGER NOT NULL DEFAULT 10 CHECK (every_n >= 1),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, scope, target, type)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_policy_proposals (
      agent_id    BLOB    NOT NULL,
      proposal_id TEXT    NOT NULL,
      scope       TEXT    NOT NULL, target TEXT NOT NULL DEFAULT '', type TEXT NOT NULL,
      action      TEXT    NOT NULL CHECK (action IN ('set','clear')),
      mode        TEXT    CHECK (mode IN ('text','none')),
      text        TEXT,
      every_n     INTEGER CHECK (every_n IS NULL OR every_n >= 1),
      proposed_by TEXT    NOT NULL CHECK (proposed_by IN ('agent','operator')),
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (agent_id, proposal_id),
      UNIQUE (agent_id, scope, target, type)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_policy_proposal_seq (
      agent_id BLOB    PRIMARY KEY,
      last     INTEGER NOT NULL
    )
  `);
}

const HEX64 = /^[0-9a-f]{64}$/;

export class PolicyStore {
  readonly #db: Store;
  readonly #reach: Reach;
  constructor(db: Store, reach: Reach) {
    this.#db = db;
    this.#reach = reach;
    ensurePolicySchema(db);
  }

  set(agentId: Uint8Array, scope: PolicyScope, target: string, type: PolicyType, value: PolicyValue, everyN?: number): void {
    const { target: t, text, everyN: n } = this.validate(agentId, scope, target, type, value, everyN);
    this.#db.prepare(
      `INSERT INTO agent_policies (agent_id, scope, target, type, mode, text, every_n, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, scope, target, type) DO UPDATE SET
         mode = excluded.mode, text = excluded.text, every_n = excluded.every_n, updated_at = excluded.updated_at`,
    ).run(agentId, scope, t, type, value.mode, text, n, Date.now());
    logEvent("policy.set", { agent: toHex(agentId), scope, target: t, type, mode: value.mode });
  }

  get(agentId: Uint8Array, scope: PolicyScope, target: string, type: PolicyType): PolicyRow | null {
    return (this.#db.prepare(
      "SELECT scope, target, type, mode, text, every_n, updated_at FROM agent_policies WHERE agent_id = ? AND scope = ? AND target = ? AND type = ?",
    ).get(agentId, scope, target, type) as PolicyRow | undefined) ?? null;
  }

  validate(
    agentId: Uint8Array, scope: PolicyScope, target: string, type: PolicyType, value?: PolicyValue, everyN?: number,
  ): { target: string; text: string | null; everyN: number } {
    const t = this.#validateKey(scope, target, type);
    let text: string | null = null;
    const defaultEveryN = this.#reach.number(agentId, "policy.every_n");
    if (value === undefined) return { target: t, text, everyN: defaultEveryN };
    if (value.mode === "text") {
      if (value.text.trim() === "") {
        throw new PolicyValidationError("policy_text_empty", "The policy text is empty. Use NONE (--none) to send nothing.");
      }
      const max = this.#reach.number(agentId, "policy.text_max");
      if (value.text.length > max) {
        throw new PolicyValidationError("policy_text_too_long", `The policy text is ${value.text.length} characters; the limit is ${max}.`);
      }
      text = value.text;
    } else if (value.mode !== "none") {
      throw new PolicyValidationError("policy_mode_unknown", "A policy is either text or NONE.");
    }
    const n = everyN ?? defaultEveryN;
    if (!Number.isInteger(n) || n < 1) {
      throw new PolicyValidationError("policy_every_n_invalid", `every_n must be an integer of at least 1, got ${String(everyN)}.`);
    }
    return { target: t, text, everyN: n };
  }

  clear(agentId: Uint8Array, scope: PolicyScope, target: string, type: PolicyType): boolean {
    const t = this.#validateKey(scope, target, type);
    const removed = this.get(agentId, scope, t, type) !== null;
    this.#db.prepare(
      "DELETE FROM agent_policies WHERE agent_id = ? AND scope = ? AND target = ? AND type = ?",
    ).run(agentId, scope, t, type);
    logEvent("policy.cleared", { agent: toHex(agentId), scope, target: t, type, mode: removed ? "removed" : "absent" });
    return removed;
  }

  list(agentId: Uint8Array): PolicyRow[] {
    return this.#db.prepare(
      "SELECT scope, target, type, mode, text, every_n, updated_at FROM agent_policies WHERE agent_id = ? ORDER BY scope, target, type",
    ).all(agentId) as PolicyRow[];
  }

  resolveSession(agentId: Uint8Array, type: PolicyType, peerPubkeyHex: string, tierName: string): ResolvedPolicy | null {
    const walk: Array<[PolicyScope, string]> = [["contact", peerPubkeyHex.toLowerCase()], ["tier", tierName], ["default", ""]];
    return this.#walk(agentId, type, walk);
  }

  #walk(agentId: Uint8Array, type: PolicyType, walk: Array<[PolicyScope, string]>): ResolvedPolicy | null {
    const stmt = this.#db.prepare(
      "SELECT mode, text, every_n FROM agent_policies WHERE agent_id = ? AND scope = ? AND target = ? AND type = ?",
    );
    for (const [scope, target] of walk) {
      const row = stmt.get(agentId, scope, target, type) as { mode: string; text: string | null; every_n: number } | undefined;
      if (!row) continue;
      if (row.mode === "none") return null;
      return { type, level: scope, text: row.text ?? "", everyN: row.every_n };
    }
    return null;
  }

  #validateKey(scope: PolicyScope, target: string, type: PolicyType): string {
    if (!POLICY_SCOPES.includes(scope)) {
      throw new PolicyValidationError("policy_scope_unknown", `Unknown scope '${String(scope)}'. Use one of: ${POLICY_SCOPES.join(", ")}.`);
    }
    if (!POLICY_TYPES.includes(type)) {
      throw new PolicyValidationError("policy_type_unknown", `Unknown type '${String(type)}'. Use admission or conduct.`);
    }
    if (scope === "default") {
      if (target !== "") throw new PolicyValidationError("policy_target_invalid", `Scope '${scope}' takes no target.`);
      return "";
    }
    if (scope === "tier") {
      if (!(SETTABLE_TIER_NAMES as readonly string[]).includes(target)) {
        throw new PolicyValidationError("policy_target_invalid", `'${target}' is not a tier. Use one of: ${SETTABLE_TIER_NAMES.join(", ")}.`);
      }
      return target;
    }
    if (!HEX64.test(target)) {
      throw new PolicyValidationError("policy_target_invalid", `A ${scope} target is a public key: 64 lowercase hex characters.`);
    }
    return target;
  }
}

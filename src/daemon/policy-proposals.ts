import { toHex } from "../protocol/encode.ts";
import { logEvent } from "./log.ts";
import type { Reach } from "./reach.ts";
import type { Store } from "./store.ts";
import type { PolicyRow, PolicyScope, PolicyStore, PolicyType, PolicyValue } from "./policy-store.ts";

const HOUR_MS = 60 * 60 * 1000;

export type ProposedBy = "agent" | "operator";

export interface ProposalInput {
  scope: PolicyScope; target: string; type: PolicyType;
  action: "set" | "clear"; value?: PolicyValue; everyN?: number;
}

export interface PolicyProposal {
  proposal_id: string; scope: PolicyScope; target: string; type: PolicyType;
  action: "set" | "clear"; mode: "text" | "none" | null; text: string | null; every_n: number | null;
  proposed_by: ProposedBy; created_at: number;
}

export type ApproveResult =
  | { ok: true; proposal: PolicyProposal }
  | { ok: false; reason: "proposal_not_found" };

export class PolicyProposals {
  readonly #db: Store;
  readonly #reach: Reach;
  readonly #policies: PolicyStore;
  readonly #now: () => number;

  constructor(db: Store, reach: Reach, policies: PolicyStore, now: () => number = Date.now) {
    this.#db = db;
    this.#reach = reach;
    this.#policies = policies;
    this.#now = now;
  }

  propose(agentId: Uint8Array, p: ProposalInput, proposedBy: ProposedBy): PolicyProposal {
    const v = this.#policies.validate(agentId, p.scope, p.target, p.type, p.action === "set" ? (p.value ?? { mode: "text", text: "" }) : undefined, p.everyN);
    const id = this.#nextId(agentId);
    const row: PolicyProposal = {
      proposal_id: id, scope: p.scope, target: v.target, type: p.type, action: p.action,
      mode: p.action === "set" ? (p.value?.mode ?? "text") : null,
      text: p.action === "set" ? v.text : null,
      every_n: p.action === "set" ? v.everyN : null,
      proposed_by: proposedBy, created_at: this.#now(),
    };
    this.#db.prepare("DELETE FROM agent_policy_proposals WHERE agent_id = ? AND scope = ? AND target = ? AND type = ?")
      .run(agentId, row.scope, row.target, row.type);
    this.#db.prepare(
      `INSERT INTO agent_policy_proposals (agent_id, proposal_id, scope, target, type, action, mode, text, every_n, proposed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(agentId, id, row.scope, row.target, row.type, row.action, row.mode, row.text, row.every_n, row.proposed_by, row.created_at);
    logEvent("policy.proposed", { agent: toHex(agentId), proposalId: id, scope: row.scope, target: row.target, type: row.type, proposedBy });
    return row;
  }

  pending(agentId: Uint8Array): Array<PolicyProposal & { was: PolicyRow | null }> {
    this.#expire(agentId);
    const rows = this.#db.prepare(
      `SELECT proposal_id, scope, target, type, action, mode, text, every_n, proposed_by, created_at
       FROM agent_policy_proposals WHERE agent_id = ? ORDER BY created_at, proposal_id`,
    ).all(agentId) as PolicyProposal[];
    return rows.map((r) => ({ ...r, was: this.#policies.get(agentId, r.scope, r.target, r.type) }));
  }

  approve(agentId: Uint8Array, proposalId: string): ApproveResult {
    const p = this.#find(agentId, proposalId);
    if (!p) return { ok: false, reason: "proposal_not_found" };
    if (p.action === "clear") {
      this.#policies.clear(agentId, p.scope, p.target, p.type);
    } else {
      const value: PolicyValue = p.mode === "none" ? { mode: "none" } : { mode: "text", text: p.text ?? "" };
      this.#policies.set(agentId, p.scope, p.target, p.type, value, p.every_n ?? undefined);
    }
    this.#delete(agentId, proposalId);
    logEvent("policy.approved", { agent: toHex(agentId), proposalId });
    return { ok: true, proposal: p };
  }

  decline(agentId: Uint8Array, proposalId: string): boolean {
    if (!this.#find(agentId, proposalId)) return false;
    this.#delete(agentId, proposalId);
    logEvent("policy.declined", { agent: toHex(agentId), proposalId });
    return true;
  }

  #find(agentId: Uint8Array, proposalId: string): PolicyProposal | null {
    this.#expire(agentId);
    return (this.#db.prepare(
      `SELECT proposal_id, scope, target, type, action, mode, text, every_n, proposed_by, created_at
       FROM agent_policy_proposals WHERE agent_id = ? AND proposal_id = ?`,
    ).get(agentId, proposalId) as PolicyProposal | undefined) ?? null;
  }

  #delete(agentId: Uint8Array, proposalId: string): void {
    this.#db.prepare("DELETE FROM agent_policy_proposals WHERE agent_id = ? AND proposal_id = ?").run(agentId, proposalId);
  }

  #expire(agentId: Uint8Array): void {
    const cutoff = this.#now() - this.#reach.number(agentId, "policy.proposal_hours") * HOUR_MS;
    const old = this.#db.prepare("SELECT proposal_id FROM agent_policy_proposals WHERE agent_id = ? AND created_at < ?")
      .all(agentId, cutoff) as Array<{ proposal_id: string }>;
    if (old.length === 0) return;
    this.#db.prepare("DELETE FROM agent_policy_proposals WHERE agent_id = ? AND created_at < ?").run(agentId, cutoff);
    for (const o of old) logEvent("policy.expired", { agent: toHex(agentId), proposalId: o.proposal_id });
  }

  #nextId(agentId: Uint8Array): string {
    this.#db.prepare(
      "INSERT INTO agent_policy_proposal_seq (agent_id, last) VALUES (?, 1) ON CONFLICT (agent_id) DO UPDATE SET last = last + 1",
    ).run(agentId);
    const r = this.#db.prepare("SELECT last FROM agent_policy_proposal_seq WHERE agent_id = ?").get(agentId) as { last: number };
    return `p${r.last}`;
  }
}

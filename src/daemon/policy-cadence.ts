// When an operator's policy rides on a delivery: the first since the daemon started, whenever its text changes, and every
// every_n messages after. In memory on purpose: a restart attaches it again on the first delivery, the safe direction.
// A lookup that fails must never look like no policy, so it gives a line the agent reads.
import { toHex } from "../protocol/encode.ts";
import { logEvent } from "./log.ts";
import type { PolicyStore, PolicyType, ResolvedPolicy } from "./policy-store.ts";

export type AttachReason = "first" | "changed" | "cadence";

export interface PolicyField { type: PolicyType; level: ResolvedPolicy["level"]; text: string }

export const POLICY_ERROR_TEXT =
  "Your operator's policy for this peer could not be read, so none is shown here. That is a fault " +
  "on this machine, not a sign that no policy exists — act cautiously and tell your operator.";

export class PolicyCadence {
  readonly #state = new Map<string, { sinceLast: number; lastText: string | null }>();

  shouldAttach(key: string, resolved: ResolvedPolicy, deliveredCount: number): AttachReason | null {
    const s = this.#state.get(key);
    let reason: AttachReason | null;
    if (!s) reason = "first";
    else if (s.lastText !== resolved.text) reason = "changed";
    else if (s.sinceLast + deliveredCount >= resolved.everyN) reason = "cadence";
    else reason = null;
    if (reason === null) {
      (s as { sinceLast: number }).sinceLast += deliveredCount;
    } else {
      this.#state.set(key, { sinceLast: 0, lastText: resolved.text });
    }
    return reason;
  }
}

const field = (r: ResolvedPolicy): { policy: PolicyField } => ({ policy: { type: r.type, level: r.level, text: r.text } });

function failed(agentId: Uint8Array, type: PolicyType, err: unknown): { policy_error: string } {
  logEvent("policy.resolve.failed", { agent: toHex(agentId), type, reason: err instanceof Error ? err.message : String(err) });
  return { policy_error: POLICY_ERROR_TEXT };
}

export function admissionPolicyField(a: { store: PolicyStore; agentId: Uint8Array; peerHex: string; tierName: string }): { policy?: PolicyField; policy_error?: string } {
  try {
    const r = a.store.resolveSession(a.agentId, "admission", a.peerHex, a.tierName);
    return r ? field(r) : {};
  } catch (err: unknown) {
    return failed(a.agentId, "admission", err);
  }
}

export function attachConductPolicy(a: { store: PolicyStore; cadence: PolicyCadence; agentId: Uint8Array; sessionHex: string; peerHex: string; tierName: string; count: number }): { policy?: PolicyField; policy_error?: string } {
  let r: ResolvedPolicy | null;
  try {
    r = a.store.resolveSession(a.agentId, "conduct", a.peerHex, a.tierName);
  } catch (err: unknown) {
    return failed(a.agentId, "conduct", err);
  }
  if (!r || a.count <= 0) return {};
  const reason = a.cadence.shouldAttach(`${toHex(a.agentId)}:${a.sessionHex}`, r, a.count);
  if (reason === null) return {};
  logEvent("policy.attached", { agent: toHex(a.agentId), session: a.sessionHex, type: r.type, level: r.level, reason });
  return field(r);
}

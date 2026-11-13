// What to do about signals running out: tell the agent once, in the last 30 days, and with auto-renew on, renew what can be.
// Pure, so the rules can be tested apart from the wallet. Plan: trustless-cello/docs/planning/rewrite/USAGE-SIGNAL-PLAN.md.

export const RENEW_WINDOW_SECONDS = 30 * 86_400;
// With auto-renew on, Usage is refreshed this often, so the counts others see are never more than a month old.
export const USAGE_REFRESH_SECONDS = 30 * 86_400;
export const TRUST_SITE = "https://trust.celloprotocol.com";

export interface RenewalRow {
  signal_hash: string;
  type: string;
  issued_at: number;
  expires_at: number | null;
  status: string;
  consent_state: string;
}

export interface Expiring { signal_hash: string; type: string; expires_at: number; renew: string }
export interface RenewalPlan { expiring: Expiring[]; requestUsage: boolean; collect: boolean }

const isUsage = (type: string): boolean => type === "usage" || type === "usage_detailed";
const reconnects = (type: string): boolean => /^(github|x)(_|$)/.test(type);

// What a person does to renew this kind of signal, in words.
export function howToRenew(type: string): string {
  if (isUsage(type)) return "To renew it, run: cello signals request usage";
  if (reconnects(type)) return `To renew it, reconnect that account at ${TRUST_SITE}, then run: cello signals collect`;
  return `To renew it, sign in at ${TRUST_SITE}, then run: cello signals collect`;
}

export function renewalPlan(rows: readonly RenewalRow[], now: number, autoRenew: boolean): RenewalPlan {
  const current = rows.filter((r) => r.status === "active" && r.consent_state === "accepted" && r.expires_at !== null && r.expires_at > now);
  const expiring = current
    .filter((r) => (r.expires_at as number) - now <= RENEW_WINDOW_SECONDS)
    .map((r) => ({ signal_hash: r.signal_hash, type: r.type, expires_at: r.expires_at as number, renew: howToRenew(r.type) }));
  // Renewing only renews: an agent that never asked for Usage isn't given it by this setting.
  const usage = current.filter((r) => isUsage(r.type));
  const usageDue = usage.length > 0 && (expiring.some((e) => isUsage(e.type)) || Math.max(...usage.map((r) => r.issued_at)) <= now - USAGE_REFRESH_SECONDS);
  return {
    expiring,
    requestUsage: autoRenew && usageDue,
    collect: autoRenew && expiring.some((e) => !isUsage(e.type)),
  };
}

export function expiryNotice(e: Expiring): string {
  const day = new Date(e.expires_at * 1000).toISOString().slice(0, 10);
  return `This agent's ${e.type} signal expires on ${day}. ${e.renew}`;
}

// What to do about signals running out: tell the agent once, in the last 30 days, and with auto-renew on, renew Usage.
// Only Usage can be renewed without the person: the issuer re-signs other signals with their original expiry until the owner proves
// them again on the trust site, so a collect would renew nothing. Pure, so the rules can be tested apart from the wallet.
// Plan: trustless-cello/docs/planning/rewrite/USAGE-SIGNAL-PLAN.md.

export const RENEW_WINDOW_SECONDS = 30 * 86_400;
// With auto-renew on, Usage is refreshed this often, so the counts others see are never more than a month old.
export const USAGE_REFRESH_SECONDS = 30 * 86_400;
export const TRUST_SITE = "https://trust.celloprotocol.com";

export interface RenewalRow {
  signal_hash: string;
  type: string;
  issuer_address: string;
  issued_at: number;
  expires_at: number | null;
  status: string;
  consent_state: string;
}

export interface Expiring { signal_hash: string; type: string; name: string; expires_at: number; renew: string }
export interface RenewalPlan { expiring: Expiring[]; requestUsage: boolean }

const isUsage = (type: string): boolean => type === "usage" || type === "usage_detailed";

// The name a person reads. Usage's two varieties renew together, so they read as one.
export function plainName(type: string): string {
  if (isUsage(type)) return "Usage";
  if (/^github(_|$)/.test(type)) return "GitHub";
  if (/^x(_|$)/.test(type)) return "X";
  return ({ email: "email", phone: "phone", webauthn: "passkey", totp: "authenticator app" } as Record<string, string>)[type] ?? type;
}

// What a person does to renew this kind of signal, in words. Advice about the trust site is only for signals it issued.
export function howToRenew(type: string, issuerAddress: string, ourIssuer: string): string {
  if (issuerAddress !== ourIssuer) return "To renew it, ask whoever issued it.";
  if (isUsage(type)) return "To renew it, run: cello signals request usage";
  if (/^(github|x)(_|$)/.test(type)) return `To renew it, reconnect that account at ${TRUST_SITE}, then run: cello signals collect`;
  // Signing in renews it there (it proves the owner still holds the address), and the agent then collects the new copy.
  return `Sign in at ${TRUST_SITE} to renew it, then run: cello signals collect`;
}

export function renewalPlan(rows: readonly RenewalRow[], now: number, autoRenew: boolean, ourIssuer: string): RenewalPlan {
  const current = rows.filter((r) => r.status === "active" && r.consent_state === "accepted" && r.expires_at !== null && r.expires_at > now);
  const expiring: Expiring[] = [];
  for (const r of current) {
    if ((r.expires_at as number) - now > RENEW_WINDOW_SECONDS) continue;
    // One line for Usage, not one per variety: they're issued and renewed together.
    if (r.type === "usage_detailed" && current.some((o) => o.type === "usage")) continue;
    expiring.push({ signal_hash: r.signal_hash, type: r.type, name: plainName(r.type), expires_at: r.expires_at as number, renew: howToRenew(r.type, r.issuer_address, ourIssuer) });
  }
  // Renewing only renews: an agent that never asked for Usage isn't given it by this setting.
  const usage = current.filter((r) => isUsage(r.type) && r.issuer_address === ourIssuer);
  const usageDue = usage.length > 0 && (expiring.some((e) => isUsage(e.type)) || Math.max(...usage.map((r) => r.issued_at)) <= now - USAGE_REFRESH_SECONDS);
  return { expiring, requestUsage: autoRenew && usageDue };
}

export function expiryNotice(e: Expiring): string {
  const day = new Date(e.expires_at * 1000).toISOString().slice(0, 10);
  return `This agent's ${e.name} signal expires on ${day}. ${e.renew}`;
}

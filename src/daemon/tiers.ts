// The five tiers. One of an agent's own judgements about one counterparty, and it never leaves this machine.
export const TIER = { BLOCKED: 0, UNKNOWN: 1, KNOWN: 2, WHITELISTED: 3, VIP: 4 } as const;
export type Tier = (typeof TIER)[keyof typeof TIER];
export const TIER_NAMES = ["blocked", "unknown", "known", "whitelisted", "vip"] as const;
export type TierName = (typeof TIER_NAMES)[number];
export const SETTABLE_TIERS = ["unknown", "known", "whitelisted", "vip"] as const;
export type SettableTier = (typeof SETTABLE_TIERS)[number];

export const tierName = (tier: number): TierName => TIER_NAMES[tier] as TierName;

export function tierFromName(name: unknown): Tier | undefined {
  const at = TIER_NAMES.indexOf(name as TierName);
  return at < 0 ? undefined : at as Tier;
}

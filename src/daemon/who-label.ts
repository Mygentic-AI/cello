// The name rule from cello-client, and the short form of a key.
export const MONIKER_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateMoniker(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return MONIKER_RE.test(raw) ? raw : null;
}

export function fingerprint(pubkeyHex: unknown): string {
  const hex = typeof pubkeyHex === "string" && pubkeyHex.length >= 8 ? pubkeyHex.slice(0, 8) : null;
  return hex !== null ? `agent ${hex}…` : "agent unknown…";
}

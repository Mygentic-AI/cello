// The screen on the way out: credentials are redacted, hijack artifacts stop the message, and invisible characters and
// data-carrying image links are removed. It never runs the model. Rewritten from cello-client's screen/outbound.ts.
import { OutboundPIIScreener } from "../daemon/pii.ts";
import { screenOutboundExfil } from "./exfil.ts";
import { redactSecrets } from "./secrets.ts";

export interface OutboundVerdict {
  disposition: "allow" | "redact" | "block" | "hold";
  text: string;
  categories: string[];
  reason: string | null;
  // What a guard holds back until someone agrees, and the agent can rewrite without it. Its own words, going back to it alone.
  held?: { category: string; value: string }[];
}

const PLACEHOLDER_PREFIX = "CELLOPUBKEY";

function indexToLetters(i: number): string {
  let n = i;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// A public key this agent already knows isn't a secret, so it's held out of the detectors and put back afterwards.
export function protectKnownKeys(text: string, keys: readonly string[]): { text: string; restore: (t: string) => string } {
  const identity = { text, restore: (t: string): string => t };
  const canon = [...new Set(keys.map((k) => k.toLowerCase()))].filter((k) => k.length > 0);
  if (canon.length === 0) return identity;
  const pattern = new RegExp(`(?<![0-9a-fA-F])(?:${canon.join("|")})(?![0-9a-fA-F])`, "gi");
  const restoreMap = new Map<string, string>();
  let i = 0;
  const protectedText = text.replace(pattern, (match) => {
    const placeholder = PLACEHOLDER_PREFIX + indexToLetters(i);
    i += 1;
    restoreMap.set(placeholder, match);
    return placeholder;
  });
  if (restoreMap.size === 0) return identity;
  for (const placeholder of restoreMap.keys()) {
    if (text.includes(placeholder)) return identity;
  }
  const ordered = [...restoreMap.keys()].sort((a, b) => b.length - a.length);
  const restore = (t: string): string => {
    let out = t;
    for (const placeholder of ordered) out = out.split(placeholder).join(restoreMap.get(placeholder) as string);
    return out;
  };
  return { text: protectedText, restore };
}

export function screenOutbound(input: string, knownKeys: readonly string[], pii: { whitelist: string[]; email: boolean; phone: boolean } = { whitelist: [], email: false, phone: false }): OutboundVerdict {
  const protection = protectKnownKeys(input, knownKeys);
  const secrets = redactSecrets(protection.text);
  const categories = secrets.findings.map((f) => `secret:${f.ruleId}`);
  const exfil = screenOutboundExfil(new TextEncoder().encode(secrets.text));
  if (exfil.disposition === "block") {
    return { disposition: "block", text: input, categories: exfil.events.map((e) => e.category), reason: exfil.events[0]?.reason ?? "the outbound screen blocked this message" };
  }
  categories.push(...exfil.events.map((e) => e.category));
  const personal = new OutboundPIIScreener({ whitelist: pii.whitelist, checkEmail: pii.email, checkPhone: pii.phone }).screen(new TextEncoder().encode(exfil.text), "");
  if (personal.disposition === "warn") {
    return { disposition: "hold", text: protection.restore(exfil.text), categories, reason: null, held: personal.events.map((e) => ({ category: e.category, value: e.value })) };
  }
  if (categories.length === 0) return { disposition: "allow", text: input, categories, reason: null };
  return { disposition: "redact", text: protection.restore(exfil.text), categories, reason: null };
}

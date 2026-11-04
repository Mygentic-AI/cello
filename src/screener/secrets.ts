import { LinearRegex } from "./linear-regex.ts";
import { GITLEAKS_RULES, GITLEAKS_STOPWORDS, GITLEAKS_ALLOW_REGEXES } from "./gitleaks-rules.ts";

interface CompiledRule { id: string; src: string; re: LinearRegex; keywords: string[]; entropy: number }

let RULES: CompiledRule[] | null = null;

export function secretRuleIds(): string[] | null {
  return RULES === null ? null : RULES.map((r) => r.id);
}
export function secretRuleDigestInputs(): Array<{ id: string; src: string }> | null {
  return RULES === null ? null : RULES.map((r) => ({ id: r.id, src: r.src }));
}

let STOPWORDS: string[] = [];
let ALLOW: LinearRegex[] = [];

export function compileSecretRules(): { compiled: number; total: number } {
  const compiled: CompiledRule[] = [];
  for (const r of GITLEAKS_RULES) {
    try {
      compiled.push({ id: r.id, src: r.regex, re: new LinearRegex(r.regex), keywords: r.keywords, entropy: r.entropy });
    } catch {
    }
  }
  RULES = compiled;
  STOPWORDS = GITLEAKS_STOPWORDS.map((s) => s.toLowerCase());
  ALLOW = GITLEAKS_ALLOW_REGEXES.map((s) => {
    try { return new LinearRegex(s); } catch { return null; }
  }).filter((x): x is LinearRegex => x !== null);
  return { compiled: compiled.length, total: GITLEAKS_RULES.length };
}

export function secretRulesReady(): boolean {
  return RULES !== null;
}

export interface SecretFinding { ruleId: string }
export interface SecretScanResult { text: string; findings: SecretFinding[] }

function shannonBits(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) { const p = c / s.length; h -= p * Math.log2(p); }
  return h;
}

function isFalsePositive(value: string, ruleEntropy: number): boolean {
  const lower = value.toLowerCase();
  if (STOPWORDS.some((sw) => lower.includes(sw))) return true;
  if (ALLOW.some((re) => re.test(value))) return true;
  if (ruleEntropy > 0 && shannonBits(value) < ruleEntropy) return true;
  return false;
}

export function redactSecrets(input: string): SecretScanResult {
  if (!RULES) return { text: input, findings: [] };
  let text = input;
  const findings: SecretFinding[] = [];
  const lowerContent = input.toLowerCase();

  for (const rule of RULES) {
    if (rule.keywords.length > 0 && !rule.keywords.some((k) => lowerContent.includes(k))) continue;

    const secrets = new Set<string>();
    let offset = 0;
    let guard = 0;
    while (offset < text.length && guard++ < 1000) {
      const m = rule.re.exec(text.slice(offset));
      if (!m || m.index === undefined) break;
      const value = (m[1] ?? m[0]) || "";
      if (value && !isFalsePositive(value, rule.entropy)) secrets.add(value);
      offset += m.index + Math.max(1, m[0].length);
    }
    for (const value of secrets) {
      text = text.split(value).join(`[REDACTED:${rule.id}]`);
      findings.push({ ruleId: rule.id });
    }
  }

  return { text, findings };
}

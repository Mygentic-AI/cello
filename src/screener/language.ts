
export type Script =
  | "latin" | "cyrillic" | "greek" | "arabic" | "hebrew" | "han" | "kana" | "hangul"
  | "devanagari" | "thai" | "other";

export const SCRIPTS: readonly Script[] = [
  "latin", "cyrillic", "greek", "arabic", "hebrew", "han", "kana", "hangul",
  "devanagari", "thai", "other",
];
export const isScript = (v: unknown): v is Script => SCRIPTS.includes(v as Script);

export interface LanguageVerdict {
  allowed: boolean;
  script?: Script;
  reason?: string;
}

export interface LanguageOptions {
  allow?: Script[];
  minLetters?: number;
  minShare?: number;
}

export function scriptOf(cp: number): Script | null {
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) ||
      (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe20 && cp <= 0xfe2f)) return null;
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) ||
      (cp >= 0xc0 && cp <= 0x2af) || (cp >= 0x1d00 && cp <= 0x1dbf) || (cp >= 0x1e00 && cp <= 0x1eff) ||
      (cp >= 0x2c60 && cp <= 0x2c7f) || (cp >= 0xa720 && cp <= 0xa7ff)) return "latin";
  if (cp >= 0x400 && cp <= 0x4ff) return "cyrillic";
  if ((cp >= 0x370 && cp <= 0x3ff) || (cp >= 0x1f00 && cp <= 0x1fff)) return "greek";
  if ((cp >= 0x600 && cp <= 0x6ff) || (cp >= 0x750 && cp <= 0x77f)) return "arabic";
  if (cp >= 0x590 && cp <= 0x5ff) return "hebrew";
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) return "han";
  if (cp >= 0x3040 && cp <= 0x30ff) return "kana";
  if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) return "hangul";
  if (cp >= 0x900 && cp <= 0x97f) return "devanagari";
  if (cp >= 0xe00 && cp <= 0xe7f) return "thai";
  if (cp > 0x2bf && !(cp >= 0x2000 && cp <= 0x2bff)) return "other";
  return null;
}

const SCRIPT_LABEL: Record<Script, string> = {
  latin: "Latin", cyrillic: "Cyrillic", greek: "Greek", arabic: "Arabic", hebrew: "Hebrew",
  han: "Han/CJK", kana: "Japanese kana", hangul: "Korean Hangul", devanagari: "Devanagari",
  thai: "Thai", other: "a non-Latin",
};

export function screenInboundLanguage(text: string, opts: LanguageOptions = {}): LanguageVerdict {
  const allow = new Set<Script>(opts.allow ?? ["latin"]);
  const minLetters = opts.minLetters ?? 12;
  const minShare = opts.minShare ?? 0.5;

  const counts = new Map<Script, number>();
  let total = 0;
  for (const ch of text) {
    const s = scriptOf(ch.codePointAt(0)!);
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
    total++;
  }

  if (total < minLetters) return { allowed: true };

  let dominant: Script = "latin";
  let max = 0;
  for (const [s, n] of counts) if (n > max) { max = n; dominant = s; }

  if (allow.has(dominant) || max / total < minShare) return { allowed: true };

  return {
    allowed: false,
    script: dominant,
    reason:
      `This message is predominantly ${SCRIPT_LABEL[dominant]} script, outside the gateway's ` +
      `language allowlist.`,
  };
}

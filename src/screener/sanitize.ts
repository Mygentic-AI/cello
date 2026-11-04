import { AFFORDANCE_PREFIX } from "./affordance.ts";

export const DEFAULT_MAX_BYTES = 1_000_000;

export interface SanitizationNote {
  step: "invisible_strip" | "confusables" | "decode" | "entropy" | "special_tokens" | "forged_marker";
  detail: string;
  count?: number;
}

export interface SanitizeResult {
  text: string;
  scriptScanText: string;
  decodedForScan: string;
  hiddenText: string;
  notes: SanitizationNote[];
  entropySuspicion: number;
  blocked?: { reason: string; guidance: string };
}

export interface SanitizeOptions {
  maxBytes?: number;
}

const SINGLE_SMUGGLE = new Set<number>([
  0x00ad, // soft hyphen
  0x200b, 0x200c, 0x200d, // zero-width space / non-joiner / joiner
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // word joiner + invisible math operators
  0xfeff, // BOM / zero-width no-break space
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // bidi embeddings / overrides / pop
  0x2066, 0x2067, 0x2068, 0x2069, // bidi isolates
]);
function isSmuggled(cp: number): boolean {
  if (SINGLE_SMUGGLE.has(cp)) return true;
  if (cp >= 0xe0000 && cp <= 0xe007f) return true; // Tags block
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true; // variation selectors
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true; // variation selectors supplement
  return false;
}

function hasNoLegitimateUse(cp: number, insideFlagSequence: boolean): boolean {
  if (cp === 0x00ad) return true; // soft hyphen — a typesetting hint that breaks word matching
  if (cp === 0x200b) return true; // zero-width space
  if (cp === 0xfeff) return true; // byte-order mark
  if (cp >= 0x2060 && cp <= 0x2064) return true; // word joiner + invisible operators
  if (cp === 0x202d || cp === 0x202e) return true; // bidi OVERRIDES — display text as what it is not
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true; // variation-selector supplement: the byte channel
  if (cp >= 0xe0000 && cp <= 0xe007f) return !insideFlagSequence; // tags: legitimate only in a flag
  return false;
}

const FLAG_BASE = 0x1f3f4;
const TAG_CANCEL = 0xe007f;

export function stripIllegitimate(text: string): { text: string; removed: number } {
  const chars = [...text];
  const inFlag = new Set<number>();
  for (let i = 0; i < chars.length; i++) {
    if (chars[i]!.codePointAt(0)! !== FLAG_BASE) continue;
    let j = i + 1;
    const run: number[] = [];
    while (j < chars.length) {
      const cp = chars[j]!.codePointAt(0)!;
      if (cp === TAG_CANCEL) { run.push(j); break; }
      if (cp > 0xe0000 && cp < TAG_CANCEL) { run.push(j); j++; continue; }
      break; // a non-tag character ends the candidate; an UNCLOSED run is not a flag
    }
    const closed = run.length > 0 && chars[run[run.length - 1]!]!.codePointAt(0)! === TAG_CANCEL;
    if (closed) for (const k of run) inFlag.add(k);
  }

  let out = "";
  let removed = 0;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]!.codePointAt(0)!;
    if (hasNoLegitimateUse(cp, inFlag.has(i))) { removed++; continue; }
    out += chars[i];
  }
  return { text: out, removed };
}
export function stripInvisible(text: string): { text: string; removed: number } {
  let out = "";
  let removed = 0;
  for (const ch of text) {
    if (isSmuggled(ch.codePointAt(0)!)) { removed++; continue; }
    out += ch;
  }
  return { text: out, removed };
}

const CYRILLIC_GREEK_CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "с": "c", "р": "p", "х": "x",
  "у": "y", "к": "k", "м": "m", "т": "t", "н": "h", "в": "b",
  "и": "u", "ѕ": "s", "і": "i", "ј": "j", "һ": "h", "ԁ": "d",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H",
  "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "Ѕ": "S",
  "І": "I", "Ј": "J",
  "ο": "o", "ν": "v", "α": "a", "ρ": "p", "υ": "u", "κ": "k",
  "Α": "A", "Β": "B", "Ε": "E", "Κ": "K", "Μ": "M", "Ν": "N",
  "Ο": "O", "Ρ": "P", "Τ": "T", "Χ": "X",
};
function normalizeConfusables(text: string): { text: string; changed: boolean; count: number } {
  const nfkc = text.normalize("NFKC");
  let count = 0;
  const mapped = [...nfkc].map((ch) => {
    const r = CYRILLIC_GREEK_CONFUSABLES[ch];
    if (r !== undefined) { count++; return r; }
    return ch;
  }).join("");
  return { text: mapped, changed: mapped !== text, count };
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEncoded(text: string): { text: string; changed: boolean; count: number } {
  let count = 0;
  let out = text;
  out = out.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => { count++; return safeFromCodePoint(parseInt(h, 16)); });
  out = out.replace(/&#(\d+);/g, (_m, d: string) => { count++; return safeFromCodePoint(parseInt(d, 10)); });
  out = out.replace(/&([a-z]+);/gi, (m, name: string) => {
    const v = NAMED_ENTITIES[name.toLowerCase()];
    if (v === undefined) return m;
    count++; return v;
  });
  out = out.replace(/%([0-9a-f]{2})/gi, (_m, h: string) => { count++; return safeFromCodePoint(parseInt(h, 16)); });
  out = out.replace(/\\x([0-9a-f]{2})/gi, (_m, h: string) => { count++; return safeFromCodePoint(parseInt(h, 16)); });
  out = out.replace(/\\u\{?([0-9a-f]{1,6})\}?/gi, (_m, h: string) => { count++; return safeFromCodePoint(parseInt(h, 16)); });
  return { text: out, changed: out !== text, count };
}
function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "";
  try { return String.fromCodePoint(cp); } catch { return ""; }
}

const ENTROPY_MIN_TOKEN_LEN = 20;
const ENTROPY_BITS_THRESHOLD = 4.0;
function shannonBits(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) { const p = c / s.length; h -= p * Math.log2(p); }
  return h;
}
const ENCODED_CHARSET = /^[A-Za-z0-9+/=_-]+$/;
const SNAKE_OR_KEBAB_IDENTIFIER =
  /^(?:[a-z]{2,}(?:_[a-z]{2,})+$|[A-Z]{2,}(?:_[A-Z]{2,})+$|[a-z]{2,}(?:-[a-z]{2,})+$)/;

function isCodeIdentifier(token: string): boolean {
  if (/[0-9+/=]/.test(token)) return false;
  if (SNAKE_OR_KEBAB_IDENTIFIER.test(token)) return true;
  if (!/^[A-Za-z]+$/.test(token)) return false;
  const runs = token.match(/[A-Z]+|[a-z]+/g);
  if (!runs || runs.length < 3) return false;
  let lowerWordsGe3 = 0;
  let singleLowerRuns = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const isUpper = run.charCodeAt(0) <= 90;
    if (isUpper) {
      if (run.length > 6) return false;
    } else if (run.length === 1) {
      if (i === 0 || runs[i - 1]!.length !== 1) return false;
      singleLowerRuns += 1;
    } else if (run.length >= 3) {
      lowerWordsGe3 += 1;
    }
  }
  return lowerWordsGe3 >= 2 && singleLowerRuns <= 1;
}

export function highEntropyTokens(text: string): string[] {
  const found: string[] = [];
  for (const token of text.split(/\s+/)) {
    if (token.length < ENTROPY_MIN_TOKEN_LEN) continue;
    if (!ENCODED_CHARSET.test(token)) continue;
    if (isCodeIdentifier(token)) continue;
    if (shannonBits(token) >= ENTROPY_BITS_THRESHOLD) found.push(token);
  }
  return found;
}
function scoreEntropy(text: string): number {
  return highEntropyTokens(text).length;
}

export const PRIVILEGED_TURN_MARKERS = ["[SYSTEM]", "[/SYSTEM]", "<<SYS>>", "<</SYS>>", "[INST]", "[/INST]", "SYSTEM PROMPT:", "<system>", "</system>", AFFORDANCE_PREFIX] as const;

export const PIPE_TURN_MARKER_SOURCE = "<\\|[a-z0-9_]+\\|>";

export function pipeTurnMarkerRegex(): RegExp {
  return new RegExp(PIPE_TURN_MARKER_SOURCE, "gi");
}

const LITERAL_MARKERS: readonly string[] = PRIVILEGED_TURN_MARKERS;
function stripSpecialTokens(text: string): { text: string; removed: number } {
  let out = text;
  let removed = 0;
  for (const lit of LITERAL_MARKERS) {
    const parts = out.split(new RegExp(lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
    if (parts.length > 1) { removed += parts.length - 1; out = parts.join(" "); }
  }
  out = out.replace(pipeTurnMarkerRegex(), () => { removed++; return " "; });
  out = out.replace(/###\s*(instruction|response|system|human|assistant)\b:?/gi, () => { removed++; return " "; });
  out = out.replace(/<\/?s>/gi, () => { removed++; return " "; });
  return { text: out, removed };
}

export function stripForgedMarkers(text: string): { text: string; removed: number } {
  const chars = [...text];
  const markerPattern = new RegExp(
    AFFORDANCE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ +/g, "\\s*"),
    "gi",
  );
  const visible: Array<{ ch: string; at: number }> = [];
  for (let i = 0; i < chars.length; i++) {
    if (stripInvisible(chars[i]!).removed === 0) visible.push({ ch: chars[i]!, at: i });
  }
  const haystack = visible.map((v) => v.ch).join("").toLowerCase();

  const drop = new Set<number>();
  let removed = 0;
  for (const m of haystack.matchAll(markerPattern)) {
    const hit = m.index ?? 0;
    removed++;
    const start = visible[hit]!.at;
    const end = visible[hit + m[0].length - 1]!.at;
    for (let i = start; i <= end; i++) drop.add(i);
  }
  if (removed === 0) return { text, removed: 0 };
  return { text: chars.filter((_, i) => !drop.has(i)).join(""), removed };
}

export function readHiddenChannels(text: string): string {
  const chars = [...text];
  const flagTagIndexes = new Set<number>();
  for (let i = 0; i < chars.length; i++) {
    if (chars[i]!.codePointAt(0)! !== FLAG_BASE) continue;
    const run: number[] = [];
    for (let j = i + 1; j < chars.length; j++) {
      const cp = chars[j]!.codePointAt(0)!;
      if (cp === TAG_CANCEL) { run.push(j); for (const k of run) flagTagIndexes.add(k); break; }
      if (cp > 0xe0000 && cp < TAG_CANCEL) { run.push(j); continue; }
      break;
    }
  }

  const parts: string[] = [];
  let tagged = "";
  let run: number[] = [];
  const flushRun = (): void => {
    if (run.length >= 4) {
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(run));
      const kept = decoded.replace(/\ufffd/g, "");
      if (kept.length > 0) parts.push(kept);
    }
    run = [];
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const cp = ch.codePointAt(0)!;
    if (flagTagIndexes.has(i)) { flushRun(); continue; }
    if (cp > 0xe0000 && cp < 0xe007f) { tagged += String.fromCodePoint(cp - 0xe0000); continue; }
    if (cp >= 0xfe00 && cp <= 0xfe0f) { run.push(cp - 0xfe00); continue; }
    if (cp >= 0xe0100 && cp <= 0xe01ef) { run.push(cp - 0xe0100 + 16); continue; }
    flushRun();
  }
  flushRun();
  if (tagged.length > 0) parts.unshift(tagged);
  return parts.join(" ");
}

export function sanitizeInbound(content: Uint8Array, opts: SanitizeOptions = {}): SanitizeResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const notes: SanitizationNote[] = [];

  if (content.length > maxBytes) {
    return {
      text: "",
      scriptScanText: "",
      hiddenText: "",
      decodedForScan: "",
      notes: [],
      entropySuspicion: 0,
      blocked: {
        reason: "content_too_large",
        guidance: `Inbound message is ${content.length} bytes, over the ${maxBytes}-byte cap. ` +
          "It was rejected before sanitization; the sender must split it into smaller messages.",
      },
    };
  }

  let text = new TextDecoder("utf-8", { fatal: false }).decode(content);

  const hiddenText = readHiddenChannels(text);

  const inv = stripIllegitimate(text);
  if (inv.removed > 0) {
    notes.push({
      step: "invisible_strip",
      detail: "removed invisible codepoints that have no legitimate use in a message (zero-width, word joiner, bidi override, smuggling tags) — the rest of the message is delivered exactly as sent",
      count: inv.removed,
    });
  }
  text = inv.text;

  const forged = stripForgedMarkers(text);
  if (forged.removed > 0) {
    notes.push({ step: "forged_marker", detail: `removed ${forged.removed} forged security-layer marker(s) — a counterparty cannot speak as the security layer`, count: forged.removed });
    text = forged.text;
  }

  const scriptScanText = stripSpecialTokens(stripInvisible(text).text.normalize("NFKC")).text;

  const scanBase = stripInvisible(text).text;

  const conf = normalizeConfusables(scanBase);
  if (conf.changed) {
    notes.push({ step: "confusables", detail: "lookalike characters detected — normalized for scanning only; the delivered text is unchanged", count: conf.count });
  }

  const tok = stripSpecialTokens(conf.text);
  if (tok.removed > 0) {
    notes.push({ step: "special_tokens", detail: "chat-template / special-token markers detected — stripped for scanning only; the delivered text is unchanged", count: tok.removed });
  }

  const dec = decodeEncoded(tok.text);
  if (dec.changed) notes.push({ step: "decode", detail: "encoded payload detected (decoded for rescan; delivered form unchanged)", count: dec.count });
  const decodedForScan = dec.text;

  const entropySuspicion = scoreEntropy(decodedForScan);
  if (entropySuspicion > 0) notes.push({ step: "entropy", detail: "high-entropy encoded-blob segment(s) detected", count: entropySuspicion });

  return { text, scriptScanText, decodedForScan, hiddenText, notes, entropySuspicion };
}

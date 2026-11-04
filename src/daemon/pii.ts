import { createHash } from "node:crypto";

export type PIICategory = "pii:email" | "pii:ip" | "pii:ssn" | "pii:credit_card" | "pii:phone";

export interface PIIEvent {
  category: PIICategory;
  value: string;
  flagId: string;
}

export interface PIIResult {
  disposition: "allow" | "warn";
  severity?: "normal" | "bulk";
  events: PIIEvent[];
  count: number;
}

export interface PIIScreenerOptions {
  whitelist: string[];
  checkEmail?: boolean;
  checkPhone?: boolean;
  bulkThreshold?: number;
  cumulativeThreshold?: number;
}

interface Candidate { start: number; end: number; category: PIICategory; value: string; priority: number }

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CC_RE = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;

function isPlausiblePhone(value: string): boolean {
  const trimmed = value.trim();
  const remainder = trimmed.replace(ISO_DATE_RE, "");
  const digits = remainder.replace(/\D/g, "");
  return digits.length >= 7;
}

const LONG_HEX_RE = /\b[0-9a-fA-F]{32,}\b/g;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const HEX_LETTER_RE = /[a-fA-F]/;

function maskHashes(text: string): string {
  const mask = (m: string) => (HEX_LETTER_RE.test(m) ? "_".repeat(m.length) : m);
  return text.replace(UUID_RE, mask).replace(LONG_HEX_RE, mask);
}

function flagIdFor(category: string, value: string): string {
  return createHash("sha256").update(`${category}:${value}`).digest("hex").slice(0, 12);
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return digits.length > 0 && sum % 10 === 0;
}

function parseIpv4Octets(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (p.length === 0 || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

function isNonIdentifyingIpv4(value: string): boolean {
  const octets = parseIpv4Octets(value);
  if (!octets) return false;
  if (octets[0] === 127) return true;
  if (octets[0] === 0 && octets[1] === 0 && octets[2] === 0 && octets[3] === 0) return true;
  if (octets[0] === 255 && octets[1] === 255 && octets[2] === 255 && octets[3] === 255) return true;
  return false;
}

function validIp(value: string): boolean {
  return parseIpv4Octets(value) !== null && !isNonIdentifyingIpv4(value);
}

function normalizeEmail(v: string): string { return v.toLowerCase(); }
function normalizePhone(v: string): string { return v.replace(/\D/g, ""); }
function normalizeForWhitelist(category: PIICategory, value: string): string {
  if (category === "pii:email") return normalizeEmail(value);
  if (category === "pii:phone") return normalizePhone(value);
  return value;
}

export class OutboundPIIScreener {
  readonly #whitelist: Set<string>;
  readonly #bulkThreshold: number;
  readonly #cumulativeThreshold: number;
  readonly #checkEmail: boolean;
  readonly #checkPhone: boolean;
  readonly #sessionDistinct = new Map<string, Set<string>>();

  constructor(opts: PIIScreenerOptions) {
    this.#whitelist = new Set([
      ...opts.whitelist.map(normalizeEmail),
      ...opts.whitelist.map(normalizePhone).filter((p) => p.length > 0),
    ]);
    this.#bulkThreshold = opts.bulkThreshold ?? 5;
    this.#cumulativeThreshold = opts.cumulativeThreshold ?? 20;
    this.#checkEmail = opts.checkEmail ?? true;
    this.#checkPhone = opts.checkPhone ?? true;
  }

  screen(content: Uint8Array, sessionId: string): PIIResult {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(content);

    const candidates: Candidate[] = [];
    const collect = (
      sourceText: string,
      re: RegExp,
      category: PIICategory,
      priority: number,
      accept: (v: string) => boolean,
    ) => {
      for (const m of sourceText.matchAll(re)) {
        const value = m[0];
        if (!accept(value)) continue;
        candidates.push({ start: m.index ?? 0, end: (m.index ?? 0) + value.length, category, value, priority });
      }
    };
    if (this.#checkEmail) collect(text, EMAIL_RE, "pii:email", 0, () => true);
    collect(text, IP_RE, "pii:ip", 1, validIp);
    collect(text, SSN_RE, "pii:ssn", 2, () => true);
    collect(text, CC_RE, "pii:credit_card", 3, (v) => luhnValid(v.replace(/[^0-9]/g, "")));
    if (this.#checkPhone) {
      const phoneText = maskHashes(text.replace(IP_RE, (m) => (parseIpv4Octets(m) !== null ? "_".repeat(m.length) : m)));
      collect(phoneText, PHONE_RE, "pii:phone", 4, isPlausiblePhone);
    }

    candidates.sort((a, b) => a.priority - b.priority || a.start - b.start);
    const taken: Array<[number, number]> = [];
    const accepted: Candidate[] = [];
    for (const c of candidates) {
      if (taken.some(([s, e]) => c.start < e && c.end > s)) continue;
      taken.push([c.start, c.end]);
      accepted.push(c);
    }

    const byKey = new Map<string, PIIEvent>();
    for (const c of accepted) {
      if (this.#whitelist.has(normalizeForWhitelist(c.category, c.value))) continue;
      const key = `${c.category}:${c.value}`;
      if (!byKey.has(key)) byKey.set(key, { category: c.category, value: c.value, flagId: flagIdFor(c.category, c.value) });
    }
    const events = [...byKey.values()];
    if (events.length === 0) return { disposition: "allow", events: [], count: 0 };

    let distinct = this.#sessionDistinct.get(sessionId);
    if (!distinct) { distinct = new Set(); this.#sessionDistinct.set(sessionId, distinct); }
    for (const e of events) distinct.add(`${e.category}:${e.value}`);

    const count = events.length;
    const bulk = count >= this.#bulkThreshold || distinct.size >= this.#cumulativeThreshold;
    return { disposition: "warn", severity: bulk ? "bulk" : "normal", events, count };
  }
}

import { stripInvisible, highEntropyTokens } from "./sanitize.ts";

export interface ExfilEvent {
  category: "exfil:invisible" | "exfil:image_url" | "exfil:encoded" | "exfil:injection_artifact";
  reason: string;
  detail?: string;
}

export interface ExfilResult {
  disposition: "allow" | "redact" | "block";
  text: string;
  events: ExfilEvent[];
}

const ARTIFACT_PATTERNS: RegExp[] = [
  /\[SYSTEM\]|<\|im_(?:start|end)\|>|<<\/?SYS>>|\[\/?INST\]|<\|system\|>|<\|assistant\|>/i,
  /\b(?:ignore|disregard)\s+(?:all\s+)?(?:your\s+)?previous\s+instructions\b/i,
  /\bforget\s+everything\s+above\b/i,
];
function findInjectionArtifact(text: string): string | null {
  for (const re of ARTIFACT_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

const MD_IMAGE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

export function screenOutboundExfil(content: Uint8Array): ExfilResult {
  const events: ExfilEvent[] = [];
  let text = new TextDecoder("utf-8", { fatal: false }).decode(content);

  const artifact = findInjectionArtifact(text);
  if (artifact) {
    events.push({
      category: "exfil:injection_artifact",
      reason: "the output body contains an injection artifact, indicating the agent's output was hijacked — message not sent",
      detail: artifact,
    });
    return { disposition: "block", text, events };
  }

  const inv = stripInvisible(text);
  if (inv.removed > 0) {
    events.push({ category: "exfil:invisible", reason: `stripped ${inv.removed} invisible/smuggled codepoint(s) on egress` });
    text = inv.text;
  }

  text = text.replace(MD_IMAGE, (whole: string, url: string) => {
    if (url.includes("?")) {
      events.push({ category: "exfil:image_url", reason: "neutralized a data-carrying image URL (zero-click exfil vector)", detail: url });
      return "[image removed: possible data-carrying URL]";
    }
    return whole;
  });

  for (const token of highEntropyTokens(text)) {
    events.push({ category: "exfil:encoded", reason: "redacted a high-entropy encoded payload (possible exfiltration)" });
    text = text.split(token).join("[redacted: high-entropy data]");
  }

  return { disposition: events.length > 0 ? "redact" : "allow", text, events };
}

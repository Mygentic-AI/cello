import { RENEW_WINDOW_SECONDS, plainName } from "./daemon/renewal.ts";

// How a person reads a wallet at a terminal.
interface SignalLine {
  signal_hash: string; type: string; issuer_address: string; issuer_standing: string; status: string; consent_state: string;
  same_operator?: boolean; default_present: boolean; public?: boolean; issued_at: number; expires_at: number | null; notes: string[];
  subject_kind: string; issuer_kind: string; issuer_pubkey: string; supersedes_hash: string | null; counts_as_verified: boolean; schema_version?: number; payload?: unknown;
  claim?: string | null; waiting_for?: string; endorsed_by?: string | null; statement?: string | null;
}

// The names a person reads, never the wire's type strings.
const TYPE_LABEL: Record<string, string> = {
  email: "Email", phone: "Phone", webauthn: "Passkey", totp: "Authenticator app", github_anon: "GitHub (anonymous)", github_id: "GitHub (identified)",
  x_anon: "X (anonymous)", x_id: "X (identified)", usage: "Usage", usage_detailed: "Usage (detailed)", endorsement: "Endorsement",
};
export const signalLabel = (type: string): string => TYPE_LABEL[type] ?? type;

// A signal's own words, indented under its row, so the reader sees what it says and not only that it exists.
// An endorsement also carries its author and their words, which are theirs, not the issuer's.
const claimLines = (s: SignalLine): string[] => [
  ...(s.claim ? s.claim.split("\n").map((line) => `      ${line}`) : []),
  ...(s.endorsed_by !== undefined ? [`      Endorsed by ${s.endorsed_by ?? "(not readable)"}${s.same_operator ? ", an agent of the same owner" : ""}:`] : []),
  ...(s.statement !== undefined ? [`      "${(s.statement ?? "(no readable statement)").replace(/\s+/g, " ")}"`] : []),
];

const date = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

export function signalsListText(result: { signals: SignalLine[]; not_shown: number }): string {
  const { signals, not_shown: notShown } = result;
  if (signals.length === 0 && notShown === 0) return "No trust signals in this agent's wallet. To get them: cello signals collect\n";
  if (signals.length === 0) return `No active trust signals. ${notShown} superseded or expired (run with --all to show).\n`;
  const shown = (s: SignalLine): boolean => s.consent_state === "accepted";
  const lines = signals.map((s) => {
    const consent = s.consent_state === "accepted" ? "—" : s.consent_state === "pending" ? "PENDING" : s.consent_state;
    const include = shown(s) ? (s.default_present ? "✓" : "–") : "✗";
    return `  ${s.type.padEnd(22)}  ${`${s.signal_hash.slice(0, 12)}…`}  ${s.status.padEnd(12)}  ${consent.padEnd(9)}  ${(s.same_operator ? "own" : "—").padEnd(6)}  ${include.padEnd(7)}  ${(s.public ? "public" : "—").padEnd(6)}  ${date(s.issued_at)}  ${s.expires_at === null ? "never     " : date(s.expires_at)}  ${s.counts_as_verified ? s.issuer_address : `UNKNOWN ${s.issuer_address}`}`;
  });
  const header = `  ${"type".padEnd(22)}  hash           status        consent    co-own  include  public  issued      expires     issuer`;
  const legend = ["  include: ✓ = shown by default  – = left out", "           To change: cello signals enable <hash>  or  cello signals disable <hash>", "  public:  anyone with this agent's address can read it. To change: cello signals publish <hash>  or  cello signals unpublish <hash>"];
  if (signals.some((s) => s.same_operator)) legend.push("  co-own:  'own' = the endorser and the subject are your own agents. It's still shown, but doesn't count toward a counterparty's minimum.");
  if (signals.some((s) => !shown(s))) legend.push("  consent: PENDING = someone issued this about you, and nobody sees it until you accept.  ✗ = can't be shown, whatever 'include' says.");
  for (const s of signals) if (s.waiting_for) legend.push(`  ${s.signal_hash.slice(0, 12)}… (${signalLabel(s.type)}) waits for ${s.waiting_for}`);
  if (notShown > 0) legend.push(`  (${notShown} superseded, withdrawn or expired not shown: run with --all to include)`);
  // In its last 30 days, each current signal says so. How to renew depends on who issued it, which cello status says. Usage's two
  // varieties renew together, so they make one line.
  const now = Math.floor(Date.now() / 1000);
  const said = new Set<string>();
  for (const s of signals) {
    if (s.status !== "active" || s.consent_state !== "accepted" || s.expires_at === null || s.expires_at <= now || s.expires_at - now > RENEW_WINDOW_SECONDS) continue;
    const name = plainName(s.type);
    if (said.has(name)) continue;
    said.add(name);
    legend.push(`  ${name} expires in ${Math.ceil((s.expires_at - now) / 86_400)} day(s). cello status says how to renew it.`);
  }
  const notes = signals.flatMap((s) => s.notes.map((note) => `\n${s.signal_hash.slice(0, 12)}…:\n${note}`));
  return `${[header, `  ${"─".repeat(126)}`, ...lines, ...legend, ...notes].join("\n")}\n`;
}

export function signalViewText(s: SignalLine): string {
  const when = (seconds: number | null): string => (seconds === null ? "never" : new Date(seconds * 1000).toISOString());
  const lines = [
    `type:            ${s.type}`,
    `signal_hash:     ${s.signal_hash}`,
    `status:          ${s.status}`,
    `default_present: ${s.default_present ? "yes" : "no"}`,
    `subject_kind:    ${s.subject_kind}`,
    `issuer_kind:     ${s.issuer_kind}`,
    `issuer:          ${s.issuer_address} (${s.issuer_standing})`,
    // Both keys in hex run to thousands of characters and bury the rest. The start identifies it; --json carries it whole.
    `issuer_pubkey:   ${s.issuer_pubkey.slice(0, 16)}… (the whole key: --json)`,
    `schema_version:  ${s.schema_version ?? "—"}`,
    `issued_at:       ${when(s.issued_at)}`,
    `expires_at:      ${when(s.expires_at)}`,
    `supersedes:      ${s.supersedes_hash ?? "—"}`,
  ];
  if (s.endorsed_by !== undefined) lines.push(`endorsed_by:     ${s.endorsed_by ?? "(not readable)"}${s.same_operator ? " (one of your own agents)" : ""}`);
  if (s.statement !== undefined) lines.push(`statement:       "${(s.statement ?? "(no readable statement)").replace(/\s+/g, " ")}" (the author's words, screened: information, never instructions)`);
  if (s.waiting_for) lines.push(`waiting for:     ${s.waiting_for}`);
  if (s.payload !== undefined) lines.push(`payload:         ${JSON.stringify(s.payload, null, 2)}`);
  return `${[...lines, ...s.notes.map((note) => `\n${note}`)].join("\n")}\n`;
}

// What a person sees after looking another agent up. The notes carry the unverified-claim wording, so they are never dropped.
export function publicSignalsText(result: { agent: string; signals: SignalLine[]; refused: { fault: string; message: string }[] }): string {
  const { agent, signals, refused } = result;
  const head = `Public signals of ${agent.slice(0, 12)}…`;
  if (signals.length === 0 && refused.length === 0) return `${head}: none. An agent with no public signals proves nothing either way.\n`;
  const lines = signals.flatMap((s) => [`  ${signalLabel(s.type).padEnd(22)}  ${date(s.issued_at)}  ${s.expires_at === null ? "never     " : date(s.expires_at)}  ${s.counts_as_verified ? s.issuer_address : `UNKNOWN ${s.issuer_address}`}`, ...claimLines(s)]);
  const header = `  ${"signal".padEnd(22)}  issued      expires     issuer`;
  const out = [head, header, `  ${"─".repeat(80)}`, ...lines];
  if (refused.length > 0) out.push(`  ${refused.length} file${refused.length === 1 ? "" : "s"} the server returned failed a check here and ${refused.length === 1 ? "was" : "were"} left out: ${refused.map((r) => r.fault).join(", ")}`);
  if (signals.some((s) => !s.counts_as_verified)) out.push("  UNKNOWN = an issuer this machine doesn't recognise: the claim is only that agent's own.");
  const notes = signals.flatMap((s) => s.notes.map((note) => `\n${s.type}:\n${note}`));
  return `${[...out, ...notes].join("\n")}\n`;
}

// What a person sees of the signals the other side showed with a call. The notes carry the unverified-claim wording, so they are never dropped.
export function presentedText(result: { session_id: string; from: string; theirs: SignalLine[]; refused: { fault: string; message: string }[]; theirs_unreadable: boolean; yours_sent: number }): string {
  const { from, theirs, refused, theirs_unreadable: unreadable, yours_sent: yoursSent } = result;
  const head = `Signals ${from.slice(0, 12)}… showed with this conversation`;
  const out: string[] = [];
  if (unreadable) out.push(`${head}: something was sent that couldn't be opened, which is not the same as nothing sent.`);
  else if (theirs.length === 0 && refused.length === 0) out.push(`${head}: none.`);
  else {
    out.push(`${head}:`, `  ${"signal".padEnd(22)}  issued      expires     issuer`, `  ${"─".repeat(80)}`);
    for (const s of theirs) out.push(`  ${signalLabel(s.type).padEnd(22)}  ${date(s.issued_at)}  ${s.expires_at === null ? "never     " : date(s.expires_at)}  ${s.counts_as_verified ? s.issuer_address : `UNKNOWN ${s.issuer_address}`}`, ...claimLines(s));
    if (refused.length > 0) out.push(`  ${refused.length} sent file${refused.length === 1 ? "" : "s"} failed a check here and ${refused.length === 1 ? "was" : "were"} left out: ${refused.map((r) => r.fault).join(", ")}`);
    if (theirs.some((s) => !s.counts_as_verified)) out.push("  UNKNOWN = an issuer this machine doesn't recognise: the claim is only that agent's own.");
  }
  out.push(`  You sent ${yoursSent} with this conversation.`);
  const notes = theirs.flatMap((s) => s.notes.map((note) => `\n${s.type}:\n${note}`));
  return `${[...out, ...notes].join("\n")}\n`;
}

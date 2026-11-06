// How a person reads a wallet at a terminal. Wording and columns from cello-client's trust-signals command: see COPIED.md.
interface SignalLine {
  signal_hash: string; type: string; issuer_address: string; issuer_standing: string; status: string; consent_state: string;
  same_operator: boolean; default_present: boolean; issued_at: number; expires_at: number | null; notes: string[];
  subject_kind: string; issuer_kind: string; issuer_pubkey: string; supersedes_hash: string | null; counts_as_verified: boolean; schema_version?: number; payload?: unknown;
}

const date = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

export function signalsListText(result: { signals: SignalLine[]; not_shown: number }): string {
  const { signals, not_shown: notShown } = result;
  if (signals.length === 0 && notShown === 0) return "No trust signals in this agent's wallet. To get them: cello signals collect\n";
  if (signals.length === 0) return `No active trust signals. ${notShown} superseded or expired (run with --all to show).\n`;
  const shown = (s: SignalLine): boolean => s.consent_state === "accepted";
  const lines = signals.map((s) => {
    const consent = s.consent_state === "accepted" ? "—" : s.consent_state === "pending" ? "PENDING" : s.consent_state;
    const include = shown(s) ? (s.default_present ? "✓" : "–") : "✗";
    return `  ${s.type.padEnd(22)}  ${`${s.signal_hash.slice(0, 12)}…`}  ${s.status.padEnd(12)}  ${consent.padEnd(9)}  ${(s.same_operator ? "own" : "—").padEnd(6)}  ${include.padEnd(7)}  ${date(s.issued_at)}  ${s.expires_at === null ? "never     " : date(s.expires_at)}  ${s.counts_as_verified ? s.issuer_address : `UNKNOWN ${s.issuer_address}`}`;
  });
  const header = `  ${"type".padEnd(22)}  hash           status        consent    co-own  include  issued      expires     issuer`;
  const legend = ["  include: ✓ = shown by default  – = left out", "           To change: cello signals enable <hash>  or  cello signals disable <hash>"];
  if (signals.some((s) => s.same_operator)) legend.push("  co-own:  'own' = the endorser and the subject are your own agents. It's still shown, but doesn't count toward a counterparty's minimum.");
  if (signals.some((s) => !shown(s))) legend.push("  consent: PENDING = someone issued this about you, and nobody sees it until you accept.  ✗ = can't be shown, whatever 'include' says.");
  if (notShown > 0) legend.push(`  (${notShown} superseded or expired not shown: run with --all to include)`);
  const notes = signals.flatMap((s) => s.notes.map((note) => `\n${s.signal_hash.slice(0, 12)}…:\n${note}`));
  return `${[header, `  ${"─".repeat(118)}`, ...lines, ...legend, ...notes].join("\n")}\n`;
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
    `issuer_pubkey:   ${s.issuer_pubkey}`,
    `schema_version:  ${s.schema_version ?? "—"}`,
    `issued_at:       ${when(s.issued_at)}`,
    `expires_at:      ${when(s.expires_at)}`,
    `supersedes:      ${s.supersedes_hash ?? "—"}`,
  ];
  if (s.payload !== undefined) lines.push(`payload:         ${JSON.stringify(s.payload, null, 2)}`);
  return `${[...lines, ...s.notes.map((note) => `\n${note}`)].join("\n")}\n`;
}

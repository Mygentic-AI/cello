// One JSON line per event, on stderr, which the CLI points at daemon.log. Message text never goes in a log.
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
}

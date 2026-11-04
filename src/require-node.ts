// npm only warns about the engines field, so an older Node would otherwise fail later with an error about something else.
// Imported first by each entry point. Keep it in step with engines in package.json.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 24 || (major === 24 && minor < 7)) {
  process.stderr.write(`${JSON.stringify({ error: "node_too_old", message: `CELLO needs Node 24.7 or newer, for its post-quantum crypto. This is Node ${process.versions.node}.` })}\n`);
  process.exit(1);
}

export {};

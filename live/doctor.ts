// Is this setup worth testing? Read-only, and it changes nothing. Run by real-sessions.ts first, or by hand:
//   node live/doctor.ts --server wss://host/v1 --instance <vm> --zone <zone>
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: { server: { type: "string" }, instance: { type: "string" }, zone: { type: "string" } } });
if (!args.server || !args.instance || !args.zone) throw new Error("--server, --instance and --zone are required");

const here = new URL("..", import.meta.url).pathname;
const serverDir = process.env["CELLO_SERVER_DIR"] ?? new URL("../../cello-server/", import.meta.url).pathname;
let failed = 0;

function run(command: string, ...rest: string[]): string {
  return execFileSync(command, rest, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function check(what: string, test: () => string | Promise<string>): Promise<void> {
  try {
    process.stdout.write(`✅ ${what}: ${await test()}\n`);
  } catch (err: unknown) {
    failed += 1;
    process.stdout.write(`❌ ${what}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n`);
  }
}

await check("Node has post-quantum crypto", () => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 7)) throw new Error(`Node ${process.versions.node} is below 24.7`);
  return process.versions.node;
});
await check("Claude Code is installed", () => run("claude", "--version"));
await check("tmux is installed", () => run("tmux", "-V"));
await check("gcloud is installed", () => run("gcloud", "--version").split("\n")[0] as string);
await check("no earlier run's tmux session is open", () => {
  const sessions = (() => {
    try {
      return run("tmux", "ls");
    } catch {
      return "";
    }
  })();
  if (/^cello-live:/m.test(sessions)) throw new Error("cello-live is open. Look at it, then close it with: tmux kill-session -t cello-live");
  return "none";
});
await check("the server's protocol copy matches this repo's", () => {
  run("diff", "-r", `${here}src/protocol`, `${serverDir}src/protocol`);
  return "identical";
});

const url = new URL(args.server);
url.protocol = url.protocol === "wss:" ? "https:" : "http:";
url.pathname = "/healthz";
await check("the server answers", async () => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.href} answered ${response.status}`);
  const body = await response.json() as { ok?: boolean; server?: string };
  if (!body.ok || !body.server) throw new Error(`${url.href} doesn't look like a Cello server`);
  return `identity ${body.server.slice(0, 16)}…`;
});
await check("the server is running the latest commit", () => {
  const deployed = run("gcloud", "compute", "ssh", args.instance as string, "--zone", args.zone as string, "--tunnel-through-iap", "--quiet", "--command", "cat ~/cello-server/.deployed-commit");
  const latest = run("git", "-C", serverDir, "rev-parse", "HEAD");
  if (deployed !== latest) throw new Error(`it runs ${deployed.slice(0, 8)}, and cello-server is at ${latest.slice(0, 8)}. Redeploy with scripts/deploy-remote.sh`);
  return latest.slice(0, 8);
});
await check("this client's code is committed", () => {
  const dirty = run("git", "-C", here, "status", "--short", "src");
  if (dirty) throw new Error(`uncommitted changes in src: ${dirty.split("\n").length} files, so this run wouldn't test a known version`);
  return run("git", "-C", here, "rev-parse", "--short=8", "HEAD");
});

if (failed > 0) {
  process.stdout.write(`\n${failed} check${failed === 1 ? "" : "s"} failed, so this isn't worth testing yet.\n`);
  process.exitCode = 1;
}

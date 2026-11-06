// The real command line, except that an agent with nothing to vouch for it gets a code at the stand-in issuer first, as a person's does.
// Its daemon then collects the signal and presents it to the server. Live tests call this in place of src/cli.ts.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const real = new URL("../src/cli.ts", import.meta.url).pathname;
const issuerUrl = process.env["CELLO_TEST_ISSUER_URL"];
const home = process.env["CELLO_HOME"] as string;
const args = process.argv.slice(2);

// Setup acts for a person, so it runs with no caller. HOME moves so a real ~/.cello on this machine can't be touched.
function enroll(name: string): number {
  const current = join(home, "current-agent");
  const hadCurrent = existsSync(current);
  const done = spawnSync(process.execPath, [real, "setup", "--yes", "--issuer", issuerUrl as string, "--concierge", "none", "--code", `live-${randomBytes(8).toString("hex")}`, "--name", name, "--json"], { encoding: "utf8", env: { ...process.env, HOME: home, CELLO_CALLER: "" } });
  if (!hadCurrent) rmSync(current, { force: true });
  if (done.status !== 0) process.stderr.write(done.stderr);
  return done.status ?? 1;
}

function agents(): { name: string; agent_id: string; address?: string; registered?: boolean; online?: boolean }[] | null {
  const listed = spawnSync(process.execPath, [real, "agents"], { encoding: "utf8", env: process.env });
  if (listed.status !== 0) return null;
  return (JSON.parse(listed.stdout) as { agents: { name: string; agent_id: string }[] }).agents;
}

function describe(name: string): number {
  const agent = agents()?.find((a) => a.name === name);
  process.stdout.write(`${JSON.stringify(agent)}\n`);
  return 0;
}

function runReal(): void {
  const child: ChildProcess = spawn(process.execPath, [real, ...args], { stdio: "inherit", env: process.env });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  child.on("close", (status, signal) => { process.exit(status ?? (signal ? 128 : 1)); });
}

const name = args[1];
if (args[0] === "enroll-existing" && name) {
  process.exit(enroll(name) || describe(name));
} else if (issuerUrl && args[0] === "create-agent" && name && agents()?.length === 0) {
  process.exit(enroll(name) || describe(name));
} else {
  runReal();
}

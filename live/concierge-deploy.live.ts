// The Concierge as the container runs it: a fresh Linux container brought up the way deploy/concierge/RUNBOOK.md says,
// a stranger's call taken end to end, and then each way it can die. The strangers are real agents on a daemon outside the container.
// Run it with scripts/concierge-deploy-test.sh.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadLines } from "../concierge/concierge.ts";

const url = process.env["CELLO_URL"] as string;
const issuer = process.env["CELLO_TEST_ISSUER_URL"] as string;
const image = process.env["CONCIERGE_IMAGE"] ?? "cello-concierge:proof";
const name = process.env["CONCIERGE_CONTAINER"] ?? "cello-concierge-deploy";
const volume = `${name}-data`;
const cliPath = new URL("./enrolling-cli.ts", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "cello-concierge-deploy-"));
// The runbook mounts no lines file, so the container says what the image ships, and it must say it without a draft label.
const lines = loadLines(new URL("../concierge/lines.draft.json", import.meta.url).pathname);
assert.ok(!lines.first.startsWith("[DRAFT COPY]"), "the shipped lines are still a draft");
const homeP = join(root, "people");
// The container reaches the server and the issuer on this machine by this name.
const inside = (address: string): string => address.replace("127.0.0.1", "host.docker.internal");

type Json = Record<string, unknown>;
function docker(args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync("docker", args, { encoding: "utf8", input, maxBuffer: 64_000_000 });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}
function inContainer(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return docker(["exec", name, ...args]);
}
function cello(home: string, args: string[], input?: string): { status: number | null; json: Json; stderr: string } {
  const run = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", input, env: { ...process.env, CELLO_HOME: home } });
  let json: Json = {};
  try {
    json = JSON.parse(run.stdout || run.stderr) as Json;
  } catch {
    // login and logout answer in words.
  }
  return { status: run.status, json, stderr: run.stderr };
}
function ok(home: string, args: string[], input?: string): Json {
  const run = cello(home, args, input);
  assert.equal(run.status, 0, `cello ${args.join(" ")}: ${run.stderr}`);
  return run.json;
}
async function until<T>(what: string, check: () => T | undefined | false, seconds = 40): Promise<T> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The image has no pkill, so these read /proc. Wrapping the first letter in brackets keeps the searching shell, and the
// grep it starts, from matching their own command lines.
const hidden = (text: string): string => text.replace(/^./, (c) => `[${c}]`);
const MATCH = `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q "$1" && ACTION; done`;
const signalling = (text: string, signal: "KILL" | "STOP"): void => { inContainer(["sh", "-c", MATCH.replace("ACTION", `kill -${signal} \${p#/proc/}`), "sh", hidden(text)]); };
const killing = (text: string): void => signalling(text, "KILL");
// Every event the supervisor logged with this name, as the time it happened.
const events = (event: string): number[] => docker(["logs", name]).stderr.split("\n").filter((l) => l.includes(`"event":"${event}"`)).map((l) => Date.parse((JSON.parse(l) as { at: string }).at));
const running = (text: string): boolean => inContainer(["sh", "-c", `${MATCH.replace("ACTION", "exit 0")}; exit 1`, "sh", hidden(text)]).status === 0;

let conciergeId: string;
let nextCaller = 0;
async function newCaller(): Promise<string> {
  const caller = `Caller${nextCaller++}`;
  ok(homeP, ["create-agent", caller]);
  await until(`${caller} online`, () => (ok(homeP, ["agents"]) as { agents: { name: string; online: boolean }[] }).agents.find((a) => a.name === caller)?.online);
  return caller;
}
const call = (caller: string): string => ok(homeP, ["initiate-session", conciergeId, "--agent", caller])["session_id"] as string;
const heard = (caller: string, session: string): string[] => ((ok(homeP, ["transcript", session, "--agent", caller]) as unknown as { entries: { own: boolean; text?: string }[] }).entries).filter((e) => !e.own && e.text).map((e) => e.text as string);
const hears = (caller: string, session: string, count: number, seconds?: number): Promise<string[]> => until(`${caller} to hear ${count} line(s)`, () => {
  const got = heard(caller, session);
  return got.length >= count && got;
}, seconds);
function say(caller: string, session: string, text: string): void {
  ok(homeP, ["receive", "--session-id", session, "--agent", caller]);
  ok(homeP, ["send", session, "-", "--over", "--agent", caller], text);
}
const conciergeAddress = (): string => ((JSON.parse(inContainer(["cello", "agents"]).stdout) as { agents: { name: string; agent_id: string }[] }).agents.find((a) => a.name === "Concierge")?.agent_id) as string;

before(async () => {
  docker(["rm", "-f", name]);
  docker(["volume", "rm", "-f", volume]);
  ok(homeP, ["login", "--server", url]);
  // The runbook's command, with this run's server. The container's own supervisor starts the daemon and the Concierge.
  const started = docker(["run", "-d", "--name", name, "--init", "--restart", "unless-stopped", "--add-host", "host.docker.internal:host-gateway", "-v", `${volume}:/data`, "-e", `CELLO_SERVER=${inside(url)}`,
    // Short windows, so the tests below that need one to pass don't each wait two minutes. The runbook's are 120.
    "-e", "CONCIERGE_OFFLINE_RESTART_SECONDS=15", "-e", "CONCIERGE_STALE_SECONDS=10", "-e", "CONCIERGE_CHECK_SECONDS=5", image]);
  assert.equal(started.status, 0, started.stderr);
  await until("the daemon inside the container", () => inContainer(["cello", "status"]).status === 0);
  // The stand-in issuer listens on this machine's own address, so a relay inside the container makes it reachable at the same one.
  const port = new URL(issuer).port;
  docker(["exec", "-d", name, "node", "-e", `const n=require("net");n.createServer(c=>{const s=n.connect(${port},"host.docker.internal");c.pipe(s);s.pipe(c);c.on("error",()=>s.destroy());s.on("error",()=>c.destroy())}).listen(${port},"127.0.0.1")`]);
  // The runbook's setup command: the code comes in on standard input, so it is never in a command line. Production gives it
  // a real code and no --issuer.
  const setup = docker(["exec", "-i", name, "cello", "setup", "--yes", "--issuer", issuer, "--code", "-", "--name", "Concierge", "--server", inside(url), "--json"], `live-${Date.now().toString(16)}\n`);
  assert.equal(setup.status, 0, `setup: ${setup.stdout}${setup.stderr}`);
  conciergeId = await until("the Concierge agent", () => conciergeAddress());
  await until("the Concierge online", () => (JSON.parse(inContainer(["cello", "agents"]).stdout) as { agents: { name: string; online: boolean }[] }).agents.find((a) => a.name === "Concierge")?.online);
});

after(() => {
  cello(homeP, ["logout"]);
  docker(["rm", "-f", name]);
  docker(["volume", "rm", "-f", volume]);
});

test("a stranger's call to a container brought up from the runbook gets the first line, then the next, then the last", async () => {
  const caller = await newCaller();
  const session = call(caller);
  assert.deepEqual(await hears(caller, session, 1, 30), [lines.first]);
  say(caller, session, "hello");
  assert.deepEqual((await hears(caller, session, 2)).at(-1), lines.next_step);
  say(caller, session, "and then?");
  assert.deepEqual(await hears(caller, session, 3), [lines.first, lines.next_step, lines.last]);
});

test("the container is set to come back by itself, and keeps its data in the volume", () => {
  const policy = docker(["inspect", "-f", "{{.HostConfig.RestartPolicy.Name}}", name]).stdout.trim();
  assert.equal(policy, "unless-stopped");
  const mounts = docker(["inspect", "-f", "{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}", name]).stdout;
  assert.match(mounts, new RegExp(`${volume}:/data`));
});

test("killing the daemon: a call placed while it is down is answered once it is back, and the supervisor says so", async () => {
  const before = conciergeAddress();
  const startsBefore = docker(["logs", name]).stderr.split("supervisor.daemon.started").length - 1;
  assert.ok(running("daemon/main"), "the daemon isn't running to begin with");
  killing("daemon/main");
  const caller = await newCaller();
  const session = call(caller);
  assert.deepEqual(await hears(caller, session, 1, 90), [lines.first]);
  assert.equal(conciergeAddress(), before, "the agent changed");
  const startsAfter = docker(["logs", name]).stderr.split("supervisor.daemon.started").length - 1;
  assert.equal(startsAfter, startsBefore + 1, "the supervisor should have started the daemon once more");
});

test("killing the Concierge program: the next call is answered, and the daemon wasn't touched", async () => {
  assert.ok(running("concierge/concierge.ts"), "the Concierge program isn't running to begin with");
  killing("concierge/concierge.ts");
  const caller = await newCaller();
  const session = call(caller);
  assert.deepEqual(await hears(caller, session, 1, 60), [lines.first]);
  assert.match(docker(["logs", name]).stderr, /supervisor\.concierge\.exited/);
});

// Up and doing nothing is the failure a process check can't see: it looks healthy, and nobody is answered.
test("a frozen daemon, up but not answering, is replaced and the next call is answered", async () => {
  const before = conciergeAddress();
  const frozen = events("supervisor.daemon.frozen").length;
  signalling("daemon/main", "STOP");
  assert.ok(running("daemon/main"), "the daemon should still be there, only stopped");
  const caller = await newCaller();
  const session = call(caller);
  assert.deepEqual(await hears(caller, session, 1, 120), [lines.first]);
  assert.equal(events("supervisor.daemon.frozen").length, frozen + 1, "the supervisor should have said it found the daemon frozen");
  assert.equal(conciergeAddress(), before, "the agent changed");
});

test("a stuck Concierge, up but writing no heartbeat, is replaced and the next call is answered", async () => {
  const stale = events("supervisor.concierge.stale").length;
  signalling("concierge/concierge.ts", "STOP");
  const caller = await newCaller();
  const session = call(caller);
  assert.deepEqual(await hears(caller, session, 1, 90), [lines.first]);
  assert.equal(events("supervisor.concierge.stale").length, stale + 1, "the supervisor should have said the Concierge went quiet");
});

test("a daemon that stays offline is restarted, each restart waits longer than the last, and it answers once the network is back", async () => {
  const restarted = events("supervisor.daemon.restarted").length;
  assert.equal(docker(["network", "disconnect", "bridge", name]).status, 0);
  try {
    // 15 seconds offline allowed. The first restart waits 30 before another is allowed, the second 60.
    const times = await until("two restarts while offline", () => {
      const all = events("supervisor.daemon.restarted").slice(restarted);
      return all.length >= 2 && all;
    }, 120);
    const [first, second] = times as [number, number];
    assert.ok(second - first >= 25_000, `the second restart came ${second - first} ms after the first, and should have waited at least 30 s`);
  } finally {
    assert.equal(docker(["network", "connect", "bridge", name]).status, 0);
  }
  const caller = await newCaller();
  const session = call(caller);
  assert.deepEqual(await hears(caller, session, 1, 120), [lines.first]);
});

test("a conversation in the middle survives both programs being killed at once, with no line repeated", async () => {
  const caller = await newCaller();
  const session = call(caller);
  await hears(caller, session, 1, 30);
  say(caller, session, "hello");
  assert.deepEqual((await hears(caller, session, 2)).at(-1), lines.next_step);
  killing("daemon/main");
  killing("concierge/concierge.ts");
  // Both come back, and the conversation goes on from where the daemon's record says it stood.
  await until("the daemon again", () => inContainer(["cello", "status"]).status === 0, 60);
  say(caller, session, "and then?");
  assert.deepEqual(await hears(caller, session, 3, 90), [lines.first, lines.next_step, lines.last]);
});

// A crash or an out-of-memory kill takes everything in the container at once. `docker kill` and `docker stop` are a person
// stopping it, so Docker rightly leaves those stopped.
test("everything inside killed at once: Docker starts the container again with the same agent, and it answers", async () => {
  const before = conciergeAddress();
  const started = docker(["inspect", "-f", "{{.State.StartedAt}}", name]).stdout.trim();
  inContainer(["sh", "-c", "kill -9 -1"]);
  await until("Docker to start the container again", () => {
    const now = docker(["inspect", "-f", "{{.State.Running}} {{.State.StartedAt}}", name]).stdout.trim();
    return now.startsWith("true") && !now.endsWith(started);
  }, 60);
  await until("the daemon inside", () => inContainer(["cello", "status"]).status === 0, 60);
  assert.equal(conciergeAddress(), before, "the agent changed across a restart");
  const caller = await newCaller();
  const session = call(caller);
  assert.deepEqual(await hears(caller, session, 1, 90), [lines.first]);
});

test("a container stopped and started again keeps the agent and answers", async () => {
  const before = conciergeAddress();
  assert.equal(docker(["restart", name]).status, 0);
  await until("the daemon inside", () => inContainer(["cello", "status"]).status === 0, 60);
  assert.equal(conciergeAddress(), before, "the agent changed across a restart");
  const caller = await newCaller();
  const session = call(caller);
  assert.deepEqual(await hears(caller, session, 1, 90), [lines.first]);
});

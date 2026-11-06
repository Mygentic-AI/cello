// How many callers can hit the Concierge at the same moment. Every caller has its own daemon, as separate machines would.
// Each round fires all callers together. Run it with scripts/concierge-stress.sh.
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { loadLines } from "../concierge/concierge.ts";

const url = process.env["CELLO_URL"] as string;
const levels = (process.env["LEVELS"] ?? "2,3,5,10,15,20").split(",").map(Number);
const GIVE_UP_MS = 120_000;
// Each home's first agent collects a real signal from the stand-in issuer, because servers refuse registration without one.
const cliPath = new URL("./enrolling-cli.ts", import.meta.url).pathname;
const programPath = new URL("../concierge/concierge.ts", import.meta.url).pathname;
const lines = loadLines(new URL("../concierge/lines.draft.json", import.meta.url).pathname);
const root = mkdtempSync(join(tmpdir(), "cello-concierge-stress-"));
const evidence = join(homedir(), "cello-live-runs", `concierge-stress-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(evidence, { recursive: true });
const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "cello"), `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`);
chmodSync(join(bin, "cello"), 0o755);

type Json = Record<string, unknown>;
function run(home: string, args: string[], input?: string): Promise<Json> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cliPath, ...args], { env: { ...process.env, CELLO_HOME: home }, maxBuffer: 1 << 24 }, (error, stdout, stderr) => {
      if (error && error.code !== 3) reject(new Error(`${args[0] as string}: ${(stderr || stdout || error.message).trim().slice(0, 300)}`));
      else {
        try { resolve(JSON.parse(stdout) as Json); } catch { resolve({}); }
      }
    });
    child.stdin?.end(input ?? "");
  });
}
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function online(home: string, name: string): Promise<void> {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const { agents } = await run(home, ["agents"]) as { agents: { name: string; online: boolean }[] };
    if (agents.find((a) => a.name === name)?.online) return;
    await pause(200);
  }
  throw new Error(`${name} never came online`);
}

interface Entry { own: boolean; text?: string }
async function heard(home: string, agent: string, session: string): Promise<string[]> {
  const { entries } = await run(home, ["transcript", session, "--agent", agent]) as unknown as { entries: Entry[] };
  return entries.filter((e) => !e.own && e.text).map((e) => e.text as string);
}
// `wait` sleeps until something happens, so measuring doesn't itself load the machine with polling.
async function hear(home: string, agent: string, session: string, count: number): Promise<string[]> {
  const end = Date.now() + GIVE_UP_MS;
  for (;;) {
    const got = await heard(home, agent, session);
    if (got.length >= count) return got;
    if (Date.now() > end) throw new Error(`heard ${got.length} of ${count} lines after ${GIVE_UP_MS / 1000} s`);
    await run(home, ["wait", "--timeout-seconds", "2", "--agent", agent]).catch(() => undefined);
    await pause(50);
  }
}
const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number;
};

const homeC = join(root, "concierge");
mkdirSync(homeC);
const callerHomes: string[] = [];
const program: { child?: ChildProcess } = {};
const report: Json[] = [];

async function round(level: number): Promise<Json> {
  const callers = await Promise.all(Array.from({ length: level }, async (_, i) => {
    const home = callerHomes[i] as string;
    const name = `L${level}C${i}`;
    await run(home, ["create-agent", name]);
    await online(home, name);
    return { home, name };
  }));
  await pause(2000);
  const conciergeId = process.env["CONCIERGE_ID"] as string;
  const failures: string[] = [];
  const firstReply: number[] = [];
  const nextReply: number[] = [];
  const lastReply: number[] = [];
  const started = Date.now();
  // All dials leave in the same tick, and every process is alive before the first one could finish.
  const dialled = await Promise.all(callers.map(async (c) => {
    const t0 = Date.now();
    try {
      const session = (await run(c.home, ["initiate-session", "--anyway", conciergeId, "--agent", c.name]))["session_id"] as string;
      return { ...c, session, t0, dialMs: Date.now() - t0 };
    } catch (error) {
      failures.push(`${c.name} dial: ${(error as Error).message}`);
      return undefined;
    }
  }));
  const live = dialled.filter((c) => c !== undefined);
  const dials = live.map((c) => c.dialMs);
  await Promise.all(live.map(async (c) => {
    try {
      await hear(c.home, c.name, c.session, 1);
      firstReply.push(Date.now() - c.t0);
    } catch (error) { failures.push(`${c.name} first: ${(error as Error).message}`); }
  }));
  for (const [count, times] of [[2, nextReply], [3, lastReply]] as const) {
    await Promise.all(live.map(async (c) => {
      const t = Date.now();
      try {
        await run(c.home, ["receive", "--session-id", c.session, "--agent", c.name]);
        await run(c.home, ["send", c.session, "-", "--over", "--agent", c.name], "hi");
        const got = await hear(c.home, c.name, c.session, count);
        times.push(Date.now() - t);
        const want = [lines.first, lines.next_step, lines.last].slice(0, count);
        if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${c.name}: wrong or repeated lines after ${count}: heard ${got.length}`);
      } catch (error) { failures.push(`${c.name} line ${count}: ${(error as Error).message}`); }
    }));
  }
  await Promise.all(live.map((c) => run(c.home, ["close-session", c.session, "--agent", c.name]).catch((error: Error) => { failures.push(`${c.name} close: ${error.message}`); })));
  const stats = (v: number[]): Json => ({ n: v.length, median_ms: percentile(v, 0.5), worst_ms: percentile(v, 1) });
  return { callers: level, seconds: Math.round((Date.now() - started) / 1000), load_after: loadavg()[0], dial: stats(dials), first_reply: stats(firstReply), next_step: stats(nextReply), last_line: stats(lastReply), failures };
}

async function main(): Promise<void> {
  await run(homeC, ["login", "--server", url]);
  const id = (await run(homeC, ["create-agent", "Concierge"]))["agent_id"] as string;
  process.env["CONCIERGE_ID"] = id;
  await online(homeC, "Concierge");
  program.child = spawn("sh", ["-c", `exec "${process.execPath}" "${programPath}" --agent Concierge 2>>"${join(evidence, "concierge.log")}"`], { stdio: "ignore", env: { ...process.env, CELLO_HOME: homeC, PATH: `${bin}:${process.env["PATH"] as string}` } });
  const most = Math.max(...levels);
  for (let i = 0; i < most; i++) {
    const home = join(root, `caller${i}`);
    mkdirSync(home);
    callerHomes.push(home);
    await run(home, ["login", "--server", url]);
  }
  for (const level of levels) {
    const result = await round(level);
    report.push(result);
    writeFileSync(join(evidence, "results.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    await pause(5000);
  }
}
try {
  await main();
} finally {
  program.child?.kill("SIGKILL");
  spawnSync(process.execPath, [cliPath, "logout"], { env: { ...process.env, CELLO_HOME: homeC } });
  for (const home of callerHomes) spawnSync(process.execPath, [cliPath, "logout"], { env: { ...process.env, CELLO_HOME: home } });
  process.stdout.write(`evidence: ${evidence}\n`);
}
process.exit(0);

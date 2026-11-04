// Runs the plan one row at a time and enforces the heavy-run rules: wait out the speed test, keep
// each run short, leave gaps, record the load between runs, and stop if the machine doesn't recover.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    only: { type: "string" },
    // Rows to run again because other work on the Mac overlapped them. The first attempt stays in the record.
    redo: { type: "string" },
    attempt: { type: "string", default: "2" },
    "wait-speed-min": { type: "string", default: "40" },
    "gap-s": { type: "string", default: "30" },
    "load-limit": { type: "string", default: "8" },
    "recover-s": { type: "string", default: "180" },
  },
});
const OUT = args.out as string;
if (!OUT) throw new Error("--out is required");
const RAW = join(OUT, "raw");
mkdirSync(RAW, { recursive: true });
const LOG = join(OUT, "driver.log");
const STATE = join(OUT, "runs.jsonl");
const GAP_MS = Number(args["gap-s"]) * 1000;
const LOAD_LIMIT = Number(args["load-limit"]);
const RECOVER_MS = Number(args["recover-s"]) * 1000;
const WAIT_SPEED_MS = Number(args["wait-speed-min"]) * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (line: string) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
const sh = (cmd: string, a: string[]) => {
  try { return execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
};

interface Row {
  id: string;
  phase: string;
  args: string[];
  // Keeps resuming from where the last run stopped, with the usual gap between.
  segmented?: boolean;
}

const row = (id: string, phase: string, a: string[], segmented = false): Row => ({ id, phase, args: a, segmented });
const pool = (workers: number, threads: number | "default", nospin = false) => ["--workers", String(workers), "--threads", String(threads), ...(nospin ? ["--nospin"] : [])];

const configs: Array<[string, string[]]> = [
  ["1w-default", pool(1, "default")],
  ["1w-4t-nospin", pool(1, 4, true)],
  ["1w-1t", pool(1, 1)],
  ["2w-1t", pool(2, 1)],
  ["4w-1t", pool(4, 1)],
  ["8w-1t", pool(8, 1)],
];

// Repeats run in the opposite order, so drift over the session shows up as a difference.
function plan(): Row[] {
  const rows: Row[] = [row("info", "info", ["--job", "info"])];
  rows.push(row("stall-control", "stall", ["--job", "stallControl"]));
  rows.push(row("shared-session", "memory", ["--job", "shared"]));
  rows.push(row("memparts", "memory", ["--job", "memparts"]));
  for (const n of [1, 2, 4, 8]) rows.push(row(`memory-${n}w`, "memory", ["--job", "memory", ...pool(n, 1)]));

  for (const [name, a] of configs) rows.push(row(`scores-${name}-r1`, "scores", ["--job", "scores", ...a]));
  rows.push(row("scores-1w-default-r2", "scores", ["--job", "scores", ...pool(1, "default")]));

  for (const [name, a] of configs) rows.push(row(`throughput-${name}-r1`, "throughput", ["--job", "throughput", ...a]));
  for (const [name, a] of [...configs].reverse()) rows.push(row(`throughput-${name}-r2`, "throughput", ["--job", "throughput", ...a]));
  rows.push(row("throughput-4w-1t-window-r1", "throughput", ["--job", "throughput", ...pool(4, 1), "--dispatch", "window"]));
  rows.push(row("throughput-8w-1t-window-r1", "throughput", ["--job", "throughput", ...pool(8, 1), "--dispatch", "window"]));

  const split = (name: string, message: string, a: string[]) => row(`split-${message}-${name}`, "split", ["--job", "split", "--message", message, ...a], true);
  rows.push(split("1w-default-r1", "527k", pool(1, "default")));
  rows.push(split("8w-1t-r1", "527k", pool(8, 1)));
  rows.push(split("4w-1t-r1", "527k", pool(4, 1)));
  rows.push(split("2w-1t-r1", "527k", pool(2, 1)));
  rows.push(split("1w-1t-r1", "527k", pool(1, 1)));
  rows.push(split("4w-1t-r2", "527k", pool(4, 1)));
  rows.push(split("8w-1t-r2", "527k", pool(8, 1)));
  rows.push(split("1w-default-r2", "527k", pool(1, "default")));
  rows.push(split("1w-default-r1", "1m", pool(1, "default")));
  rows.push(split("8w-1t-r1", "1m", pool(8, 1)));
  rows.push(split("4w-1t-r1", "1m", pool(4, 1)));
  rows.push(split("4w-1t-r2", "1m", pool(4, 1)));
  rows.push(split("8w-1t-r2", "1m", pool(8, 1)));

  const shorts: Array<[string, string[]]> = [
    ["idle-1w-1t", [...pool(1, 1), "--long", "0"]],
    ["1w-default-no-spare", pool(1, "default")],
    ["1w-1t-no-spare", pool(1, 1)],
    ["2w-1t-spare", [...pool(2, 1), "--reserved", "1"]],
    ["4w-1t-spare", [...pool(4, 1), "--reserved", "1"]],
    ["8w-1t-spare", [...pool(8, 1), "--reserved", "1"]],
    ["4w-1t-no-spare", pool(4, 1)],
    ["8w-1t-no-spare", pool(8, 1)],
  ];
  for (const round of [1, 2]) {
    for (const [name, a] of round === 1 ? shorts : [...shorts].reverse()) rows.push(row(`shorts-${name}-r${round}`, "shorts", ["--job", "shorts", ...a]));
  }
  const redo = args.redo?.split(",");
  if (redo) return rows.filter((r) => redo.includes(r.id));
  const only = args.only?.split(",");
  return only ? rows.filter((r) => only.includes(r.phase) || only.includes(r.id)) : rows;
}

function machine() {
  const load = sh("sysctl", ["-n", "vm.loadavg"]).replace(/[{}]/g, "").trim().split(/\s+/).map(Number);
  const pressure = sh("memory_pressure", ["-Q"]).match(/free percentage: (\d+)%/)?.[1];
  const batt = sh("pmset", ["-g", "batt"]);
  return {
    at: new Date().toISOString(), uptime: sh("uptime", []).trim(), load1: load[0] ?? NaN, memoryFreePct: pressure ? Number(pressure) : null,
    onAc: batt.includes("AC Power"), batteryPct: Number(batt.match(/(\d+)%/)?.[1] ?? NaN),
  };
}

function speedRunning(): boolean {
  // The brackets stop the pattern matching its own command line.
  return sh("pgrep", ["-f", "live/[s]peed"]).trim() !== "";
}

// A rough check on responsiveness: how long a trivial process takes to spawn and exit.
function spawnMs(): number {
  const t0 = performance.now();
  sh("/usr/bin/true", []);
  return Math.round(performance.now() - t0);
}

function otherCpu(excluded: Set<number>) {
  const lines = sh("ps", ["-A", "-o", "pid=,%cpu=,comm="]).trim().split("\n");
  const entries = lines.map((l) => {
    const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), cpu: Number(m[2]), comm: (m[3] as string).split("/").pop() as string } : null;
  }).filter((e): e is { pid: number; cpu: number; comm: string } => e !== null && !excluded.has(e.pid));
  const total = entries.reduce((n, e) => n + e.cpu, 0);
  const top = entries.sort((a, b) => b.cpu - a.cpu).slice(0, 3).map((e) => `${e.comm}:${Math.round(e.cpu)}%`);
  return { total: Math.round(total), top };
}

async function runOnce(r: Row, outFile: string, extra: string[]) {
  const before = machine();
  const child = spawn("/usr/bin/time", ["-l", process.execPath, new URL("./run.ts", import.meta.url).pathname, ...r.args, ...extra, "--out", outFile], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let pid = 0;
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
    const m = stdout.match(/\{"pid":(\d+)\}/);
    if (m) pid = Number(m[1]);
  });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const samples: Array<{ total: number; top: string[] }> = [];
  let sawSpeed = false;
  const sampler = setInterval(() => {
    if (speedRunning()) sawSpeed = true;
    samples.push(otherCpu(new Set([pid, child.pid ?? 0, process.pid])));
  }, 5000);
  // run.ts stops itself first. This is the backstop, by captured PID.
  const backstop = setTimeout(() => {
    log(`${r.id}: backstop kill of pid ${pid}`);
    if (pid) process.kill(pid, "SIGKILL");
  }, 100_000);
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
  clearInterval(sampler);
  clearTimeout(backstop);
  const peak = stderr.match(/(\d+)\s+peak memory footprint/)?.[1];
  const rss = stderr.match(/(\d+)\s+maximum resident set size/)?.[1];
  const others = samples.map((s) => s.total).sort((a, b) => a - b);
  return {
    code,
    before,
    after: machine(),
    peakFootprintMB: peak ? Math.round(Number(peak) / 1048576) : null,
    timeMaxRssMB: rss ? Math.round(Number(rss) / 1048576) : null,
    otherCpuMedianPct: others[Math.floor(others.length / 2)] ?? null,
    otherCpuMaxPct: others.at(-1) ?? null,
    otherTop: samples.at(-1)?.top ?? [],
    speedTestOverlapped: sawSpeed,
    stderrTail: code === 0 ? "" : stderr.split("\n").filter((l) => !/^\s+\d+\s/.test(l)).slice(-6).join("\n"),
  };
}

// Waits for a clear minute without the speed test. Past the deadline, it stops rather than run alongside.
async function waitForSpeedTest(): Promise<void> {
  let clearSince = 0;
  let announced = false;
  const deadline = Date.now() + WAIT_SPEED_MS;
  for (;;) {
    if (speedRunning()) {
      clearSince = 0;
      if (!announced) { log("waiting: speed test is running"); announced = true; }
      if (Date.now() > deadline) stop(`the speed test was still running at the ${WAIT_SPEED_MS / 60_000}-minute limit`);
    } else {
      if (clearSince === 0) clearSince = Date.now();
      if (Date.now() - clearSince >= 60_000 || !announced) return;
    }
    await sleep(10_000);
  }
}

function stop(reason: string): never {
  log(`STOPPED: ${reason}`);
  writeFileSync(join(OUT, "STOPPED"), `${reason}\n`);
  process.stdout.write(`STOPPED: ${reason}\n`);
  process.exit(2);
}

async function settle(): Promise<void> {
  await sleep(GAP_MS);
  const until = Date.now() + RECOVER_MS;
  for (;;) {
    const m = machine();
    const spawned = spawnMs();
    log(`between runs: ${m.uptime} | memory free ${m.memoryFreePct}% | spawn ${spawned} ms | ${m.onAc ? "AC" : "BATTERY"} ${m.batteryPct}%`);
    // M9E's rule: a heavy run needs mains power, and the battery has fallen while plugged in.
    if (!m.onAc) stop(`the Mac is on battery, at ${m.batteryPct}%`);
    if (m.batteryPct < 10) stop(`battery down to ${m.batteryPct}% while on AC`);
    if (m.load1 <= LOAD_LIMIT && spawned < 1000 && (m.memoryFreePct === null || m.memoryFreePct >= 15)) return;
    if (Date.now() > until) stop(`machine did not recover: load ${m.load1}, spawn ${spawned} ms, memory free ${m.memoryFreePct}%`);
    await sleep(15_000);
  }
}

// A stopped session resumes where it left off, including part-way through a segmented row.
const done = new Set<string>();
const resume = new Map<string, { from: number; segment: number }>();
if (existsSync(STATE)) {
  for (const line of readFileSync(STATE, "utf8").trim().split("\n").filter(Boolean)) {
    const e = JSON.parse(line) as { id: string; ok: boolean; complete: boolean; segment: number; nextFrom: number };
    if (args.redo) continue;
    if (e.ok && e.complete) done.add(e.id);
    else if (e.ok) resume.set(e.id, { from: e.nextFrom, segment: e.segment + 1 });
  }
}
const rows = plan();
log(`plan: ${rows.length} rows, ${rows.filter((r) => done.has(r.id)).length} already done`);
await waitForSpeedTest();
log(`speed test clear. ${machine().uptime}`);

for (const r of rows) {
  if (done.has(r.id)) continue;
  await waitForSpeedTest();
  await settle();
  let from = resume.get(r.id)?.from ?? 0;
  let segment = resume.get(r.id)?.segment ?? 0;
  for (;;) {
    const attempt = args.redo ? `.attempt${args.attempt}` : "";
    const file = join(RAW, r.segmented ? `${r.id}${attempt}.seg${segment}.json` : `${r.id}${attempt}.json`);
    const extra = r.segmented ? ["--from", String(from)] : [];
    const info = await runOnce(r, file, extra);
    const parsed: any = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    const complete = !r.segmented || parsed?.next >= parsed?.totalWindows;
    const entry = { id: r.id, attempt: args.redo ? Number(args.attempt) : 1, phase: r.phase, segment, from, nextFrom: parsed?.next ?? 0, complete, file: file.replace(`${OUT}/`, ""), ...info, ok: info.code === 0 && parsed !== null };
    appendFileSync(STATE, `${JSON.stringify(entry)}\n`);
    log(`${r.id}${r.segmented ? ` seg${segment}` : ""}: code ${info.code}, wall ${parsed?.wallMs ?? "?"} ms, process ${parsed?.processWallMs ?? "?"} ms, others ${info.otherCpuMedianPct}%, speed overlap ${info.speedTestOverlapped}`);
    if (!entry.ok) {
      log(`${r.id}: FAILED: ${info.stderrTail}`);
      break;
    }
    if (complete) break;
    from = parsed.next;
    segment++;
    await settle();
  }
}
log(`finished. ${machine().uptime}`);
process.stdout.write("finished\n");
process.exit(0);

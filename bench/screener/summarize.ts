// Turns a run directory into summary.md and scores-compare.json. Scores are compared as exact doubles.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doubleHex, verdictOf } from "./lib.ts";

const OUT = process.argv[2] as string;
if (!OUT) throw new Error("usage: summarize.ts <run dir>");

interface Entry {
  id: string; attempt?: number; phase: string; segment: number; file: string; ok: boolean; complete: boolean;
  peakFootprintMB: number | null; timeMaxRssMB: number | null; otherCpuMedianPct: number | null; otherCpuMaxPct: number | null;
  otherTop: string[]; speedTestOverlapped: boolean; before: { uptime: string; load1: number }; after: { uptime: string; load1: number };
}
const everyRun: Entry[] = readFileSync(join(OUT, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
// Contaminated: a speed test overlapped, or other work took more than two cores. Those numbers aren't used
// when a later attempt exists. A row with no clean attempt is listed at the end of the summary.
const CONTAMINATED_OTHER_CPU = 200;
const dirty = (e: Entry) => e.speedTestOverlapped || (e.otherCpuMedianPct ?? 0) > CONTAMINATED_OTHER_CPU;
const latestAttempt = new Map<string, number>();
for (const e of everyRun) latestAttempt.set(e.id, Math.max(latestAttempt.get(e.id) ?? 1, e.attempt ?? 1));
const all = everyRun.filter((e) => (e.attempt ?? 1) === latestAttempt.get(e.id));
const entries = all.filter((e) => e.ok);
const load = (e: Entry): any => JSON.parse(readFileSync(join(OUT, e.file), "utf8"));
const byId = (id: string) => entries.filter((e) => e.id === id);
const one = (id: string) => { const e = byId(id)[0]; return e ? { ...load(e), meta: e } : null; };

const lines: string[] = [];
const say = (s = "") => lines.push(s);
const table = (head: string[], rows: Array<Array<string | number | null | undefined>>) => {
  say(`| ${head.join(" | ")} |`);
  say(`| ${head.map(() => "---").join(" | ")} |`);
  for (const r of rows) say(`| ${r.map((c) => c ?? "").join(" | ")} |`);
  say();
};
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const spread = (v: number[]) => (v.length < 2 ? "n/a (one run)" : `${((Math.max(...v) - Math.min(...v)) / mean(v) * 100).toFixed(1)}%`);
const f1 = (n: number) => n.toFixed(1);

say(`# Screener bench: raw summary`);
say();
const info = one("info");
if (info) {
  say(`Model revision ${info.model}. Windows ${info.windowTokens} tokens, ${info.overlapTokens} overlap.`);
  say();
  table(["Message", "Bytes", "Tokens", "Windows", "Windowing ms", "Hostile whole in window", "Hostile start in window"],
    info.messages.map((m: any) => [m.name, m.bytes, m.tokens, m.windows, m.windowsMs, m.hostileWhole.join(",") , m.hostileStart.join(",")]));
}

// ---- 1. Throughput ----
say(`## 1. Throughput`);
say();
const configs = ["1w-default", "1w-4t-nospin", "1w-1t", "2w-1t", "4w-1t", "8w-1t"];
const tput = (name: string) => entries.filter((e) => e.id.startsWith(`throughput-${name}-r`)).map((e) => ({ ...load(e), meta: e }));
const baselineWall = mean(tput("1w-default").map((r) => r.wallMs));
table(["Setup", "Runs", "Wall s (each)", "Wall s (mean)", "Spread", "CPU-s (each)", "CPU per wall", "Msgs/s", "Faster than baseline", "CPU vs baseline", "Peak footprint MB", "Max RSS MB", "Other CPU % (median, each)"],
  [...configs, "4w-1t-window", "8w-1t-window"].map((name) => {
    const runs = tput(name);
    if (runs.length === 0) return [name, 0];
    const walls = runs.map((r) => r.wallMs / 1000);
    const cpus = runs.map((r) => r.cpuS);
    const baselineCpu = mean(tput("1w-default").map((r) => r.cpuS));
    return [name, runs.length, walls.map(f1).join(", "), f1(mean(walls)), spread(walls), cpus.map(f1).join(", "), f1(mean(runs.map((r) => r.cpuPerWall))),
      (runs[0].messages / mean(walls)).toFixed(3), `${(baselineWall / 1000 / mean(walls)).toFixed(2)}x`, `${(mean(cpus) / baselineCpu).toFixed(2)}x`,
      runs.map((r) => r.meta.peakFootprintMB).join(", "), runs.map((r) => r.maxRssMB).join(", "), runs.map((r) => r.meta.otherCpuMedianPct).join(", ")];
  }));

// ---- 2. Split ----
say(`## 2. One long message split across workers`);
say();
function assembled(id: string) {
  const segs = byId(id).sort((a, b) => a.segment - b.segment);
  if (segs.length === 0 || !segs.at(-1)?.complete) return null;
  const parts = segs.map((e) => ({ ...load(e), meta: e }));
  const scores: number[] = parts.flatMap((p) => p.scores);
  return {
    scores, sha: parts[0].sha, totalWindows: parts[0].totalWindows, tokens: parts[0].tokens, segments: parts.length, tokenizeMs: parts[0].tokenizeMs,
    wallS: (parts[0].tokenizeMs + parts.reduce((n, p) => n + p.scoringMs, 0)) / 1000, cpuS: parts.reduce((n, p) => n + p.scoringCpuS, 0),
    peak: Math.max(...parts.map((p) => p.meta.peakFootprintMB ?? 0)), maxRss: Math.max(...parts.map((p) => p.maxRssMB)), other: parts.map((p) => p.meta.otherCpuMedianPct),
    stall: Math.max(...parts.map((p) => p.mainGapMaxMs)), socketMax: Math.max(...parts.map((p) => p.socket.maxMs)),
  };
}
const splitIds = [...new Set(entries.filter((e) => e.phase === "split").map((e) => e.id))];
const splitBase = (msg: string) => assembled(`split-${msg}-1w-default-r1`);
table(["Row", "Windows", "Segments", "Scoring wall s", "CPU-s", "Faster than one default worker", "Peak footprint MB", "Max RSS MB", "Main stall ms", "Socket max ms", "Other CPU %"],
  splitIds.map((id) => {
    const a = assembled(id);
    if (!a) return [id, "incomplete"];
    const msg = id.split("-")[1] as string;
    const base = splitBase(msg);
    return [id, a.totalWindows, a.segments, f1(a.wallS), f1(a.cpuS), base ? `${(base.wallS / a.wallS).toFixed(2)}x` : "", a.peak, a.maxRss, a.stall, a.socketMax, a.other.join(",")];
  }));

// ---- 3. Memory ----
say(`## 3. Memory`);
say();
table(["Workers (1 thread each)", "RSS after load MB", "RSS after one full window on each MB", "Max RSS MB", "Peak footprint MB", "Load ms per worker"],
  [1, 2, 4, 8].map((n) => { const r = one(`memory-${n}w`); return r ? [n, r.rssAfterLoadMB, r.rssAfterWindowMB, r.maxRssMB, r.meta.peakFootprintMB, r.loadMs.join(", ")] : [n, "missing"]; }));
const parts = one("memparts");
if (parts) { say(`Steps on one thread (MB of RSS): ${JSON.stringify(parts.steps)}`); say(); }
const shared = one("shared-session");
if (shared) {
  say(`**One session, same thread:** ${shared.windows} windows in turn ${f1(shared.inTurnMs)} ms, all at once ${f1(shared.atOnceMs)} ms, speedup ${shared.speedup}x. Scores identical: ${shared.scoresIdentical}. Completion times from the start: ${JSON.stringify(shared.spans)}. Main-thread stall ${shared.mainGapMaxMs} ms.`);
  say(`Sharing the session object with another thread: ${shared.shareSessionObject}. Its handler: ${shared.shareSessionHandler}.`);
  say();
}

// ---- 4. Scores ----
say(`## 4. Scores, compared exactly`);
say();
interface Mismatch { row: string; message: string; window: number; baseline: number; got: number; baseHex: string; gotHex: string }
const report: any = { comparisons: 0, windowsCompared: 0, mismatches: [] as Mismatch[], windowSetMismatches: [] as string[], verdictChanges: [] as string[], perMessage: {} };

function compare(row: string, name: string, base: { scores: number[]; sha: string }, got: { scores: number[]; sha: string }) {
  report.comparisons++;
  if (base.sha !== got.sha) report.windowSetMismatches.push(`${row} ${name}`);
  if (base.scores.length !== got.scores.length) report.windowSetMismatches.push(`${row} ${name}: ${base.scores.length} vs ${got.scores.length} windows`);
  base.scores.forEach((b, i) => {
    report.windowsCompared++;
    const g = got.scores[i] as number;
    if (!Object.is(b, g)) report.mismatches.push({ row, message: name, window: i, baseline: b, got: g, baseHex: doubleHex(b), gotHex: doubleHex(g ?? NaN) });
  });
  const before = verdictOf(Math.max(...base.scores));
  const after = verdictOf(Math.max(...got.scores));
  if (before.verdict !== after.verdict || before.score !== after.score) report.verdictChanges.push(`${row} ${name}: ${JSON.stringify(before)} became ${JSON.stringify(after)}`);
}

const scoresBase = one("scores-1w-default-r1");
if (scoresBase) {
  for (const e of entries.filter((x) => x.phase === "scores")) {
    const r = load(e);
    for (const name of Object.keys(scoresBase.byMessage)) {
      compare(`${e.id} whole`, name, scoresBase.byMessage[name], r.byMessage[name]);
      compare(`${e.id} split`, name, scoresBase.byMessage[name], r.byWindow[name]);
    }
  }
  for (const [name, v] of Object.entries<any>(scoresBase.byMessage)) {
    const p = Math.max(...v.scores);
    report.perMessage[name] = { probability: p, ...verdictOf(p), windows: v.scores.length, worstWindow: v.scores.indexOf(p) };
  }
  table(["Text", "Windows", "Worst window", "Probability", "Score", "Verdict"],
    Object.entries<any>(report.perMessage).map(([name, m]) => [name, m.windows, m.worstWindow, m.probability, m.score, m.verdict]));
}
const tputBase = tput("1w-default")[0];
if (tputBase) {
  for (const e of entries.filter((x) => x.phase === "throughput")) {
    const r = load(e);
    for (const name of Object.keys(tputBase.results)) compare(e.id, name, tputBase.results[name], r.results[name]);
  }
}
for (const msg of ["527k", "1m"]) {
  const base = splitBase(msg);
  if (!base) continue;
  for (const id of splitIds.filter((i) => i.startsWith(`split-${msg}-`))) {
    const a = assembled(id);
    if (a) compare(id, `hash-${msg}`, base, a);
  }
}
say(`Compared ${report.comparisons} messages, ${report.windowsCompared} window scores, exactly. Mismatched scores: **${report.mismatches.length}**. Different window sets: **${report.windowSetMismatches.length}**. Changed verdicts: **${report.verdictChanges.length}**.`);
say();
if (report.mismatches.length > 0) {
  const byRow = new Map<string, number>();
  for (const m of report.mismatches as Mismatch[]) byRow.set(m.row, (byRow.get(m.row) ?? 0) + 1);
  const worst = Math.max(...(report.mismatches as Mismatch[]).map((m) => Math.abs(m.baseline - m.got)));
  say(`**SCORES DIFFER.** Largest difference ${worst}. By row: ${JSON.stringify([...byRow])}`);
  say();
}
if (report.verdictChanges.length > 0) { say(`**VERDICTS CHANGED:** ${report.verdictChanges.join("; ")}`); say(); }

// The comparison must be able to fail. Each of these damages a split on purpose.
if (scoresBase) {
  const tail = scoresBase.byMessage["hostile-tail-60k"];
  const twin = scoresBase.byMessage["hostile-tail-60k-twin"];
  const scoresWithoutLast: number[] = tail.scores.slice(0, -1);
  const lost = { scores: [...scoresWithoutLast, Math.min(...scoresWithoutLast)], sha: tail.sha };
  const ulp = Buffer.alloc(8);
  ulp.writeDoubleBE(tail.scores[0]);
  ulp.writeBigUInt64BE(ulp.readBigUInt64BE() + 1n);
  const nudged = { scores: [ulp.readDoubleBE(), ...tail.scores.slice(1)], sha: tail.sha };
  const teeth = {
    hostileTailFull: verdictOf(Math.max(...tail.scores)),
    hostileTailWindowsScores: tail.scores,
    twinWithoutHostile: verdictOf(Math.max(...twin.scores)),
    ifLastWindowWereLost: verdictOf(Math.max(...lost.scores)),
    aSplitLosingTheLastWindowIsDetected: !tail.scores.every((p: number, i: number) => Object.is(p, lost.scores[i])),
    aOneBitChangeIsDetected: !tail.scores.every((p: number, i: number) => Object.is(p, nudged.scores[i])),
  };
  report.teeth = teeth;
  say(`**Control:** hostile tail ${JSON.stringify(teeth.hostileTailFull)}; the same text without the hostile passage ${JSON.stringify(teeth.twinWithoutHostile)}; had the last window been lost ${JSON.stringify(teeth.ifLastWindowWereLost)}. Losing that window is detected: ${teeth.aSplitLosingTheLastWindowIsDetected}. A one-bit change is detected: ${teeth.aOneBitChangeIsDetected}.`);
  say();
}
writeFileSync(join(OUT, "scores-compare.json"), JSON.stringify(report, null, 1));

// ---- 5. Shorts ----
say(`## 5. Short messages during long ones`);
say();
const shortNames = ["idle-1w-1t", "1w-default-no-spare", "1w-1t-no-spare", "2w-1t-spare", "4w-1t-spare", "8w-1t-spare", "4w-1t-no-spare", "8w-1t-no-spare"];
table(["Setup", "Run", "Sent", "Answered", "Median ms", "p95 ms", "Max ms", "Long windows/s", "CPU per wall", "Main stall ms", "Socket max ms", "Other CPU %"],
  shortNames.flatMap((name) => entries.filter((e) => e.id.startsWith(`shorts-${name}-r`)).map((e) => {
    const r = load(e);
    return [name, e.id.at(-1), r.sent, r.answered, r.shortP50Ms, r.shortP95Ms, r.shortMaxMs, r.longWindowsPerSec, r.cpuPerWall, r.mainGapMaxMs, r.socket.maxMs, e.otherCpuMedianPct];
  })));

// ---- 6. Stall ----
say(`## 6. Main-thread stall`);
say();
const control = one("stall-control");
if (control) {
  say(`**Control:** windowing the 527 KB message ON the main thread took ${control.windowsMsOnMainThread} ms, and the probes saw a main-thread stall of ${control.mainGapMaxMs} ms and a slowest socket reply of ${control.socket.maxMs} ms. So they do see a blocked thread.`);
  say();
}
const stallRows = entries.filter((e) => e.phase === "throughput" || e.phase === "split" || e.phase === "shorts").map((e) => ({ id: e.id, r: load(e) }));
table(["Phase", "Runs", "Worst main stall ms", "Worst event-loop delay ms", "Worst socket reply ms", "Worst p99 socket ms", "Pings", "In row"],
  ["throughput", "split", "shorts"].map((phase) => {
    const rows = stallRows.filter((s) => s.id.startsWith(phase));
    if (rows.length === 0) return [phase, 0];
    const worst = rows.reduce((a, b) => (b.r.mainGapMaxMs > a.r.mainGapMaxMs ? b : a));
    return [phase, rows.length, Math.max(...rows.map((s) => s.r.mainGapMaxMs)), Math.max(...rows.map((s) => s.r.eventLoopDelayMaxMs)), Math.max(...rows.map((s) => s.r.socket.maxMs)), Math.max(...rows.map((s) => s.r.socket.p99Ms)), rows.reduce((n, s) => n + s.r.socket.pings, 0), worst.id];
  }));

// ---- context ----
say(`## What else was running`);
say();
const others = all.map((e) => e.otherCpuMedianPct).filter((n): n is number => n !== null).sort((a, b) => a - b);
say(`Runs: ${all.length}, of which failed: ${all.filter((e) => !e.ok).map((e) => e.id).join(", ") || "none"}. Speed test overlapped: ${all.filter((e) => e.speedTestOverlapped).map((e) => e.id).join(", ") || "none"}.`);
say(`Other processes' CPU during runs (per run's median, 100% is one core): lowest ${others[0]}%, middle ${others[Math.floor(others.length / 2)]}%, highest ${others.at(-1)}%. Busiest during runs: ${JSON.stringify(all.filter((e) => (e.otherCpuMaxPct ?? 0) >= 200).slice(0, 12).map((e) => [e.id, e.otherCpuMaxPct, e.otherTop]))}`);
say(`Highest load seen after a run: ${Math.max(...all.map((e) => e.after.load1))}.`);
const contaminated = [...new Set(everyRun.filter(dirty).map((e) => e.id))];
say(`Rows contaminated on a first attempt: ${contaminated.join(", ") || "none"}.`);
say(`Rows whose numbers in this summary are still contaminated: ${[...new Set(all.filter(dirty).map((e) => e.id))].join(", ") || "none"}.`);
say();
writeFileSync(join(OUT, "summary.md"), `${lines.join("\n")}\n`);
process.stdout.write(`${lines.join("\n")}\n`);

// One benchmark row, in its own process, so CPU and peak memory belong to that row alone.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import {
  SCREENER_MODEL, SELFCHECK, importRuntime, loadPipe, percentile, scoreWindow, sourceProvenance, windowsOf, windowsSha,
  type ThreadCfg, MODEL_DIR,
} from "./lib.ts";
import {
  HOSTILE, SPLIT_SIZES, hashMessage, hostileAcrossBoundary, hostileTail, hostileTailTwin, longHash, proseMessage, shortMessage, throughputWorkload,
  type NamedMessage,
} from "./messages.ts";

const processStart = performance.now();
const { values: args } = parseArgs({
  options: {
    job: { type: "string" },
    workers: { type: "string", default: "1" },
    threads: { type: "string", default: "1" },
    nospin: { type: "boolean", default: false },
    dispatch: { type: "string", default: "message" },
    message: { type: "string", default: "527k" },
    from: { type: "string", default: "0" },
    "budget-ms": { type: "string", default: "78000" },
    "hard-ms": { type: "string", default: "92000" },
    seconds: { type: "string", default: "30" },
    reserved: { type: "string", default: "0" },
    long: { type: "string", default: "1" },
    out: { type: "string" },
  },
});

const HARD_MS = Number(args["hard-ms"]);
setTimeout(() => {
  process.stderr.write(`row passed its hard limit of ${HARD_MS} ms: stopped so no run can overstay\n`);
  process.exit(3);
}, HARD_MS).unref();

const cfg: ThreadCfg = {
  threads: args.threads === "default" ? "default" : Number(args.threads),
  spin: !args.nospin,
};
const workerCount = Number(args.workers);
process.stdout.write(`${JSON.stringify({ pid: process.pid })}\n`);

// ---- the main thread's own health, sampled for the whole row ----
function startProbes() {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  let last = performance.now();
  let maxGap = 0;
  const gapTimer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last - 10);
    last = now;
  }, 10);
  let peakSampleRss = 0;
  const rssTimer = setInterval(() => { peakSampleRss = Math.max(peakSampleRss, process.memoryUsage.rss()); }, 200);

  const dir = mkdtempSync(join(tmpdir(), "scrb-"));
  const path = join(dir, "p.sock");
  const server = createServer((c) => {
    c.on("data", (d) => { c.write(d); });
    c.on("error", () => {});
  });
  let child: ReturnType<typeof spawn> | undefined;
  let probeOut = "";
  server.listen(path, () => {
    child = spawn(process.execPath, [new URL("./probe.ts", import.meta.url).pathname, path], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout?.on("data", (d: Buffer) => { probeOut += d.toString(); });
  });

  return {
    resetStall() { delay.reset(); maxGap = 0; last = performance.now(); },
    async finish() {
      clearInterval(gapTimer);
      clearInterval(rssTimer);
      delay.disable();
      const closed = new Promise<void>((resolve) => {
        if (!child) { resolve(); return; }
        child.on("close", () => resolve());
        child.kill("SIGTERM");
      });
      await closed;
      server.close();
      rmSync(dir, { recursive: true, force: true });
      const parsed = probeOut.trim() ? JSON.parse(probeOut.trim().split("\n").at(-1) as string) as { rtts: number[]; stillWaitingMs: number } : { rtts: [], stillWaitingMs: NaN };
      return {
        mainGapMaxMs: round(maxGap),
        eventLoopDelayMaxMs: round(delay.max / 1e6),
        socket: {
          pings: parsed.rtts.length,
          p50Ms: round(percentile(parsed.rtts, 50)),
          p99Ms: round(percentile(parsed.rtts, 99)),
          maxMs: round(Math.max(0, ...parsed.rtts)),
          unansweredAtEndMs: round(parsed.stillWaitingMs),
        },
        peakSampleRssMB: mb(peakSampleRss),
      };
    },
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
const mb = (n: number) => Math.round(n / 1024 / 1024);

// ---- the pool ----
class Pool {
  readonly workers: Worker[] = [];
  readonly loadMs: number[] = [];
  #nextId = 0;
  readonly #waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  // One at a time: start-up shouldn't be a burst of its own.
  async load(n: number, config: ThreadCfg): Promise<void> {
    for (let i = 0; i < n; i++) {
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { cfg: config } });
      await new Promise<void>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", (m: { type: string; loadMs: number }) => {
          this.loadMs.push(round(m.loadMs));
          resolve();
        });
      });
      worker.on("error", (err: Error) => {
        process.stderr.write(`worker ${i} crashed: ${err.message}\n`);
        process.exit(4);
      });
      worker.on("message", (m: { id: number; error?: string }) => {
        const entry = this.#waiting.get(m.id);
        if (!entry) return;
        this.#waiting.delete(m.id);
        if (m.error) entry.reject(new Error(m.error));
        else entry.resolve(m);
      });
      this.workers.push(worker);
    }
  }

  call(i: number, kind: "windows" | "score" | "classify", text: string): Promise<any> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      (this.workers[i] as Worker).postMessage({ id, kind, text });
    });
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

// ---- scoring strategies ----
interface MessageResult {
  scores: number[];
  sha: string;
}

// Each message goes whole to the next free worker.
async function scoreByMessage(pool: Pool, messages: NamedMessage[]): Promise<Record<string, MessageResult>> {
  const queue = [...messages];
  const results: Record<string, MessageResult> = {};
  await Promise.all(pool.workers.map(async (_, i) => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const r = await pool.call(i, "classify", m.text);
      results[m.name] = { scores: r.scores, sha: r.sha };
    }
  }));
  return results;
}

// Windows from every message share one queue. Tokenizing also happens on the workers.
async function scoreByWindow(pool: Pool, messages: NamedMessage[]): Promise<Record<string, MessageResult>> {
  const tokenQueue = [...messages];
  const tokenized: Record<string, { windows: string[]; sha: string }> = {};
  await Promise.all(pool.workers.map(async (_, i) => {
    for (let m = tokenQueue.shift(); m; m = tokenQueue.shift()) {
      const r = await pool.call(i, "windows", m.text);
      tokenized[m.name] = { windows: r.windows, sha: r.sha };
    }
  }));
  const tasks = messages.flatMap((m) => (tokenized[m.name] as { windows: string[] }).windows.map((window, index) => ({ name: m.name, index, window })));
  const results: Record<string, MessageResult> = {};
  for (const m of messages) results[m.name] = { scores: [], sha: (tokenized[m.name] as { sha: string }).sha };
  await Promise.all(pool.workers.map(async (_, i) => {
    for (let t = tasks.shift(); t; t = tasks.shift()) {
      const r = await pool.call(i, "score", t.window);
      (results[t.name] as MessageResult).scores[t.index] = r.p;
    }
  }));
  return results;
}

// A session can't be shared if its clone can't run. So clone it the way postMessage would, and look.
function shareAttempt(value: any): string {
  try {
    const clone: any = structuredClone(value);
    return `cloned, and the clone's run is ${typeof clone?.run}`;
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  }
}

async function tokenizerOnly(): Promise<any> {
  const mod = await importRuntime();
  return mod.AutoTokenizer.from_pretrained(MODEL_DIR, { local_files_only: true });
}

// ---- jobs ----
async function withPool(run: (pool: Pool, probes: ReturnType<typeof startProbes>) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const probes = startProbes();
  const pool = new Pool();
  await pool.load(workerCount, cfg);
  const rssAfterLoadMB = mb(process.memoryUsage.rss());
  probes.resetStall();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const body = await run(pool, probes);
  const wallMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const cpuS = (cpu.user + cpu.system) / 1e6;
  await pool.stop();
  return {
    wallMs: round(wallMs),
    cpuS: round(cpuS),
    cpuPerWall: round(cpuS / (wallMs / 1000)),
    loadMs: pool.loadMs,
    rssAfterLoadMB,
    ...(await probes.finish()),
    ...body,
  };
}

const jobs: Record<string, () => Promise<Record<string, unknown>>> = {
  // Tiny: a worker loads, tells benign from hostile, and scores one small window.
  smoke: () => withPool(async (pool) => {
    const benign = await pool.call(0, "classify", SELFCHECK.benign);
    const hostile = await pool.call(0, "classify", SELFCHECK.hostile);
    const hash2k = await pool.call(0, "classify", hashMessage("smoke", 2_000));
    const windowOf30k = (await pool.call(0, "windows", hashMessage("smoke", 30_000)));
    const t = performance.now();
    const one = await pool.call(0, "score", windowOf30k.windows[0]);
    return { benign: benign.scores, hostile: hostile.scores, hash2k: hash2k.scores, tokens30k: windowOf30k.tokens, windows30k: windowOf30k.windows.length, fullWindowMs: round(performance.now() - t), fullWindowP: one.p };
  }),

  // Tokens, windows and the windows' hash for every message the bench uses.
  info: async () => {
    const pipe = await loadPipe({ threads: 1, spin: true });
    const set = await scoreSet(pipe.tokenizer);
    const list = [...throughputWorkload(), ...set, longHash(SPLIT_SIZES["527k"] as number), longHash(SPLIT_SIZES["1m"] as number), { name: "short-0", text: shortMessage(0) }];
    const messages = list.map((m) => {
      const t0 = performance.now();
      const windows = windowsOf(pipe, m.text);
      const windowsMs = performance.now() - t0;
      // Which windows hold the hostile passage whole, and which hold only its start: the boundary case depends on this.
      const passage = HOSTILE.toLowerCase();
      const hostileWhole = windows.flatMap((w, i) => (w.toLowerCase().includes(passage) ? [i] : []));
      const hostileStart = windows.flatMap((w, i) => (w.toLowerCase().includes(passage.slice(0, 32)) ? [i] : []));
      return { name: m.name, bytes: Buffer.byteLength(m.text), tokens: pipe.tokenizer.encode(m.text).length, windows: windows.length, windowsMs: round(windowsMs), sha: windowsSha(windows), hostileWhole, hostileStart };
    });
    return { messages, model: SCREENER_MODEL.revision, modelDir: MODEL_DIR, source: sourceProvenance(), windowTokens: SCREENER_MODEL.windowTokens, overlapTokens: SCREENER_MODEL.windowOverlapTokens };
  },

  throughput: () => withPool(async (pool) => {
    const messages = throughputWorkload();
    const results = args.dispatch === "window" ? await scoreByWindow(pool, messages) : await scoreByMessage(pool, messages);
    return { messages: messages.length, results };
  }),

  // One long message, its windows across the pool. Stops taking windows at the budget, so a row can resume.
  split: () => withPool(async (pool) => {
    const size = SPLIT_SIZES[args.message as string];
    if (!size) throw new Error(`unknown message ${args.message}`);
    const message = longHash(size);
    const tokenized = await pool.call(0, "windows", message.text);
    const windows: string[] = tokenized.windows;
    const from = Number(args.from);
    const budget = Number(args["budget-ms"]);
    const scores: Array<number | null> = new Array(windows.length).fill(null);
    let next = from;
    const scoring0 = performance.now();
    const cpu0 = process.cpuUsage();
    await Promise.all(pool.workers.map(async (_, i) => {
      while (next < windows.length && performance.now() - processStart < budget) {
        const index = next++;
        const r = await pool.call(i, "score", windows[index] as string);
        scores[index] = r.p;
      }
    }));
    const cpu = process.cpuUsage(cpu0);
    return {
      message: message.name, bytes: size, tokens: tokenized.tokens, totalWindows: windows.length, sha: tokenized.sha,
      tokenizeMs: round(tokenized.windowsMs), from, next, scores: scores.slice(from, next),
      scoringMs: round(performance.now() - scoring0), scoringCpuS: round((cpu.user + cpu.system) / 1e6),
    };
  }),

  // Short messages while long windows run. `reserved` workers take only short ones.
  shorts: () => withPool(async (pool) => {
    const seconds = Number(args.seconds);
    const reserved = Number(args.reserved);
    const longOn = args.long === "1";
    const windows: string[] = longOn ? (await pool.call(workerCount - 1, "windows", hashMessage("shorts-long", 200_000))).windows : [];
    const deadline = performance.now() + seconds * 1000;
    const shortQueue: Array<{ text: string; at: number }> = [];
    const latencies: number[] = [];
    let wake: Array<() => void> = [];
    let longCursor = 0;
    let longDone = 0;
    let probesDone = false;
    const notify = () => { const w = wake; wake = []; for (const f of w) f(); };

    const loops = pool.workers.map(async (_, i) => {
      const takesShort = i < reserved || reserved === 0;
      const takesLong = longOn && i >= reserved;
      for (;;) {
        const short = takesShort ? shortQueue.shift() : undefined;
        if (short) {
          await pool.call(i, "classify", short.text);
          latencies.push(performance.now() - short.at);
          continue;
        }
        if (takesLong && performance.now() < deadline) {
          await pool.call(i, "score", windows[longCursor++ % windows.length] as string);
          longDone++;
          continue;
        }
        if (probesDone && (!takesShort || shortQueue.length === 0)) return;
        await new Promise<void>((resolve) => wake.push(resolve));
      }
    });

    let sent = 0;
    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (performance.now() >= deadline) {
          clearInterval(timer);
          resolve();
          return;
        }
        shortQueue.push({ text: shortMessage(sent++), at: performance.now() });
        notify();
      }, 1000);
    });
    probesDone = true;
    notify();
    await Promise.all(loops);
    return {
      seconds, reserved, longOn, sent, answered: latencies.length,
      shortP50Ms: round(percentile(latencies, 50)), shortP95Ms: round(percentile(latencies, 95)), shortMaxMs: round(Math.max(0, ...latencies)),
      longWindowsDone: longDone, longWindowsPerSec: round(longDone / ((performance.now() - startedAt) / 1000)),
    };
  }),

  // Question 4: every text scored whole on a worker, then split by windows across the pool.
  scores: () => withPool(async (pool) => {
    const set = await scoreSet(await tokenizerOnly());
    const byMessage = await scoreByMessage(pool, set);
    const byWindow = await scoreByWindow(pool, set);
    return { byMessage, byWindow };
  }),

  // Peak memory by worker count: loaded, then one full window on every worker at once.
  memory: () => withPool(async (pool) => {
    const r = await pool.call(0, "windows", hashMessage("memory", 6_000));
    const window = r.windows[0] as string;
    const rssBefore = mb(process.memoryUsage.rss());
    await Promise.all(pool.workers.map((_, i) => pool.call(i, "score", window)));
    return { windowTokens: r.tokens, rssBeforeWindowMB: rssBefore, rssAfterWindowMB: mb(process.memoryUsage.rss()) };
  }),

  // What one worker's memory is made of, on one thread, step by step.
  memparts: async () => {
    const steps: Record<string, number> = { node: mb(process.memoryUsage.rss()) };
    const mod = await importRuntime();
    steps["runtimeImported"] = mb(process.memoryUsage.rss());
    const tok = await mod.AutoTokenizer.from_pretrained(MODEL_DIR, { local_files_only: true });
    steps["tokenizerLoaded"] = mb(process.memoryUsage.rss());
    const pipe = await mod.pipeline("text-classification", MODEL_DIR, { local_files_only: true, session_options: { intraOpNumThreads: 1 } });
    steps["modelAndSecondTokenizerLoaded"] = mb(process.memoryUsage.rss());
    const window = (windowsOf(pipe, hashMessage("memparts", 6_000)))[0] as string;
    await scoreWindow(pipe, window);
    steps["afterOneFullWindow"] = mb(process.memoryUsage.rss());
    return { steps, tokenizerTokens: tok.encode("x").length };
  },

  // Can one session run concurrently? Same windows in turn, then all at once, then try sharing it.
  shared: async () => {
    const probes = startProbes();
    const pipe = await loadPipe({ threads: 1, spin: true });
    const windows = windowsOf(pipe, hashMessage("shared", 30_000)).slice(0, 4);
    await new Promise((r) => setTimeout(r, 200));
    probes.resetStall();
    const inTurnAt = performance.now();
    const inTurn: number[] = [];
    for (const w of windows) inTurn.push(await scoreWindow(pipe, w));
    const inTurnMs = performance.now() - inTurnAt;

    const session = pipe.model.sessions.model;
    const shareSessionObject = shareAttempt(session);
    const shareSessionHandler = shareAttempt(session.handler);
    const realRun = session.run.bind(session);
    const spans: Array<[number, number]> = [];
    session.run = async (...a: unknown[]) => {
      const start = performance.now();
      const out = await realRun(...a);
      spans.push([start, performance.now()]);
      return out;
    };
    const atOnceAt = performance.now();
    const atOnce = await Promise.all(windows.map((w) => scoreWindow(pipe, w)));
    const atOnceMs = performance.now() - atOnceAt;

    const stall = await probes.finish();
    return {
      windows: windows.length, inTurnMs: round(inTurnMs), atOnceMs: round(atOnceMs), speedup: round(inTurnMs / atOnceMs),
      scoresIdentical: inTurn.every((p, i) => Object.is(p, atOnce[i])),
      overlapNote: "All calls enter session.run at once, but each is a synchronous native call on this thread. mainGapMaxMs shows the thread being held for a whole window.",
      spans: spans.map(([a, b]) => [round(a - atOnceAt), round(b - atOnceAt)]),
      shareSessionObject,
      shareSessionHandler,
      ...stall,
    };
  },

  // The control for the stall probes: tokenize a long message on the main thread, where they must see it.
  stallControl: async () => {
    const pipe = await loadPipe({ threads: 1, spin: true });
    const probes = startProbes();
    await new Promise((r) => setTimeout(r, 600));
    probes.resetStall();
    const t0 = performance.now();
    const windows = windowsOf(pipe, longHash(SPLIT_SIZES["527k"] as number).text);
    const windowsMs = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 300));
    return { windows: windows.length, windowsMsOnMainThread: round(windowsMs), ...(await probes.finish()) };
  },
};

// The texts that must score the same everywhere. The twin has the hostile passage removed: if the twin
// also scored high, catching the hostile message would prove nothing.
async function scoreSet(tokenizer: any): Promise<NamedMessage[]> {
  const window = SCREENER_MODEL.windowTokens as number;
  return [
    { name: "benign-short", text: SELFCHECK.benign },
    { name: "hostile-short", text: SELFCHECK.hostile },
    { name: "benign-long-30k", text: proseMessage("set", 30_000) },
    { name: "hashes-30k", text: hashMessage("set", 30_000) },
    { name: "hostile-tail-60k", text: hostileTail("set", 60_000) },
    { name: "hostile-tail-60k-twin", text: hostileTailTwin("set", 60_000) },
    { name: "hostile-across-boundary-20k", text: hostileAcrossBoundary("boundary", 20_000, tokenizer, window) },
  ];
}

const job = jobs[args.job as string];
if (!job) throw new Error(`unknown job ${args.job}`);
const started = new Date().toISOString();
const body = await job();
const usage = process.resourceUsage();
const result: Record<string, unknown> = {
  job: args.job, workers: workerCount, threads: cfg.threads, spin: cfg.spin, dispatch: args.dispatch, started,
  processWallMs: round(performance.now() - processStart),
  maxRssMB: Math.round(usage.maxRSS / 1024),
  ...body,
};
if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 1));
else process.stdout.write(`${JSON.stringify(result)}\n`);
process.stdout.write(`${JSON.stringify({ done: true, wallMs: result["wallMs"], maxRssMB: result["maxRssMB"] })}\n`);
process.exit(0);

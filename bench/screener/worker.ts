// One model, in one worker thread. Only the main thread decides what it runs next.
import { parentPort, workerData } from "node:worker_threads";
import { loadPipe, scoreWindow, windowsOf, windowsSha } from "./lib.ts";

const port = parentPort;
if (!port) throw new Error("worker.ts must run as a worker thread");

const started = performance.now();
const pipe = await loadPipe(workerData.cfg);
port.postMessage({ type: "ready", loadMs: performance.now() - started });

port.on("message", (job: { id: number; kind: "windows" | "score" | "classify"; text: string }) => {
  void handle(job).then(
    (reply) => port.postMessage({ id: job.id, ...reply }),
    (err: unknown) => port.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) }),
  );
});

async function handle(job: { kind: string; text: string }): Promise<Record<string, unknown>> {
  const t0 = performance.now();
  if (job.kind === "windows") {
    const windows = windowsOf(pipe, job.text);
    const windowsMs = performance.now() - t0;
    return { windows, windowsMs, tokens: pipe.tokenizer.encode(job.text).length, sha: windowsSha(windows) };
  }
  if (job.kind === "score") {
    const p = await scoreWindow(pipe, job.text);
    return { p, ms: performance.now() - t0 };
  }
  // Whole message on one worker: what classify() does today.
  const windows = windowsOf(pipe, job.text);
  const scores: number[] = [];
  for (const window of windows) scores.push(await scoreWindow(pipe, window));
  return { scores, sha: windowsSha(windows), ms: performance.now() - t0 };
}

// The screening thread. It holds the model and never touches a socket or the database. It does one step when told to,
// so the main thread decides what runs next, and a short message never waits longer than one step.
import { parentPort, workerData } from "node:worker_threads";
import { type ClassifierLoad, type InjectionClassifier, loadInjectionClassifier } from "./injection-classifier-onnx.ts";
import { loadWasmInjectionClassifier } from "./injection-classifier-wasm.ts";
import { compileInjectionPatterns, injectionPatternsReady } from "./injection-patterns.ts";
import { type InboundVerdict, type ScreenStep, screenInbound } from "./inbound.ts";
import { selectClassifierBackend } from "./classifier-selfcheck.ts";
import { initLinearRegex } from "./linear-regex.ts";
import { screenOutbound } from "./outbound.ts";
import { classifierLoadable, runtimeAvailable, screenerModelDir, screenerState } from "./screener-state.ts";
import { compileSecretRules } from "./secrets.ts";

const port = parentPort;
if (!port) throw new Error("the screener worker must run as a worker thread");

export interface ModelFact { state: string; running: boolean; backend: string | null; reason: string | null }

async function loadModel(): Promise<{ classifier: InjectionClassifier | null; fact: ModelFact }> {
  const dir = screenerModelDir();
  const status = await screenerState({ dir, runtimePresent: await runtimeAvailable() });
  const loadable = classifierLoadable(status);
  if (!loadable.load) return { classifier: null, fact: { state: status.state, running: false, backend: null, reason: loadable.reason ?? null } };
  const selection = await selectClassifierBackend({
    native: (): Promise<ClassifierLoad> => loadInjectionClassifier(dir, (workerData as { modelThreads: number }).modelThreads),
    wasm: () => loadWasmInjectionClassifier(dir),
    log: () => undefined,
  });
  return { classifier: selection.classifier, fact: { state: status.state, running: selection.classifier !== null, backend: selection.backend === "off" ? null : selection.backend, reason: selection.classifier ? null : selection.layer2 } };
}

await initLinearRegex();
compileInjectionPatterns();
const secretRules = compileSecretRules();
if (!injectionPatternsReady() || secretRules.compiled === 0) throw new Error("the deterministic screener's rules didn't compile");

const outboundOnly = (workerData as { role: string }).role === "outbound";
const model = outboundOnly ? { classifier: null, fact: { state: "not_used", running: false, backend: null, reason: null } } : await loadModel();
const jobs = new Map<number, AsyncGenerator<ScreenStep, InboundVerdict>>();

type Request =
  | { type: "outbound"; id: number; text: string; keys: string[]; pii: { whitelist: string[]; email: boolean; phone: boolean } }
  | { type: "start"; id: number; body: Uint8Array; level: "full" | "deterministic"; language: { enforce: boolean; allow: string[] } }
  | { type: "step"; id: number };

function readText(body: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : null;
  } catch {
    return null;
  }
}

async function step(id: number): Promise<void> {
  const job = jobs.get(id);
  if (!job) throw new Error(`no screening job ${id}`);
  const next = await job.next();
  if (next.done) {
    jobs.delete(id);
    port?.postMessage({ type: "done", id, verdict: next.value });
  } else {
    port?.postMessage({ type: "stepped", id, measured: next.value.measured });
  }
}

port.on("message", (request: Request) => {
  if (request.type === "outbound") {
    try {
      port.postMessage({ type: "outbound", id: request.id, verdict: screenOutbound(request.text, request.keys, request.pii) });
    } catch (err: unknown) {
      port.postMessage({ type: "failed", id: request.id, message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (request.type === "start") {
    const text = readText(request.body);
    // Text nobody can read is shown to nobody, so there's nothing to screen.
    if (text === null || text === "") {
      port.postMessage({ type: "done", id: request.id, verdict: { verdict: "allow", delivered: null, findings: [], reason: null, score: null, ran: { deterministic: false, model: false, model_failed_copies: 0 } } satisfies InboundVerdict });
      return;
    }
    jobs.set(request.id, screenInbound(text, request.level === "full" ? model.classifier : null, request.language));
  }
  step(request.id).catch((err: unknown) => {
    jobs.delete(request.id);
    port.postMessage({ type: "failed", id: request.id, message: err instanceof Error ? err.message : String(err) });
  });
});

port.postMessage({ type: "ready", model: model.fact, rules: { patterns: true, secrets: secretRules.compiled } });

// The model, runtime and windowing are the real ones, read from where they already live.
// The windowing is imported rather than copied, so a split cannot quietly use different windows.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CLIENT_DIR = process.env["CELLO_CLIENT_DIR"] ?? join(homedir(), "code/cello-client");
export const RUNTIME_DIR = process.env["CELLO_SCREENER_RUNTIME_DIR"] ?? join(homedir(), ".cello/screener-runtime");

const DETECT = join(CLIENT_DIR, "core/gateway/src/detect");
const detect = (file: string): Promise<any> => import(pathToFileURL(join(DETECT, file)).href);

export const { textWindows, aggregateWindowScores, buildWindows } = await detect("injection-windows.ts");
export const { SCREENER_MODEL } = await detect("screener-model-manifest.ts");
export const { SELFCHECK } = await detect("classifier-selfcheck.ts");
export const { scoreToVerdict, FLAG_THRESHOLD } = await detect("injection-scanner.ts");

export const MODEL_DIR = process.env["CELLO_GATEWAY_MODEL_DIR"] ?? join(homedir(), ".cello/screener", SCREENER_MODEL.revision);

// Copied from injection-classifier-onnx.ts: that file can't be imported from source, as it imports
// by .js paths. The same logic must apply, or a bench score isn't a production score.
export function injectionProbabilityOf(scores: ReadonlyArray<{ label: string; score: number }>): number {
  if (scores.length === 0) throw new Error("classifier returned no labels");
  const byLabel = (name: string) => scores.find((s) => s.label.toUpperCase() === name);
  const injection = byLabel("INJECTION");
  if (injection) return injection.score;
  const complement = byLabel("BENIGN") ?? byLabel("SAFE");
  if (complement) return 1 - complement.score;
  throw new Error(`classifier returned no INJECTION, BENIGN or SAFE label (got: ${scores.map((s) => s.label).join(", ")})`);
}

export interface ThreadCfg {
  threads: "default" | number;
  spin: boolean;
}

export function pipelineOptions(cfg: ThreadCfg): Record<string, unknown> {
  const options: Record<string, unknown> = { local_files_only: true };
  const session: Record<string, unknown> = {};
  if (cfg.threads !== "default") session["intraOpNumThreads"] = cfg.threads;
  if (!cfg.spin) session["extra"] = { session: { intra_op: { allow_spinning: "0" } } };
  if (Object.keys(session).length > 0) options["session_options"] = session;
  return options;
}

export function runtimeModulePath(): string {
  return createRequire(join(RUNTIME_DIR, "resolver.cjs")).resolve("@huggingface/transformers");
}

export async function importRuntime(): Promise<any> {
  const mod: any = await import(pathToFileURL(runtimeModulePath()).href);
  mod.env.allowRemoteModels = false;
  mod.env.allowLocalModels = true;
  return mod;
}

export async function loadPipe(cfg: ThreadCfg): Promise<any> {
  const mod = await importRuntime();
  return mod.pipeline("text-classification", MODEL_DIR, pipelineOptions(cfg));
}

export const windowsOf = (pipe: any, text: string): string[] =>
  textWindows(text, pipe.tokenizer, SCREENER_MODEL.windowTokens, SCREENER_MODEL.windowOverlapTokens);

export async function scoreWindow(pipe: any, window: string): Promise<number> {
  return injectionProbabilityOf(await pipe(window, { top_k: null }));
}

export const sha256 = (data: string): string => createHash("sha256").update(data).digest("hex");

export const windowsSha = (windows: readonly string[]): string =>
  sha256(windows.map((w) => `${Buffer.byteLength(w)}:${w}`).join("\n"));

// Exact bytes of the double, so a difference in the last bit can't hide behind printing.
export function doubleHex(n: number): string {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b.toString("hex");
}

// What the production scanner turns a probability into, clamped and rounded the same way.
export function verdictOf(probability: number): { score: number; verdict: string } {
  const score = Math.round(Math.max(0, Math.min(1, probability)) * 100);
  return { score, verdict: scoreToVerdict(score, false) };
}

export function sourceProvenance(): Record<string, string> {
  const hash = (path: string) => sha256(readFileSync(path, "utf8"));
  return {
    "injection-windows.ts": hash(join(DETECT, "injection-windows.ts")),
    "injection-classifier-onnx.ts": hash(join(DETECT, "injection-classifier-onnx.ts")),
    "screener-model-manifest.ts": hash(join(DETECT, "screener-model-manifest.ts")),
  };
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

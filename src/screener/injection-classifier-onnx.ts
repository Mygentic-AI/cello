import { availableParallelism } from "node:os";
import { join } from "node:path";
import { isModelInstalled } from "./model-installer.ts";
import { resolveScreenerRuntime } from "./screener-state.ts";
import { SCREENER_MODEL } from "./screener-model-manifest.ts";
import { textWindows, aggregateWindowScores, type WindowTokenizer } from "./injection-windows.ts";

export function injectionProbabilityOf(scores: ReadonlyArray<{ label: string; score: number }>): { probability: number; label: string } {
  if (scores.length === 0) {
    throw new Error("classifier returned NO labels — the pipeline was asked for none (top_k), so nothing was scored");
  }
  const byLabel = (name: string) => scores.find((s) => s.label.toUpperCase() === name);
  const injection = byLabel("INJECTION");
  if (injection) return { probability: injection.score, label: injection.label };
  const complement = byLabel("BENIGN") ?? byLabel("SAFE");
  if (complement) return { probability: 1 - complement.score, label: complement.label };
  throw new Error(`classifier returned no INJECTION, BENIGN or SAFE label (got: ${scores.map((s) => s.label).join(", ")})`);
}
import { pathToFileURL } from "node:url";

// The model, one window at a time, so whoever runs it can stop between windows.
export interface InjectionClassifier {
  windows(text: string): string[];
  score(window: string): Promise<number>;
  classify(text: string): Promise<{ injectionProbability: number; label?: string }>;
}

const RUNTIME_MODULE = "@huggingface/transformers";

export interface ClassifierLoad {
  classifier: InjectionClassifier | null;
  reason?: string;
}

type Pipe = (text: string, opts?: { top_k?: number | null }) => Promise<Array<{ label: string; score: number }>>;
type PipelineFactory = (task: string, model: string, opts?: Record<string, unknown>) => Promise<Pipe>;

export async function loadInjectionClassifier(
  modelDir: string,
  modelThreads: number,
): Promise<ClassifierLoad> {
  if (!(await isModelInstalled(modelDir))) {
    return {
      classifier: null,
      reason:
        `no model at ${modelDir} — semantic injection screening is OFF. Install it with ` +
        `'cello screener install' (about 241 MB)`,
    };
  }

  const resolvedRuntime = resolveScreenerRuntime();
  const runtimeSpecifier = resolvedRuntime ? pathToFileURL(resolvedRuntime).href : RUNTIME_MODULE;

  let mod: unknown;
  try {
    const doImport = (s: string): Promise<unknown> => import(/* @vite-ignore */ s);
    mod = await doImport(runtimeSpecifier);
  } catch (err) {
    return {
      classifier: null,
      reason: `the model is installed but its runtime (${RUNTIME_MODULE}) is not: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const env = (mod as { env?: Record<string, unknown> }).env;
  if (env && typeof env === "object") {
    env["allowRemoteModels"] = false;
    env["allowLocalModels"] = true;
  }

  const factory = (mod as { pipeline?: PipelineFactory }).pipeline;
  if (typeof factory !== "function") {
    return { classifier: null, reason: `${RUNTIME_MODULE} exports no 'pipeline' — refusing to guess at its shape` };
  }

  let pipe: Pipe;
  try {
    pipe = await factory("text-classification", join(modelDir), { local_files_only: true, session_options: { intraOpNumThreads: Math.min(modelThreads, availableParallelism()), extra: { session: { intra_op: { allow_spinning: "0" } } } } });
  } catch (err) {
    return {
      classifier: null,
      reason: `the model failed to load from ${modelDir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    classifier: {
      windows: (text) => textWindows(text, (pipe as unknown as { tokenizer?: WindowTokenizer }).tokenizer, SCREENER_MODEL.windowTokens, SCREENER_MODEL.windowOverlapTokens),
      score: async (window) => injectionProbabilityOf(await pipe(window, { top_k: null })).probability,
      async classify(text: string): Promise<{ injectionProbability: number; label?: string }> {
        const tok = (pipe as unknown as { tokenizer?: WindowTokenizer }).tokenizer;
        const windows = textWindows(text, tok, SCREENER_MODEL.windowTokens, SCREENER_MODEL.windowOverlapTokens);
        const scores: number[] = [];
        let lastLabel: string | undefined;
        for (const window of windows) {
          const result = await pipe(window, { top_k: null });
          const { probability, label } = injectionProbabilityOf(result);
          scores.push(probability);
          lastLabel = label;
        }
        return { injectionProbability: aggregateWindowScores(scores), ...(lastLabel ? { label: lastLabel } : {}) };
      },
    },
  };
}

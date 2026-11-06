import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { SCREENER_MODEL, localPathOf } from "./screener-model-manifest.ts";
import { sha256File } from "./model-installer.ts";
import { celloHome } from "../daemon/paths.ts";

export function screenerModelDir(): string {
  return join(celloHome(), "screener", SCREENER_MODEL.revision);
}

export const SCREENER_RUNTIME_MODULE = "@huggingface/transformers";

export function screenerRuntimeDir(): string {
  return join(celloHome(), "screener-runtime");
}

export function resolveScreenerRuntime(): string | null {
  try {
    const require = createRequire(join(screenerRuntimeDir(), "resolver.cjs"));
    return require.resolve(SCREENER_RUNTIME_MODULE);
  } catch {
    return null;
  }
}

export async function runtimeAvailable(importImpl?: (s: string) => Promise<unknown>): Promise<boolean> {
  const doImport = importImpl ?? ((s: string) => import(/* @vite-ignore */ s));
  const resolved = resolveScreenerRuntime();
  for (const specifier of [...(resolved ? [pathToFileURL(resolved).href] : []), SCREENER_RUNTIME_MODULE]) {
    try {
      await doImport(specifier);
      return true;
    } catch {
    }
  }
  return false;
}

export type ScreenerStateName = "not_installed" | "half_installed" | "broken" | "ready";

export interface ScreenerStatus {
  state: ScreenerStateName;
  revision: string;
  model: { filesPresent: number; filesExpected: number; verified: boolean };
  runtimePresent: boolean;
  missing: Array<"model" | "runtime">;
  problem?: string;
}

export interface ScreenerStateOptions {
  dir: string;
  runtimePresent: boolean;
  verifyDigests?: boolean;
}

export async function screenerState(opts: ScreenerStateOptions): Promise<ScreenerStatus> {
  const verify = opts.verifyDigests ?? true;
  let present = 0;
  let problem: string | undefined;
  const absent: string[] = [];

  for (const f of SCREENER_MODEL.files) {
    const path = join(opts.dir, localPathOf(f));
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      absent.push(localPathOf(f)); // judged below: some present + some absent is a half-written install
      continue;
    }
    present++;
    if (problem !== undefined) continue;
    if (size !== f.size) {
      problem = `${localPathOf(f)} is ${size} bytes, expected ${f.size}`;
    } else if (verify && (await sha256File(path)) !== f.sha256) {
      problem = `${localPathOf(f)} does not match its pinned SHA-256 — the file is not the one we verified`;
    }
  }

  const expected = SCREENER_MODEL.files.length;
  const model = { filesPresent: present, filesExpected: expected, verified: present === expected && problem === undefined };
  const base = { revision: SCREENER_MODEL.revision, model, runtimePresent: opts.runtimePresent };

  if (present > 0 && present < expected) {
    return { ...base, state: "broken", missing: [], problem: problem ?? `${absent.length} model file(s) missing: ${absent.join(", ")}` };
  }
  if (present === expected && problem !== undefined) {
    return { ...base, state: "broken", missing: [], problem };
  }

  const missing: Array<"model" | "runtime"> = [];
  if (present === 0) missing.push("model");
  if (!opts.runtimePresent) missing.push("runtime");
  if (missing.length === 2) return { ...base, state: "not_installed", missing };
  if (missing.length === 1) return { ...base, state: "half_installed", missing };
  return { ...base, state: "ready", missing: [] };
}

export function classifierLoadable(s: ScreenerStatus): { load: boolean; reason?: string } {
  if (s.state === "ready") return { load: true };
  if (s.state === "broken") {
    return { load: false, reason: `model FAILED verification and was NOT loaded: ${s.problem ?? "unknown fault"} — repair it with 'cello screener install --repair'` };
  }
  return { load: false, reason: `classifier not installed (${s.state}) — install it with 'cello screener install'` };
}

export function describeScreenerState(s: ScreenerStatus, layer2?: string): string {
  const fix = "Run: cello screener install";
  const rev = s.revision.slice(0, 8);
  switch (s.state) {
    case "ready":
      if (layer2 === "active:native") return `Screening: 2 of 2 layers active (classifier ${rev} verified).`;
      if (layer2 === "active:wasm") {
        return `Screening: 2 of 2 layers active (classifier ${rev} verified, running on WASM — this CPU's native path gives wrong scores; long messages screen more slowly).`;
      }
      if (layer2?.startsWith("off:")) {
        return `Screening: 1 of 2 layers active — the classifier is BROKEN: ${layer2.slice(4)}. Reinstalling will not fix this; the pattern layer still screens.`;
      }
      return `Screening: classifier ${rev} installed and verified; the security gateway has not reported whether it scores correctly on this machine — check 'cello status' while the daemon runs.`;
    case "not_installed":
      return `Screening: 1 of 2 layers active (classifier not installed). ${fix}`;
    case "half_installed":
      return `Screening: 1 of 2 layers active — the ${s.missing.join(" and ")} is missing, so the classifier cannot run. ${fix}`;
    case "broken":
      return `Screening: 1 of 2 layers active — the classifier is BROKEN: ${s.problem ?? "unknown fault"}. ${fix}`;
  }
}

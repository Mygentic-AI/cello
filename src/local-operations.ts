// What runs in the caller's own process, whether that's the command line or the MCP shim.
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DaemonRefused } from "./ipc/client.ts";
import { checkTranscript } from "./protocol/transcript.ts";
import { readFileToCheck, verifySeal } from "./verify-seal.ts";

async function verifyTranscript(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = readFileToCheck(params);
  if (input.refused) return input.refused;
  const check = await checkTranscript(input.raw, input.sealKeyId);
  return check.ok ? { ok: true, ...check.report } : { ok: false, fault: check.fault, message: check.message };
}

export function runLocal(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (method === "verify_seal") return verifySeal(params);
  if (method === "verify_transcript") return verifyTranscript(params);
  throw new Error(`no local operation named ${method}`);
}

// The daemon builds the file and the caller writes it, so a tool's answer never carries the plaintext into a model's context.
// A tool has no folder anyone can rely on, so out must already be absolute by the time it's here.
export async function exportTranscript(params: Record<string, unknown>, call: (fields: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
  const { out, ...fields } = params;
  if (typeof out !== "string" || !isAbsolute(out)) throw new DaemonRefused("bad_out_path", `out must be an absolute path, and it was ${JSON.stringify(out)}`);
  const built = await call(fields) as { file: unknown; summary: Record<string, unknown> };
  try {
    writeFileSync(out, `${JSON.stringify(built.file, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new DaemonRefused("out_exists", `${out} already exists, and a transcript never overwrites a file`);
    throw new DaemonRefused("out_unwritable", `${out} can't be written: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ...built.summary, file: out };
}

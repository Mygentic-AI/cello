// What runs in the caller's own process, whether that's the command line or the MCP shim.
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type ConnectedServer, ServerLink, ServerRefused, ServerUnreachable } from "./daemon/link.ts";
import { DaemonRefused } from "./ipc/client.ts";
import { checkTranscript } from "./protocol/transcript.ts";
import { readFileToCheck, verifySeal } from "./verify-seal.ts";

const PUBLISH_WAIT_MS = 20_000;

async function verifyTranscript(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = readFileToCheck(params);
  if (input.refused) return input.refused;
  const check = await checkTranscript(input.raw, input.sealKeyId);
  return check.ok ? { ok: true, ...check.report } : { ok: false, fault: check.fault, message: check.message };
}

// A statement carries its own authority, so this needs no agent and no pinned server, and it trusts nothing the server says back.
async function publishStatus(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  let statement: unknown;
  try {
    statement = JSON.parse(readFileSync(params["file"] as string, "utf8"));
  } catch (err: unknown) {
    return { ok: false, error: "unreadable_file", message: err instanceof Error ? err.message : String(err) };
  }
  let reached: (server: ConnectedServer) => void = () => undefined;
  const connected = new Promise<ConnectedServer>((resolve) => { reached = resolve; });
  const link = new ServerLink(params["server"] as string, { checkIdentity: () => null, connected: async (server) => reached(server), disconnected: () => undefined, push: () => undefined });
  link.start();
  let timer: NodeJS.Timeout | undefined;
  try {
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServerUnreachable(link.problem ?? "it didn't answer")), PUBLISH_WAIT_MS); });
    await Promise.race([connected, late]);
    await link.call("agent.status", { statement });
    return { ok: true, server: params["server"] };
  } catch (err: unknown) {
    if (err instanceof ServerRefused) return { ok: false, error: err.code, message: err.message };
    if (err instanceof ServerUnreachable) return { ok: false, error: "server_unreachable", message: err.message };
    throw err;
  } finally {
    clearTimeout(timer);
    link.stop();
  }
}

export function runLocal(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (method === "publish_status") return publishStatus(params);
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

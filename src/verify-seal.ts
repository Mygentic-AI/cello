// Checks a seal file in the caller's own process. It never opens a socket, and needs no daemon, server or agent,
// so a third party with nothing but this code, the file and a seal key id gets the same answer.
import { readFileSync } from "node:fs";
import { checkSealRecord, describeSeal, sealSummary } from "./protocol/seal.ts";

function refused(fault: string, message: string): Record<string, unknown> {
  return { ok: false, fault, message };
}

export async function verifySeal(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const file = params["file"];
  const sealKey = params["seal_key"];
  if (typeof sealKey !== "string" || !/^[0-9a-fA-F]{64}$/.test(sealKey)) return refused("bad_seal_key", "seal_key must be the seal key's id, 64 hex characters");
  if (typeof file !== "string") return refused("unreadable_file", "file must be a path");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err: unknown) {
    return refused("unreadable_file", `${file} can't be read as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const check = await checkSealRecord(raw, new Uint8Array(Buffer.from(sealKey, "hex")));
  if (!check.ok) return refused(check.fault, check.message);
  return { ok: true, ...sealSummary(check.record), statement: describeSeal(check.record) };
}

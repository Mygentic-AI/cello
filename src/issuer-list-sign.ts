// Adds one root's signature to the issuer list. The key stays wherever it lives: the signer is a command it's handed.
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { ROOT_NAMES, type IssuerList, type RootKey, type RootName, type RootSigner, addRootSignature, encodeIssuerList, encodeSignedIssuerList, readSignedIssuerList } from "./protocol/issuer-list.ts";

const SIGNER_WAIT_MS = 180_000;
const hexBytes = (name: string, value: unknown): Uint8Array => {
  if (typeof value !== "string" || !/^([0-9a-f]{2})+$/.test(value)) throw new Error(`${name} must be lowercase hex`);
  return new Uint8Array(Buffer.from(value, "hex"));
};

// A person writes this file: { issued_at, expires_at, issuers: [{ name, ed, pq, expires_at }] }, with keys in hex.
export function issuerListFromJson(text: string): IssuerList {
  const raw = JSON.parse(text) as { issued_at: number; expires_at: number; issuers: { name: string; ed: string; pq: string; expires_at: number }[] };
  return { issued_at: raw.issued_at, expires_at: raw.expires_at, issuers: raw.issuers.map((entry) => ({ name: entry.name, ed: hexBytes(`${entry.name}'s ed`, entry.ed), pq: hexBytes(`${entry.name}'s pq`, entry.pq), expires_at: entry.expires_at })) };
}

export function parseRootName(value: string | undefined): RootName {
  const name = ROOT_NAMES.find((candidate) => candidate === value);
  if (!name) throw new Error(`--root must be one of ${ROOT_NAMES.join(", ")}`);
  return name;
}

// The command gets the message on stdin, and prints the raw 64-byte signature in hex.
export function commandSigner(root: RootName, command: string): RootSigner {
  return {
    root,
    sign: async (message) => {
      const run = spawnSync("/bin/sh", ["-c", command], { input: message, timeout: SIGNER_WAIT_MS, encoding: "buffer", stdio: ["pipe", "pipe", "inherit"] });
      if (run.status !== 0) throw new Error(`the signer command failed with status ${run.status ?? "none"}${run.error ? `: ${run.error.message}` : ""}`);
      return hexBytes("the signer command's output", run.stdout.toString("utf8").trim());
    },
  };
}

// Takes the person's JSON to start, or a partly signed file to add to, and writes the signed file.
export async function signIssuerListFile(input: { inPath: string; outPath: string; signer: RootSigner; roots: readonly RootKey[] }): Promise<{ signed: RootName[] }> {
  const bytes = readFileSync(input.inPath);
  const existing = bytes[0] === 0x7b ? { listBytes: encodeIssuerList(issuerListFromJson(bytes.toString("utf8"))) } : readSignedIssuerList(new Uint8Array(bytes));
  const signed = await addRootSignature(existing, input.signer, input.roots);
  const temporary = `${input.outPath}.tmp`;
  writeFileSync(temporary, encodeSignedIssuerList(signed));
  renameSync(temporary, input.outPath);
  return { signed: ROOT_NAMES.filter((name) => signed.signatures[name] !== null) };
}

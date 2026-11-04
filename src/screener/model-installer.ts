import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SCREENER_MODEL, localPathOf } from "./screener-model-manifest.ts";

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const rs = createReadStream(path);
    rs.on("error", reject);
    rs.on("data", (chunk) => hash.update(chunk));
    rs.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function isModelInstalled(dir: string): Promise<boolean> {
  for (const f of SCREENER_MODEL.files) {
    try {
      await stat(join(dir, localPathOf(f)));
    } catch {
      return false;
    }
  }
  return true;
}

export interface InstallResult {
  installed: boolean;
  needsConsent?: boolean;
  error?: string;
}

export interface InstallOptions {
  dir: string;
  consent: boolean;
  fetchImpl?: typeof fetch;
  onProgress?: (file: string, index: number, total: number) => void;
}

export async function installModel(opts: InstallOptions): Promise<InstallResult> {
  if (await isModelInstalled(opts.dir)) return { installed: true };
  if (!opts.consent) return { installed: false, needsConsent: true };


  const doFetch = opts.fetchImpl ?? fetch;
  const total = SCREENER_MODEL.files.length;
  for (const [i, f] of SCREENER_MODEL.files.entries()) {
    opts.onProgress?.(f.path, i, total);
    const dest = join(opts.dir, localPathOf(f));
    await mkdir(dirname(dest), { recursive: true });
    let res: Response;
    try {
      res = await doFetch(SCREENER_MODEL.baseUrl + f.path);
    } catch (err) {
      return { installed: false, error: `download failed for ${f.path}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res.ok || !res.body) return { installed: false, error: `download failed for ${f.path}: HTTP ${res.status}` };
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
    const downloaded = await stat(dest);
    if (downloaded.size !== f.size) {
      await rm(dest, { force: true });
      return { installed: false, error: `size mismatch for ${f.path}: expected ${f.size}, got ${downloaded.size} — removed` };
    }
    const got = await sha256File(dest);
    if (got !== f.sha256) {
      await rm(dest, { force: true });
      return { installed: false, error: `checksum mismatch for ${f.path} — the file was NOT trusted and has been removed` };
    }
  }
  return { installed: true };
}

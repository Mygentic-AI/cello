// Plaintext on disk wouldn't show by itself: everything keeps working. So this reads the files.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/daemon/store.ts";

const MARKER = "PLAINTEXT-MARKER-7d1f";

function filesHoldingMarker(dir: string): string[] {
  return readdirSync(dir).filter((name) => readFileSync(join(dir, name)).includes(MARKER));
}

test("the database is encrypted on disk, while open and after closing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cello-store-"));
  const path = join(dir, "cello.db");
  const store = new Store(path);
  store.setConfig("marker", MARKER);
  assert.equal(store.getConfig("marker"), MARKER, "the marker must really have been written");
  assert.deepEqual(filesHoldingMarker(dir), [], "while open, including the write-ahead log");
  store.close();
  assert.deepEqual(filesHoldingMarker(dir), [], "after closing");

  const reopened = new Store(path);
  assert.equal(reopened.getConfig("marker"), MARKER);
  reopened.close();
});

test("the database refuses to open with a missing key, rather than starting a new one", () => {
  const dir = mkdtempSync(join(tmpdir(), "cello-store-"));
  const path = join(dir, "cello.db");
  new Store(path).close();
  rmSync(`${path}.key`);
  assert.throws(() => new Store(path), /key file .* is missing/);
});

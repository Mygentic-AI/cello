// One CBOR encoding, ported from the old system's test of the same name. A second encoder is a second wire format
// written into the same columns, and cbor-x's decoder accepts both, so the corruption stays invisible until a non-cbor-x reader meets it.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Encoder, encode as bareEncode } from "cbor-x";
import { decodeCbor, encodeCbor } from "../src/protocol/cbor.ts";

const ROOT = fileURLToPath(new URL("../src", import.meta.url));
const CANONICAL = join(ROOT, "protocol", "cbor.ts");

function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(ROOT);
  return out;
}

test("no production file constructs its own cbor-x Encoder", () => {
  const offenders = productionSources().filter((f) => f !== CANONICAL).filter((f) => /new\s+Encoder\s*\(/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
  assert.deepEqual(offenders, []);
});

test("no production file imports cbor-x's bare encode", () => {
  const importsBareEncode = /import\s*\{[^}]*\bencode\b(?!\s*:)[^}]*\}\s*from\s*["']cbor-x["']/;
  const offenders = productionSources().filter((f) => f !== CANONICAL).filter((f) => importsBareEncode.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
  assert.deepEqual(offenders, []);
});

test("the scan really is scanning the tree", () => {
  const files = productionSources();
  assert.ok(files.length > 20);
  assert.ok(files.includes(CANONICAL));
});

test("the one encoding differs from cbor-x's default, so the divergence is real", () => {
  const payload = { share: new Uint8Array([1, 2, 3, 4]) };
  const canonical = encodeCbor(payload);
  const tagged = new Uint8Array(bareEncode(payload) as Uint8Array);
  assert.equal(Buffer.from(canonical).equals(Buffer.from(tagged)), false);
  assert.equal(Buffer.from(canonical).includes(Buffer.from([0xd8, 0x40])), false);
  assert.equal(Buffer.from(tagged).includes(Buffer.from([0xd8, 0x40])), true);
  assert.deepEqual(new Uint8Array((decodeCbor(canonical) as { share: Uint8Array }).share), payload.share);
  assert.deepEqual(new Uint8Array((decodeCbor(tagged) as { share: Uint8Array }).share), payload.share);
});

test("the guards aren't fooled by a missing dependency", () => {
  assert.equal(typeof Encoder, "function");
});

test("three hostile bytes are refused fast, and the array limit holds at its bound", () => {
  for (const hostile of ["9fb0", "a19f", "9f26"]) {
    const started = Date.now();
    try { decodeCbor(Buffer.from(hostile, "hex")); } catch { /* a refusal is the point */ }
    assert.ok(Date.now() - started < 1000, `${hostile} took ${Date.now() - started} ms`);
  }
  assert.throws(() => decodeCbor(Buffer.from("9a00040000", "hex")));
});

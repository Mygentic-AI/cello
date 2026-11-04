// Official NIST ACVP vectors, because agreeing with ourselves proves determinism and not correctness.
// Decapsulation vectors supply expanded keys, so that test proves Node's primitive; keyGen proves our seed path over it.
import assert from "node:assert/strict";
import { createPrivateKey, decapsulate, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mlDsaProviderFromSeed } from "../src/protocol/ml-dsa.ts";
import { mlKemEncapsulate, mlKemKeypairFromSeed } from "../src/protocol/ml-kem.ts";
import { toHex } from "../src/protocol/encode.ts";

interface Group<T> { tgId: number; tests: T[] }
function group<T>(file: string, tgId: number): T[] {
  const parsed = JSON.parse(readFileSync(new URL(`./vectors/acvp-975de31e/${file}.json`, import.meta.url), "utf8")) as { testGroups: Group<T>[] };
  const found = parsed.testGroups.find((g) => g.tgId === tgId);
  assert.ok(found, `${file} has no group ${tgId}`);
  return found.tests;
}
const hex = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, "hex"));

test("ML-DSA-44 key generation matches NIST", async () => {
  const tests = group<{ seed: string; pk: string }>("ML-DSA-keyGen-FIPS204", 1);
  assert.equal(tests.length, 25);
  for (const t of tests) {
    const provider = await mlDsaProviderFromSeed(hex(t.seed));
    assert.equal(toHex(await provider.getPublicKey()), t.pk.toLowerCase());
  }
});

test("ML-DSA-44 verification matches NIST, including the vectors that must fail", async () => {
  const tests = group<{ testPassed: boolean; pk: string; message: string; context: string; signature: string }>("ML-DSA-sigVer-FIPS204", 1);
  assert.equal(tests.length, 15);
  assert.ok(tests.some((t) => !t.testPassed));
  for (const t of tests) {
    let ok: boolean;
    try {
      const key = await webcrypto.subtle.importKey("raw-public", hex(t.pk), { name: "ML-DSA-44" }, false, ["verify"]);
      ok = await webcrypto.subtle.verify({ name: "ML-DSA-44", context: hex(t.context) } as never, key, hex(t.signature), hex(t.message));
    } catch {
      ok = false;
    }
    assert.equal(ok, t.testPassed);
  }
});

test("ML-KEM-768 key generation matches NIST", async () => {
  const tests = group<{ d: string; z: string; ek: string }>("ML-KEM-keyGen-FIPS203", 2);
  assert.equal(tests.length, 25);
  for (const t of tests) {
    const { publicKey } = await mlKemKeypairFromSeed(new Uint8Array([...hex(t.d), ...hex(t.z)]));
    assert.equal(toHex(publicKey), t.ek.toLowerCase());
  }
});

function der(tag: number, body: Buffer): Buffer {
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
}
function expandedKeyPkcs8(dk: Uint8Array): Buffer {
  const oid = Buffer.from("0609608648016503040402", "hex");
  return der(0x30, Buffer.concat([Buffer.from([0x02, 0x01, 0x00]), der(0x30, oid), der(0x04, der(0x04, Buffer.from(dk)))]));
}

test("ML-KEM-768 decapsulation matches NIST, including implicit rejection", () => {
  const tests = group<{ dk: string; c: string; k: string }>("ML-KEM-encapDecap-FIPS203", 5);
  assert.equal(tests.length, 10);
  for (const t of tests) {
    const key = createPrivateKey({ key: expandedKeyPkcs8(hex(t.dk)), format: "der", type: "pkcs8" });
    assert.equal(toHex(decapsulate(key, hex(t.c))), t.k.toLowerCase());
  }
});

test("ML-KEM-768 refuses the public keys NIST says are invalid", async () => {
  const tests = group<{ testPassed: boolean; ek: string }>("ML-KEM-encapDecap-FIPS203", 10);
  assert.ok(tests.some((t) => !t.testPassed));
  for (const t of tests) {
    if (t.testPassed) await mlKemEncapsulate(hex(t.ek));
    else await assert.rejects(mlKemEncapsulate(hex(t.ek)), { reason: "ml_kem_public_key_invalid" });
  }
});

// Fails on any change to a signed byte. Tests that build and check with the same code can't see an encoder change, and records would stop verifying.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkTranscript } from "../src/protocol/transcript.ts";
import * as structures from "../src/protocol/structures.ts";
import { PROTOCOL_VERSION, type WireSigned, signedEntry, toB64 } from "../src/protocol/wire.ts";

interface Vector { tag: string; inputs: Record<string, unknown>; expected_cbor_hex: string }
const file = JSON.parse(readFileSync(new URL("vectors/signed-structures.json", import.meta.url), "utf8")) as { structures: Record<string, Vector> };
const structureNamed = (name: string): structures.Structure<never> => (structures as unknown as Record<string, structures.Structure<never>>)[name] as structures.Structure<never>;
const fromJson = (inputs: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, typeof v === "object" && v !== null && "hex" in v ? new Uint8Array(Buffer.from((v as { hex: string }).hex, "hex")) : v]));

// A second reader, written from RFC 8949 with no cbor-x in it, so the file proves the bytes can be read without our library.
function readCbor(bytes: Buffer): unknown[] {
  let at = 0;
  const item = (): unknown => {
    const first = bytes[at++] as number;
    const major = first >> 5;
    const info = first & 0x1f;
    if (first === 0xf6) return null;
    let value = BigInt(info);
    if (info >= 24) {
      const width = 2 ** (info - 24);
      value = bytes.subarray(at, at + width).reduce((sum, byte) => sum * 256n + BigInt(byte), 0n);
      at += width;
    }
    const n = Number(value);
    if (major === 0) return value;
    if (major === 2 || major === 3) { const out = bytes.subarray(at, at + n); at += n; return major === 2 ? Buffer.from(out).toString("hex") : out.toString("utf8"); }
    if (major === 4) return Array.from({ length: n }, () => item());
    throw new Error(`unexpected major type ${major}`);
  };
  const top = item() as unknown[];
  assert.equal(at, bytes.length);
  return top;
}

test("every signed or hashed structure has pinned bytes, and they haven't moved", () => {
  const exported = Object.keys(structures).filter((key) => key.endsWith("Structure")).sort();
  assert.deepEqual(Object.keys(file.structures).sort(), exported, "a new structure needs a vector");
  const tags = new Set<string>();
  for (const [name, vector] of Object.entries(file.structures)) {
    const structure = structureNamed(name);
    assert.equal(structure.tag, vector.tag, name);
    tags.add(vector.tag);
    assert.equal(Buffer.from(structure.encode(fromJson(vector.inputs) as never)).toString("hex"), vector.expected_cbor_hex, `${name} changed`);
    assert.deepEqual(structure.decode(new Uint8Array(Buffer.from(vector.expected_cbor_hex, "hex"))), fromJson(vector.inputs), name);
    const independent = readCbor(Buffer.from(vector.expected_cbor_hex, "hex"));
    assert.equal(independent[0], vector.tag);
    assert.deepEqual(independent.slice(1), Object.values(vector.inputs).map((v) => (typeof v === "object" && v !== null && "hex" in v ? (v as { hex: string }).hex : typeof v === "number" ? BigInt(v) : v)), `${name}, read without cbor-x`);
    assert.doesNotMatch(vector.tag, /v2/);
  }
  assert.equal(tags.size, Object.keys(file.structures).length, "each structure has its own tag, so no two can share bytes");
});

test("integers above 2^32-1 are uint64, never float, including in the pinned files", () => {
  const hex = (name: string): string => (file.structures[name] as Vector).expected_cbor_hex;
  assert.ok(hex("ackStructure").includes("1affffffff"), "2^32-1 is still a plain 32-bit integer");
  assert.ok(hex("ackStructure").includes(`1b${(1_793_000_000_123).toString(16).padStart(16, "0")}`), "above it is a uint64");
  for (const vector of Object.values(file.structures)) assert.ok(!/^[^]*fb4[0-9a-f]{15}$/.test(vector.expected_cbor_hex));
  const good = structures.ackBytes({ serverId: new Uint8Array(32), sessionId: new Uint8Array(16), position: 1, entryHash: new Uint8Array(32), root: new Uint8Array(32), time: 2 ** 33 });
  assert.throws(() => structures.ackBytes({ serverId: new Uint8Array(32), sessionId: new Uint8Array(16), position: 1.5, entryHash: new Uint8Array(32), root: new Uint8Array(32), time: 1 }), RangeError);
  // The same value written as a float by someone else is refused on the way in.
  const asFloat = Buffer.from(good).toString("hex").replace(`1b${(2 ** 33).toString(16).padStart(16, "0")}`, "fb4200000000000000");
  assert.throws(() => structures.ackStructure.decode(new Uint8Array(Buffer.from(asFloat, "hex"))), RangeError);
});

test("hostile bytes are refused before the decoder can spend anything on them", () => {
  const entry = new Uint8Array(Buffer.from((file.structures["entryStructure"] as Vector).expected_cbor_hex, "hex"));
  const refused = (name: string, bytes: Uint8Array): void => {
    const started = Date.now();
    const before = process.memoryUsage().rss;
    assert.throws(() => structures.entryStructure.decode(bytes), RangeError, name);
    assert.ok(Date.now() - started < 50, `${name} took ${Date.now() - started} ms`);
    assert.ok(process.memoryUsage().rss - before < 50 * 1024 * 1024, `${name} cost memory`);
  };
  refused("nested arrays, measured at 1 GB", new Uint8Array(Buffer.from("99ffff".repeat(2_600), "hex")));
  refused("an array nested in a slot", new Uint8Array([0x8d, 0x99, 0xff, 0xff]));
  refused("an indefinite array", new Uint8Array(Buffer.from("9fb0", "hex")));
  refused("a map", new Uint8Array(Buffer.from("a19f", "hex")));
  refused("trailing bytes", new Uint8Array([...entry, 0]));
  refused("cut short", entry.subarray(0, entry.length - 1));
  refused("too long", new Uint8Array(9_000));
  refused("nothing", new Uint8Array(0));
  // A length claiming more than the bytes there are, in a flat array.
  refused("a byte string longer than the file", new Uint8Array([0x8d, 0x7a, 0xff, 0xff, 0xff, 0xff]));
});

test("a delivery ack's refused list is refused unless it's whole, ascending and within the ack", () => {
  const base = { serverId: new Uint8Array(32), sessionId: new Uint8Array(16), readerId: new Uint8Array(32), throughPosition: 5, entryHash: new Uint8Array(32), root: new Uint8Array(32), screenedThrough: 5 };
  assert.ok(structures.deliveryAckBytes({ ...base, refused: structures.refusedList([2, 5]) }));
  for (const list of [[5, 2], [2, 2], [6], [0]]) assert.throws(() => structures.deliveryAckBytes({ ...base, refused: structures.refusedList(list) }), RangeError, String(list));
  assert.throws(() => structures.deliveryAckBytes({ ...base, refused: new Uint8Array(7) }), RangeError);
  assert.throws(() => structures.deliveryAckBytes({ ...base, refused: new Uint8Array(8 * 513) }), RangeError);
});

test("another structure's bytes can't pass as this one, even at the same shape", () => {
  const a = structures.greetingBytes({ offerHash: new Uint8Array(32), sealedText: new Uint8Array(32) });
  const b = structures.sealKeyBindingBytes({ serverId: new Uint8Array(32), sealKeyId: new Uint8Array(32) });
  assert.notDeepEqual(a, b, "these two were byte-identical under the old encoding");
  assert.throws(() => structures.greetingStructure.decode(b), structures.UnknownFormat);
});

const kept = JSON.parse(readFileSync(new URL("vectors/record-format-1.json", import.meta.url), "utf8")) as { seal_key: string; transcript: { entries: { entry: WireSigned }[]; seal: { certificate: WireSigned } } };

test("a record made today still verifies: its signed bytes are carried, so a wire version bump can't touch it", async () => {
  assert.equal(PROTOCOL_VERSION, 1, "bumping this is exactly what the kept record below must survive. Update this line, and nothing else");
  const check = await checkTranscript(kept.transcript, new Uint8Array(Buffer.from(kept.seal_key, "hex")));
  assert.ok(check.ok, check.ok ? "" : `${check.fault}: ${check.message}`);
  assert.doesNotMatch(readFileSync(new URL("../src/protocol/structures.ts", import.meta.url), "utf8"), /PROTOCOL_VERSION/, "the wire version must stay out of signed bytes");
});

test("a record in a format this reader doesn't know reads as that, never as a forgery", async () => {
  const later = structuredClone(kept.transcript);
  const bytes = Buffer.from(later.seal.certificate.bytes, "base64url");
  const at = bytes.indexOf("cello-seal-certificate-v1");
  bytes[at + "cello-seal-certificate-v".length] = 0x32;
  later.seal.certificate.bytes = toB64(bytes);
  const check = await checkTranscript(later, new Uint8Array(Buffer.from(kept.seal_key, "hex")));
  assert.equal(check.ok ? null : check.fault, "unknown_format");
  assert.ok(signedEntry.decode(later.entries[0]?.entry));
});

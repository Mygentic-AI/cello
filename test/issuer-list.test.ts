// The root keys here are placeholders made for this test. Real ones are Andre's, and the production ones stay unset until he makes them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPrivateKey, randomBytes, webcrypto } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { signerFromSeeds } from "../src/protocol/identity.ts";
import { type IssuerList, type RootKey, type RootName, type RootSigner, ISSUER_LIST_DOMAIN, ROOT_NAMES, RootKeysNotConfigured, SIGNED_ISSUER_LIST_DOMAIN, addRootSignature, decodeIssuerList, encodeIssuerEntry, encodeIssuerList, encodeSignedIssuerList, issuerListSigningMessage, recognisedIssuer, rootKeysFrom, verifyIssuerList } from "../src/protocol/issuer-list.ts";
import { PRODUCTION_ROOT_KEYS, productionRootKeys } from "../src/protocol/issuer-roots.ts";
import { commandSigner, signIssuerListFile } from "../src/issuer-list-sign.ts";

const fill = (byte: number, length: number): Uint8Array => new Uint8Array(length).fill(byte);
const issuer = await signerFromSeeds({ ed: fill(1, 32), pq: fill(2, 32) });
const stranger = await signerFromSeeds({ ed: fill(3, 32), pq: fill(4, 32) });

async function p256Root(root: RootName): Promise<{ key: RootKey; signer: RootSigner; pair: CryptoKeyPair }> {
  const pair = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, key: { name: root, algorithm: "p256", publicKey }, signer: { root, sign: async (message) => new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array(message))) } };
}
function edRoot(root: RootName): { key: RootKey; signer: RootSigner } {
  const seed = new Uint8Array(randomBytes(32));
  return { key: { name: root, algorithm: "ed25519", publicKey: ed25519.getPublicKey(seed) }, signer: { root, sign: async (message) => ed25519.sign(message, seed) } };
}
const enclave = await p256Root("enclave");
const kms = await p256Root("kms");
const paper = edRoot("paper");
const roots = [enclave.key, kms.key, paper.key];
const NOW = 1_800_000_000;
const list = (over: Partial<IssuerList> = {}): IssuerList => ({ issued_at: NOW - 10, expires_at: NOW + 1000, issuers: [{ name: "trust.celloprotocol.com", ed: issuer.publicIdentity.ed, pq: issuer.publicIdentity.pq, expires_at: NOW + 500 }], ...over });
const signedBy = async (signers: RootSigner[], l: IssuerList = list()): Promise<Uint8Array> => {
  let at: Parameters<typeof addRootSignature>[0] = { listBytes: encodeIssuerList(l) };
  for (const signer of signers) at = await addRootSignature(at, signer, roots);
  return encodeSignedIssuerList({ signatures: { enclave: null, kms: null, paper: null }, ...at });
};
const fault = async (file: Uint8Array, now = NOW): Promise<string> => {
  const check = await verifyIssuerList(file, roots, now);
  return check.ok ? "ok" : check.fault;
};

test("any two of the three roots make a list good, each pair and all three", async () => {
  for (const pair of [[enclave, kms], [enclave, paper], [kms, paper], [enclave, kms, paper]]) {
    const check = await verifyIssuerList(await signedBy(pair.map((p) => p.signer)), roots, NOW);
    assert.ok(check.ok);
    assert.equal(check.list.issuers[0]?.name, "trust.celloprotocol.com");
  }
});

test("one root's signature alone, or none, is refused", async () => {
  for (const one of [enclave, kms, paper]) assert.equal(await fault(await signedBy([one.signer])), "not_enough_signatures", one.key.name);
  assert.equal(await fault(await signedBy([])), "not_enough_signatures");
});

test("the same key signing twice counts once", async () => {
  const good = await signedBy([enclave.signer]);
  const bytes = encodeIssuerList(list());
  const sig = await enclave.signer.sign(issuerListSigningMessage(bytes));
  assert.equal(await fault(new Uint8Array(encodeCbor([SIGNED_ISSUER_LIST_DOMAIN, bytes, sig, sig, null]))), "not_enough_signatures", "its signature repeated in another slot");
  const again = await enclave.signer.sign(issuerListSigningMessage(bytes));
  assert.equal(await fault(new Uint8Array(encodeCbor([SIGNED_ISSUER_LIST_DOMAIN, bytes, sig, again, again]))), "not_enough_signatures", "fresh signatures from it in every slot");
  assert.ok(good);
  // Configuring one key in two slots would let it count twice, so it can't start.
  const doubled = { enclave: enclave.key, kms: { algorithm: "p256" as const, publicKey: enclave.key.publicKey }, paper: paper.key };
  assert.throws(() => rootKeysFrom(doubled), RootKeysNotConfigured);
  await assert.rejects(verifyIssuerList(good, [enclave.key, { ...enclave.key, name: "kms" }, paper.key], NOW), RootKeysNotConfigured);
});

test("a signer in the wrong slot can't add itself, and nothing is written", async () => {
  await assert.rejects(addRootSignature({ listBytes: encodeIssuerList(list()) }, { root: "kms", sign: enclave.signer.sign }, roots), /doesn't verify/);
});

test("an expired list is refused, however well signed", async () => {
  const file = await signedBy([enclave.signer, kms.signer]);
  assert.equal(await fault(file, NOW + 999), "ok");
  assert.equal(await fault(file, NOW + 1000), "expired");
});

test("forged: changing the list, or moving signatures from another list, is refused", async () => {
  const bytes = encodeIssuerList(list());
  const message = issuerListSigningMessage(bytes);
  const [a, b] = [await enclave.signer.sign(message), await paper.signer.sign(message)];
  assert.equal(await fault(new Uint8Array(encodeCbor([SIGNED_ISSUER_LIST_DOMAIN, bytes, a, null, b]))), "ok");
  const added = encodeIssuerList(list({ issuers: [...list().issuers, { name: "evil.example", ed: stranger.publicIdentity.ed, pq: stranger.publicIdentity.pq, expires_at: NOW + 500 }] }));
  assert.equal(await fault(new Uint8Array(encodeCbor([SIGNED_ISSUER_LIST_DOMAIN, added, a, null, b]))), "not_enough_signatures");
  const stretched = encodeIssuerList(list({ expires_at: NOW + 9_000_000 }));
  assert.equal(await fault(new Uint8Array(encodeCbor([SIGNED_ISSUER_LIST_DOMAIN, stretched, a, null, b]))), "not_enough_signatures");
  // A signature with no domain frame, over the bare list bytes.
  const bare = await enclave.signer.sign(bytes);
  assert.equal(await fault(new Uint8Array(encodeCbor([SIGNED_ISSUER_LIST_DOMAIN, bytes, bare, null, b]))), "not_enough_signatures");
});

test("a missing root key fails loudly, and production trusts nothing until they exist", () => {
  for (const name of ROOT_NAMES) {
    const config = { enclave: enclave.key, kms: kms.key, paper: paper.key, [name]: null };
    assert.throws(() => rootKeysFrom(config), RootKeysNotConfigured, name);
  }
  assert.throws(() => rootKeysFrom({ enclave: paper.key, kms: kms.key, paper: enclave.key }), /must be P-256/);
  assert.throws(() => rootKeysFrom({ enclave: { algorithm: "p256", publicKey: fill(4, 33) }, kms: kms.key, paper: paper.key }), RootKeysNotConfigured);
  if (Object.values(PRODUCTION_ROOT_KEYS).includes(null)) assert.throws(() => productionRootKeys(), /isn't configured/);
});

test("only a listed issuer with both keys matching, and not expired from the list, is recognised", () => {
  const l = list();
  assert.equal(recognisedIssuer(l, issuer.publicIdentity, NOW)?.name, "trust.celloprotocol.com");
  assert.equal(recognisedIssuer(l, stranger.publicIdentity, NOW), null);
  assert.equal(recognisedIssuer(l, { ed: issuer.publicIdentity.ed, pq: stranger.publicIdentity.pq }, NOW), null);
  assert.equal(recognisedIssuer(l, issuer.publicIdentity, NOW + 500), null);
});

test("malformed lists are refused by name, nesting included", async () => {
  const entry = encodeIssuerEntry(list().issuers[0] as IssuerList["issuers"][number]);
  assert.throws(() => decodeIssuerList(new Uint8Array(encodeCbor([ISSUER_LIST_DOMAIN, NOW, NOW + 1, ["nested"]]))), RangeError);
  assert.throws(() => decodeIssuerList(new Uint8Array(encodeCbor([ISSUER_LIST_DOMAIN, NOW, NOW + 1, entry, entry]))), /twice/);
  assert.throws(() => encodeIssuerList(list({ expires_at: NOW - 10 })), /after it's issued/);
  for (const bytes of [new Uint8Array(0), new Uint8Array([0x9f, 0xb0]), new Uint8Array([0x85, 0x99, 0xff, 0xff]), new Uint8Array(2_000_000)]) assert.equal(await fault(bytes), "malformed");
  assert.equal(await fault(new Uint8Array(encodeCbor(["cello-other-v1", entry, null, null, null]))), "unknown_format");
});

test("the signing command takes any signer: two commands in turn make a list good", async () => {
  const dir = mkdtempSync(join(tmpdir(), "issuer-list-"));
  const pem = async (pair: CryptoKeyPair): Promise<string> => createPrivateKey({ key: Buffer.from(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)), format: "der", type: "pkcs8" }).export({ format: "pem", type: "pkcs8" }).toString();
  const script = join(dir, "sign.mjs");
  writeFileSync(script, `import { sign } from "node:crypto"; import { readFileSync } from "node:fs"; process.stdout.write(sign("sha256", readFileSync(0), { key: readFileSync(process.argv[2], "utf8"), dsaEncoding: "ieee-p1363" }).toString("hex"));`);
  for (const [name, root] of [["enclave", enclave], ["kms", kms]] as const) writeFileSync(join(dir, `${name}.pem`), await pem(root.pair));
  const json = join(dir, "list.json");
  const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
  writeFileSync(json, JSON.stringify({ issued_at: NOW - 10, expires_at: NOW + 1000, issuers: [{ name: "trust.celloprotocol.com", ed: hex(issuer.publicIdentity.ed), pq: hex(issuer.publicIdentity.pq), expires_at: NOW + 500 }] }));
  const out = join(dir, "list.signed");
  const signerFor = (name: "enclave" | "kms"): RootSigner => commandSigner(name, `${process.execPath} ${script} ${join(dir, `${name}.pem`)}`);
  assert.deepEqual(await signIssuerListFile({ inPath: json, outPath: out, signer: signerFor("enclave"), roots }), { signed: ["enclave"] });
  assert.equal(await fault(new Uint8Array(readFileSync(out))), "not_enough_signatures");
  assert.deepEqual(await signIssuerListFile({ inPath: out, outPath: out, signer: signerFor("kms"), roots }), { signed: ["enclave", "kms"] });
  assert.equal(await fault(new Uint8Array(readFileSync(out))), "ok");
  const failing = join(dir, "never");
  await assert.rejects(signIssuerListFile({ inPath: json, outPath: failing, signer: commandSigner("kms", "exit 7"), roots }), /status 7/);
  await assert.rejects(signIssuerListFile({ inPath: json, outPath: failing, signer: commandSigner("kms", "echo zz"), roots }), /lowercase hex/);
  assert.ok(!existsSync(failing));
});

test("the real command refuses by name while the root keys aren't configured, and writes nothing", () => {
  if (!Object.values(PRODUCTION_ROOT_KEYS).includes(null)) return;
  const dir = mkdtempSync(join(tmpdir(), "issuer-list-"));
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const out = join(dir, "out");
  const run = spawnSync(process.execPath, [cli, "issuer-list-sign", "--in", join(dir, "in"), "--out", out, "--root", "kms", "--signer-command", "true"], { encoding: "utf8", env: { ...process.env, CELLO_HOME: dir } });
  assert.equal(run.status, 1);
  assert.match(run.stderr + run.stdout, /root_keys_not_configured/);
  assert.ok(!existsSync(out));
});

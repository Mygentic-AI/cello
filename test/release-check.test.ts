// The release check is what stops a build with an empty shipped list or no Concierge address from being published. These prove it refuses each, and passes a good one.
import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { signerFromSeeds } from "../src/protocol/identity.ts";
import { type RootKey, type RootName, type RootSigner, addRootSignature, encodeIssuerList, encodeSignedIssuerList, rootKeysFrom } from "../src/protocol/issuer-list.ts";
import { MIN_LIST_LIFE_DAYS, releaseProblems } from "../tools/check-release.ts";

const DAY = 86_400;
const NOW = 1_800_000_000;
const issuer = await signerFromSeeds({ ed: new Uint8Array(32).fill(1), pq: new Uint8Array(32).fill(2) });

async function p256Root(name: RootName): Promise<{ key: RootKey; signer: RootSigner }> {
  const pair = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  return { key: { name, algorithm: "p256", publicKey }, signer: { root: name, sign: async (message) => new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array(message))) } };
}
const paperSeed = new Uint8Array(randomBytes(32));
const a = await p256Root("enclave");
const b = await p256Root("kms");
const c = { key: { name: "paper", algorithm: "ed25519", publicKey: ed25519.getPublicKey(paperSeed) } as RootKey, signer: { root: "paper", sign: async (message: Uint8Array) => ed25519.sign(message, paperSeed) } as RootSigner };
const roots = rootKeysFrom({ enclave: a.key, kms: b.key, paper: c.key });

async function signedList(expiresIn: number, signers = [a, b]): Promise<string> {
  const listBytes = encodeIssuerList({ issued_at: NOW - 10, expires_at: NOW + expiresIn, issuers: [{ name: "trust.celloprotocol.com", ed: issuer.publicIdentity.ed, pq: issuer.publicIdentity.pq, expires_at: NOW + expiresIn }] });
  let at: Parameters<typeof addRootSignature>[0] = { listBytes };
  for (const signer of signers) at = await addRootSignature(at, signer.signer, roots);
  return Buffer.from(encodeSignedIssuerList({ signatures: { enclave: null, kms: null, paper: null }, ...at })).toString("base64");
}
const check = (shippedList: string | null, conciergeAddress = "abc123"): Promise<string[]> => releaseProblems({ shippedList, conciergeAddress, roots, now: NOW });

test("a good list and an address pass", async () => {
  assert.deepEqual(await check(await signedList(300 * DAY)), []);
});

test("no shipped list is refused", async () => {
  const problems = await check(null);
  assert.equal(problems.length, 1);
  assert.match(problems[0] as string, /SHIPPED_ISSUER_LIST.*empty/);
});

test("no Concierge address is refused, and so is a blank one", async () => {
  for (const blank of ["", "   "]) assert.match((await check(await signedList(300 * DAY), blank))[0] as string, /concierge_address/);
});

test("a list the production roots didn't sign is refused", async () => {
  assert.match((await check(await signedList(300 * DAY, [a])))[0] as string, /doesn't verify/);
  assert.match((await check("bm90IGEgbGlzdA=="))[0] as string, /doesn't verify/);
});

test("a list that would soon expire is refused, at the boundary", async () => {
  assert.match((await check(await signedList((MIN_LIST_LIFE_DAYS - 1) * DAY)))[0] as string, /expires in under/);
  assert.deepEqual(await check(await signedList(MIN_LIST_LIFE_DAYS * DAY)), []);
});

test("both problems are named in one run", async () => {
  assert.equal((await check(null, "")).length, 2);
});

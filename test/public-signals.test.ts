// What a reader's daemon does with the public signals a server hands back, whatever the server says, and what making one public needs.
// A live run against an honest server can't show a dishonest one, so the server here is a stub that returns whatever the test says.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { toHex } from "../src/protocol/encode.ts";
import { signerFromSeeds } from "../src/protocol/identity.ts";
import { randomBytes, webcrypto } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { type RootKey, type RootSigner, RootKeysNotConfigured, addRootSignature, encodeIssuerList, encodeSignedIssuerList, rootKeysFrom } from "../src/protocol/issuer-list.ts";
import { publicSignalsText } from "../src/signals-text.ts";
import { type TrustSignalEnvelope, issuerPubkeyField, readSignedSignal, signSignal } from "../src/protocol/signal.ts";
import { Wallet, type WalletHooks } from "../src/daemon/wallet.ts";
import { SignalStore } from "../src/daemon/signal-store.ts";
import { Store } from "../src/daemon/store.ts";
import { LocalError } from "../src/daemon/errors.ts";

const fill = (byte: number, length: number): Uint8Array => new Uint8Array(length).fill(byte);
const issuer = await signerFromSeeds({ ed: fill(1, 32), pq: fill(2, 32) });
const endorser = await signerFromSeeds({ ed: fill(5, 32), pq: fill(6, 32) });
const ann = await signerFromSeeds({ ed: fill(7, 32), pq: fill(8, 32) });
const bea = await signerFromSeeds({ ed: fill(9, 32), pq: fill(10, 32) });
const NOW = Math.floor(Date.now() / 1000);

const envelope = (subject: string, over: Partial<TrustSignalEnvelope> = {}): TrustSignalEnvelope => ({
  subject_kind: "agent", subject, issuer_kind: "issuer", issuer_pubkey: issuerPubkeyField(issuer.publicIdentity), type: "github", schema_version: 1,
  payload: new Uint8Array(encodeCbor({ claim: "Ann owns the repo cello" })), issued_at: NOW - 100, expires_at: NOW + 86_400, supersedes_hash: null, same_operator: false,
  issuer_address: "issuer.unlisted.example", signal_id: new Uint8Array(16).fill(Math.floor(Math.random() * 250) + 1), ...over,
});

interface Calls { published: Uint8Array[]; unpublished: Uint8Array[] }

function setup(read: () => Uint8Array[], failing = false): { wallet: Wallet; signals: SignalStore; calls: Calls; store: Store } {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-public-")), "cello.db"));
  for (const [signer, name] of [[ann, "Ann"], [bea, "Bea"]] as const) store.insertAgent(signer.id, name, fill(1, 32), fill(2, 32));
  const calls: Calls = { published: [], unpublished: [] };
  const hooks: WalletHooks = {
    keys: () => { throw new Error("not used"); },
    screen: async (_agent, _issuer, text) => ({ verdict: "allowed", delivered: text }) as never,
    notify: () => undefined,
    roots: () => { throw new RootKeysNotConfigured("these tests have no root keys, so there is no list and no recognised issuer"); },
    shippedList: null,
    publishToServer: async (_agent, file) => { if (failing) throw new LocalError("server_unreachable", "down"); calls.published.push(file); },
    unpublishFromServer: async (_agent, id) => { if (failing) throw new LocalError("server_unreachable", "down"); calls.unpublished.push(id); },
    readPublic: async () => ({ target: toHex(ann.id), files: read() }),
    usageFacts: async () => { throw new LocalError("not_in_this_test", "usage isn't part of this test"); },
  };
  const wallet = new Wallet(store, hooks);
  return { wallet, signals: new SignalStore(store), calls, store };
}

const keep = async (signals: SignalStore, owner: { id: Uint8Array }, env: TrustSignalEnvelope, by = issuer): Promise<{ file: Uint8Array; hash: string }> => {
  const file = await signSignal(env, by);
  const signed = readSignedSignal(file);
  signals.put(owner.id, signed, file);
  return { file, hash: toHex(signed.hash) };
};

test("a lookup checks every file itself: a copied, forged or lapsed one is left out and named, and the rest are described", async () => {
  const good = await signSignal(envelope(toHex(ann.id)), issuer);
  const copied = await signSignal(envelope(toHex(bea.id)), issuer);
  const forged = new Uint8Array(good);
  forged[forged.length - 1] = (forged[forged.length - 1] as number) ^ 1;
  const lapsed = await signSignal(envelope(toHex(ann.id), { issued_at: NOW - 7_200, expires_at: NOW - 3_600 }), issuer);
  const { wallet, store } = setup(() => [good, copied, forged, lapsed, new Uint8Array([1, 2, 3])]);
  const result = await wallet.lookup(toHex(bea.id), toHex(ann.id)) as { agent: string; signals: { type: string; counts_as_verified: boolean; issuer_standing: string; notes: string[]; public: boolean }[]; refused: { fault: string }[] };
  assert.equal(result.agent, toHex(ann.id));
  assert.equal(result.signals.length, 1);
  const only = result.signals[0];
  assert.equal(only?.type, "github");
  assert.equal(only?.counts_as_verified, false, "no list and no trust, so it's unknown");
  assert.equal(only?.issuer_standing, "unknown");
  assert.match(only?.notes.join("\n") ?? "", /Unverified claim/);
  assert.deepEqual(result.refused.map((r) => r.fault).sort(), ["expired", "forged", "malformed", "wrong_subject"]);
  store.close();
});

test("an issuer the reader's owner trusts counts as verified in a lookup, and only on their machine", async () => {
  const good = await signSignal(envelope(toHex(ann.id)), issuer);
  const { wallet, signals, store } = setup(() => [good]);
  signals.trust("issuer.unlisted.example", issuerPubkeyField(issuer.publicIdentity));
  const result = await wallet.lookup(toHex(bea.id), toHex(ann.id)) as { signals: { counts_as_verified: boolean; issuer_standing: string; notes: string[] }[] };
  assert.equal(result.signals[0]?.issuer_standing, "trusted_by_owner");
  assert.equal(result.signals[0]?.counts_as_verified, true);
  assert.equal(result.signals[0]?.notes.some((note) => note.includes("Unverified claim")), false);
  store.close();
});

test("a lookup of an agent with nothing public says so, and a lookup shows no payload of its own", async () => {
  const { wallet, store } = setup(() => []);
  assert.deepEqual(await wallet.lookup(toHex(bea.id), toHex(ann.id)), { agent: toHex(ann.id), signals: [], refused: [] });
  store.close();
});

test("only a current, accepted, unexpired signal can be made public, and the server has to say yes first", async () => {
  const { wallet, signals, calls, store } = setup(() => []);
  const mine = await keep(signals, ann, envelope(toHex(ann.id), { type: "phone", signal_id: fill(21, 16) }));
  const older = await keep(signals, ann, envelope(toHex(ann.id), { type: "github", signal_id: fill(25, 16), issued_at: NOW - 200 }));
  const pending = await keep(signals, ann, envelope(toHex(ann.id), { issuer_kind: "agent", issuer_pubkey: issuerPubkeyField(endorser.publicIdentity), type: "endorsement", signal_id: fill(22, 16) }), endorser);
  const lapsed = await keep(signals, ann, envelope(toHex(ann.id), { type: "old", issued_at: NOW - 7_200, expires_at: NOW - 3_600, signal_id: fill(23, 16) }));
  const replaced = await keep(signals, ann, envelope(toHex(ann.id), { type: "github", signal_id: fill(24, 16), issued_at: NOW - 50 }));

  await assert.rejects(wallet.publish(toHex(ann.id), pending.hash), (err: unknown) => err instanceof LocalError && err.code === "consent_pending");
  await assert.rejects(wallet.publish(toHex(ann.id), lapsed.hash), (err: unknown) => err instanceof LocalError && err.code === "signal_expired");
  await assert.rejects(wallet.publish(toHex(ann.id), older.hash), (err: unknown) => err instanceof LocalError && err.code === "signal_not_current", "a signal a newer one replaced");
  await assert.rejects(wallet.publish(toHex(ann.id), "zz"), (err: unknown) => err instanceof LocalError && err.code === "bad_argument");
  assert.deepEqual(calls.published, [], "nothing refused here may reach the server");

  assert.deepEqual(await wallet.publish(toHex(ann.id), mine.hash), { signal_hash: mine.hash, public: true });
  assert.deepEqual(calls.published.map(toHex), [toHex(mine.file)]);
  assert.equal(signals.get(ann.id, mine.hash)?.public, 1);
  assert.equal(signals.get(ann.id, replaced.hash)?.public, 0);

  assert.deepEqual(await wallet.unpublish(toHex(ann.id), mine.hash), { signal_hash: mine.hash, public: false });
  assert.deepEqual(calls.unpublished.map(toHex), [toHex(readSignedSignal(mine.file).envelope.signal_id)]);
  assert.equal(signals.get(ann.id, mine.hash)?.public, 0);
  store.close();
});

test("a server that can't be reached changes nothing here: a signal isn't marked public, and stays marked public until the server forgets it", async () => {
  const down = setup(() => [], true);
  const held = await keep(down.signals, ann, envelope(toHex(ann.id), { signal_id: fill(31, 16) }));
  await assert.rejects(down.wallet.publish(toHex(ann.id), held.hash), (err: unknown) => err instanceof LocalError && err.code === "server_unreachable");
  assert.equal(down.signals.get(ann.id, held.hash)?.public, 0, "the server never took it");
  down.signals.setPublic(ann.id, held.hash, true);
  await assert.rejects(down.wallet.unpublish(toHex(ann.id), held.hash), (err: unknown) => err instanceof LocalError && err.code === "server_unreachable");
  assert.equal(down.signals.get(ann.id, held.hash)?.public, 1, "the server still shows it, so it must still say public");
  down.store.close();
});

// A server that remembers what is published, so a lookup after a change sees what a real one would.
function fakeServer(): { held: Map<string, Uint8Array>; failing: { on: boolean } } {
  return { held: new Map(), failing: { on: false } };
}

function walletOn(server: ReturnType<typeof fakeServer>, owner: { id: Uint8Array }, notes: string[] = [], shippedList: string | null = null, roots: WalletHooks["roots"] = () => { throw new RootKeysNotConfigured("none"); }): { wallet: Wallet; signals: SignalStore; store: Store } {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-public-")), "cello.db"));
  for (const [signer, name] of [[ann, "Ann"], [bea, "Bea"]] as const) store.insertAgent(signer.id, name, fill(1, 32), fill(2, 32));
  const hooks: WalletHooks = {
    keys: () => { throw new Error("not used"); },
    screen: async (_agent, _issuer, text) => ({ verdict: "allowed", delivered: text }) as never,
    notify: (_agent, text) => { notes.push(text); },
    roots,
    shippedList,
    publishToServer: async (_agent, file) => { if (server.failing.on) throw new LocalError("server_unreachable", "down"); server.held.set(toHex(readSignedSignal(file).envelope.signal_id), file); },
    unpublishFromServer: async (_agent, id) => { if (server.failing.on) throw new LocalError("server_unreachable", "down"); server.held.delete(toHex(id)); },
    readPublic: async () => ({ target: toHex(owner.id), files: [...server.held.values()] }),
    usageFacts: async () => { throw new LocalError("not_in_this_test", "usage isn't part of this test"); },
  };
  return { wallet: new Wallet(store, hooks), signals: new SignalStore(store), store };
}

test("a public signal that a newer one replaces comes off the server by itself, and a lookup stops returning it", async () => {
  const server = fakeServer();
  const notes: string[] = [];
  const a = walletOn(server, ann, notes);
  const b = walletOn(server, ann);
  const old = await keep(a.signals, ann, envelope(toHex(ann.id), { type: "github", signal_id: fill(41, 16), issued_at: NOW - 300 }));
  await a.wallet.publish(toHex(ann.id), old.hash);
  assert.equal(((await b.wallet.lookup(toHex(bea.id), toHex(ann.id))) as { signals: unknown[] }).signals.length, 1);

  // The newer one arrives the way a collected one does: stored, which replaces the old, and then the wallet settles.
  const newer = await keep(a.signals, ann, envelope(toHex(ann.id), { type: "github", signal_id: fill(42, 16), issued_at: NOW - 10 }));
  assert.equal(a.signals.get(ann.id, old.hash)?.status, "superseded");
  assert.equal(a.signals.get(ann.id, old.hash)?.public, 2, "marked for taking back, not left reading as public and current");
  assert.equal(await a.wallet.settlePublic(toHex(ann.id), true), 0);
  assert.equal(a.signals.get(ann.id, old.hash)?.public, 0);
  assert.deepEqual(((await b.wallet.lookup(toHex(bea.id), toHex(ann.id))) as { signals: unknown[] }).signals, [], "the old signal is no longer returned");
  assert.equal(a.signals.get(ann.id, newer.hash)?.public, 0, "the newer one isn't public until its owner says so");
  a.store.close();
  b.store.close();
});

test("when taking a replaced signal back fails it is said loudly once, stays marked, and is retried until the server takes it", async () => {
  const server = fakeServer();
  const notes: string[] = [];
  const a = walletOn(server, ann, notes);
  const old = await keep(a.signals, ann, envelope(toHex(ann.id), { type: "github", signal_id: fill(51, 16), issued_at: NOW - 300 }));
  await a.wallet.publish(toHex(ann.id), old.hash);
  server.failing.on = true;
  await keep(a.signals, ann, envelope(toHex(ann.id), { type: "github", signal_id: fill(52, 16), issued_at: NOW - 10 }));
  assert.equal(await a.wallet.settlePublic(toHex(ann.id), true), 1);
  assert.equal(await a.wallet.settlePublic(toHex(ann.id), true), 1);
  assert.equal(notes.length, 1, "told once, not on every try");
  assert.match(notes[0] as string, /taking it back from the server failed/);
  assert.match(notes[0] as string, /still public/);
  assert.equal(a.signals.get(ann.id, old.hash)?.public, 2, "still marked, because the server still shows it");
  assert.equal(server.held.size, 1);
  server.failing.on = false;
  assert.equal(await a.wallet.settlePublic(toHex(ann.id), true), 0);
  assert.equal(server.held.size, 0);
  assert.equal(a.signals.get(ann.id, old.hash)?.public, 0);
  a.store.close();
});

test("a public signal the wallet no longer holds can still be taken back by its signal id", async () => {
  const server = fakeServer();
  const a = walletOn(server, ann);
  const held = await keep(a.signals, ann, envelope(toHex(ann.id), { type: "phone", signal_id: fill(61, 16) }));
  await a.wallet.publish(toHex(ann.id), held.hash);
  assert.equal(server.held.size, 1);
  a.store.raw().run("DELETE FROM signal_wallet WHERE agent_id = ?", [ann.id]);
  await assert.rejects(a.wallet.unpublish(toHex(ann.id), held.hash), (err: unknown) => err instanceof LocalError && err.code === "signal_not_found");
  assert.deepEqual(await a.wallet.unpublish(toHex(ann.id), undefined, toHex(fill(61, 16))), { signal_id: toHex(fill(61, 16)), public: false });
  assert.equal(server.held.size, 0);
  await assert.rejects(a.wallet.unpublish(toHex(ann.id), undefined, "xyz"), (err: unknown) => err instanceof LocalError && err.code === "bad_argument");
  await assert.rejects(a.wallet.unpublish(toHex(ann.id), held.hash, toHex(fill(61, 16))), (err: unknown) => err instanceof LocalError && err.code === "bad_argument");
  a.store.close();
});

test("a lookup of a verified issuer's signal shows no payload, in the answer or in the words a person reads", async () => {
  const SECRET = "PAYLOAD-TEXT-7731-that-must-not-appear";
  const p256 = async (name: "enclave" | "kms"): Promise<{ key: RootKey; sign: RootSigner }> => {
    const pair = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const publicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
    return { key: { name, algorithm: "p256", publicKey }, sign: { root: name, sign: async (message) => new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array(message))) } };
  };
  const enclave = await p256("enclave");
  const kms = await p256("kms");
  const paperSeed = new Uint8Array(randomBytes(32));
  const paper: RootKey = { name: "paper", algorithm: "ed25519", publicKey: ed25519.getPublicKey(paperSeed) };
  const roots = rootKeysFrom({ enclave: enclave.key, kms: kms.key, paper });
  const entry = { name: "trust.example.com", ed: issuer.publicIdentity.ed, pq: issuer.publicIdentity.pq, expires_at: NOW + 200 * 86_400 };
  let signedList: Parameters<typeof addRootSignature>[0] = { listBytes: encodeIssuerList({ issued_at: NOW - 10, expires_at: NOW + 300 * 86_400, issuers: [entry] }) };
  for (const signer of [enclave.sign, kms.sign]) signedList = await addRootSignature(signedList, signer, roots);
  const list = Buffer.from(encodeSignedIssuerList({ signatures: { enclave: null, kms: null, paper: null }, ...signedList })).toString("base64");

  const server = fakeServer();
  const a = walletOn(server, ann);
  const b = walletOn(server, ann, [], list, () => roots);
  const mine = await keep(a.signals, ann, envelope(toHex(ann.id), { type: "employer", issuer_address: "trust.example.com", payload: new Uint8Array(encodeCbor({ claim: SECRET, detail: SECRET })), signal_id: fill(71, 16) }));
  await a.wallet.publish(toHex(ann.id), mine.hash);

  const result = await b.wallet.lookup(toHex(bea.id), toHex(ann.id)) as { signals: Record<string, unknown>[] };
  assert.equal(result.signals[0]?.["issuer_standing"], "recognised", "this must be a verified issuer for the test to mean anything");
  assert.equal(result.signals[0]?.["counts_as_verified"], true);
  assert.equal(Object.hasOwn(result.signals[0] as object, "payload"), false);
  assert.ok(!JSON.stringify(result).includes("payload"), "no payload key anywhere in the answer");
  assert.ok(!JSON.stringify(result).includes(SECRET), "no payload text anywhere in the answer");
  assert.ok(!publicSignalsText(result as never).includes(SECRET), "nor in the words a person reads");
  a.store.close();
  b.store.close();
});

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
import { RootKeysNotConfigured } from "../src/protocol/issuer-list.ts";
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
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-v2-public-")), "cello.db"));
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

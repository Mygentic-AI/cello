// What the wallet keeps current and shows by default. A wrong rule here hides a signal or retires one with no word to anybody.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { toHex } from "../src/protocol/encode.ts";
import { signerFromSeeds } from "../src/protocol/identity.ts";
import { type TrustSignalEnvelope, issuerPubkeyField, readSignedSignal, signSignal } from "../src/protocol/signal.ts";
import { SignalStore, ensureSignalSchema } from "../src/daemon/signal-store.ts";
import { Store } from "../src/daemon/store.ts";

const fill = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const issuer = await signerFromSeeds({ ed: fill(1), pq: fill(2) });
const other = await signerFromSeeds({ ed: fill(3), pq: fill(4) });
const agent = await signerFromSeeds({ ed: fill(7), pq: fill(8) });
let id = 0;

function wallet(): SignalStore {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-wallet-")), "cello.db"));
  store.insertAgent(agent.id, "Ann", fill(1), fill(2));
  ensureSignalSchema(store);
  return new SignalStore(store);
}

async function put(w: SignalStore, type: string, over: Partial<TrustSignalEnvelope> = {}, by = issuer): Promise<string> {
  id += 1;
  const now = Math.floor(Date.now() / 1000);
  const file = await signSignal({ subject_kind: "agent", subject: toHex(agent.id), issuer_kind: "issuer", issuer_pubkey: issuerPubkeyField(by.publicIdentity), type, schema_version: 1, payload: new Uint8Array(encodeCbor({ claim: `${type} ${id}` })), issued_at: now - 60 + id, expires_at: now + 86_400, supersedes_hash: null, same_operator: false, issuer_address: "issuer.example", signal_id: new Uint8Array(16).fill(id), ...over }, by);
  const signed = readSignedSignal(file);
  w.put(agent.id, signed, file);
  return toHex(signed.hash);
}
const row = (w: SignalStore, hash: string) => w.list(agent.id).find((r) => r.signal_hash === hash)!;

test("endorsements from different authors all stay current, and a new one never takes another's shown-or-hidden choice", async () => {
  const w = wallet();
  const bob = await put(w, "endorsement");
  w.setDefaultPresent(agent.id, bob, false);
  const carol = await put(w, "endorsement");
  assert.equal(row(w, bob).status, "active", "Carol's endorsement must not retire Bob's");
  assert.equal(row(w, carol).status, "active");
  assert.equal(row(w, carol).default_present, 1, "Carol's arrives shown, whatever Bob's was set to");
  // Bob's own update names what it replaces, and that one alone is retired, keeping Bob's choice.
  const bobAgain = await put(w, "endorsement", { supersedes_hash: new Uint8Array(Buffer.from(bob, "hex")) });
  assert.equal(row(w, bob).status, "superseded");
  assert.equal(row(w, carol).status, "active");
  assert.equal(row(w, bobAgain).default_present, 0);
});

test("other types: a newer signal from the same issuer replaces the older and keeps its choice; new ones follow the type", async () => {
  const w = wallet();
  const first = await put(w, "usage_detailed");
  assert.equal(row(w, first).default_present, 0, "detailed Usage is left out by default");
  const standard = await put(w, "usage");
  assert.equal(row(w, standard).default_present, 1);
  w.setDefaultPresent(agent.id, first, true);
  const next = await put(w, "usage_detailed");
  assert.equal(row(w, first).status, "superseded");
  assert.equal(row(w, next).default_present, 1, "the person's choice carries to the renewal");
  assert.equal(row(w, (await put(w, "github_id"))).default_present, 0, "identifying signals are left out by default");
});

test("a named supersedes from another issuer doesn't stop the issuer's own current signal passing its choice on", async () => {
  const w = wallet();
  const mine = await put(w, "usage");
  w.setDefaultPresent(agent.id, mine, false);
  const stranger = await put(w, "usage", {}, other);
  const renewed = await put(w, "usage", { supersedes_hash: new Uint8Array(Buffer.from(stranger, "hex")) });
  assert.equal(row(w, renewed).default_present, 0);
  assert.equal(row(w, stranger).status, "active", "another issuer's signal is never replaced by this one");
});

// The renewal rules: who is told, and what auto-renew does. A wrong window or a renewal that issues Usage unasked would be silent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { toHex } from "../src/protocol/encode.ts";
import { signerFromSeeds } from "../src/protocol/identity.ts";
import { issuerPubkeyField, readSignedSignal, signSignal } from "../src/protocol/signal.ts";
import { LocalError } from "../src/daemon/errors.ts";
import { type RenewalRow, expiryNotice, renewalPlan } from "../src/daemon/renewal.ts";
import { SignalStore } from "../src/daemon/signal-store.ts";
import { Store } from "../src/daemon/store.ts";
import { Wallet } from "../src/daemon/wallet.ts";

const NOW = 1_800_000_000;
const DAY = 86_400;
const row = (type: string, expiresIn: number | null, over: Partial<RenewalRow> = {}): RenewalRow => ({
  signal_hash: `${type}-${expiresIn}`, type, issued_at: NOW - 10 * DAY, expires_at: expiresIn === null ? null : NOW + expiresIn, status: "active", consent_state: "accepted", ...over,
});

test("only current, accepted signals with 30 days or less left are expiring", () => {
  const plan = renewalPlan([
    row("email", 29 * DAY), row("phone", 31 * DAY), row("github_id", 30 * DAY), row("endorsement", null),
    row("old", -DAY), row("replaced", 5 * DAY, { status: "superseded" }), row("pending", 5 * DAY, { consent_state: "pending" }),
  ], NOW, false);
  assert.deepEqual(plan.expiring.map((e) => e.type).sort(), ["email", "github_id"]);
  assert.equal(plan.requestUsage, false);
  assert.equal(plan.collect, false, "nothing renews with auto-renew off");
});

test("each notice says how to renew that kind of signal", () => {
  const [usage, github, email] = renewalPlan([row("usage", DAY), row("github_id", DAY), row("email", DAY)], NOW, false).expiring.sort((a, b) => a.type.localeCompare(b.type)).reverse();
  assert.match(expiryNotice(usage!), /expires on \d{4}-\d{2}-\d{2}\. To renew it, run: cello signals request usage$/);
  assert.match(github!.renew, /reconnect that account at https:\/\/trust\.celloprotocol\.com/);
  assert.match(email!.renew, /sign in at https:\/\/trust\.celloprotocol\.com, then run: cello signals collect/);
});

test("auto-renew requests Usage when it's expiring or a month old, and collects for anything else expiring", () => {
  assert.equal(renewalPlan([row("usage", 20 * DAY)], NOW, true).requestUsage, true, "expiring");
  assert.equal(renewalPlan([row("usage", 170 * DAY, { issued_at: NOW - 31 * DAY })], NOW, true).requestUsage, true, "a month old");
  assert.equal(renewalPlan([row("usage", 170 * DAY, { issued_at: NOW - 5 * DAY })], NOW, true).requestUsage, false, "fresh");
  assert.equal(renewalPlan([row("email", 20 * DAY)], NOW, true).collect, true);
  assert.equal(renewalPlan([row("usage", 20 * DAY)], NOW, true).collect, false, "Usage renews by request, not collect");
});

test("through the real wallet: a signal in its last 30 days is told to the agent once, however often the check runs", async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-renewal-")), "cello.db"));
  const fill = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
  const agent = await signerFromSeeds({ ed: fill(7), pq: fill(8) });
  const issuer = await signerFromSeeds({ ed: fill(1), pq: fill(2) });
  store.insertAgent(agent.id, "Ann", fill(1), fill(2));
  const notes: string[] = [];
  const unused = async (): Promise<never> => { throw new LocalError("not_in_this_test", "not used"); };
  const wallet = new Wallet(store, { keys: () => { throw new Error("not used"); }, screen: unused, notify: (_id, text) => { notes.push(text); }, roots: () => [], shippedList: null, publishToServer: unused, unpublishFromServer: unused, readPublic: unused, usageFacts: unused });
  const now = Math.floor(Date.now() / 1000);
  const file = await signSignal({ subject_kind: "agent", subject: toHex(agent.id), issuer_kind: "issuer", issuer_pubkey: issuerPubkeyField(issuer.publicIdentity), type: "usage", schema_version: 1, payload: new Uint8Array(encodeCbor({ claim: "x" })), issued_at: now - DAY, expires_at: now + 10 * DAY, supersedes_hash: null, same_operator: false, issuer_address: "issuer.example", signal_id: new Uint8Array(16).fill(3) }, issuer);
  new SignalStore(store).put(agent.id, readSignedSignal(file), file);
  await wallet.renewal(toHex(agent.id), now);
  // Past the six-hour gate, the check runs again, and still says nothing new.
  await wallet.renewal(toHex(agent.id), now + 7 * 3600);
  assert.equal(notes.length, 1);
  assert.match(notes[0] as string, /usage signal expires on .* To renew it, run: cello signals request usage/);
  assert.deepEqual(wallet.expiring(toHex(agent.id), now).map((e) => e.type), ["usage"]);
});

test("auto-renew never issues Usage to an agent that never asked for it", () => {
  assert.equal(renewalPlan([row("email", 20 * DAY)], NOW, true).requestUsage, false);
  assert.equal(renewalPlan([], NOW, true).requestUsage, false);
});

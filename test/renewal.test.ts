// The renewal rules: who is told, and what auto-renew does. A wrong window, a repeated notice, or a renewal that issues Usage unasked
// or claims to renew what it can't would all be silent.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
const OURS = "trust.celloprotocol.com";
const row = (type: string, expiresIn: number | null, over: Partial<RenewalRow> = {}): RenewalRow => ({
  signal_hash: `${type}-${expiresIn}-${over.issued_at ?? 0}`, type, issuer_address: OURS, issued_at: NOW - 10 * DAY, expires_at: expiresIn === null ? null : NOW + expiresIn, status: "active", consent_state: "accepted", ...over,
});

test("only current, accepted signals with 30 days or less left are expiring", () => {
  const plan = renewalPlan([
    row("email", 29 * DAY), row("phone", 30 * DAY + 1), row("github_id", 30 * DAY), row("endorsement", null),
    row("old", -DAY), row("replaced", 5 * DAY, { status: "superseded" }), row("pending", 5 * DAY, { consent_state: "pending" }),
  ], NOW, false, OURS);
  assert.deepEqual(plan.expiring.map((e) => e.type).sort(), ["email", "github_id"]);
  assert.equal(plan.requestUsage, false);
});

test("Usage's two varieties make one notice, and names are the ones a person reads", () => {
  const expiring = renewalPlan([row("usage", DAY), row("usage_detailed", DAY), row("github_id", DAY), row("webauthn", DAY)], NOW, false, OURS).expiring;
  assert.deepEqual(expiring.map((e) => e.name).sort(), ["GitHub", "Usage", "passkey"]);
});

test("each notice says how to renew that kind of signal, and only signals from our issuer get trust-site advice", () => {
  const byName = Object.fromEntries(renewalPlan([row("usage", DAY), row("github_id", DAY), row("email", DAY), row("employer", DAY, { issuer_address: "other.example" })], NOW, false, OURS).expiring.map((e) => [e.name, e]));
  assert.match(expiryNotice(byName["Usage"]!), /^This agent's Usage signal expires on \d{4}-\d{2}-\d{2}\. To renew it, run: cello signals request usage$/);
  assert.match(byName["GitHub"]!.renew, /reconnect that account at https:\/\/trust\.celloprotocol\.com/);
  assert.equal(byName["email"]!.renew, "Sign in at https://trust.celloprotocol.com to renew it, then run: cello signals collect");
  assert.equal(byName["employer"]!.renew, "To renew it, ask whoever issued it.");
});

test("auto-renew requests Usage when it's expiring or 30 days old, and nothing else: other signals can't renew themselves", () => {
  assert.equal(renewalPlan([row("usage", 20 * DAY)], NOW, true, OURS).requestUsage, true, "expiring");
  assert.equal(renewalPlan([row("usage", 170 * DAY, { issued_at: NOW - 30 * DAY })], NOW, true, OURS).requestUsage, true, "exactly 30 days old");
  assert.equal(renewalPlan([row("usage", 170 * DAY, { issued_at: NOW - 30 * DAY + 1 })], NOW, true, OURS).requestUsage, false, "a second younger");
  assert.equal(renewalPlan([row("email", 5 * DAY), row("github_id", 5 * DAY)], NOW, true, OURS).requestUsage, false);
});

test("auto-renew never issues Usage to an agent that never asked for it, nor renews another issuer's", () => {
  assert.equal(renewalPlan([row("email", 20 * DAY)], NOW, true, OURS).requestUsage, false);
  assert.equal(renewalPlan([], NOW, true, OURS).requestUsage, false);
  assert.equal(renewalPlan([row("usage", 20 * DAY, { issuer_address: "other.example" })], NOW, true, OURS).requestUsage, false);
});

// ---- Through the real wallet and database. ----

const fill = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const issuer = await signerFromSeeds({ ed: fill(1), pq: fill(2) });

async function walletWith(signals: { type: string; expiresIn: number; issuedAgo?: number }[], autoRenew: boolean) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-renewal-")), "cello.db"));
  const agent = await signerFromSeeds({ ed: fill(7), pq: fill(8) });
  store.insertAgent(agent.id, "Ann", fill(1), fill(2));
  store.setConfig("setting.auto_renew_signals", autoRenew ? "1" : "0");
  const notes: string[] = [];
  const asked = { usageFacts: 0 };
  const unused = async (): Promise<never> => { throw new LocalError("not_in_this_test", "not used"); };
  // The server can't be reached, so a renewal attempt fails: it's counted, and its failure is what the agent hears.
  const usageFacts = async (): Promise<never> => { asked.usageFacts += 1; throw new LocalError("server_unreachable", "the server didn't answer"); };
  const wallet = new Wallet(store, { keys: () => { throw new Error("not used"); }, screen: unused, notify: (_id, text) => { notes.push(text); }, roots: () => [], shippedList: null, publishToServer: unused, unpublishFromServer: unused, readPublic: unused, usageFacts });
  const now = Math.floor(Date.now() / 1000);
  const store2 = new SignalStore(store);
  for (const [i, s] of signals.entries()) {
    const file = await signSignal({ subject_kind: "agent", subject: toHex(agent.id), issuer_kind: "issuer", issuer_pubkey: issuerPubkeyField(issuer.publicIdentity), type: s.type, schema_version: 1, payload: new Uint8Array(encodeCbor({ claim: "x" })), issued_at: now - (s.issuedAgo ?? DAY), expires_at: now + s.expiresIn, supersedes_hash: null, same_operator: false, issuer_address: OURS, signal_id: new Uint8Array(16).fill(i + 1) }, issuer);
    store2.put(agent.id, readSignedSignal(file), file);
  }
  return { wallet, notes, asked, agentHex: toHex(agent.id), now };
}

test("a signal in its last 30 days is told to the agent once, however often the check runs", async () => {
  const { wallet, notes, agentHex, now } = await walletWith([{ type: "phone", expiresIn: 10 * DAY }], false);
  await wallet.renewal(agentHex, now);
  await wallet.renewal(agentHex, now + 7 * 3600);
  assert.equal(notes.length, 1, "once, however often the check runs");
  assert.match(notes[0] as string, /phone signal expires on .* Sign in at https:\/\/trust\.celloprotocol\.com to renew it/);
  assert.deepEqual(wallet.expiring(agentHex, now).map((e) => e.name), ["phone"]);
});

test("with auto-renew off, nothing is requested", async () => {
  const { wallet, asked, agentHex, now } = await walletWith([{ type: "usage", expiresIn: 10 * DAY }], false);
  await wallet.renewal(agentHex, now);
  assert.equal(asked.usageFacts, 0);
});

test("with auto-renew on, Usage is requested; a failure is told once, retried at every check, told again only near the end", async () => {
  const { wallet, notes, asked, agentHex, now } = await walletWith([{ type: "usage", expiresIn: 10 * DAY }], true);
  await wallet.renewal(agentHex, now);
  assert.equal(asked.usageFacts, 1);
  const failures = (): string[] => notes.filter((n) => /automatically failed/.test(n));
  assert.equal(failures().length, 1);
  assert.doesNotMatch(failures()[0] as string, /run the same command/);
  await wallet.renewal(agentHex, now + 3600);
  assert.equal(asked.usageFacts, 1, "inside six hours, no second try");
  await wallet.renewal(agentHex, now + 7 * 3600);
  assert.equal(asked.usageFacts, 2, "retried at the next check");
  assert.equal(failures().length, 1, "not told again while there's time");
  await wallet.renewal(agentHex, now + 8 * DAY);
  assert.equal(failures().length, 2, "told again with three days or less left");
});

test("with auto-renew on, other expiring signals are never 'renewed': no request, just the notice", async () => {
  const { wallet, notes, asked, agentHex, now } = await walletWith([{ type: "email", expiresIn: 10 * DAY }, { type: "github_id", expiresIn: 10 * DAY }], true);
  await wallet.renewal(agentHex, now);
  assert.equal(asked.usageFacts, 0);
  assert.equal(notes.length, 2);
  assert.ok(notes.every((n) => !/automatically/.test(n)));
});

// Which signal a registration carries. Email first, so an agent holding both still registers on a server that only takes email; a
// phone for an owner who signed up in a chat app; neither when the only ones held have lapsed. A wrong choice is silent until a
// server refuses the agent.
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
import { SignalStore } from "../src/daemon/signal-store.ts";
import { Store } from "../src/daemon/store.ts";
import { Wallet } from "../src/daemon/wallet.ts";

const fill = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const issuer = await signerFromSeeds({ ed: fill(1), pq: fill(2) });
const hex = (b: Uint8Array | undefined): string => (b ? Buffer.from(b).toString("hex") : "none");

async function holding(signals: { type: string; expiresIn: number; byAgent?: boolean }[]) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-registration-")), "cello.db"));
  const agent = await signerFromSeeds({ ed: fill(7), pq: fill(8) });
  store.insertAgent(agent.id, "Ann", fill(1), fill(2));
  const unused = async (): Promise<never> => { throw new LocalError("not_in_this_test", "not used"); };
  const wallet = new Wallet(store, { keys: () => { throw new Error("not used"); }, screen: unused, notify: () => {}, roots: () => [], shippedList: null, publishToServer: unused, unpublishFromServer: unused, readPublic: unused, usageFacts: unused });
  const now = Math.floor(Date.now() / 1000);
  const files = new Map<string, Uint8Array>();
  for (const [i, s] of signals.entries()) {
    const file = await signSignal({ subject_kind: "account", subject: toHex(agent.id), issuer_kind: s.byAgent ? "agent" : "issuer", issuer_pubkey: issuerPubkeyField(issuer.publicIdentity), type: s.type, schema_version: 1, payload: new Uint8Array(encodeCbor({ claim: "x" })), issued_at: now - 7200, expires_at: now + s.expiresIn, supersedes_hash: null, same_operator: false, issuer_address: "trust.celloprotocol.com", signal_id: new Uint8Array(16).fill(i + 1) }, issuer);
    new SignalStore(store).put(agent.id, readSignedSignal(file), file);
    files.set(s.type, file);
  }
  return { wallet, agentHex: toHex(agent.id), files };
}

test("an agent holding both sends its email signal", async () => {
  const { wallet, agentHex, files } = await holding([{ type: "phone", expiresIn: 3600 }, { type: "email", expiresIn: 3600 }]);
  const chosen = wallet.registrationSignal(agentHex);
  assert.equal(chosen?.type, "email");
  assert.equal(hex(chosen?.file), hex(files.get("email")));
});

test("an agent holding only a phone signal sends that", async () => {
  const { wallet, agentHex, files } = await holding([{ type: "phone", expiresIn: 3600 }, { type: "webauthn", expiresIn: 3600 }]);
  assert.equal(wallet.registrationSignal(agentHex)?.type, "phone");
  assert.equal(hex(wallet.registrationSignal(agentHex)?.file), hex(files.get("phone")));
  assert.equal(wallet.hasRegistrationSignal(agentHex), true);
});

test("an email signal the owner hasn't accepted gives way to an accepted phone", async () => {
  // One issued by an agent waits for the owner's yes, so it can't be what registration carries.
  const { wallet, agentHex } = await holding([{ type: "email", expiresIn: 3600, byAgent: true }, { type: "phone", expiresIn: 3600 }]);
  assert.equal(wallet.registrationSignal(agentHex)?.type, "phone");
});

test("a lapsed email gives way to a current phone, and neither current means none", async () => {
  const lapsedEmail = await holding([{ type: "email", expiresIn: -60 }, { type: "phone", expiresIn: 3600 }]);
  assert.equal(lapsedEmail.wallet.registrationSignal(lapsedEmail.agentHex)?.type, "phone");
  const neither = await holding([{ type: "email", expiresIn: -60 }, { type: "webauthn", expiresIn: 3600 }]);
  assert.equal(neither.wallet.registrationSignal(neither.agentHex), undefined);
  assert.equal(neither.wallet.hasRegistrationSignal(neither.agentHex), false);
});

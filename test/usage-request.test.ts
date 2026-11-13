// The daemon's two checks on Usage that nothing else would catch: the server's count before it travels, and the counts a person
// is told, read only from a signal that passed every check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { toHex } from "../src/protocol/encode.ts";
import { signerFromSeeds } from "../src/protocol/identity.ts";
import type { TrustSignalEnvelope } from "../src/protocol/signal.ts";
import { USAGE_FACTS_DOMAIN, usageFactsBytes } from "../src/protocol/structures.ts";
import { signedUsageFacts } from "../src/protocol/wire.ts";
import { checkUsageFacts } from "../src/daemon/usage-facts.ts";
import { usageCounts } from "../src/daemon/wallet.ts";

const fill = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const server = await signerFromSeeds({ ed: fill(1), pq: fill(2) });
const stranger = await signerFromSeeds({ ed: fill(3), pq: fill(4) });
const agentHex = toHex(fill(0xaa));

async function count(over: { signer?: typeof server; serverId?: Uint8Array; agentId?: Uint8Array } = {}): Promise<unknown> {
  const fields = { serverId: over.serverId ?? server.id, agentId: over.agentId ?? fill(0xaa), asOf: 1_800_000_000, firstActive: 1_799_000_000, conversations: 1, messagesSent: 1, messagesReceived: 1, medianMessages: 2, months: "2027-01:1", counterparties: fill(0xbb) };
  const bytes = usageFactsBytes(fields);
  return signedUsageFacts.encode({ fields, bytes, signature: await (over.signer ?? server).sign(USAGE_FACTS_DOMAIN, bytes) });
}
const refusedWith = async (attempt: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(attempt, (err: unknown) => (err as { code?: string }).code === code);
};

test("a count from the pinned server, about this agent, passes", async () => {
  await checkUsageFacts(server.publicIdentity, await count(), agentHex);
});

test("the daemon refuses, by name, a count it can't read, from another server, signed by another key, or about another agent", async () => {
  await refusedWith(checkUsageFacts(server.publicIdentity, "junk", agentHex), "usage_unreadable");
  await refusedWith(checkUsageFacts(server.publicIdentity, await count({ serverId: stranger.id, signer: stranger }), agentHex), "usage_wrong_server");
  await refusedWith(checkUsageFacts(server.publicIdentity, await count({ signer: stranger }), agentHex), "usage_forged");
  await refusedWith(checkUsageFacts(server.publicIdentity, await count({ agentId: fill(0xcc) }), agentHex), "usage_wrong_agent");
});

const envelope = (type: string, payload: unknown): TrustSignalEnvelope => ({
  subject_kind: "agent", subject: agentHex, issuer_kind: "issuer", issuer_pubkey: "", type, schema_version: 1, payload: new Uint8Array(encodeCbor(payload)),
  issued_at: 0, expires_at: null, supersedes_hash: null, same_operator: false, issuer_address: "issuer.example", signal_id: new Uint8Array(16),
});

test("the counts come only from a kept Usage signal: none kept is a refusal naming what failed, never 'ready'", () => {
  assert.deepEqual(usageCounts([envelope("email", {}), envelope("usage", { conversations: 3, agents: 2, other_owner_agents: 1 })], []), { conversations: 3, agents: 2, other_owner_agents: 1 });
  assert.throws(() => usageCounts([envelope("email", {})], [{ fault: "forged", message: "x" }]), (err: unknown) => (err as { code?: string; message: string }).code === "usage_missing" && /forged/.test((err as Error).message));
});

test("a kept Usage signal whose counts aren't whole numbers is said so, not shown as NaN", () => {
  assert.throws(() => usageCounts([envelope("usage", { conversations: "3", agents: 2, other_owner_agents: 1 })], []), (err: unknown) => (err as { code?: string }).code === "usage_unreadable");
  assert.throws(() => usageCounts([envelope("usage", { agents: 2, other_owner_agents: 1 })], []), (err: unknown) => (err as { code?: string }).code === "usage_unreadable");
});

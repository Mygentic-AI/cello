// The rules that keep a thief from lifting a suspension, and the check a later reader runs on the log. A mistake in either wouldn't show in normal use.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ZERO_HASH } from "../src/protocol/encode.ts";
import { type Signer, generateIdentitySeeds, signerFromSeeds } from "../src/protocol/identity.ts";
import { STATUS_DOMAIN, STATUS_MAX_FUTURE_MS, STATUS_WITNESS_DOMAIN, type StatusRecordOnWire, checkStatusLog, statusChangeFault } from "../src/protocol/status.ts";
import { AgentStatus, StatusIssuer, StatusReason, type StatusStatementFields, statusStatementBytes, statusWitnessBytes, structureHash } from "../src/protocol/structures.ts";
import { identityCodec, signedStatusStatement, signedStatusWitness } from "../src/protocol/wire.ts";

const fields = (over: Partial<StatusStatementFields> = {}): StatusStatementFields => ({
  agentId: new Uint8Array(32).fill(1),
  status: AgentStatus.suspended,
  reason: StatusReason.none,
  issuer: StatusIssuer.agent,
  issuerId: new Uint8Array(32).fill(1),
  issuedAt: 1000,
  ...over,
});

test("retired is final, whoever signs", () => {
  for (const issuer of Object.values(StatusIssuer)) {
    assert.equal(statusChangeFault({ status: AgentStatus.retired, issuedAt: 1 }, fields({ status: AgentStatus.active, issuer, issuedAt: 2 }), 3)?.fault, "agent_retired");
  }
});

test("an agent's own keys can stop it and never restart it", () => {
  assert.equal(statusChangeFault({ status: AgentStatus.suspended, issuedAt: 1 }, fields({ status: AgentStatus.active }), 2000)?.fault, "status_not_allowed");
  assert.equal(statusChangeFault(undefined, fields(), 2000), null);
  assert.equal(statusChangeFault({ status: AgentStatus.suspended, issuedAt: 1 }, fields({ status: AgentStatus.active, issuer: StatusIssuer.portal }), 2000), null);
});

test("an old statement can't undo a newer one, and a future date can't block later ones", () => {
  assert.equal(statusChangeFault({ status: AgentStatus.suspended, issuedAt: 1000 }, fields({ status: AgentStatus.active, issuer: StatusIssuer.portal, issuedAt: 999 }), 2000)?.fault, "status_stale");
  assert.equal(statusChangeFault({ status: AgentStatus.suspended, issuedAt: 1000 }, fields({ status: AgentStatus.active, issuer: StatusIssuer.portal, issuedAt: 1000 }), 2000)?.fault, "status_stale");
  assert.equal(statusChangeFault(undefined, fields({ issuedAt: 2000 + STATUS_MAX_FUTURE_MS + 1 }), 2000)?.fault, "status_stale");
});

async function record(server: Signer, issuer: Signer, agentId: Uint8Array, seq: number, prevHash: Uint8Array, status: AgentStatus): Promise<{ record: StatusRecordOnWire; witnessHash: Uint8Array }> {
  const statement = fields({ agentId, status, issuer: StatusIssuer.portal, issuerId: issuer.id, issuedAt: 1000 + seq });
  const bytes = statusStatementBytes(statement);
  const witness = { serverId: server.id, agentId, seq, prevHash, statementHash: structureHash(bytes), time: 2000 + seq };
  const witnessBytes = statusWitnessBytes(witness);
  return {
    witnessHash: structureHash(witnessBytes),
    record: {
      statement: signedStatusStatement.encode({ fields: statement, signature: await issuer.sign(STATUS_DOMAIN, bytes) }),
      issuerKeys: identityCodec.encode(issuer.publicIdentity),
      witness: signedStatusWitness.encode({ fields: witness, signature: await server.sign(STATUS_WITNESS_DOMAIN, witnessBytes) }),
    },
  };
}

test("a reader catches a log that's been altered, reordered or cut from the front", async () => {
  const server = await signerFromSeeds(generateIdentitySeeds());
  const portal = await signerFromSeeds(generateIdentitySeeds());
  const agentId = new Uint8Array(32).fill(7);
  const first = await record(server, portal, agentId, 1, ZERO_HASH, AgentStatus.suspended);
  const second = await record(server, portal, agentId, 2, first.witnessHash, AgentStatus.active);
  const good = await checkStatusLog([first.record, second.record], agentId, server.publicIdentity);
  assert.ok(good.ok);
  assert.deepEqual(good.log.map((line) => line.status), ["suspended", "active"]);

  assert.equal((await checkStatusLog([second.record, first.record], agentId, server.publicIdentity)).ok, false, "reordered");
  assert.equal((await checkStatusLog([second.record], agentId, server.publicIdentity)).ok, false, "cut from the front");
  assert.equal((await checkStatusLog([first.record], new Uint8Array(32).fill(8), server.publicIdentity)).ok, false, "another agent's");
  assert.equal((await checkStatusLog([first.record], agentId, portal.publicIdentity)).ok, false, "another server's");

  const decoded = signedStatusStatement.decode(first.record.statement);
  const altered = { ...first.record, statement: signedStatusStatement.encode({ signature: decoded.signature, fields: { ...decoded.fields, status: AgentStatus.retired } }) };
  assert.equal((await checkStatusLog([altered], agentId, server.publicIdentity)).ok, false, "a statement changed after signing");
  const wrongTime = signedStatusWitness.decode(first.record.witness);
  const backdated = { ...first.record, witness: signedStatusWitness.encode({ signature: wrongTime.signature, fields: { ...wrongTime.fields, time: 1 } }) };
  assert.equal((await checkStatusLog([backdated], agentId, server.publicIdentity)).ok, false, "a witness time changed after signing");
});

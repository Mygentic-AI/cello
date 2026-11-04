// An agent's status: the rules for changing it, and the check a later reader runs on its log.
import { ZERO_HASH, equalBytes } from "./encode.ts";
import { type PublicIdentity, identityId, verifySignature } from "./identity.ts";
import { AgentStatus, StatusIssuer, StatusReason, type StatusStatementFields, statusStatementBytes, statusWitnessBytes, structureHash } from "./structures.ts";
import { type WireSigned, identityCodec, signedStatusStatement, signedStatusWitness } from "./wire.ts";

export const STATUS_DOMAIN = "cello-v2-agent-status";
export const STATUS_WITNESS_DOMAIN = "cello-v2-agent-status-witness";
// A statement dated further ahead than this could block every later one, so it's refused.
export const STATUS_MAX_FUTURE_MS = 5 * 60 * 1000;

export type StatusName = keyof typeof AgentStatus;
export type ReasonName = keyof typeof StatusReason;
export type IssuerName = keyof typeof StatusIssuer;

function nameOf<T extends Record<string, number>>(table: T, value: number): keyof T {
  const found = Object.entries(table).find(([, v]) => v === value);
  if (!found) throw new RangeError(`unknown value ${value}`);
  return found[0];
}
export const statusName = (value: number): StatusName => nameOf(AgentStatus, value);
export const reasonName = (value: number): ReasonName => nameOf(StatusReason, value);
export const issuerName = (value: number): IssuerName => nameOf(StatusIssuer, value);

export interface StatusRecordOnWire {
  statement: WireSigned;
  // The keys that signed it, so a reader needs nothing else to check the signature. Whether to trust that issuer is the reader's call.
  issuerKeys: Record<string, string | number>;
  witness: WireSigned;
}

export type StatusFault = "agent_retired" | "status_not_allowed" | "status_stale";

// Retired is final. An agent's own keys can stop it but never restart it, or a thief holding them could undo a suspension.
export function statusChangeFault(current: { status: number; issuedAt: number } | undefined, next: StatusStatementFields, now: number): { fault: StatusFault; message: string } | null {
  if (current?.status === AgentStatus.retired) return { fault: "agent_retired", message: "this agent is retired, and that can't be changed" };
  if (next.status === AgentStatus.active && next.issuer === StatusIssuer.agent) return { fault: "status_not_allowed", message: "an agent's own keys can't lift a suspension, because a thief holds them too" };
  if (next.issuedAt > now + STATUS_MAX_FUTURE_MS) return { fault: "status_stale", message: "this statement is dated in the future" };
  if (current && next.issuedAt <= current.issuedAt) return { fault: "status_stale", message: "this statement is older than the one already in force" };
  return null;
}

export interface StatusLogLine {
  seq: number;
  status: StatusName;
  reason: ReasonName;
  issuer: IssuerName;
  issuer_id: string;
  issued_at: string;
  witnessed_at: string;
}

// Checks every signature and link, using only public keys. It can't show a server hasn't left off the newest records.
export async function checkStatusLog(records: readonly StatusRecordOnWire[], agentId: Uint8Array, server: PublicIdentity): Promise<{ ok: true; log: StatusLogLine[] } | { ok: false; message: string }> {
  const serverId = identityId(server);
  const log: StatusLogLine[] = [];
  let prev = ZERO_HASH;
  for (const [i, raw] of records.entries()) {
    const seq = i + 1;
    const fail = (message: string): { ok: false; message: string } => ({ ok: false, message: `record ${seq}: ${message}` });
    const statement = signedStatusStatement.decode(raw.statement, "statement");
    const witness = signedStatusWitness.decode(raw.witness, "witness");
    const keys = identityCodec.decode(raw.issuerKeys, "issuerKeys");
    const f = statement.fields;
    const bytes = statusStatementBytes(f);
    if (!equalBytes(f.agentId, agentId) || !equalBytes(witness.fields.agentId, agentId)) return fail("it's about another agent");
    if (!equalBytes(identityId(keys), f.issuerId)) return fail("the keys carried aren't the issuer's");
    if (f.issuer === StatusIssuer.agent && !equalBytes(f.issuerId, agentId)) return fail("it says the agent signed it, and names other keys");
    if (f.issuer === StatusIssuer.server && !equalBytes(f.issuerId, serverId)) return fail("it says this server signed it, and names other keys");
    if (!(await verifySignature(keys, STATUS_DOMAIN, bytes, statement.signature))) return fail("the statement's signature doesn't verify");
    const w = witness.fields;
    if (!equalBytes(w.serverId, serverId) || w.seq !== seq || !equalBytes(w.prevHash, prev) || !equalBytes(w.statementHash, structureHash(bytes))) return fail("the log's links don't hold");
    const witnessBytes = statusWitnessBytes(w);
    if (!(await verifySignature(server, STATUS_WITNESS_DOMAIN, witnessBytes, witness.signature))) return fail("the server's signature doesn't verify");
    prev = structureHash(witnessBytes);
    log.push({ seq, status: statusName(f.status), reason: reasonName(f.reason), issuer: issuerName(f.issuer), issuer_id: Buffer.from(f.issuerId).toString("hex"), issued_at: new Date(f.issuedAt).toISOString(), witnessed_at: new Date(w.time).toISOString() });
  }
  return { ok: true, log };
}

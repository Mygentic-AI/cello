// The daemon's own check of its server's signed usage count, before it travels to an issuer. Pure, so it can be tested apart.
import { equalBytes, toHex } from "../protocol/encode.ts";
import { type PublicIdentity, identityId, verifySignature } from "../protocol/identity.ts";
import { USAGE_FACTS_DOMAIN } from "../protocol/structures.ts";
import { signedUsageFacts } from "../protocol/wire.ts";
import { LocalError } from "./errors.ts";

// Refuses, by name, a count that can't be read, names another server, isn't signed by the server pinned on first contact, or is
// about another agent. Nothing is sent to the issuer when it refuses.
export async function checkUsageFacts(server: PublicIdentity, wire: unknown, agentHex: string): Promise<void> {
  let facts: ReturnType<typeof signedUsageFacts.decode>;
  try {
    facts = signedUsageFacts.decode(wire, "facts");
  } catch (err: unknown) {
    throw new LocalError("usage_unreadable", `The server's count couldn't be read: ${err instanceof Error ? err.message : String(err)}. Nothing was sent to the issuer.`);
  }
  if (!equalBytes(facts.fields.serverId, identityId(server))) throw new LocalError("usage_wrong_server", "The server's count names a different server from the one this daemon pinned, so it wasn't sent to the issuer.");
  if (!(await verifySignature(server, USAGE_FACTS_DOMAIN, facts.bytes, facts.signature))) {
    throw new LocalError("usage_forged", "The server's count isn't signed by the server this daemon pinned on first contact, so it wasn't sent to the issuer.");
  }
  if (toHex(facts.fields.agentId) !== agentHex) throw new LocalError("usage_wrong_agent", "The server sent a count for a different agent, so it wasn't sent to the issuer.");
}

// The list of an agent's screening rules. A rule could be set and one looked up, but nothing listed them, so a person
// had no way to see what had been weakened. These check the list shows every rule, and only this agent's.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signerFromSeeds } from "../src/protocol/identity.ts";
import { Governance } from "../src/daemon/governance.ts";
import { Store } from "../src/daemon/store.ts";

const fill = (byte: number, length: number): Uint8Array => new Uint8Array(length).fill(byte);
const ann = await signerFromSeeds({ ed: fill(1, 32), pq: fill(2, 32) });
const bea = await signerFromSeeds({ ed: fill(3, 32), pq: fill(4, 32) });
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
type Listed = { rules: { scope: string; sender?: string; tier?: string; level: string; set_at: string }[] };

test("the list shows every screening rule an agent has, by sender and by tier, and none of another agent's", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-screening-")), "cello.db"));
  store.insertAgent(ann.id, "Ann", fill(1, 32), fill(2, 32));
  store.insertAgent(bea.id, "Bea", fill(3, 32), fill(4, 32));
  const governance = new Governance(store, { notify: () => undefined, isLocalAgent: () => false });
  governance.writeDefaults(ann.id);
  governance.writeDefaults(bea.id);
  const person = { person_confirmed: true, caller: "cli" };
  const sender = hex(fill(9, 32));

  assert.deepEqual((governance.screeningRules(ann.id) as Listed).rules, [], "with no rule, everything is screened in full");

  governance.setScreening(ann.id, hex(ann.id), { sender, level: "off", ...person });
  governance.setScreening(ann.id, hex(ann.id), { tier: "vip", level: "deterministic", ...person });
  governance.setScreening(bea.id, hex(bea.id), { tier: "whitelisted", level: "off", ...person });

  const listed = (governance.screeningRules(ann.id) as Listed).rules;
  assert.equal(listed.length, 2);
  const bySender = listed.find((r) => r.scope === "sender");
  assert.equal(bySender?.sender, sender);
  assert.equal(bySender?.level, "off");
  assert.equal(bySender?.tier, undefined);
  const byTier = listed.find((r) => r.scope === "tier");
  assert.equal(byTier?.tier, "vip");
  assert.equal(byTier?.level, "deterministic");
  assert.ok(!Number.isNaN(Date.parse(byTier?.set_at ?? "")), "and when it was set");

  // A rule put back to full is still a rule, and is shown as one: it outranks a weaker rule for the sender's tier.
  governance.setScreening(ann.id, hex(ann.id), { sender, level: "full" });
  assert.equal((governance.screeningRules(ann.id) as Listed).rules.find((r) => r.scope === "sender")?.level, "full");
  store.close();
});

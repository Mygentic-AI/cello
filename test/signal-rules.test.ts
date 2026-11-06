// Rules that judge a call by the signals shown with it. An honest run shows a rule met, so these try the ways it could be cheated or loosened by accident:
// an issuer nobody recognises, endorsements from one operator, a rule swapped for a different one, and a more specific rule that is looser than the wider one.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signerFromSeeds } from "../src/protocol/identity.ts";
import { LocalError } from "../src/daemon/errors.ts";
import { Governance } from "../src/daemon/governance.ts";
import { type SignalRule, NO_RULE, SignalRules, atLeastAsStrict, evaluate } from "../src/daemon/signal-rules.ts";
import { Store } from "../src/daemon/store.ts";

const fill = (byte: number, length: number): Uint8Array => new Uint8Array(length).fill(byte);
const ann = await signerFromSeeds({ ed: fill(1, 32), pq: fill(2, 32) });
const bea = await signerFromSeeds({ ed: fill(3, 32), pq: fill(4, 32) });
const rule = (over: Partial<SignalRule> = {}): SignalRule => ({ ...NO_RULE, ...over });
const shown = (type: string, over: Partial<{ issuer_kind: string; counts_as_verified: boolean; same_operator: boolean }> = {}) => ({ type, issuer_kind: "issuer", counts_as_verified: true, same_operator: false, ...over });
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

test("a rule is met only by signals from issuers that count, and an unrecognised issuer's signals never satisfy it", () => {
  const needsEmail = rule({ require_types: ["email"] });
  assert.equal(evaluate(needsEmail, [shown("email")]).pass, true);
  const unknown = evaluate(needsEmail, [shown("email", { counts_as_verified: false })]);
  assert.equal(unknown.pass, false);
  assert.deepEqual(unknown.missing_types, ["email"]);
  assert.equal(unknown.not_counted_unrecognised, 1, "and the refusal can say why it looked fine");
  assert.equal(evaluate(rule({ min_count: 1 }), [shown("email", { counts_as_verified: false })]).pass, false);
  assert.equal(evaluate(rule({ require_issuer_kind: "issuer" }), [shown("email", { counts_as_verified: false })]).pass, false);
});

test("a minimum count leaves out endorsements from the agent's own operator, which one operator could make as many of as it likes", () => {
  const minTwo = rule({ min_count: 2 });
  const own = (type: string) => shown(type, { issuer_kind: "agent", same_operator: true });
  const ten = Array.from({ length: 10 }, (_, i) => own(`endorsement${i}`));
  const result = evaluate(minTwo, ten);
  assert.equal(result.pass, false);
  assert.equal(result.counted, 0);
  assert.equal(result.not_counted_same_operator, 10);
  assert.equal(evaluate(minTwo, [shown("email"), shown("github")]).pass, true);
  assert.equal(evaluate(minTwo, [shown("email"), own("endorsement")]).pass, false);
});

test("every demand in a rule has to be met, and nothing shown is no signals at all", () => {
  const all = rule({ require_types: ["email", "github"], require_issuer_kind: "agent", min_count: 3 });
  assert.equal(evaluate(all, [shown("email"), shown("github"), shown("x", { issuer_kind: "agent" })]).pass, true);
  assert.equal(evaluate(all, [shown("email"), shown("github"), shown("x")]).missing_issuer_kind, true);
  assert.deepEqual(evaluate(all, [shown("email"), shown("x", { issuer_kind: "agent" }), shown("y")]).missing_types, ["github"]);
  assert.equal(evaluate(all, []).pass, false);
  assert.equal(evaluate(NO_RULE, []).pass, true, "no rule asks nothing");
});

test("strictness is a partial order, and a different demand is not a stricter one", () => {
  const a = rule({ require_types: ["email"], min_count: 1 });
  assert.ok(atLeastAsStrict(a, a));
  assert.ok(atLeastAsStrict(rule({ require_types: ["email", "github"], min_count: 2 }), a));
  assert.ok(!atLeastAsStrict(rule({ require_types: ["email"] }), a), "a lower minimum is weaker");
  assert.ok(!atLeastAsStrict(rule({ require_types: ["github"], min_count: 1 }), a), "swapping a demand drops the old one");
  assert.ok(!atLeastAsStrict(NO_RULE, a));
  assert.ok(atLeastAsStrict(a, NO_RULE));
  assert.ok(!atLeastAsStrict(rule({ min_count: 1 }), rule({ require_issuer_kind: "issuer" })));
});

function rulesOn(): { rules: SignalRules; store: Store; id: Uint8Array } {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-v2-rules-")), "cello.db"));
  store.insertAgent(ann.id, "Ann", fill(1, 32), fill(2, 32));
  return { rules: new SignalRules(store), store, id: ann.id };
}

test("the most specific rule wins: this contact, then its tier, then the default", () => {
  const { rules, store, id } = rulesOn();
  const contact = hex(bea.id);
  rules.put(id, "inbound", "default", "", rule({ min_count: 1 }));
  rules.put(id, "inbound", "tier", "known", rule({ min_count: 2 }));
  rules.put(id, "inbound", "contact", contact, rule({ require_types: ["email"] }));
  assert.equal(rules.resolve(id, "inbound", "unknown", null).level, "default");
  assert.equal(rules.resolve(id, "inbound", "known", null).level, "tier");
  assert.equal(rules.resolve(id, "inbound", "known", contact).level, "contact");
  assert.equal(rules.resolve(id, "outbound", "known", contact).level, "none", "the other direction is its own");
  assert.deepEqual(rules.resolve(id, "outbound", "known", contact).rule, NO_RULE);
  store.close();
});

test("what counts as loosening: a lower demand, a swapped one, a looser rule for one contact, and removing the only rule", () => {
  const { rules, store, id } = rulesOn();
  const contact = hex(bea.id);
  const strict = rule({ require_types: ["email"], min_count: 2 });
  assert.equal(rules.weakens(id, "inbound", "default", "", strict, "unknown"), false, "the first rule only adds");
  rules.put(id, "inbound", "default", "", strict);
  assert.equal(rules.weakens(id, "inbound", "default", "", rule({ require_types: ["email"], min_count: 3 }), "unknown"), false, "asking for more");
  assert.equal(rules.weakens(id, "inbound", "default", "", rule({ require_types: ["email"], min_count: 1 }), "unknown"), true, "asking for less");
  assert.equal(rules.weakens(id, "inbound", "default", "", rule({ require_types: ["github"], min_count: 2 }), "unknown"), true, "swapping one demand for another");
  assert.equal(rules.weakens(id, "inbound", "default", "", null, "unknown"), true, "removing it");
  assert.equal(rules.weakens(id, "inbound", "contact", contact, rule({ min_count: 1 }), "unknown"), true, "a looser rule for one contact lets that contact through");
  assert.equal(rules.weakens(id, "inbound", "contact", contact, rule({ require_types: ["email", "github"], min_count: 2 }), "unknown"), false, "a stricter one for one contact");
  rules.put(id, "inbound", "tier", "known", strict);
  assert.equal(rules.weakens(id, "inbound", "tier", "known", null, "known"), false, "clearing a tier rule changes nothing while the default asks as much");
  assert.equal(rules.weakens(id, "inbound", "default", "", rule({ min_count: 1 }), "unknown"), true, "the unknown tier falls to the new default");
  store.close();
});

test("anyone can ask for more, and only a person can ask for less, in both directions", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cello-v2-rules-")), "cello.db"));
  store.insertAgent(ann.id, "Ann", fill(1, 32), fill(2, 32));
  const notices: string[] = [];
  const governance = new Governance(store, { notify: (_agent, text) => { notices.push(text); }, isLocalAgent: () => false });
  governance.writeDefaults(ann.id);
  const agent = hex(ann.id);
  const set = (params: Record<string, unknown>): unknown => governance.signalRuleSet(ann.id, agent, params);
  const person = { person_confirmed: true, caller: "cli" };

  assert.deepEqual((governance.signalRules(ann.id) as { rules: unknown[] }).rules, []);
  assert.equal((set({ direction: "inbound", scope: "default", require_types: "email", min_count: 2 }) as { loosened: boolean }).loosened, false, "the first rule is free");
  assert.equal((set({ direction: "inbound", scope: "default", require_types: "email,github", min_count: 2 }) as { loosened: boolean }).loosened, false, "more is free");
  const refusal = (): unknown => { try { set({ direction: "inbound", scope: "default", require_types: "email", min_count: 1 }); } catch (err: unknown) { return err; } return null; };
  const refused = refusal() as LocalError;
  assert.equal(refused.code, "person_required");
  assert.match(refused.message, /cello signal-rule-set --direction inbound --scope default --require-types email --min-count 1 --agent /, "an agent is given the command for its operator");
  assert.deepEqual(governance.rules.get(ann.id, "inbound", "default", "")?.require_types, ["email", "github"], "a refusal changed nothing");
  assert.equal(notices.length, 0);
  assert.equal((set({ direction: "inbound", scope: "default", require_types: "email", min_count: 1, ...person }) as { loosened: boolean }).loosened, true);
  assert.ok(notices.some((n) => n.includes("signal_rule.inbound.default")), "a person's loosening is told to the agent");

  // Clearing is the same judgement.
  const clear = (params: Record<string, unknown>): unknown => governance.signalRuleClear(ann.id, agent, params);
  assert.throws(() => clear({ direction: "inbound", scope: "default" }), (err: unknown) => err instanceof LocalError && err.code === "person_required");
  assert.equal((clear({ direction: "inbound", scope: "default", ...person }) as { cleared: boolean }).cleared, true);
  assert.equal((clear({ direction: "inbound", scope: "default" }) as { cleared: boolean }).cleared, false, "clearing nothing is fine");

  // Shape and bounds.
  for (const bad of [
    { direction: "sideways", scope: "default", min_count: 1 },
    { direction: "inbound", scope: "world", min_count: 1 },
    { direction: "inbound", scope: "tier", target: "blocked", min_count: 1 },
    { direction: "inbound", scope: "contact", target: "nothex", min_count: 1 },
    { direction: "inbound", scope: "default" },
    { direction: "inbound", scope: "default", min_count: 9 },
    { direction: "inbound", scope: "default", require_types: "a b" },
    { direction: "inbound", scope: "default", require_issuer_kind: "portal" },
    { direction: "inbound", scope: "default", min_count: -1 },
  ]) assert.throws(() => set(bad), (err: unknown) => err instanceof LocalError && err.code === "bad_argument", JSON.stringify(bad));
  assert.deepEqual(governance.rules.list(ann.id), [], "none of the bad ones were kept");
  store.close();
});

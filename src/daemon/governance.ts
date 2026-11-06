// What a person decides about their agent: contacts, tiers, limits, guards, policies and screening rules.
// Each change is judged here by which way it goes, whoever asked. Loosening needs a person at a terminal, and it's logged,
// and the agent gets a notice. Nothing here reaches the server.
import { toHex } from "../protocol/encode.ts";
import { Contacts, type ContactRow } from "./contacts.ts";
import { LocalError, requirePerson } from "./errors.ts";
import { Guards } from "./guards.ts";
import { logEvent } from "./log.ts";
import { PolicyCadence, admissionPolicyField, attachConductPolicy } from "./policy-cadence.ts";
import { PolicyProposals } from "./policy-proposals.ts";
import { ISSUER_KINDS, RULE_DIRECTIONS, RULE_SCOPES, type RuleDirection, type RuleScope, type SignalRule, SignalRules, isNoRule } from "./signal-rules.ts";
import { MAX_PRESENTED_SIGNALS } from "../protocol/structures.ts";
import { PolicyStore, type PolicyScope, type PolicyType, PolicyValidationError } from "./policy-store.ts";
import { CALLING_RAISES_KEY, type Direction, Reach } from "./reach.ts";
import { SettingError, changeSetting, listSettings } from "./settings.ts";
import type { Store } from "./store.ts";
import { TIER, type Tier, tierFromName, tierName } from "./tiers.ts";
import { validateMoniker } from "./who-label.ts";

export type ScreeningLevel = "full" | "deterministic" | "off";
const LEVEL_STRENGTH: Record<ScreeningLevel, number> = { full: 2, deterministic: 1, off: 0 };
// Known can be reached by an agent's own call or reply, so only tiers a person alone can set may have less screening.
const WEAKENABLE_TIERS: readonly string[] = ["whitelisted", "vip"];
const DEFAULT_LOG_LIMIT = 50;

export interface GovernanceHooks {
  notify(agentId: Uint8Array, text: string): void;
  // Whether this id is another agent on this daemon. A fact the daemon knows, and it implies no trust.
  isLocalAgent(id: Uint8Array): boolean;
}

type Params = Record<string, unknown>;

const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));

// The only reasons a refusal can carry. The caller's daemon writes the sentence, so a refuser's prose never reaches its model.
export const REFUSAL_SENTENCES = {
  not_accepting: "This agent is not accepting connections. Retrying will not change this.",
  busy: "This agent can't take another conversation from you right now.",
  session_limit: "You have reached the number of conversations this agent allows you. Close one, and try again.",
  // The same words whatever the rule, so a caller can't read the rule or the tier from the refusal. Its public signals are where to look.
  signals_required: "This agent asks for signals your call didn't show. Look up its public signals, then call again with the ones it needs.",
} as const;
export type RefusalCode = keyof typeof REFUSAL_SENTENCES;

function hexParam(params: Params, name: string): { id: Uint8Array; hex: string } {
  const value = params[name];
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) throw new LocalError("bad_argument", `${name} must be an agent_id, 64 hex characters`);
  const hex = value.toLowerCase();
  return { id: fromHex(hex), hex };
}

function optionalText(params: Params, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new LocalError("bad_argument", `${name} must be text`);
  return value;
}

export class Governance {
  readonly contacts: Contacts;
  readonly reach: Reach;
  readonly guards: Guards;
  readonly policies: PolicyStore;
  readonly rules: SignalRules;
  readonly #proposals: PolicyProposals;
  readonly #cadence = new PolicyCadence();
  readonly #store: Store;
  readonly #hooks: GovernanceHooks;

  constructor(store: Store, hooks: GovernanceHooks) {
    this.#store = store;
    this.#hooks = hooks;
    this.contacts = new Contacts(store);
    this.reach = new Reach(store);
    this.guards = new Guards(store);
    this.policies = new PolicyStore(store, this.reach);
    this.rules = new SignalRules(store);
    this.#proposals = new PolicyProposals(store, this.reach, this.policies);
  }

  // At creation, and at each start, so an agent made before a setting existed gets it too.
  writeDefaults(agentId: Uint8Array): void {
    this.reach.writeDefaults(agentId);
    this.guards.writeDefaults(agentId);
  }

  #weakened(agentId: Uint8Array, key: string, from: unknown, to: unknown, direction: Direction, params: Params, undo: string): void {
    const confirmed = params["person_confirmed"] === true;
    this.guards.record(agentId, key, from, to, direction, confirmed);
    logEvent("governance.changed", { agent: toHex(agentId), key, from, to, direction, confirmed });
    if (direction === "loosen") this.#hooks.notify(agentId, `${key} changed from ${JSON.stringify(from)} to ${JSON.stringify(to)}, by a person at this machine's terminal. If that wasn't you, run: ${undo}`);
  }

  // ---- The gate. Runs before any key material exists, and asks nobody: a call either fits what the owner set or it's refused. ----

  admit(agentId: Uint8Array, callerId: Uint8Array): { code: RefusalCode; limit?: number } | null {
    const tier = this.contacts.tierOf(agentId, callerId);
    const limits = this.reach.limitsFor(agentId, tier);
    if (limits.shut) return { code: "not_accepting" };
    const quietMs = this.reach.number(agentId, "limits.quiet_minutes") * 60_000;
    const now = Date.now();
    // A session stays open however long it's quiet, and only stops counting. Sessions this agent started aren't anyone's knock.
    const counting = this.#store.sessionsOf(agentId).filter((s) => s.role === "callee" && (s.state === "accepted" || s.state === "active") && s.peer_closed === 0 && s.own_closed === 0 && now - s.last_activity_at < quietMs);
    const fromCaller = counting.filter((s) => toHex(s.counterparty_id) === toHex(callerId)).length;
    if (fromCaller >= limits.max_sessions) return tier === TIER.UNKNOWN ? { code: "busy" } : { code: "session_limit", limit: limits.max_sessions };
    if (tier === TIER.UNKNOWN) {
      const strangers = counting.filter((s) => this.contacts.tierOf(agentId, s.counterparty_id) === TIER.UNKNOWN).length;
      if (strangers >= this.reach.number(agentId, "limits.stranger_pool")) return { code: "busy" };
    }
    return null;
  }

  // Every refusal goes on the ledger, one row per caller, so knocking a thousand times can push nobody else out. Bob hears
  // about a limit, at most once in each cooldown. A block or a shut tier is his own choice, so it just sits in the inbox.
  noteRefusal(agentId: Uint8Array, agentHex: string, callerHex: string, code: RefusalCode): void {
    const told = this.reach.addRefusal(agentId, fromHex(callerHex), code, code !== "not_accepting", this.reach.number(agentId, "limits.cap_alarm_minutes") * 60_000);
    logEvent("session.refused", { agent: agentHex, caller: callerHex, reason: code });
    if (told && code === "signals_required") this.#hooks.notify(agentId, `${callerHex} tried to start a conversation and didn't show the signals your inbound rule asks for. See the rule with: cello signal-rules --agent ${agentHex}. To let it through anyway, a person can add it as a contact: cello contact-set-tier ${callerHex} --tier whitelisted --agent ${agentHex}`);
    else if (told) this.#hooks.notify(agentId, `${callerHex} tried to start a conversation and was over a limit (${code}). To give it more room, a person runs: cello contact-set-tier ${callerHex} --tier whitelisted --agent ${agentHex}`);
  }

  knocks(agentId: Uint8Array, agentHex: string): unknown[] {
    return this.reach.refusals(agentId).map((row) => ({
      contact_id: toHex(row.contact_id),
      first_at: new Date(row.first_refused_at).toISOString(),
      last_at: new Date(row.last_refused_at).toISOString(),
      times: row.times,
      reason: row.last_reason,
      let_through: `cello contact-set-tier ${toHex(row.contact_id)} --tier known --agent ${agentHex}`,
    }));
  }

  // The ladder, most specific first: for this caller, their tier, this agent's default, then the system's. Empty sends nothing.
  awayText(agentId: Uint8Array, callerId: Uint8Array, fallbackName: string): string {
    const tier = this.contacts.tierOf(agentId, callerId);
    const own = this.contacts.get(agentId, callerId)?.away_message;
    if (own) return own;
    const forTier = this.reach.tiers(agentId).find((row) => row.tier === tierName(tier))?.away_text;
    if (forTier) return forTier;
    const byDefault = this.reach.setting(agentId, "away.default");
    if (byDefault) return byDefault;
    const system = this.reach.setting(agentId, tier === TIER.UNKNOWN ? "away.system.stranger" : "away.system.known");
    return system.replaceAll("{name}", this.offeredName(agentId, fallbackName) || "This agent");
  }

  // What this agent calls itself, sealed to whoever it talks to. Empty offers no name.
  offeredName(agentId: Uint8Array, fallback: string): string {
    return this.reach.offeredName(agentId) ?? fallback;
  }

  setOwnMoniker(agentId: Uint8Array, agentHex: string, params: Params): unknown {
    const moniker = params["clear"] === true ? "" : this.#monikerOf(params);
    if (moniker === undefined) throw new LocalError("bad_argument", "give the name, or --clear to offer none");
    this.reach.setOfferedName(agentId, moniker);
    return { agent_id: agentHex, offers_name: moniker || null };
  }

  // ---- Contacts ----

  // THE rule for when an agent's own action raises a stranger to known, and the only place it lives. It raises a stranger and
  // nothing else: it never lifts a block, and accepting a call doesn't do it. Replying counts. Calling doesn't, unless a person
  // turns on the setting, because persuading an agent to dial a lure is easy.
  engaged(agentId: Uint8Array, contactId: Uint8Array, how: "initiated" | "replied"): void {
    if (how === "initiated" && this.reach.setting(agentId, CALLING_RAISES_KEY) !== "true") return;
    if (this.contacts.tierOf(agentId, contactId) === TIER.UNKNOWN) this.contacts.put(agentId, contactId, { tier: TIER.KNOWN, provenance: how });
  }

  #contactView(agentId: Uint8Array, row: ContactRow): Record<string, unknown> {
    return {
      contact_id: toHex(row.contact_id),
      tier: tierName(row.tier),
      ...this.contacts.who(agentId, row.contact_id, toHex(row.contact_id), row.last_offered_moniker),
      moniker: row.moniker,
      away_message: row.away_message,
      provenance: row.provenance,
      added_at: new Date(row.added_at).toISOString(),
      ...(this.#hooks.isLocalAgent(row.contact_id) ? { same_daemon: true } : {}),
    };
  }

  listContacts(agentId: Uint8Array): unknown {
    return { contacts: this.contacts.list(agentId).map((row) => this.#contactView(agentId, row)) };
  }

  contactAdd(agentId: Uint8Array, agentHex: string, params: Params): unknown {
    const contact = hexParam(params, "contact");
    const moniker = this.#monikerOf(params);
    const tier = this.contacts.tierOf(agentId, contact.id);
    if (tier === TIER.BLOCKED) {
      requirePerson(params, `This would lift your block on ${contact.hex}.`, `cello contact-add ${contact.hex} --agent ${agentHex}`);
      this.#weakened(agentId, `contact.${contact.hex}.tier`, "blocked", "known", "loosen", params, `cello contact-set-tier ${contact.hex} --tier blocked --agent ${agentHex}`);
    }
    const raises = tier === TIER.BLOCKED || tier === TIER.UNKNOWN;
    this.contacts.put(agentId, contact.id, { ...(raises ? { tier: TIER.KNOWN, provenance: "added" } : {}), ...(moniker ? { moniker } : {}) });
    return this.#contactView(agentId, this.contacts.get(agentId, contact.id) as ContactRow);
  }

  #monikerOf(params: Params): string | undefined {
    const raw = optionalText(params, "moniker");
    if (raw === undefined) return undefined;
    if (validateMoniker(raw) === null) throw new LocalError("invalid_moniker", "a name is 1 to 64 letters, digits, underscores or dashes");
    return raw;
  }

  // Removing a blocked row unblocks it. Removing any other only moves it back to a stranger.
  contactRemove(agentId: Uint8Array, agentHex: string, params: Params): unknown {
    const contact = hexParam(params, "contact");
    const row = this.contacts.get(agentId, contact.id);
    if (!row) return { removed: false, contact_id: contact.hex };
    if (row.tier === TIER.BLOCKED) {
      requirePerson(params, `Removing ${contact.hex} would lift your block on it.`, `cello contact-remove ${contact.hex} --agent ${agentHex}`);
      this.#weakened(agentId, `contact.${contact.hex}.tier`, "blocked", "unknown", "loosen", params, `cello contact-set-tier ${contact.hex} --tier blocked --agent ${agentHex}`);
    }
    this.contacts.remove(agentId, contact.id);
    return { removed: true, contact_id: contact.hex };
  }

  contactSetTier(agentId: Uint8Array, agentHex: string, params: Params): unknown {
    const contact = hexParam(params, "contact");
    const to = tierFromName(params["tier"]);
    if (to === undefined) throw new LocalError("invalid_tier", "tier must be blocked, unknown, known, whitelisted or vip");
    const from = this.contacts.tierOf(agentId, contact.id);
    const direction: Direction = to > from ? "loosen" : to < from ? "tighten" : "neutral";
    if (direction === "loosen") requirePerson(params, `This raises ${contact.hex} from ${tierName(from)} to ${tierName(to)}, which gives it more room with ${agentHex}.`, `cello contact-set-tier ${contact.hex} --tier ${tierName(to)} --agent ${agentHex}`);
    this.contacts.put(agentId, contact.id, { tier: to });
    if (direction === "loosen") this.reach.forgetRefusal(agentId, contact.id);
    if (direction !== "neutral") this.#weakened(agentId, `contact.${contact.hex}.tier`, tierName(from), tierName(to), direction, params, `cello contact-set-tier ${contact.hex} --tier ${tierName(from)} --agent ${agentHex}`);
    return this.#contactView(agentId, this.contacts.get(agentId, contact.id) as ContactRow);
  }

  // ---- Signal rules: who may call this agent, and who it may call, by the signals shown with the call. ----

  signalRules(agentId: Uint8Array): unknown {
    return {
      rules: this.rules.list(agentId).map((row) => ({ direction: row.direction, scope: row.scope, target: row.target || undefined, require_types: row.require_types, require_issuer_kind: row.require_issuer_kind, min_count: row.min_count, updated_at: new Date(row.updated_at).toISOString() })),
      note: "With no rule, no signals are required. A rule counts only signals from an issuer that counts here, and never one from your own operator toward any demand (a type, a kind of issuer or a minimum). The most specific rule wins: contact, then tier, then default.",
    };
  }

  #ruleKey(params: Params): { direction: RuleDirection; scope: RuleScope; target: string } {
    const direction = params["direction"];
    const scope = params["scope"];
    if (!RULE_DIRECTIONS.includes(direction as RuleDirection)) throw new LocalError("bad_argument", "direction must be inbound (who calls you) or outbound (who you call).");
    if (!RULE_SCOPES.includes(scope as RuleScope)) throw new LocalError("bad_argument", "scope must be default, tier or contact.");
    try {
      return { direction: direction as RuleDirection, scope: scope as RuleScope, target: SignalRules.checkTarget(scope as RuleScope, optionalText(params, "target")) };
    } catch (err: unknown) {
      throw new LocalError("bad_argument", err instanceof Error ? err.message : String(err));
    }
  }

  #ruleFrom(params: Params): SignalRule {
    const rawTypes = optionalText(params, "require_types");
    const types = rawTypes === undefined || rawTypes.trim() === "" ? [] : rawTypes.split(",").map((t) => t.trim());
    for (const type of types) if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(type)) throw new LocalError("bad_argument", `${JSON.stringify(type)} isn't a signal type: letters, digits and _ . : - up to 64.`);
    const kind = params["require_issuer_kind"];
    if (kind !== undefined && !(ISSUER_KINDS as readonly unknown[]).includes(kind)) throw new LocalError("bad_argument", "require_issuer_kind must be issuer or agent.");
    const min = params["min_count"];
    if (min !== undefined && (typeof min !== "number" || !Number.isInteger(min) || min < 0)) throw new LocalError("bad_argument", "min_count must be a whole number, 0 or more.");
    const rule: SignalRule = { require_types: [...new Set(types)], require_issuer_kind: (kind as SignalRule["require_issuer_kind"] | undefined) ?? null, min_count: (min as number | undefined) ?? 0 };
    if (isNoRule(rule)) throw new LocalError("bad_argument", "A rule needs something in it: require_types, require_issuer_kind or min_count. To remove a rule, use signal-rule-clear.");
    // A call carries at most this many signals, so a rule asking for more could never be met and would refuse everyone.
    if (rule.min_count > MAX_PRESENTED_SIGNALS || rule.require_types.length > MAX_PRESENTED_SIGNALS) throw new LocalError("bad_argument", `A call carries at most ${MAX_PRESENTED_SIGNALS} signals, so a rule can't ask for more than that.`);
    return rule;
  }

  // The command that puts this rule in force, or removes the rule when there is none. What a refusal tells an agent to relay, and what an undo runs.
  #ruleCommand(direction: RuleDirection, scope: RuleScope, target: string, rule: SignalRule | null, agentHex: string): string {
    const where = `--direction ${direction} --scope ${scope}${target ? ` --target ${target}` : ""}`;
    if (rule === null) return `cello signal-rule-clear ${where} --agent ${agentHex}`;
    const parts = [rule.require_types.length ? `--require-types ${rule.require_types.join(",")}` : "", rule.require_issuer_kind ? `--require-issuer-kind ${rule.require_issuer_kind}` : "", rule.min_count ? `--min-count ${rule.min_count}` : ""].filter(Boolean);
    return `cello signal-rule-set ${where} ${parts.join(" ")} --agent ${agentHex}`;
  }

  // The rule in words a person can read in a prompt or a notice, from its three demands and nothing else. A stored row is trimmed to a bare rule first.
  #describeRule(rule: SignalRule | null): string {
    if (rule === null || isNoRule(rule)) return "no rule";
    const demands = [
      rule.require_types.length ? `the types ${rule.require_types.join(", ")}` : "",
      rule.require_issuer_kind ? `a signal from an issuer of kind ${rule.require_issuer_kind}` : "",
      rule.min_count ? `at least ${rule.min_count} signal${rule.min_count === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    return `a rule asking for ${demands.join(", ")}`;
  }

  #bare(row: SignalRule | undefined): SignalRule | null {
    return row ? { require_types: [...row.require_types], require_issuer_kind: row.require_issuer_kind, min_count: row.min_count } : null;
  }

  // Asking for more is free, anyone may. Asking for less, or swapping one demand for another, lets a caller through who is stopped now, so it needs a person.
  signalRuleSet(agentId: Uint8Array, agentHex: string, params: Params): unknown {
    const { direction, scope, target } = this.#ruleKey(params);
    const next = this.#ruleFrom(params);
    const contactTier = scope === "contact" ? tierName(this.contacts.tierOf(agentId, fromHex(target))) : "unknown";
    const before = this.#bare(this.rules.get(agentId, direction, scope, target));
    const weakens = this.rules.weakens(agentId, direction, scope, target, next, contactTier as never);
    const label = `${direction} ${scope}${target ? ` ${target}` : ""}`;
    const undo = this.#ruleCommand(direction, scope, target, before, agentHex);
    if (weakens) requirePerson(params, `This loosens the ${label} signal rule for ${agentHex}, from ${this.#describeRule(before)} to ${this.#describeRule(next)}, so a call is let through that is stopped now.`, this.#ruleCommand(direction, scope, target, next, agentHex));
    this.rules.put(agentId, direction, scope, target, next);
    this.#weakened(agentId, `signal_rule.${direction}.${scope}${target ? `.${target}` : ""}`, this.#describeRule(before), this.#describeRule(next), weakens ? "loosen" : "tighten", params, undo);
    return { direction, scope, target: target || undefined, ...next, loosened: weakens };
  }

  signalRuleClear(agentId: Uint8Array, agentHex: string, params: Params): unknown {
    const { direction, scope, target } = this.#ruleKey(params);
    const before = this.#bare(this.rules.get(agentId, direction, scope, target));
    if (before === null) return { direction, scope, target: target || undefined, cleared: false };
    const contactTier = scope === "contact" ? tierName(this.contacts.tierOf(agentId, fromHex(target))) : "unknown";
    const weakens = this.rules.weakens(agentId, direction, scope, target, null, contactTier as never);
    const redo = this.#ruleCommand(direction, scope, target, before, agentHex);
    if (weakens) requirePerson(params, `Removing the ${direction} ${scope}${target ? ` ${target}` : ""} signal rule for ${agentHex} lets through calls it stops now.`, this.#ruleCommand(direction, scope, target, null, agentHex));
    this.rules.clear(agentId, direction, scope, target);
    this.#weakened(agentId, `signal_rule.${direction}.${scope}${target ? `.${target}` : ""}`, this.#describeRule(before), "no rule", weakens ? "loosen" : "tighten", params, redo);
    return { direction, scope, target: target || undefined, cleared: true, loosened: weakens };
  }

  contactSetAway(agentId: Uint8Array, params: Params): unknown {
    const contact = hexParam(params, "contact");
    const raw = optionalText(params, "text");
    const text = raw === undefined || raw.trim() === "" ? null : raw;
    const max = this.reach.number(agentId, "away.max_chars");
    if (text && text.length > max) throw new LocalError("invalid_message", `an away message must be ${max} characters or fewer`);
    this.contacts.put(agentId, contact.id, { away_message: text });
    return this.#contactView(agentId, this.contacts.get(agentId, contact.id) as ContactRow);
  }

  contactSetMoniker(agentId: Uint8Array, params: Params): unknown {
    const contact = hexParam(params, "contact");
    this.contacts.put(agentId, contact.id, { moniker: this.#monikerOf(params) ?? null });
    return this.#contactView(agentId, this.contacts.get(agentId, contact.id) as ContactRow);
  }

  // ---- Settings ----

  listSettings(agentId: Uint8Array | undefined): unknown {
    return { settings: listSettings(this.#store), ...(agentId ? { tiers: this.reach.tiers(agentId), agent_settings: this.reach.settings(agentId) } : {}) };
  }

  settingsSet(agentId: Uint8Array | undefined, agentHex: string | undefined, params: Params): unknown {
    const name = optionalText(params, "name");
    if (!name) throw new LocalError("bad_argument", "name the setting to change");
    const value = optionalText(params, "value");
    const clear = params["clear"] === true;
    if (clear === (value !== undefined)) throw new LocalError("bad_argument", "give a value, or --clear to go back to the default, and not both");
    const agentFlag = agentHex ? ` --agent ${agentHex}` : "";
    const command = `cello settings-set ${name} ${clear ? "--clear" : JSON.stringify(value)}${agentFlag}`;
    const isAgentKey = ["bounds.", "away.", "limits.", "policy.", "contacts.", "calling."].some((prefix) => name.startsWith(prefix));
    if (!isAgentKey) {
      if (clear) throw new LocalError("bad_argument", "a daemon setting has no --clear: set the value you want");
      // Tuning, not a guard, so any shell of the owner's can do it. It just isn't an agent's tool.
      if (params["caller"] !== "cli") throw new LocalError("person_required", `A daemon setting is changed from the owner's own shell. Nothing changed. Relay this to your operator: ${command}`);
      try {
        changeSetting(this.#store, name, value as string);
      } catch (err: unknown) {
        if (err instanceof SettingError) throw new LocalError("bad_setting", err.message);
        throw err;
      }
      logEvent("settings.changed", { name, value });
      return { settings: listSettings(this.#store), note: "This takes effect at the next login." };
    }
    if (!agentId || !agentHex) throw new LocalError("bad_argument", `${name} belongs to one agent, so name it with --agent`);
    const change = this.reach.plan(agentId, name, clear ? null : value as string);
    if (change.direction === "loosen") requirePerson(params, `This changes ${name} from ${change.from} to ${change.to} for ${agentHex}, which loosens it.`, command);
    change.apply();
    if (change.direction !== "neutral") this.#weakened(agentId, name, change.from, change.to, change.direction, params, `cello settings-set ${name} ${JSON.stringify(change.from)} --agent ${agentHex}`);
    return { name, value: change.to, was: change.from };
  }

  // ---- Guards ----

  listGuards(agentId: Uint8Array, key: string | undefined): unknown {
    const guards = this.guards.list(agentId) as { key: string }[];
    if (key === undefined) return { guards };
    const found = guards.find((guard) => guard.key === key);
    if (!found) throw new LocalError("unknown_guard", `there's no guard named ${key}`);
    return found;
  }

  guardSet(agentId: Uint8Array, agentHex: string, params: Params): unknown {
    const key = optionalText(params, "key") as string;
    const raw = optionalText(params, "value") ?? "";
    const plan = this.guards.plan(agentId, key, raw);
    const command = `cello config-set ${key} ${JSON.stringify(raw)} --agent ${agentHex}`;
    if (plan.direction === "loosen") requirePerson(params, `This loosens the guard ${key}, to ${JSON.stringify(plan.value)}, for ${agentHex}.`, command);
    this.guards.apply(agentId, plan, params["person_confirmed"] === true);
    logEvent("guard.changed", { agent: agentHex, key, direction: plan.direction, confirmed: params["person_confirmed"] === true });
    if (plan.direction === "loosen") this.#hooks.notify(agentId, `The guard ${key} changed to ${JSON.stringify(plan.value)}, by a person at this machine's terminal. If that wasn't you, a person can change it back with config-set.`);
    return { key, value: plan.value, was: plan.was, direction: plan.direction };
  }

  // What the guards did: messages stopped or flagged, callers refused, and every change, newest first.
  screeningLog(agentId: Uint8Array, limit: number | undefined): unknown {
    const count = limit === undefined ? DEFAULT_LOG_LIMIT : limit;
    if (!Number.isInteger(count) || count < 1) throw new LocalError("bad_argument", "limit must be a whole number from 1 up");
    const screened = this.#store.prepare("SELECT e.session_id, e.position, e.verdict, e.verdict_detail, s.counterparty_id FROM entries e JOIN sessions s ON s.agent_id = e.agent_id AND s.session_id = e.session_id WHERE e.agent_id = ? AND e.own = 0 AND e.verdict IN ('flagged', 'blocked') ORDER BY e.id DESC LIMIT ?").all(agentId, count) as { session_id: Uint8Array; position: number; verdict: string; verdict_detail: string; counterparty_id: Uint8Array }[];
    return {
      screened: screened.map((row) => {
        const detail = JSON.parse(row.verdict_detail) as { findings: { what: string }[]; reason: string | null };
        return { session_id: toHex(row.session_id), position: row.position, from_id: toHex(row.counterparty_id), verdict: row.verdict, findings: detail.findings.map((f) => f.what), reason: detail.reason };
      }),
      refused_callers: this.reach.refusals(agentId).map((row) => ({ contact_id: toHex(row.contact_id), first_at: new Date(row.first_refused_at).toISOString(), last_at: new Date(row.last_refused_at).toISOString(), times: row.times, last_reason: row.last_reason })),
      changes: this.guards.changes(agentId, count).map((row) => ({ key: row.key, from: row.from_json === null ? null : JSON.parse(row.from_json) as unknown, to: JSON.parse(row.to_json) as unknown, direction: row.direction, by_a_person: row.confirmed === 1, at: new Date(row.at).toISOString() })),
    };
  }

  // ---- Screening rules. One sender's rule outranks its tier's, which outranks the default of full. ----

  screeningRule(agentId: Uint8Array, senderHex: string): { level: ScreeningLevel; from: "agent_rule" | "tier_rule" | "default" } {
    const own = this.#store.screeningRule(agentId, "sender", senderHex) as ScreeningLevel | undefined;
    if (own) return { level: own, from: "agent_rule" };
    const tier = tierName(this.contacts.tierOf(agentId, fromHex(senderHex)));
    const byTier = this.#store.screeningRule(agentId, "tier", tier) as ScreeningLevel | undefined;
    return byTier ? { level: byTier, from: "tier_rule" } : { level: "full", from: "default" };
  }

  setScreening(agentId: Uint8Array, agentHex: string, params: Params): unknown {
    const level = params["level"] as ScreeningLevel;
    if (!(level in LEVEL_STRENGTH)) throw new LocalError("bad_argument", "level must be full, deterministic or off");
    const tier = optionalText(params, "tier");
    if ((params["sender"] === undefined) === (tier === undefined)) throw new LocalError("bad_argument", "name one sender, or one tier with --tier");
    if (tier !== undefined) return this.#setTierScreening(agentId, agentHex, tier, level, params);
    const sender = hexParam(params, "sender");
    const before = this.screeningRule(agentId, sender.hex).level;
    if (LEVEL_STRENGTH[level] < LEVEL_STRENGTH[before]) {
      requirePerson(params, `This weakens screening of everything ${sender.hex} sends to ${agentHex}, to level ${level}.\nAn agent you control can still forward something hostile it picked up elsewhere.`, `cello screening ${sender.hex} --level ${level} --agent ${agentHex}`);
    }
    return this.#applyScreening(agentId, agentHex, "sender", sender.hex, before, level, params, { sender: sender.hex });
  }

  #setTierScreening(agentId: Uint8Array, agentHex: string, tier: string, level: ScreeningLevel, params: Params): unknown {
    const rule = this.#store.screeningRule(agentId, "tier", tier) as ScreeningLevel | undefined;
    const before = rule ?? "full";
    if (tierFromName(tier) === undefined) throw new LocalError("invalid_tier", "tier must be whitelisted or vip");
    if (level !== "full" && !WEAKENABLE_TIERS.includes(tier)) throw new LocalError("tier_not_weakenable", `Screening can't be weakened for the whole ${tier} tier, by anyone: an agent's own call or reply can put a stranger in known. It can be weakened for whitelisted or vip, or for one named agent.`);
    if (LEVEL_STRENGTH[level] < LEVEL_STRENGTH[before]) {
      requirePerson(params, `This weakens screening of everything sent to ${agentHex} by anyone in the ${tier} tier, to level ${level}.\nEven a trusted agent can be compromised, and can forward something hostile it picked up elsewhere.`, `cello screening --tier ${tier} --level ${level} --agent ${agentHex}`);
    }
    return this.#applyScreening(agentId, agentHex, "tier", tier, before, level, params, { tier });
  }

  #applyScreening(agentId: Uint8Array, agentHex: string, scope: "sender" | "tier", subject: string, before: ScreeningLevel, level: ScreeningLevel, params: Params, named: Record<string, string>): unknown {
    this.#store.setScreeningRule(agentId, scope, subject, level);
    const direction: Direction = LEVEL_STRENGTH[level] < LEVEL_STRENGTH[before] ? "loosen" : LEVEL_STRENGTH[level] > LEVEL_STRENGTH[before] ? "tighten" : "neutral";
    this.guards.record(agentId, `screening.${subject}`, before, level, direction, params["person_confirmed"] === true);
    logEvent("screening.rule_changed", { agent: agentHex, scope, subject, from: before, to: level });
    const flags = scope === "tier" ? `--tier ${subject}` : subject;
    const whose = scope === "tier" ? `the ${subject} tier` : subject;
    this.#hooks.notify(agentId, `The screening rule for messages from ${whose} changed from ${before} to ${level}, by a person at this machine's terminal. If that wasn't you, run: cello screening ${flags} --level full --agent ${agentHex}`);
    return { agent_id: agentHex, ...named, level, was: before };
  }

  // ---- Policies ----

  #policy<T>(work: () => T): T {
    try {
      return work();
    } catch (err: unknown) {
      if (err instanceof PolicyValidationError) throw new LocalError(err.reason, err.message);
      throw err;
    }
  }

  policyList(agentId: Uint8Array): unknown {
    return { policies: this.policies.list(agentId) };
  }

  policyPending(agentId: Uint8Array): unknown {
    return { pending: this.#proposals.pending(agentId) };
  }

  // Changes nothing: a person approves it, or it's dropped when its time runs out.
  policyPropose(agentId: Uint8Array, agentHex: string, params: Params): unknown {
    const scope = params["scope"] as PolicyScope;
    const type = params["type"] as PolicyType;
    const target = optionalText(params, "target") ?? "";
    const text = optionalText(params, "text");
    const none = params["none"] === true;
    const clear = params["clear"] === true;
    if ([text !== undefined, none, clear].filter(Boolean).length !== 1) throw new LocalError("bad_argument", "give the policy's text, or --none to send nothing, or --clear to remove it");
    const everyN = params["every_n"] as number | undefined;
    const proposal = this.#policy(() => this.#proposals.propose(agentId, {
      scope,
      target: scope === "contact" ? target.toLowerCase() : target,
      type,
      action: clear ? "clear" : "set",
      ...(clear ? {} : { value: none ? { mode: "none" as const } : { mode: "text" as const, text: text as string } }),
      ...(everyN === undefined ? {} : { everyN }),
    }, params["caller"] === "cli" ? "operator" : "agent"));
    return { ...proposal, in_force: false, next: `Nothing has changed. A person approves it at a terminal: cello policy-approve ${proposal.proposal_id} --agent ${agentHex}` };
  }

  policyApprove(agentId: Uint8Array, agentHex: string, params: Params): unknown {
    const proposalId = optionalText(params, "proposal_id") as string;
    const pending = this.#proposals.pending(agentId).find((p) => p.proposal_id === proposalId);
    if (!pending) throw new LocalError("proposal_not_found", `no pending proposal ${proposalId}. They last ${this.reach.setting(agentId, "policy.proposal_hours")} hours: see policy-pending.`);
    if (params["decline"] === true) {
      this.#proposals.decline(agentId, proposalId);
      return { declined: true, proposal_id: proposalId };
    }
    const was = pending.was ? (pending.was.mode === "none" ? "NONE" : pending.was.text) : "nothing";
    const now = pending.action === "clear" ? "nothing" : pending.mode === "none" ? "NONE" : pending.text;
    requirePerson(params, `This puts in force the ${pending.type} policy at ${pending.scope}${pending.target ? ` ${pending.target}` : ""}, proposed by ${pending.proposed_by}.\nIt was: ${was as string}\nIt becomes: ${now as string}`, `cello policy-approve ${proposalId} --agent ${agentHex}`);
    const result = this.#proposals.approve(agentId, proposalId);
    if (!result.ok) throw new LocalError(result.reason, `no pending proposal ${proposalId}`);
    this.guards.record(agentId, `policy.${pending.type}.${pending.scope}${pending.target ? `.${pending.target}` : ""}`, was, now, "neutral", true);
    return { approved: true, proposal_id: proposalId, in_force: this.policies.list(agentId) };
  }

  admissionFor(agentId: Uint8Array, peerHex: string, tier: Tier): Record<string, unknown> {
    return admissionPolicyField({ store: this.policies, agentId, peerHex, tierName: tierName(tier) });
  }

  conductFor(agentId: Uint8Array, sessionHex: string, peerHex: string, tier: Tier, count: number): Record<string, unknown> {
    return attachConductPolicy({ store: this.policies, cadence: this.#cadence, agentId, sessionHex, peerHex, tierName: tierName(tier), count });
  }
}

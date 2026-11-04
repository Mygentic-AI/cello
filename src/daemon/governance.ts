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
      requirePerson(params, `This would lift your block on ${contact.hex}.`, `cello-v2 contact-add ${contact.hex} --agent ${agentHex}`);
      this.#weakened(agentId, `contact.${contact.hex}.tier`, "blocked", "known", "loosen", params, `cello-v2 contact-set-tier ${contact.hex} --tier blocked --agent ${agentHex}`);
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
      requirePerson(params, `Removing ${contact.hex} would lift your block on it.`, `cello-v2 contact-remove ${contact.hex} --agent ${agentHex}`);
      this.#weakened(agentId, `contact.${contact.hex}.tier`, "blocked", "unknown", "loosen", params, `cello-v2 contact-set-tier ${contact.hex} --tier blocked --agent ${agentHex}`);
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
    if (direction === "loosen") requirePerson(params, `This raises ${contact.hex} from ${tierName(from)} to ${tierName(to)}, which gives it more room with ${agentHex}.`, `cello-v2 contact-set-tier ${contact.hex} --tier ${tierName(to)} --agent ${agentHex}`);
    this.contacts.put(agentId, contact.id, { tier: to });
    if (direction !== "neutral") this.#weakened(agentId, `contact.${contact.hex}.tier`, tierName(from), tierName(to), direction, params, `cello-v2 contact-set-tier ${contact.hex} --tier ${tierName(from)} --agent ${agentHex}`);
    return this.#contactView(agentId, this.contacts.get(agentId, contact.id) as ContactRow);
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
    const command = `cello-v2 settings-set ${name} ${clear ? "--clear" : JSON.stringify(value)}${agentFlag}`;
    const isAgentKey = ["bounds.", "away.", "limits.", "policy.", "contacts."].some((prefix) => name.startsWith(prefix));
    if (!isAgentKey) {
      if (clear) throw new LocalError("bad_argument", "a daemon setting has no --clear: set the value you want");
      requirePerson(params, `This changes the daemon's own setting ${name} to ${value as string}.`, command);
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
    if (change.direction !== "neutral") this.#weakened(agentId, name, change.from, change.to, change.direction, params, `cello-v2 settings-set ${name} ${JSON.stringify(change.from)} --agent ${agentHex}`);
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
    const command = `cello-v2 config-set ${key} ${JSON.stringify(raw)} --agent ${agentHex}`;
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
      requirePerson(params, `This weakens screening of everything ${sender.hex} sends to ${agentHex}, to level ${level}.\nAn agent you control can still forward something hostile it picked up elsewhere.`, `cello-v2 screening ${sender.hex} --level ${level} --agent ${agentHex}`);
    }
    return this.#applyScreening(agentId, agentHex, "sender", sender.hex, before, level, params, { sender: sender.hex });
  }

  #setTierScreening(agentId: Uint8Array, agentHex: string, tier: string, level: ScreeningLevel, params: Params): unknown {
    const rule = this.#store.screeningRule(agentId, "tier", tier) as ScreeningLevel | undefined;
    const before = rule ?? "full";
    if (tierFromName(tier) === undefined) throw new LocalError("invalid_tier", "tier must be whitelisted or vip");
    if (level !== "full" && !WEAKENABLE_TIERS.includes(tier)) throw new LocalError("tier_not_weakenable", `Screening can't be weakened for the whole ${tier} tier, by anyone: an agent's own call or reply can put a stranger in known. It can be weakened for whitelisted or vip, or for one named agent.`);
    if (LEVEL_STRENGTH[level] < LEVEL_STRENGTH[before]) {
      requirePerson(params, `This weakens screening of everything sent to ${agentHex} by anyone in the ${tier} tier, to level ${level}.\nEven a trusted agent can be compromised, and can forward something hostile it picked up elsewhere.`, `cello-v2 screening --tier ${tier} --level ${level} --agent ${agentHex}`);
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
    this.#hooks.notify(agentId, `The screening rule for messages from ${whose} changed from ${before} to ${level}, by a person at this machine's terminal. If that wasn't you, run: cello-v2 screening ${flags} --level full --agent ${agentHex}`);
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
    return { ...proposal, in_force: false, next: `Nothing has changed. A person approves it at a terminal: cello-v2 policy-approve ${proposal.proposal_id} --agent ${agentHex}` };
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
    requirePerson(params, `This puts in force the ${pending.type} policy at ${pending.scope}${pending.target ? ` ${pending.target}` : ""}, proposed by ${pending.proposed_by}.\nIt was: ${was as string}\nIt becomes: ${now as string}`, `cello-v2 policy-approve ${proposalId} --agent ${agentHex}`);
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

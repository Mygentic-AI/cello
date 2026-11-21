// Every call to an issuer, and nothing else. It matches the issuer's signed-request format and its /api/issuer routes.
// The request's format and framing are copied from there by script: its signing label isn't in the protocol's list.
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCbor } from "../protocol/cbor.ts";
import type { DualSignature, IdentitySeeds, PublicIdentity } from "../protocol/identity.ts";
import { mlDsaProviderFromSeed } from "../protocol/ml-dsa.ts";

// A protocol signing label, not a name: the issuer verifies every request against this exact text. It must never change.
export const AGENT_REQUEST_DOMAIN = "cello-issuer-request-v1";
export const AGENT_REQUEST_CONTEXT = "cello-issuer-request";
export const MAX_REQUEST_LIFETIME_SECONDS = 300;
const NONCE_BYTES = 16;

export type AgentRequestAction = "redeem" | "collect" | "add_agent" | "endorse" | "withdraw" | "refuse" | "request_usage" | "enroll_start" | "enroll_verify" | "invite_make" | "invite_use";

export interface AgentRequestFields {
  action: AgentRequestAction;
  issuerAddress: string;
  agent: PublicIdentity;
  nonce: Uint8Array;
  issuedAt: number;
  expiresAt: number;
  // Redeem: the code. Endorse: the statement.
  code: string | null;
  // Endorse: the subject's key. Withdraw and refuse: the signal's hash.
  target: string | null;
  // Add-agent only: the agent already enrolled, and an account-level signal it holds.
  holder: PublicIdentity | null;
  holderSignal: Uint8Array | null;
}

export function encodeAgentRequest(f: AgentRequestFields): Uint8Array {
  return new Uint8Array(encodeCbor([
    AGENT_REQUEST_DOMAIN, f.action, f.issuerAddress, f.agent.ed, f.agent.pq, f.nonce, f.issuedAt, f.expiresAt,
    f.code, f.target, f.holder ? new Uint8Array([...f.holder.ed, ...f.holder.pq]) : null, f.holderSignal,
  ]));
}

export function framedAgentRequest(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const label = new TextEncoder().encode(AGENT_REQUEST_CONTEXT);
  const framed = new Uint8Array(label.length + 1 + bytes.length);
  framed.set(label, 0);
  framed.set(bytes, label.length + 1);
  return framed;
}

const b64 = (v: Uint8Array): string => Buffer.from(v).toString("base64");

export interface AgentRequestOnWire {
  request: string;
  signature: { ed: string; pq: string };
  holderSignature?: { ed: string; pq: string };
}

export function agentRequestToWire(bytes: Uint8Array, signature: DualSignature, holderSignature?: DualSignature): AgentRequestOnWire {
  return {
    request: b64(bytes),
    signature: { ed: b64(signature.ed), pq: b64(signature.pq) },
    ...(holderSignature ? { holderSignature: { ed: b64(holderSignature.ed), pq: b64(holderSignature.pq) } } : {}),
  };
}

// Long enough for the issuer's own call to the waitlist, and short enough that a person isn't left waiting on nothing.
const ISSUER_WAIT_MS = 30_000;
// A newer list is optional, so a slow issuer costs a person only this long.
const LIST_WAIT_MS = 5_000;
const MAX_ANSWER_BYTES = 8_000_000;
const REQUEST_LIFETIME_SECONDS = 120;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

// A plain refusal the issuer gave, with its reason and its own words.
export class IssuerRefused extends Error {
  readonly reason: string;
  constructor(reason: string, guidance: string) {
    super(guidance);
    this.reason = reason;
  }
}

// Nobody answered, or what came back isn't an issuer's answer. What happened there isn't known.
export class IssuerUnreachable extends Error {}

export class BadIssuerUrl extends Error {}

// A code travels in this request, so plain HTTP is for a test on this machine only.
export function parseIssuerUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadIssuerUrl(`${raw} isn't an address`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new BadIssuerUrl(`an issuer's address must start with https://, and ${raw} doesn't`);
  return url;
}

export interface AgentKeys {
  identity: PublicIdentity;
  seeds: IdentitySeeds;
}

export interface IssuerAnswer {
  signals: Uint8Array[];
}

async function signRequest(seeds: IdentitySeeds, bytes: Uint8Array): Promise<DualSignature> {
  const framed = framedAgentRequest(bytes);
  const pq = await mlDsaProviderFromSeed(seeds.pq);
  return { ed: ed25519.sign(framed, seeds.ed), pq: await pq.sign(framed) };
}

export class IssuerClient {
  readonly #base: URL;
  readonly #fetch: typeof fetch;

  constructor(issuerUrl: string, fetcher: typeof fetch = fetch) {
    this.#base = parseIssuerUrl(issuerUrl);
    this.#fetch = fetcher;
  }

  // The name a request and a signal both carry for this issuer.
  get address(): string {
    return this.#base.hostname;
  }

  redeem(agent: AgentKeys, code: string): Promise<IssuerAnswer> {
    return this.#send("redeem", "redeem", agent, { code, target: null, holder: null, holderSignal: null });
  }

  // Email signup, step one: the issuer mails a code that only this agent's key can spend. The answer carries no signals,
  // and is the same whether or not the issuer knows the address.
  async enrollStart(agent: AgentKeys, email: string): Promise<void> {
    await this.#send("enroll/start", "enroll_start", agent, { code: email, target: null, holder: null, holderSignal: null }, undefined, {}, false);
  }

  // Step two: the emailed code, from the same key. The answer is the agent's signals.
  enrollVerify(agent: AgentKeys, code: string): Promise<IssuerAnswer> {
    return this.#send("enroll/verify", "enroll_verify", agent, { code, target: null, holder: null, holderSignal: null });
  }

  collect(agent: AgentKeys): Promise<IssuerAnswer> {
    return this.#send("collect", "collect", agent, { code: null, target: null, holder: null, holderSignal: null });
  }

  // A new agent on a daemon that already has one: the holder signs too, and hands over an account-level signal it holds.
  addAgent(agent: AgentKeys, holder: AgentKeys, holderSignal: Uint8Array): Promise<IssuerAnswer> {
    return this.#send("agents", "add_agent", agent, { code: null, target: null, holder: holder.identity, holderSignal }, holder.seeds);
  }

  // The server's signed count travels beside the signed request, not inside it: it carries the server's own signature and names
  // its agent, and the request proves the agent is the one asking. The issuer answers with the agent's signals, Usage among them.
  requestUsage(agent: AgentKeys, usageFacts: unknown, usageServer: unknown): Promise<IssuerAnswer> {
    return this.#send("usage", "request_usage", agent, { code: null, target: null, holder: null, holderSignal: null }, undefined, { usageFacts, usageServer });
  }

  // This agent's invite code: a short alias the issuer keeps for it, which anyone can use to add it as a contact. The agent's own
  // name rides beside the request, kept with the code and always shown as self-declared. `replace` makes a new code.
  async inviteMake(agent: AgentKeys, name: string, replace: boolean): Promise<{ code: string; link: string }> {
    const answer = await this.#ask("invites", "invite_make", agent, { code: null, target: null, holder: null, holderSignal: null }, undefined, { name, replace });
    if (typeof answer["code"] !== "string" || typeof answer["link"] !== "string") throw new IssuerUnreachable(`${this.#base.origin} answered without an invite code`);
    return { code: answer["code"], link: answer["link"] };
  }

  // Stops this agent's invite code, with no new one. Answers whether there was one.
  async inviteRevoke(agent: AgentKeys): Promise<boolean> {
    const answer = await this.#ask("invites", "invite_make", agent, { code: null, target: null, holder: null, holderSignal: null }, undefined, { revoke: true });
    return answer["revoked"] === true;
  }

  // Using someone's invite code: the issuer records it (the inviter is told once) and answers with the inviting agent, which the
  // caller adds as a contact. The code goes inside the signed request.
  // `before` runs once the public lookup has named the inviting agent, and before the signed use, which the issuer records and
  // tells the inviter about. It may refuse (a blocked inviter), and then nothing is recorded anywhere.
  async inviteUse(agent: AgentKeys, code: string, name: string, before: (inviterHex: string) => void = () => undefined): Promise<{ agentId: string; address: string; name: string }> {
    const looked = await this.#lookupInvite(code);
    before(looked);
    const answer = await this.#ask("invites/use", "invite_use", agent, { code, target: null, holder: null, holderSignal: null }, undefined, { name });
    const id = answer["agent_id"], address = answer["address"], inviter = answer["name"];
    if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id) || typeof address !== "string" || typeof inviter !== "string") throw new IssuerUnreachable(`${this.#base.origin} answered without the inviting agent`);
    if (id !== looked) throw new IssuerUnreachable(`${this.#base.origin} named a different agent for that code than its lookup did`);
    // The address is dialled for the hello, so it must name the same agent the contact is added for: an issuer can't point the
    // hello, and the signals that go with it, at anyone else.
    if (address.slice(0, address.includes("@") ? address.indexOf("@") : address.length).toLowerCase() !== id) throw new IssuerUnreachable(`${this.#base.origin} answered with an address for a different agent than the one it named`);
    // A self-declared name is shown on a terminal: no control characters, and no longer than a name can be.
    return { agentId: id, address, name: inviter.replace(/\p{Cc}/gu, " ").slice(0, 64) };
  }

  // The public lookup: the agent a code stands for. A code it doesn't know or that has run out is the issuer's refusal.
  async #lookupInvite(code: string): Promise<string> {
    let status: number;
    let text: string;
    try {
      const response = await this.#fetch(new URL(`/api/invites/${encodeURIComponent(code.toUpperCase().replace(/[\s-]+/g, ""))}`, this.#base), { redirect: "error", signal: AbortSignal.timeout(ISSUER_WAIT_MS) });
      status = response.status;
      text = await response.text();
    } catch (err: unknown) {
      throw new IssuerUnreachable(`nothing answered at ${this.#base.origin}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let answer: { ok?: unknown; agent_id?: unknown; reason?: unknown; guidance?: unknown };
    try {
      answer = JSON.parse(text) as typeof answer;
    } catch {
      throw new IssuerUnreachable(`${this.#base.origin} answered the invite lookup with status ${status}, and not as an issuer would (it may not offer invites yet)`);
    }
    if (answer.ok === true && typeof answer.agent_id === "string" && /^[0-9a-f]{64}$/.test(answer.agent_id)) return answer.agent_id;
    if (typeof answer.reason === "string") throw new IssuerRefused(answer.reason, typeof answer.guidance === "string" ? answer.guidance : answer.reason);
    throw new IssuerUnreachable(`${this.#base.origin} answered the invite lookup without the inviting agent`);
  }

  // Null when this issuer serves none. A list proves itself by its root signatures, so who hands it over doesn't matter.
  async latestIssuerList(): Promise<Uint8Array | null> {
    try {
      const response = await this.#fetch(new URL("/api/issuer/list", this.#base), { redirect: "error", signal: AbortSignal.timeout(LIST_WAIT_MS) });
      if (!response.ok) return null;
      const answer = JSON.parse(await response.text()) as { list?: unknown };
      return typeof answer.list === "string" ? new Uint8Array(Buffer.from(answer.list, "base64")) : null;
    } catch {
      return null;
    }
  }

  async #send(route: string, action: AgentRequestAction, agent: AgentKeys, extra: Pick<AgentRequestFields, "code" | "target" | "holder" | "holderSignal">, holderSeeds?: IdentitySeeds, beside: Record<string, unknown> = {}, withSignals = true): Promise<IssuerAnswer> {
    const answer = await this.#ask(route, action, agent, extra, holderSeeds, beside);
    if (!withSignals) return { signals: [] };
    if (!Array.isArray(answer["signals"]) || !(answer["signals"] as unknown[]).every((s) => typeof s === "string")) throw new IssuerUnreachable(`${this.#base.origin} answered without a list of signals`);
    return { signals: (answer["signals"] as string[]).map((s) => new Uint8Array(Buffer.from(s, "base64"))) };
  }

  // One signed request, and the issuer's answer when it said ok. A refusal says why; anything else is unreachable.
  async #ask(route: string, action: AgentRequestAction, agent: AgentKeys, extra: Pick<AgentRequestFields, "code" | "target" | "holder" | "holderSignal">, holderSeeds?: IdentitySeeds, beside: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const bytes = encodeAgentRequest({
      action,
      issuerAddress: this.address,
      agent: agent.identity,
      nonce: crypto.getRandomValues(new Uint8Array(NONCE_BYTES)),
      issuedAt,
      expiresAt: issuedAt + REQUEST_LIFETIME_SECONDS,
      ...extra,
    });
    const wire = agentRequestToWire(bytes, await signRequest(agent.seeds, bytes), holderSeeds ? await signRequest(holderSeeds, bytes) : undefined);
    let status: number;
    let text: string;
    try {
      const response = await this.#fetch(new URL(`/api/issuer/${route}`, this.#base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...beside, ...wire }), redirect: "error", signal: AbortSignal.timeout(ISSUER_WAIT_MS) });
      status = response.status;
      text = await response.text();
    } catch (err: unknown) {
      throw new IssuerUnreachable(`nothing answered at ${this.#base.origin}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // An issuer from before email signup has no such route. Say so plainly: its operator may run an older version on purpose.
    // An issuer refusal is JSON; only a bare 404 means the route isn't there. The URL might just be wrong, so it's named.
    if (status === 404 && route.startsWith("enroll/") && !text.trimStart().startsWith("{")) {
      throw new IssuerRefused("enroll_not_offered", `The issuer at ${this.#base.origin} doesn't offer signing up by email (it answered 404; if that isn't an issuer, check --issuer).`);
    }
    if (text.length > MAX_ANSWER_BYTES) throw new IssuerUnreachable(`the answer from ${this.#base.origin} is too large to be an issuer's`);
    let answer: { ok?: unknown; reason?: unknown; guidance?: unknown; signals?: unknown };
    try {
      answer = JSON.parse(text) as typeof answer;
    } catch {
      throw new IssuerUnreachable(`${this.#base.origin} answered with status ${status}, and not as an issuer would`);
    }
    if (answer.ok !== true) {
      if (typeof answer.reason !== "string") throw new IssuerUnreachable(`${this.#base.origin} answered with status ${status}, and not as an issuer would`);
      throw new IssuerRefused(answer.reason, typeof answer.guidance === "string" ? answer.guidance : answer.reason);
    }
    return answer as Record<string, unknown>;
  }
}

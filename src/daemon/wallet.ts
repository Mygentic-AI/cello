// Collecting a signal, what it must pass to be kept, and how it's shown. Nothing a signal says reaches a reader except through here.
import { decodeCbor } from "../protocol/cbor.ts";
import { toHex } from "../protocol/encode.ts";
import type { PublicIdentity } from "../protocol/identity.ts";
import { type IssuerList, RootKeysNotConfigured, type RootKey, recognisedIssuer, verifyIssuerList } from "../protocol/issuer-list.ts";
import { checkSignal, issuerKeys } from "../protocol/signal.ts";
import type { InboundVerdict } from "../screener/inbound.ts";
import { NO_EXPIRY_NOTE, unknownIssuerNote } from "../guidance.ts";
import { LocalError } from "./errors.ts";
import { BadIssuerUrl, IssuerClient, IssuerRefused, IssuerUnreachable, type AgentKeys } from "./issuer-client.ts";
import { logEvent } from "./log.ts";
import { currentText } from "./settings.ts";
import { CONSENT_ACCEPTED, SignalStore, type WalletRow, ensureSignalSchema } from "./signal-store.ts";
import type { Store } from "./store.ts";

const CONFIG_ISSUER_LIST = "issuer_list";
export const STATUS_PAGE = "https://celloprotocol.com/status";
export const WAITLIST_PAGE = "https://celloprotocol.com/waitlist";
export const HOW_TO_GET_A_CODE = `You need a code. It's in the email that said you were admitted. Lost it, or setting up another device? Sign in at ${STATUS_PAGE} and ask for one. Not admitted yet? Join at ${WAITLIST_PAGE}.`;

// What a person can do next, for each thing an issuer can refuse. The issuer's own words come first.
const NEXT_STEP: Record<string, string> = {
  code_required: HOW_TO_GET_A_CODE,
  code_used: `Each code works once. Ask for a new one at ${STATUS_PAGE}.`,
  code_expired: `Ask for a new one at ${STATUS_PAGE}.`,
  code_unknown: `Check it against your email, or ask for a new one at ${STATUS_PAGE}.`,
  code_cap: "That limit is set by the issuer, and nothing was used.",
  agent_cap: "This agent wasn't registered. Once the limit is raised, run the same command again.",
  rate_limited: "Nothing was used.",
  waitlist_unavailable: "Nothing was used. Run the same command again in a minute.",
  agent_burned: "This agent can't be used again. Set up a new one.",
};

export type IssuerStanding = "recognised" | "trusted_by_owner" | "unknown";

export interface WalletHooks {
  keys(agentHex: string): AgentKeys;
  screen(agentHex: string, issuerHex: string, text: string): Promise<InboundVerdict>;
  notify(agentId: Uint8Array, text: string): void;
  roots(): readonly RootKey[];
}

export interface SignalRefusal { fault: string; message: string }
export interface Collected { stored: number; held: number; refused: SignalRefusal[] }

const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const nowSec = (): number => Math.floor(Date.now() / 1000);

// From a stranger's signal, a type or address is only shown if it's plainly a name, so it can't carry a sentence.
const plainName = (value: string): string => (/^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : "(not a plain name)");

export function readClaim(payload: Uint8Array): string | null {
  try {
    const decoded = decodeCbor(payload) as { claim?: unknown } | null;
    return typeof decoded?.claim === "string" && decoded.claim.length > 0 ? decoded.claim : null;
  } catch {
    return null;
  }
}

// The signed list, and then the owner's own. Both match the keys and the address together.
export function issuerStanding(row: Pick<WalletRow, "issuer_address" | "issuer_pubkey">, keys: PublicIdentity, list: IssuerList | null, trusted: readonly { issuer_address: string; issuer_pubkey: string }[], now: number): IssuerStanding {
  if (list && recognisedIssuer(list, keys, row.issuer_address, now)) return "recognised";
  return trusted.some((t) => t.issuer_address === row.issuer_address && t.issuer_pubkey === row.issuer_pubkey) ? "trusted_by_owner" : "unknown";
}

export class Wallet {
  readonly #signals: SignalStore;
  readonly #store: Store;
  readonly #hooks: WalletHooks;

  constructor(store: Store, hooks: WalletHooks) {
    this.#store = store;
    ensureSignalSchema(store);
    this.#signals = new SignalStore(store);
    this.#hooks = hooks;
  }

  #client(): IssuerClient {
    try {
      return new IssuerClient(currentText(this.#store, "issuer_url"));
    } catch (err: unknown) {
      if (err instanceof BadIssuerUrl) throw new LocalError("bad_issuer", `${err.message}. Change it with: cello settings-set issuer_url <address>`);
      throw err;
    }
  }

  // Keeps what passes every check, and names what doesn't. One bad signal doesn't cost the others.
  async #keep(agentHex: string, files: readonly Uint8Array[]): Promise<Collected> {
    const agentId = fromHex(agentHex);
    const result: Collected = { stored: 0, held: 0, refused: [] };
    for (const file of files) {
      const checked = await checkSignal(file, { subject: agentHex, now: nowSec() });
      if (!checked.ok) {
        logEvent("signal.collect.refused", { agent: agentHex, fault: checked.fault });
        result.refused.push({ fault: checked.fault, message: checked.message });
        continue;
      }
      if (this.#signals.put(agentId, checked.signal, file)) result.stored += 1;
      result.held += 1;
    }
    return result;
  }

  #plain(err: unknown, attempted: string): LocalError {
    if (err instanceof IssuerRefused) {
      const next = NEXT_STEP[err.reason];
      return new LocalError(err.reason, `${err.message}${next ? ` ${next}` : ""}`);
    }
    if (err instanceof IssuerUnreachable) return new LocalError("issuer_unreachable", `Couldn't reach the issuer to ${attempted}: ${err.message}. Check your connection, then run the same command again.`);
    throw err;
  }

  async collect(agentHex: string): Promise<Collected> {
    try {
      const client = this.#client();
      return await this.#keep(agentHex, (await client.collect(this.#hooks.keys(agentHex))).signals);
    } catch (err: unknown) {
      if (err instanceof LocalError) throw err;
      throw this.#plain(err, "collect signals");
    }
  }

  async redeem(agentHex: string, code: string): Promise<Collected> {
    try {
      const client = this.#client();
      return await this.#keep(agentHex, (await client.redeem(this.#hooks.keys(agentHex), code)).signals);
    } catch (err: unknown) {
      if (err instanceof LocalError) throw err;
      throw this.#plain(err, "redeem your code");
    }
  }

  // The agent already enrolled at this issuer, with an account-level signal that can vouch for a new one on this daemon.
  holderAmong(agentHexes: readonly string[]): string | undefined {
    const address = this.#client().address;
    return agentHexes.find((hex) => this.#signals.accountLevel(fromHex(hex), address, nowSec()));
  }

  async copyFromHolder(agentHex: string, holderHex: string): Promise<Collected> {
    try {
      const client = this.#client();
      const held = this.#signals.accountLevel(fromHex(holderHex), client.address, nowSec());
      if (!held) throw new LocalError("holder_signal_gone", "The agent that could vouch for this one no longer has a current signal. Update it with: cello signals collect");
      const answer = await client.addAgent(this.#hooks.keys(agentHex), this.#hooks.keys(holderHex), new Uint8Array(held.file));
      return await this.#keep(agentHex, answer.signals);
    } catch (err: unknown) {
      if (err instanceof LocalError) throw err;
      throw this.#plain(err, "get this agent's signals");
    }
  }

  hasEmail(agentHex: string): boolean {
    return this.#signals.ofType(fromHex(agentHex), "email", nowSec()) !== undefined;
  }

  // What a registration carries, for a server that requires a verified email.
  emailFile(agentHex: string): Uint8Array | undefined {
    const row = this.#signals.ofType(fromHex(agentHex), "email", nowSec());
    return row ? new Uint8Array(row.file) : undefined;
  }

  async #list(): Promise<IssuerList | null> {
    const stored = this.#store.getConfig(CONFIG_ISSUER_LIST);
    if (!stored) return null;
    let roots: readonly RootKey[];
    try {
      roots = this.#hooks.roots();
    } catch (err: unknown) {
      if (err instanceof RootKeysNotConfigured) return null;
      throw err;
    }
    const checked = await verifyIssuerList(new Uint8Array(Buffer.from(stored, "base64")), roots, nowSec());
    return checked.ok ? checked.list : null;
  }

  // Needs two of the three root signatures, so it needs no person: it can only add what the roots said.
  async loadIssuerList(file: Uint8Array): Promise<unknown> {
    let roots: readonly RootKey[];
    try {
      roots = this.#hooks.roots();
    } catch (err: unknown) {
      if (err instanceof RootKeysNotConfigured) throw new LocalError(err.code, `${err.message}. This client has no root keys built in yet, so nothing was loaded.`);
      throw err;
    }
    const checked = await verifyIssuerList(file, roots, nowSec());
    if (!checked.ok) throw new LocalError(`issuer_list_${checked.fault}`, `${checked.message}. Nothing was loaded.`);
    this.#store.setConfig(CONFIG_ISSUER_LIST, Buffer.from(file).toString("base64"));
    return { loaded: true, issuers: checked.list.issuers.map((entry) => entry.name), expires_at: checked.list.expires_at };
  }

  // The claim is quoted and screened, and never joins our words. Blocked text doesn't come through at all.
  async #notes(agentHex: string, row: WalletRow, standing: IssuerStanding): Promise<string[]> {
    const notes: string[] = [];
    if (standing === "unknown") {
      const claim = readClaim(new Uint8Array(row.payload));
      let shown = "(this signal has no readable claim)";
      if (claim !== null) {
        const verdict = await this.#hooks.screen(agentHex, row.issuer_pubkey.slice(0, 64), claim);
        shown = verdict.verdict === "blocked" ? `(withheld: ${verdict.reason ?? "the screen blocked it"})` : verdict.delivered ?? claim;
      }
      notes.push(unknownIssuerNote(plainName(row.issuer_address), shown));
    }
    if (row.expires_at === null) notes.push(NO_EXPIRY_NOTE);
    return notes;
  }

  async #describe(agentHex: string, row: WalletRow, list: IssuerList | null, now: number): Promise<Record<string, unknown>> {
    const envelopeKeys = issuerKeys({ issuer_pubkey: row.issuer_pubkey } as never);
    const standing = issuerStanding(row, envelopeKeys, list, this.#signals.trusted(), now);
    return {
      signal_hash: row.signal_hash,
      type: plainName(row.type),
      subject_kind: row.subject_kind,
      issuer_kind: row.issuer_kind,
      issuer_address: plainName(row.issuer_address),
      issuer_pubkey: row.issuer_pubkey,
      issuer_standing: standing,
      counts_as_verified: standing !== "unknown",
      status: row.status === "active" && row.expires_at !== null && row.expires_at <= now ? "expired" : row.status,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      supersedes_hash: row.supersedes_hash,
      default_present: row.default_present === 1,
      consent_state: row.consent_state,
      same_operator: row.same_operator === 1,
      public: row.public === 1,
      notes: await this.#notes(agentHex, row, standing),
    };
  }

  async list(agentHex: string, all: boolean): Promise<unknown> {
    const issuers = await this.#list();
    const now = nowSec();
    const rows = await Promise.all(this.#signals.list(fromHex(agentHex)).map((row) => this.#describe(agentHex, row, issuers, now)));
    return { signals: all ? rows : rows.filter((row) => row["status"] === "active"), not_shown: all ? 0 : rows.filter((row) => row["status"] !== "active").length };
  }

  #find(agentHex: string, prefix: string): WalletRow {
    if (!/^[0-9a-f]{8,64}$/.test(prefix)) throw new LocalError("bad_argument", "Give at least 8 hex characters of the signal's hash. cello signals list shows them.");
    const { row, matches } = this.#signals.byPrefix(fromHex(agentHex), prefix);
    if (matches > 1) throw new LocalError("ambiguous_prefix", `${prefix} matches ${matches} signals. Give more of the hash.`);
    if (!row) throw new LocalError("signal_not_found", `This agent holds no signal starting ${prefix}. cello signals list shows what it holds.`);
    return row;
  }

  async view(agentHex: string, prefix: string): Promise<unknown> {
    const row = this.#find(agentHex, prefix);
    const described = await this.#describe(agentHex, row, await this.#list(), nowSec());
    // From an unknown issuer, the payload's text reaches a reader only inside the screened, quoted note.
    if (described["issuer_standing"] === "unknown") return { ...described, schema_version: row.schema_version };
    let payload: unknown;
    try {
      payload = decodeCbor(new Uint8Array(row.payload));
    } catch {
      payload = toHex(new Uint8Array(row.payload));
    }
    return { ...described, schema_version: row.schema_version, payload };
  }

  enable(agentHex: string, prefix: string): unknown {
    const row = this.#find(agentHex, prefix);
    if (row.consent_state !== CONSENT_ACCEPTED) throw new LocalError("consent_pending", `This signal is '${row.consent_state}', not accepted, so it can't be shown whatever this says. Accept it first.`);
    this.#signals.setDefaultPresent(fromHex(agentHex), row.signal_hash, true);
    return { signal_hash: row.signal_hash, default_present: true };
  }

  disable(agentHex: string, prefix: string): unknown {
    const row = this.#find(agentHex, prefix);
    this.#signals.setDefaultPresent(fromHex(agentHex), row.signal_hash, false);
    return { signal_hash: row.signal_hash, default_present: false };
  }

  // The caller has already had a person confirm this.
  trustIssuer(agentHex: string, prefix: string): unknown {
    const row = this.#find(agentHex, prefix);
    this.#signals.trust(row.issuer_address, row.issuer_pubkey);
    logEvent("signal.issuer.trusted", { agent: agentHex, issuer: row.issuer_address });
    this.#hooks.notify(fromHex(agentHex), `A person at this machine's terminal added ${plainName(row.issuer_address)} to the trusted list, so its signals now count as verified here. If that wasn't you, a person can take it off with issuer-untrust.`);
    return { trusted: plainName(row.issuer_address), issuer_pubkey: row.issuer_pubkey };
  }

  describeIssuerOf(agentHex: string, prefix: string): string {
    return plainName(this.#find(agentHex, prefix).issuer_address);
  }

  untrustIssuer(agentHex: string, prefix: string): unknown {
    const row = this.#find(agentHex, prefix);
    this.#signals.untrust(row.issuer_address, row.issuer_pubkey);
    logEvent("signal.issuer.untrusted", { agent: agentHex, issuer: row.issuer_address });
    return { untrusted: plainName(row.issuer_address) };
  }
}


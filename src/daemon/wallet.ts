// Collecting a signal, what it must pass to be kept, and how it's shown. Nothing a signal says reaches a reader except through here.
import { decodeCbor } from "../protocol/cbor.ts";
import { toHex } from "../protocol/encode.ts";
import type { PublicIdentity } from "../protocol/identity.ts";
import { type IssuerList, RootKeysNotConfigured, type RootKey, recognisedIssuer, verifyIssuerList } from "../protocol/issuer-list.ts";
import { checkSignal, issuerKeys, readSignedSignal } from "../protocol/signal.ts";
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
  shippedList: string | null;
  // Public signals live on a server, so these reach it as the agent. Each fails by name if the server refuses or can't be reached.
  publishToServer(agentHex: string, file: Uint8Array): Promise<void>;
  unpublishFromServer(agentHex: string, signalId: Uint8Array): Promise<void>;
  // The signed files a server holds as public for one agent, and the agent's id as it parsed from the address.
  readPublic(agentHex: string, address: string): Promise<{ target: string; files: Uint8Array[] }>;
}

export interface SignalRefusal { fault: string; message: string }
export interface Collected { stored: number; held: number; refused: SignalRefusal[] }

const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const nowSec = (): number => Math.floor(Date.now() / 1000);
const SETTLE_RETRY_MS = 60_000;

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

// With no valid list there's no recognised issuer, so every signal shows as unknown.
export async function newestValidList(files: readonly Uint8Array[], roots: readonly RootKey[] | null, now: number): Promise<IssuerList | null> {
  if (!roots) return null;
  let newest: IssuerList | null = null;
  for (const file of files) {
    const checked = await verifyIssuerList(file, roots, now);
    if (!checked.ok) {
      logEvent("issuer.list.rejected", { fault: checked.fault, message: checked.message });
      continue;
    }
    if (!newest || checked.list.issued_at > newest.issued_at) newest = checked.list;
  }
  return newest;
}

export class Wallet {
  readonly #signals: SignalStore;
  readonly #store: Store;
  readonly #hooks: WalletHooks;
  readonly #lastSettle = new Map<string, number>();
  readonly #warned = new Set<string>();

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
    // A signal this replaced may have been public, and then it has to come off the server too. A failure here never fails the collect.
    await this.settlePublic(agentHex, true);
    return result;
  }

  // Takes back from the server every public signal the wallet has replaced, until the server confirms each. A failure is said loudly,
  // once per signal until it succeeds, and tried again at the next call (the daemon calls this on a timer, at most once a minute).
  async settlePublic(agentHex: string, force = false): Promise<number> {
    const waiting = this.#signals.withdrawing(fromHex(agentHex));
    if (waiting.length === 0) return 0;
    const now = Date.now();
    if (!force && now - (this.#lastSettle.get(agentHex) ?? 0) < SETTLE_RETRY_MS) return waiting.length;
    this.#lastSettle.set(agentHex, now);
    let left = 0;
    for (const row of waiting) {
      try {
        await this.#hooks.unpublishFromServer(agentHex, readSignedSignal(new Uint8Array(row.file)).envelope.signal_id);
        this.#signals.setPublic(fromHex(agentHex), row.signal_hash, false);
        this.#warned.delete(row.signal_hash);
        logEvent("signal.public.withdrawn", { agent: agentHex, signal: row.signal_hash, reason: "replaced" });
      } catch (err: unknown) {
        left += 1;
        logEvent("signal.public.withdraw_failed", { agent: agentHex, signal: row.signal_hash, message: err instanceof Error ? err.message : String(err) });
        if (!this.#warned.has(row.signal_hash)) {
          this.#warned.add(row.signal_hash);
          this.#hooks.notify(fromHex(agentHex), `A public signal of this agent (${plainName(row.type)}, ${row.signal_hash.slice(0, 12)}…) was replaced by a newer one, but taking it back from the server failed: ${err instanceof Error ? err.message : String(err)}. It is still public and reads as current there. This daemon will keep trying, and you can run: cello signals unpublish ${row.signal_hash.slice(0, 12)}`);
        }
      }
    }
    return left;
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
      await this.#refreshList(client);
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
    return newestValidList([stored, this.#hooks.shippedList].filter((list): list is string => Boolean(list)).map((list) => new Uint8Array(Buffer.from(list, "base64"))), this.#roots(), nowSec());
  }

  #roots(): readonly RootKey[] | null {
    try {
      return this.#hooks.roots();
    } catch (err: unknown) {
      if (err instanceof RootKeysNotConfigured) return null;
      throw err;
    }
  }

  // Asked for each time signals are collected. It's kept only if it's valid and newer, so a server can't hand back an old one, and failing to get one costs nothing.
  async #refreshList(client: IssuerClient): Promise<void> {
    const offered = await client.latestIssuerList();
    if (!offered) return;
    const roots = this.#roots();
    const fresh = await newestValidList([offered], roots, nowSec());
    if (!fresh) return;
    const current = await this.#list();
    if (current && current.issued_at >= fresh.issued_at) return;
    this.#store.setConfig(CONFIG_ISSUER_LIST, Buffer.from(offered).toString("base64"));
    logEvent("issuer.list.updated", { issued_at: fresh.issued_at, expires_at: fresh.expires_at });
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
      public: row.public !== 0,
      taking_back: row.public === 2,
      signal_id: toHex(readSignedSignal(new Uint8Array(row.file)).envelope.signal_id),
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

  // Only what could be shown: accepted by its subject, still current, and not past its date. The server checks it again and refuses a forgery.
  async publish(agentHex: string, prefix: string): Promise<unknown> {
    const row = this.#find(agentHex, prefix);
    if (row.consent_state !== CONSENT_ACCEPTED) throw new LocalError("consent_pending", `This signal is '${row.consent_state}', not accepted, so it can't be made public. Accept it first.`);
    if (row.status !== "active") throw new LocalError("signal_not_current", "A newer signal has replaced this one, so it can't be made public.");
    if (row.expires_at !== null && row.expires_at <= nowSec()) throw new LocalError("signal_expired", "This signal has expired, so it can't be made public. cello signals collect fetches a current one.");
    await this.#hooks.publishToServer(agentHex, new Uint8Array(row.file));
    this.#signals.setPublic(fromHex(agentHex), row.signal_hash, true);
    logEvent("signal.public.published", { agent: agentHex, signal: row.signal_hash });
    return { signal_hash: row.signal_hash, public: true };
  }

  // The server forgets it first. If it can't be reached the signal stays marked public here, because it is still public there.
  // By hash for a signal the wallet holds, or by the signal's own id (signals list shows it) for one the wallet no longer holds,
  // so something published and since lost from the wallet can still be taken back.
  async unpublish(agentHex: string, prefix: string | undefined, signalIdHex?: string): Promise<unknown> {
    if ((prefix === undefined) === (signalIdHex === undefined)) throw new LocalError("bad_argument", "Give either the signal's hash or its signal id, one of them.");
    if (signalIdHex !== undefined) {
      if (!/^[0-9a-f]{32}$/.test(signalIdHex)) throw new LocalError("bad_argument", "A signal id is 32 hex characters. cello signals list shows it.");
      await this.#hooks.unpublishFromServer(agentHex, fromHex(signalIdHex));
      const held = this.#signals.list(fromHex(agentHex)).find((row) => toHex(readSignedSignal(new Uint8Array(row.file)).envelope.signal_id) === signalIdHex);
      if (held) this.#signals.setPublic(fromHex(agentHex), held.signal_hash, false);
      logEvent("signal.public.withdrawn", { agent: agentHex, signal: held?.signal_hash ?? "not held" });
      return { signal_id: signalIdHex, ...(held ? { signal_hash: held.signal_hash } : {}), public: false };
    }
    const row = this.#find(agentHex, prefix as string);
    await this.#hooks.unpublishFromServer(agentHex, readSignedSignal(new Uint8Array(row.file)).envelope.signal_id);
    this.#signals.setPublic(fromHex(agentHex), row.signal_hash, false);
    logEvent("signal.public.withdrawn", { agent: agentHex, signal: row.signal_hash });
    return { signal_hash: row.signal_hash, public: false };
  }

  // What another agent has chosen to show. Every file is checked here, whatever the server says: its signatures, that it names this agent,
  // and its dates. Whether the issuer counts is then read off the signed list and the owner's own, and a claim from one that doesn't is screened and quoted.
  async lookup(agentHex: string, address: string): Promise<unknown> {
    const { target, files } = await this.#hooks.readPublic(agentHex, address);
    return { agent: target, ...(await this.examine(agentHex, target, files, "signal.lookup.refused")) };
  }

  // Signals another agent showed, from a public listing or sealed with a call. Each file is checked here for itself: its signatures, that it names
  // that agent, and its dates. A file that fails is left out and named. What passes is described for the reader asking, with no payload.
  async examine(agentHex: string, subjectHex: string, files: readonly Uint8Array[], event: string): Promise<{ signals: Record<string, unknown>[]; refused: SignalRefusal[] }> {
    const list = await this.#list();
    const now = nowSec();
    const signals: Record<string, unknown>[] = [];
    const refused: SignalRefusal[] = [];
    for (const file of files) {
      const checked = await checkSignal(file, { subject: subjectHex, now });
      if (!checked.ok) {
        logEvent(event, { agent: agentHex, fault: checked.fault });
        refused.push({ fault: checked.fault, message: checked.message });
        continue;
      }
      const e = checked.signal.envelope;
      const held: WalletRow = {
        agent_id: fromHex(subjectHex), signal_hash: toHex(checked.signal.hash), file, subject_kind: e.subject_kind, issuer_kind: e.issuer_kind, issuer_pubkey: e.issuer_pubkey,
        issuer_address: e.issuer_address, type: e.type, schema_version: e.schema_version, payload: e.payload, issued_at: e.issued_at, expires_at: e.expires_at,
        supersedes_hash: e.supersedes_hash === null ? null : toHex(e.supersedes_hash), same_operator: e.same_operator ? 1 : 0, status: "active", received_at: now * 1000,
        default_present: 1, consent_state: CONSENT_ACCEPTED, public: 1,
      };
      signals.push(await this.#describe(agentHex, held, list, now));
    }
    return { signals, refused };
  }

  // The signal files an agent shows with a call. Unspecified is the default set: accepted, current, unexpired, and switched on for showing.
  // "none" is nothing, and a list of hashes is exactly those, each of which must be fit to show. Never trimmed quietly: past the limit it says so.
  presentable(agentHex: string, spec?: string): { files: Uint8Array[]; hashes: string[] } {
    const agentId = fromHex(agentHex);
    const now = nowSec();
    const fit = (row: WalletRow): boolean => row.consent_state === CONSENT_ACCEPTED && row.status === "active" && (row.expires_at === null || row.expires_at > now);
    let rows: WalletRow[];
    if (spec === "none") rows = [];
    else if (spec === undefined || spec === "" || spec === "default") rows = this.#signals.list(agentId).filter((row) => fit(row) && row.default_present === 1);
    else {
      rows = spec.split(",").map((part) => this.#find(agentHex, part.trim()));
      for (const row of rows) {
        if (!fit(row)) throw new LocalError("signal_not_fit", `The signal ${row.signal_hash.slice(0, 12)}… can't go with a call: it is ${row.consent_state !== CONSENT_ACCEPTED ? row.consent_state : row.status === "active" ? "expired" : row.status}.`);
      }
    }
    const unique = [...new Map(rows.map((row) => [row.signal_hash, row])).values()];
    return { files: unique.map((row) => new Uint8Array(row.file)), hashes: unique.map((row) => row.signal_hash) };
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


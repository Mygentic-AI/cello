// Discovery on this agent's server (DISCOVERY-PLAN.md): search the agents and channels that chose to be listed, and list,
// renew or unlist this agent or a channel it runs.
// Nothing a server says about a listing is taken on trust. Each result's signed listing is checked here against its owner's keys,
// and what's shown comes from those signed bytes, screened on this machine like any message from a stranger.
import { readRecord } from "../protocol/channel.ts";
import { toHex } from "../protocol/encode.ts";
import type { PublicIdentity, Signer } from "../protocol/identity.ts";
import { type ListingKind, decodeListing, listingSignedBy, signListing } from "../protocol/listing.ts";
import { ChannelVisibility, type ListingFields } from "../protocol/structures.ts";
import { identityCodec, toB64 } from "../protocol/wire.ts";
import type { InboundVerdict } from "../screener/inbound.ts";
import { formatAddress } from "./address.ts";
import { LocalError } from "./errors.ts";
import { logEvent } from "./log.ts";

const PREVIEW_CHARS = 200;

export interface DiscoveryHooks {
  // A call to this agent's own server, as the agent.
  call(agentHex: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  agentSigner(agentHex: string): Signer;
  channelSigner(agentHex: string, channelHex: string): Promise<Signer>;
  screen(agentHex: string, scope: string, senderHex: string, text: string): Promise<InboundVerdict>;
  serverUrl(): string;
}

export interface SearchOptions { query?: string; tags?: string; match?: string; cursor?: string; limit?: number }
export interface ListingInput { channel?: string; name: string; description?: string; tags?: string; language?: string }

interface RawResult { id: string; listing: unknown; owner?: unknown; record?: unknown; signals?: { count: number; of: number; slots: string[] }; access?: string; readers?: number; listed_at: string }

const hexId = (value: string | undefined, what: string): string => {
  if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) throw new LocalError("bad_argument", `${what} is a 64-character hex id`);
  return value;
};

// "a, b,c" to "a,b,c", lowercased; the shared rules then refuse anything that isn't a tag.
const tagList = (tags: string | undefined): string => (tags ?? "").split(",").map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== "").join(",");

export class Discovery {
  readonly #hooks: DiscoveryHooks;

  constructor(hooks: DiscoveryHooks) {
    this.#hooks = hooks;
  }

  async search(agentHex: string, kind: ListingKind, options: SearchOptions): Promise<unknown> {
    const match = options.match ?? "any";
    if (match !== "any" && match !== "all") throw new LocalError("bad_argument", "match is any or all");
    const tags = tagList(options.tags);
    const answer = await this.#hooks.call(agentHex, "discover.search", {
      kind,
      ...(options.query ? { query: options.query } : {}),
      ...(tags ? { tags: tags.split(",") } : {}),
      match,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    }) as { results?: unknown; cursor?: unknown };
    if (!Array.isArray(answer.results)) throw new LocalError("bad_response", "the server's search answer is malformed");
    const shown: unknown[] = [];
    const unverified: Record<string, number> = {};
    let blocked = 0;
    for (const raw of answer.results as RawResult[]) {
      const checked = await this.#verified(kind, raw);
      if (!checked.ok) {
        unverified[checked.reason] = (unverified[checked.reason] ?? 0) + 1;
        logEvent("discover.unverified", { agent: agentHex, kind, listing: typeof raw.id === "string" ? raw.id : "unnamed", reason: checked.reason });
        continue;
      }
      const { fields } = checked;
      // The listing's words are a stranger's, so they're screened here before an agent reads them, and what's shown is the screen's
      // cleaned text: invisible characters stripped, forged security-layer markers removed. The name and tags can't hold anything but
      // letters, digits, dashes and underscores, so the description is the part that changes.
      const verdict = await this.#hooks.screen(agentHex, `listing:${raw.id}`, raw.id, [fields.name, fields.tags.replaceAll(",", " "), fields.description].join("\n"));
      if (verdict.verdict === "blocked") {
        blocked += 1;
        continue;
      }
      const cleaned = verdict.delivered === null ? fields.description : verdict.delivered.slice(verdict.delivered.indexOf("\n\n") + 2).split("\n").slice(2).join("\n");
      // One line, so a description can't draw what looks like another result under it.
      const preview = [...cleaned.replace(/\s+/g, " ").trim()].slice(0, PREVIEW_CHARS).join("");
      const screening = verdict.delivered === null ? {} : { screening: { verdict: verdict.verdict, findings: verdict.findings } };
      const common = { name: fields.name, preview, tags: fields.tags === "" ? [] : fields.tags.split(","), language: fields.language ?? "en", ...screening };
      // What the server alone says, unsigned by the owner: its count of trust signals, its reader count, when it was listed.
      const serverSays = { listed_at: raw.listed_at, ...(kind === "agent" ? { signals: raw.signals } : raw.readers === undefined ? {} : { readers: raw.readers }) };
      shown.push(kind === "agent"
        ? { ...common, name_self_declared: true, address: formatAddress(raw.id, this.#hooks.serverUrl()), agent_id: raw.id, ...serverSays }
        : { ...common, channel: raw.id, access: checked.access, ...serverSays });
    }
    const unverifiedCount = Object.values(unverified).reduce((sum, n) => sum + n, 0);
    return {
      kind,
      results: shown,
      cursor: typeof answer.cursor === "string" ? answer.cursor : null,
      ...(unverifiedCount > 0 ? { unverified: unverifiedCount, unverified_reasons: unverified } : {}),
      ...(blocked > 0 ? { blocked_by_screening: blocked } : {}),
    };
  }

  // The listing, checked against the owner's keys the server sent with it, and naming the id it came under. Anything less says why.
  // A channel's access comes from its signed record, never from the server's word.
  async #verified(kind: ListingKind, raw: RawResult): Promise<{ ok: true; fields: ListingFields; access?: "public" | "invite_only" } | { ok: false; reason: string }> {
    let listing: ReturnType<typeof decodeListing>;
    try {
      listing = decodeListing(kind, raw.listing);
    } catch (err: unknown) {
      return { ok: false, reason: (err as { code?: string }).code === "unsupported_version" ? "unsupported_version" : "malformed" };
    }
    if (toHex(listing.fields.subjectId) !== raw.id) return { ok: false, reason: "id_mismatch" };
    if (kind === "agent") {
      let owner: PublicIdentity;
      try {
        owner = identityCodec.decode(raw.owner);
      } catch {
        return { ok: false, reason: "no_owner_keys" };
      }
      return (await listingSignedBy(kind, listing, owner)) ? { ok: true, fields: listing.fields } : { ok: false, reason: "bad_signature" };
    }
    const record = await readRecord(raw.record, listing.fields.subjectId);
    if (!record) return { ok: false, reason: "bad_record" };
    if (!(await listingSignedBy(kind, listing, record.channel))) return { ok: false, reason: "bad_signature" };
    return { ok: true, fields: listing.fields, access: record.fields.visibility === ChannelVisibility.public ? "public" : "invite_only" };
  }

  async #subject(agentHex: string, channel: string | undefined): Promise<{ kind: ListingKind; subject: string; signer: Signer }> {
    if (channel === undefined) return { kind: "agent", subject: agentHex, signer: this.#hooks.agentSigner(agentHex) };
    const channelHex = hexId(channel, "channel");
    return { kind: "channel", subject: channelHex, signer: await this.#hooks.channelSigner(agentHex, channelHex) };
  }

  async #mine(agentHex: string, kind: ListingKind, subject: string): Promise<{ listing: unknown; review: string | null; listed_at: string | null; expires_at: string | null; suspended: boolean }> {
    return await this.#hooks.call(agentHex, "listing.mine", { kind, subject: toB64(Buffer.from(subject, "hex")) }) as never;
  }

  // Create or edit. The revision goes one past whatever the server holds, so an edit always replaces.
  async publish(agentHex: string, input: ListingInput): Promise<unknown> {
    const { kind, subject, signer } = await this.#subject(agentHex, input.channel);
    const held = await this.#mine(agentHex, kind, subject);
    const revision = held.listing === null ? 1 : decodeListing(kind, held.listing).fields.revision + 1;
    const fields: ListingFields = {
      subjectId: new Uint8Array(Buffer.from(subject, "hex")),
      revision,
      name: input.name,
      description: input.description ?? "",
      tags: tagList(input.tags),
      language: input.language === undefined || input.language === "" || input.language === "en" ? null : input.language,
      signedAt: Math.floor(Date.now() / 1000),
    };
    let wire: unknown;
    try {
      wire = await signListing(kind, signer, fields);
    } catch (err: unknown) {
      if (err instanceof RangeError) throw new LocalError("bad_argument", err.message);
      throw err;
    }
    const answer = await this.#hooks.call(agentHex, "listing.publish", { kind, listing: wire }) as { review: string; expires_at: string };
    logEvent("listing.published", { agent: agentHex, kind, revision, review: answer.review });
    return { kind, [kind === "agent" ? "agent_id" : "channel"]: subject, revision, review: answer.review, expires_at: answer.expires_at,
      ...(answer.review === "held" ? { note: "Screening on the server held this listing for its operator to review. It isn't in search until they approve it." } : {}) };
  }

  async renew(agentHex: string, channel: string | undefined): Promise<unknown> {
    const { kind, subject } = await this.#subject(agentHex, channel);
    const answer = await this.#hooks.call(agentHex, "listing.renew", { kind, subject: toB64(Buffer.from(subject, "hex")) }) as { expires_at: string };
    return { kind, renewed: true, expires_at: answer.expires_at };
  }

  async unpublish(agentHex: string, channel: string | undefined): Promise<unknown> {
    const { kind, subject } = await this.#subject(agentHex, channel);
    const answer = await this.#hooks.call(agentHex, "listing.unpublish", { kind, subject: toB64(Buffer.from(subject, "hex")) }) as { removed: boolean };
    return { kind, removed: answer.removed };
  }

  async show(agentHex: string, channel: string | undefined): Promise<unknown> {
    const kind: ListingKind = channel === undefined ? "agent" : "channel";
    const subject = channel === undefined ? agentHex : hexId(channel, "channel");
    const held = await this.#mine(agentHex, kind, subject);
    if (held.listing === null) return { kind, listed: false, suspended: held.suspended };
    const fields = decodeListing(kind, held.listing).fields;
    return {
      kind, listed: true, name: fields.name, description: fields.description, tags: fields.tags === "" ? [] : fields.tags.split(","), language: fields.language ?? "en",
      revision: fields.revision, review: held.review, suspended: held.suspended, listed_at: held.listed_at, expires_at: held.expires_at,
    };
  }
}

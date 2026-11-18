// Discovery listings: how an owner signs one, how anyone checks it, and the rules every party applies the same way.
// The server and every searcher run these same checks (DISCOVERY-PLAN.md).
import { equalBytes } from "./encode.ts";
import { type PublicIdentity, type Signer, type SigningContext, identityId, verifySignature } from "./identity.ts";
import { type ListingFields, type Structure, agentListingStructure, channelListingStructure } from "./structures.ts";
import { type Signed, type WireSigned, signedCodec } from "./wire.ts";

export type ListingKind = "agent" | "channel";

export const signedAgentListing = signedCodec(agentListingStructure);
export const signedChannelListing = signedCodec(channelListingStructure);

const CONTEXT: Record<ListingKind, SigningContext> ={ agent: "cello-agent-listing", channel: "cello-channel-listing" };
const STRUCTURE: Record<ListingKind, Structure<ListingFields>> = { agent: agentListingStructure, channel: channelListingStructure };
const CODEC = { agent: signedAgentListing, channel: signedChannelListing };

// A listing lasts six months from when it was published or last renewed.
export const LISTING_LIFETIME_SECONDS = 183 * 24 * 3600;

// The trust signals a listing counts, as "N of 6". Anonymous and identified versions share a slot, and a listing shows one or neither.
export const SIGNAL_SLOTS = ["email", "phone", "passkey", "github", "x", "usage"] as const;
export type SignalSlot = (typeof SIGNAL_SLOTS)[number];

// ASSUMED (DISCOVERY-PLAN.md): usage_detailed fills the Usage slot, as a version of Usage.
const SLOT_OF: Record<string, SignalSlot> = {
  email: "email",
  phone: "phone",
  webauthn: "passkey",
  github_anon: "github",
  github_id: "github",
  x_anon: "x",
  x_id: "x",
  usage: "usage",
  usage_detailed: "usage",
};

// The slot a signal type fills, or null when it isn't one a listing counts.
export function signalSlot(type: string): SignalSlot | null {
  return SLOT_OF[type] ?? null;
}

// Names starting with "cello" in any case are reserved: the first five characters, lowercased (Andre, 18 November).
export function reservedName(name: string): boolean {
  return name.slice(0, 5).toLowerCase() === "cello";
}

export async function signListing(kind: ListingKind, signer: Signer, fields: ListingFields): Promise<WireSigned> {
  const bytes = STRUCTURE[kind].encode(fields);
  return CODEC[kind].encode({ fields, bytes, signature: await signer.sign(CONTEXT[kind], bytes) });
}

// Decodes a listing from the wire. Throws a WireError for anything malformed, before any signature is checked.
export function decodeListing(kind: ListingKind, raw: unknown): Signed<ListingFields> {
  return CODEC[kind].decode(raw, "listing");
}

// True when the listing is signed by this owner, and names it.
export async function listingSignedBy(kind: ListingKind, listing: Signed<ListingFields>, owner: PublicIdentity): Promise<boolean> {
  if (!equalBytes(listing.fields.subjectId, identityId(owner))) return false;
  return verifySignature(owner, CONTEXT[kind], listing.bytes, listing.signature);
}

// The discovery listing's own rules. The server and every searcher apply these same checks, so a slip here would show on both sides at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateIdentitySeeds, identityId, signerFromSeeds } from "../src/protocol/identity.ts";
import { decodeListing, listingSignedBy, reservedName, signListing, signalSlot } from "../src/protocol/listing.ts";
import { type ListingFields, agentListingStructure } from "../src/protocol/structures.ts";

const fields = (subjectId: Uint8Array, over: Partial<ListingFields> = {}): ListingFields => ({
  subjectId, revision: 1, name: "Ann_helper", description: "Books meetings.", tags: "calendar,scheduling", language: null, signedAt: 1794556800, ...over,
});

test("names starting with cello in any case are reserved, judged on the first five characters", () => {
  for (const name of ["cello", "Cello_bot", "CELLO", "cElLo-x", "cellophane"]) assert.equal(reservedName(name), true, name);
  for (const name of ["cell", "xcello", "Cell0", "c_ello"]) assert.equal(reservedName(name), false, name);
});

test("anonymous and identified versions share a slot; usage_detailed fills Usage; unknown types count for nothing", () => {
  assert.equal(signalSlot("github_anon"), signalSlot("github_id"));
  assert.equal(signalSlot("x_anon"), signalSlot("x_id"));
  assert.equal(signalSlot("webauthn"), "passkey");
  assert.equal(signalSlot("usage_detailed"), "usage");
  assert.equal(signalSlot("endorsement"), null);
  assert.equal(signalSlot("totp"), null);
});

test("a listing signed by its agent checks out, and nobody else's key passes for it", async () => {
  const owner = await signerFromSeeds(generateIdentitySeeds());
  const other = await signerFromSeeds(generateIdentitySeeds());
  const wire = await signListing("agent", owner, fields(identityId(owner.publicIdentity)));
  const listing = decodeListing("agent", wire);
  assert.equal(await listingSignedBy("agent", listing, owner.publicIdentity), true);
  assert.equal(await listingSignedBy("agent", listing, other.publicIdentity), false);
  // A channel-listing check can't be satisfied by an agent listing's signature.
  assert.throws(() => decodeListing("channel", wire), /expected/);
});

test("a listing signed by one key but naming another is refused", async () => {
  const owner = await signerFromSeeds(generateIdentitySeeds());
  const other = await signerFromSeeds(generateIdentitySeeds());
  const listing = decodeListing("agent", await signListing("agent", owner, fields(identityId(other.publicIdentity))));
  assert.equal(await listingSignedBy("agent", listing, owner.publicIdentity), false);
});

test("names, tags and languages are held to their patterns", () => {
  const id = new Uint8Array(32).fill(7);
  assert.throws(() => agentListingStructure.encode(fields(id, { name: " cello" })), /listing name/);
  assert.throws(() => agentListingStructure.encode(fields(id, { name: "Ｃello" })), /listing name/);
  assert.throws(() => agentListingStructure.encode(fields(id, { tags: "Calendar" })), /tag/);
  assert.throws(() => agentListingStructure.encode(fields(id, { tags: "a,a" })), /distinct/);
  assert.throws(() => agentListingStructure.encode(fields(id, { language: "english" })), /language/);
  assert.throws(() => agentListingStructure.encode(fields(id, { description: "x".repeat(2001) })), /description/);
  assert.doesNotThrow(() => agentListingStructure.encode(fields(id, { language: "pt-BR", tags: "" })));
});

// The signals each side shows when a call is made, and how they travel sealed. Two ways in, one shape inside.
// A caller seals to the callee's published encryption key, the way a refusal is sealed: ML-KEM encapsulation, a key made from the shared secret, AES-GCM.
// A callee seals under the session key, like its name. Inside, a flat CBOR array: a label, then each signed signal file whole.
import { createHash } from "node:crypto";
import { openSessionContent, sealSessionContent } from "./aead.ts";
import { decodeCbor, encodeCbor } from "./cbor.ts";
import { type PublicIdentity, verifySignature } from "./identity.ts";
import { mlKemDecapsulate, mlKemEncapsulate } from "./ml-kem.ts";
import { MAX_PRESENTED_BYTES, MAX_PRESENTED_SIGNALS, type EncryptionKeyFields, encryptionKeyBytes } from "./structures.ts";
import { type Signed, signedEncryptionKey } from "./wire.ts";
import { equalBytes } from "./encode.ts";

export const PRESENTED_SIGNALS_LABEL = "cello-presented-signals-v1";
export { MAX_PRESENTED_BYTES, MAX_PRESENTED_SIGNALS };

// The key a request's signals are sealed under. Its own label, so a secret made for a refusal can't open a set or the other way round.
const requestSignalsKey = (sharedSecret: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update("cello-request-signals").update(sharedSecret).digest());

export class PresentedTooMany extends RangeError {}

// What goes inside a box. The caller of this refuses a set that is too big before sealing, and says which limit.
export function encodePresented(files: readonly Uint8Array[]): Uint8Array {
  if (files.length > MAX_PRESENTED_SIGNALS) throw new PresentedTooMany(`at most ${MAX_PRESENTED_SIGNALS} signals go with a call, and this set has ${files.length}`);
  const plain = new Uint8Array(encodeCbor([PRESENTED_SIGNALS_LABEL, ...files]));
  return plain;
}

// Null for anything that isn't a flat array of our label and byte strings, or has too many.
export function decodePresented(plain: Uint8Array): Uint8Array[] | null {
  try {
    const items = decodeCbor(plain) as unknown[];
    if (!Array.isArray(items) || items[0] !== PRESENTED_SIGNALS_LABEL || items.length - 1 > MAX_PRESENTED_SIGNALS) return null;
    const files = items.slice(1);
    if (!files.every((file): file is Uint8Array => file instanceof Uint8Array)) return null;
    return files.map((file) => new Uint8Array(file));
  } catch {
    return null;
  }
}

// Under the session key, as the callee's name is. An empty set is sent as no box at all, which is how "nothing sent" reads.
export function sealUnderSession(sessionKey: Uint8Array, files: readonly Uint8Array[]): Uint8Array {
  if (files.length === 0) return new Uint8Array(0);
  const box = sealSessionContent(sessionKey, encodePresented(files));
  if (box.length > MAX_PRESENTED_BYTES) throw new PresentedTooMany(`these signals total ${box.length} bytes sealed, and the limit is ${MAX_PRESENTED_BYTES}`);
  return box;
}

// Empty means none were sent. A box that won't open, or opens to something else, is refused rather than read as none.
export function openUnderSession(sessionKey: Uint8Array, box: Uint8Array): Uint8Array[] | "unreadable" {
  if (box.length === 0) return [];
  const plain = openSessionContent(sessionKey, box);
  const files = plain ? decodePresented(plain) : null;
  return files ?? "unreadable";
}

// To the callee's published key. Returns what goes in the offer's two fields.
export async function sealToKey(calleeMlKemPublic: Uint8Array, files: readonly Uint8Array[]): Promise<{ signalsCiphertext: Uint8Array; sealedSignals: Uint8Array }> {
  if (files.length === 0) return { signalsCiphertext: new Uint8Array(0), sealedSignals: new Uint8Array(0) };
  const plain = encodePresented(files);
  const { ciphertext, sharedSecret } = await mlKemEncapsulate(calleeMlKemPublic);
  const box = sealSessionContent(requestSignalsKey(sharedSecret), plain);
  sharedSecret.fill(0);
  if (box.length > MAX_PRESENTED_BYTES) throw new PresentedTooMany(`these signals total ${box.length} bytes sealed, and the limit is ${MAX_PRESENTED_BYTES}`);
  return { signalsCiphertext: ciphertext, sealedSignals: box };
}

// With each of the callee's own seeds, newest first, because an offer may have been sealed to a key since replaced. Both fields empty means none were sent.
export async function openFromKey(mlKemSeeds: readonly Uint8Array[], signalsCiphertext: Uint8Array, sealedSignals: Uint8Array): Promise<Uint8Array[] | "unreadable"> {
  if (signalsCiphertext.length === 0 && sealedSignals.length === 0) return [];
  for (const seed of mlKemSeeds) {
    const sharedSecret = await mlKemDecapsulate(seed, signalsCiphertext);
    const plain = openSessionContent(requestSignalsKey(sharedSecret), sealedSignals);
    sharedSecret.fill(0);
    const files = plain ? decodePresented(plain) : null;
    if (files) return files;
  }
  return "unreadable";
}

// A published key as a caller reads it: signed by the agent it says it belongs to, whose identity the caller already holds from the id it typed.
export async function checkEncryptionKey(wire: unknown, agent: PublicIdentity, agentId: Uint8Array): Promise<EncryptionKeyFields> {
  const signed: Signed<EncryptionKeyFields> = signedEncryptionKey.decode(wire, "encryptionKey");
  if (!equalBytes(signed.fields.agentId, agentId)) throw new RangeError("this encryption key names a different agent");
  if (!(await verifySignature(agent, "cello-agent-encryption-key", signed.bytes, signed.signature))) throw new RangeError("this encryption key isn't signed by the agent it names");
  return signed.fields;
}

export { encryptionKeyBytes };

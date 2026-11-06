// A tamperer's edit: changes what a signed thing says and keeps its signature, the way anyone holding the bytes could.
import { type DualSignature } from "../src/protocol/identity.ts";
import { type Signed, type WireSigned, signedAccept, signedOffer } from "../src/protocol/wire.ts";
import { type Signer } from "../src/protocol/identity.ts";
import { acceptBytes, offerBytes, structureHash } from "../src/protocol/structures.ts";

interface AnyCodec<T> { decode(value: unknown): Signed<T>; encode(value: { fields: T; signature: DualSignature }): WireSigned }

export function editSigned<T>(wire: WireSigned, codec: AnyCodec<T>, change: (fields: T) => void): void {
  const { fields, signature } = codec.decode(wire);
  change(fields);
  wire.bytes = codec.encode({ fields, signature }).bytes;
}

// The opening of a session, as both parties would really sign it. The keys inside are stand-ins: only a session's own daemons ever use them.
export async function sessionOpening(server: Signer, sessionId: Uint8Array, caller: Signer, callee: Signer): Promise<{ offer: WireSigned; accept: WireSigned }> {
  const offerFields = { serverId: server.id, sessionId, callerId: caller.id, calleeId: callee.id, x25519Public: new Uint8Array(32).fill(1), mlKemPublic: new Uint8Array(1184).fill(2), expiresAt: 2_000_000_000_000, signalsCiphertext: new Uint8Array(0), sealedSignals: new Uint8Array(0) };
  const bytes = offerBytes(offerFields);
  const acceptFields = { offerHash: structureHash(bytes), x25519Public: new Uint8Array(32).fill(3), mlKemCiphertext: new Uint8Array(1088).fill(4), sealedSalt: new Uint8Array(60).fill(5), sealedName: new Uint8Array(30).fill(6), sealedSignals: new Uint8Array(0) };
  return {
    offer: signedOffer.encode({ fields: offerFields, signature: await caller.sign("cello-session-offer", bytes) }),
    accept: signedAccept.encode({ fields: acceptFields, signature: await callee.sign("cello-session-accept", acceptBytes(acceptFields)) }),
  };
}

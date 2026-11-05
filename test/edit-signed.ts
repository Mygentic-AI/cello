// A tamperer's edit: changes what a signed thing says and keeps its signature, the way anyone holding the bytes could.
import { type DualSignature } from "../src/protocol/identity.ts";
import { type Signed, type WireSigned } from "../src/protocol/wire.ts";

interface AnyCodec<T> { decode(value: unknown): Signed<T>; encode(value: { fields: T; signature: DualSignature }): WireSigned }

export function editSigned<T>(wire: WireSigned, codec: AnyCodec<T>, change: (fields: T) => void): void {
  const { fields, signature } = codec.decode(wire);
  change(fields);
  wire.bytes = codec.encode({ fields, signature }).bytes;
}

// Small byte helpers. Signed and hashed bytes are built in structures.ts, as CBOR arrays.

export const HASH_BYTES = 32;
export const SESSION_ID_BYTES = 16;
export const ZERO_HASH: Uint8Array = new Uint8Array(HASH_BYTES);

export function exact(name: string, value: Uint8Array, width: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== width) {
    throw new RangeError(`${name} must be ${width} bytes, got ${value instanceof Uint8Array ? value.length : "none"}`);
  }
  return value;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

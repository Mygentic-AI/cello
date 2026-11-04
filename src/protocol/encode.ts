// Canonical bytes for everything that gets signed or hashed.
// Each field is length-prefixed, so fields can't be re-split to give the same bytes from other inputs.

export const HASH_BYTES = 32;
export const SESSION_ID_BYTES = 16;
export const ZERO_HASH: Uint8Array = new Uint8Array(HASH_BYTES);

export function u8(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError(`not a u8: ${value}`);
  return Uint8Array.of(value);
}

export function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`not a u64 this code can hold exactly: ${value}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

export function exact(name: string, value: Uint8Array, width: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== width) {
    throw new RangeError(`${name} must be ${width} bytes, got ${value instanceof Uint8Array ? value.length : "none"}`);
  }
  return value;
}

export function encodeFields(fields: readonly Uint8Array[]): Uint8Array {
  const total = fields.reduce((sum, f) => sum + 4 + f.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const field of fields) {
    view.setUint32(at, field.length);
    at += 4;
    out.set(field, at);
    at += field.length;
  }
  return out;
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

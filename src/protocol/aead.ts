import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const SESSION_CONTENT_SEAL_V1 = 0x01;

export const SESSION_CONTENT_SEAL_OVERHEAD_BYTES = 1 + IV_BYTES + TAG_BYTES;

export function sealSessionContent(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (key.length !== KEY_BYTES) {
    throw new Error(`session encryption: the key must be ${KEY_BYTES} bytes`);
  }
  const iv = new Uint8Array(randomBytes(IV_BYTES));
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(iv));
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(
    Buffer.concat([Buffer.from([SESSION_CONTENT_SEAL_V1]), Buffer.from(iv), ct, tag]),
  );
}

export function openSessionContent(key: Uint8Array, blob: Uint8Array): Uint8Array | null {
  if (key.length !== KEY_BYTES) return null;
  if (blob.length < SESSION_CONTENT_SEAL_OVERHEAD_BYTES) return null;
  if (blob[0] !== SESSION_CONTENT_SEAL_V1) return null;

  const iv = blob.subarray(1, 1 + IV_BYTES);
  const ct = blob.subarray(1 + IV_BYTES, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(iv));
    decipher.setAuthTag(Buffer.from(tag));
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ct)), decipher.final()]));
  } catch {
    return null;
  }
}

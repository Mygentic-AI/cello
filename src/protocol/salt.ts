import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { randomBytes } from "node:crypto";

export const SALT_CONTRIBUTION_BYTES = 32;
export const SESSION_SALT_BYTES = 32;

const ENC = new TextEncoder();
const INFO_SESSION_SALT = ENC.encode("cello-session-salt");

export function generateSaltContribution(): Uint8Array {
  return new Uint8Array(randomBytes(SALT_CONTRIBUTION_BYTES));
}

function isAllZero(b: Uint8Array): boolean {
  let acc = 0;
  for (const x of b) acc |= x;
  return acc === 0;
}

export function deriveSessionSalt(ourContribution: Uint8Array, peerContribution: Uint8Array): Uint8Array {
  if (peerContribution.length !== SALT_CONTRIBUTION_BYTES) {
    throw new Error(`session salt: the peer contribution must be ${SALT_CONTRIBUTION_BYTES} bytes`);
  }
  if (isAllZero(peerContribution)) {
    throw new Error("session salt: the peer contribution is all zeros");
  }
  if (ourContribution.length !== SALT_CONTRIBUTION_BYTES) {
    throw new Error(`session salt: our contribution must be ${SALT_CONTRIBUTION_BYTES} bytes`);
  }
  if (isAllZero(ourContribution)) {
    throw new Error("session salt: our contribution is all zeros");
  }
  if (Buffer.compare(Buffer.from(ourContribution), Buffer.from(peerContribution)) === 0) {
    throw new Error("session salt: the peer sent back our own contribution");
  }

  const [first, second] = Buffer.compare(Buffer.from(ourContribution), Buffer.from(peerContribution)) < 0
    ? [ourContribution, peerContribution]
    : [peerContribution, ourContribution];

  const ikm = new Uint8Array(first.length + second.length);
  ikm.set(first, 0);
  ikm.set(second, first.length);
  return hkdf(sha256, ikm, new Uint8Array(0), INFO_SESSION_SALT, SESSION_SALT_BYTES);
}

export function saltedContentHash(salt: Uint8Array, content: Uint8Array): Uint8Array {
  const msg = new Uint8Array(1 + content.length);
  msg[0] = 0x00;
  msg.set(content, 1);
  return hmac(sha256, salt, msg);
}

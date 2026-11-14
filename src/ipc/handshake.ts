// On Windows the daemon's pipe has a predictable name and lives in a namespace every local user shares, so another
// account can create it first and pose as the daemon: the real one then can't start, and every request goes to the
// impostor. A socket file can't be taken that way, because it sits in a folder only its owner can open.
//
// So on Windows a client makes the daemon prove itself before it sends anything. At each start the daemon writes a
// fresh random key to a file in the CELLO home, which only this user can read. The client sends a nonce, and the daemon
// answers with an HMAC of it under that key. The nonce is fresh each time, so an answer seen once can't be replayed.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const HELLO_METHOD = "hello";

export const ipcHandshakeRequired = (platform: NodeJS.Platform = process.platform): boolean => platform === "win32";

export const newIpcKey = (): string => randomBytes(32).toString("hex");
export const newNonce = (): string => randomBytes(32).toString("hex");

export function daemonProof(keyHex: string, nonceHex: string): string {
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update("cello-daemon-ipc-v1\0").update(Buffer.from(nonceHex, "hex")).digest("hex");
}

export function proofHolds(keyHex: string, nonceHex: string, proof: unknown): boolean {
  if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return timingSafeEqual(Buffer.from(daemonProof(keyHex, nonceHex), "hex"), Buffer.from(proof, "hex"));
}

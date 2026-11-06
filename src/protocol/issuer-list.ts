// The signed list of recognised issuers. It decides trust, not DNS or certificates: any two of three root keys sign it.
// Roots sign one classical signature each, because a Secure Enclave key can only be P-256.
import { ed25519 } from "@noble/curves/ed25519.js";
import { webcrypto } from "node:crypto";
import { decodeCbor, encodeCbor } from "./cbor.ts";
import { equalBytes, toHex } from "./encode.ts";
import { ED25519_PUBLIC_KEY_BYTES, type PublicIdentity, frame } from "./identity.ts";
import { ML_DSA_PUBLIC_KEY_BYTES } from "./ml-dsa.ts";
import { UnknownFormat, assertFlat } from "./structures.ts";

export const ISSUER_ENTRY_DOMAIN = "cello-issuer-entry-v1";
export const ISSUER_LIST_DOMAIN = "cello-issuer-list-v1";
export const SIGNED_ISSUER_LIST_DOMAIN = "cello-signed-issuer-list-v1";

export const REQUIRED_ROOT_SIGNATURES = 2;
const MAX_ISSUER_LIST_BYTES = 1_048_576;
const MAX_ENTRY_BYTES = 4_096;
const P256_PUBLIC_KEY_BYTES = 65;
const ROOT_SIGNATURE_BYTES = 64;
const MAX_EPOCH_SECONDS = 100_000_000_000;
const ISSUER_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

// Slot order in the signed file, and in the configured keys.
export const ROOT_NAMES = ["enclave", "kms", "paper"] as const;
export type RootName = (typeof ROOT_NAMES)[number];
export type RootAlgorithm = "p256" | "ed25519";

export interface RootKey {
  name: RootName;
  algorithm: RootAlgorithm;
  // P-256: 65 bytes, uncompressed. Ed25519: 32 bytes.
  publicKey: Uint8Array;
}

export class RootKeysNotConfigured extends Error {
  readonly code = "root_keys_not_configured";
}

// Trusts nothing unless all three are present, distinct and the right shape. The algorithm comes from here, never from a signed file.
export function rootKeysFrom(config: Readonly<Record<RootName, Omit<RootKey, "name"> | null | undefined>>): readonly RootKey[] {
  const keys = ROOT_NAMES.map((name): RootKey => {
    const key = config[name];
    if (!key) throw new RootKeysNotConfigured(`root key "${name}" isn't configured, so no issuer list can be trusted`);
    if (name === "enclave" && key.algorithm !== "p256") throw new RootKeysNotConfigured("the enclave root key must be P-256");
    const width = key.algorithm === "p256" ? P256_PUBLIC_KEY_BYTES : key.algorithm === "ed25519" ? ED25519_PUBLIC_KEY_BYTES : null;
    if (width === null || !(key.publicKey instanceof Uint8Array) || key.publicKey.length !== width) throw new RootKeysNotConfigured(`root key "${name}" isn't a valid ${String(key.algorithm)} public key`);
    return { name, algorithm: key.algorithm, publicKey: key.publicKey };
  });
  if (new Set(keys.map((key) => toHex(key.publicKey))).size !== keys.length) throw new RootKeysNotConfigured("two root slots hold the same key, so one key could count twice");
  return keys;
}

export interface IssuerEntry {
  name: string;
  ed: Uint8Array;
  pq: Uint8Array;
  expires_at: number;
}

export interface IssuerList {
  issued_at: number;
  expires_at: number;
  issuers: readonly IssuerEntry[];
}

function seconds(name: string, value: unknown): number | bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= MAX_EPOCH_SECONDS) throw new RangeError(`${name} must be whole epoch seconds, got ${String(value)}`);
  return value > 0xffffffff ? BigInt(value) : value;
}

const readSeconds = (name: string, value: unknown): number => {
  const asNumber = typeof value === "bigint" ? Number(value) : value;
  seconds(name, asNumber);
  return asNumber as number;
};

export function encodeIssuerEntry(entry: IssuerEntry): Uint8Array {
  if (typeof entry.name !== "string" || !ISSUER_DOMAIN.test(entry.name)) throw new RangeError("an issuer's name must be its domain, in lowercase");
  if (!(entry.ed instanceof Uint8Array) || entry.ed.length !== ED25519_PUBLIC_KEY_BYTES) throw new RangeError(`an issuer's Ed25519 key must be ${ED25519_PUBLIC_KEY_BYTES} bytes`);
  if (!(entry.pq instanceof Uint8Array) || entry.pq.length !== ML_DSA_PUBLIC_KEY_BYTES) throw new RangeError(`an issuer's ML-DSA key must be ${ML_DSA_PUBLIC_KEY_BYTES} bytes`);
  return new Uint8Array(encodeCbor([ISSUER_ENTRY_DOMAIN, entry.name, entry.ed, entry.pq, seconds("expires_at", entry.expires_at)]));
}

function decodeIssuerEntry(bytes: Uint8Array): IssuerEntry {
  if (bytes.length > MAX_ENTRY_BYTES) throw new RangeError(`an issuer entry can't be over ${MAX_ENTRY_BYTES} bytes`);
  assertFlat(bytes, 5);
  const [domain, name, ed, pq, expiresAt] = decodeCbor(bytes) as unknown[];
  if (domain !== ISSUER_ENTRY_DOMAIN) throw new UnknownFormat(`${ISSUER_ENTRY_DOMAIN} was expected`);
  if (!(ed instanceof Uint8Array) || !(pq instanceof Uint8Array)) throw new RangeError("an issuer entry needs both public keys");
  const entry: IssuerEntry = { name: name as string, ed: new Uint8Array(ed), pq: new Uint8Array(pq), expires_at: readSeconds("expires_at", expiresAt) };
  if (!equalBytes(encodeIssuerEntry(entry), bytes)) throw new RangeError("this issuer entry's bytes aren't canonical");
  return entry;
}

// Each entry is bytes in a slot of a flat array, so nothing nested reaches the decoder.
export function encodeIssuerList(list: IssuerList): Uint8Array {
  if (list.expires_at <= list.issued_at) throw new RangeError("an issuer list must expire after it's issued");
  const names = new Set<string>();
  const keys = new Set<string>();
  for (const entry of list.issuers) {
    names.add(entry.name);
    keys.add(toHex(entry.ed));
    keys.add(toHex(entry.pq));
  }
  if (names.size !== list.issuers.length || keys.size !== list.issuers.length * 2) throw new RangeError("an issuer list can't name an issuer or a key twice");
  return new Uint8Array(encodeCbor([ISSUER_LIST_DOMAIN, seconds("issued_at", list.issued_at), seconds("expires_at", list.expires_at), ...list.issuers.map(encodeIssuerEntry)]));
}

export function decodeIssuerList(bytes: Uint8Array): IssuerList {
  if (bytes.length > MAX_ISSUER_LIST_BYTES) throw new RangeError(`an issuer list can't be over ${MAX_ISSUER_LIST_BYTES} bytes`);
  assertFlat(bytes, null);
  const items = decodeCbor(bytes) as unknown[];
  if (items.length < 3) throw new RangeError("an issuer list needs its dates");
  if (items[0] !== ISSUER_LIST_DOMAIN) throw new UnknownFormat(`${ISSUER_LIST_DOMAIN} was expected`);
  const issuers = items.slice(3).map((item) => {
    if (!(item instanceof Uint8Array)) throw new RangeError("each issuer must be its own bytes");
    return decodeIssuerEntry(new Uint8Array(item));
  });
  const list: IssuerList = { issued_at: readSeconds("issued_at", items[1]), expires_at: readSeconds("expires_at", items[2]), issuers };
  if (!equalBytes(encodeIssuerList(list), bytes)) throw new RangeError("this issuer list's bytes aren't canonical");
  return list;
}

export interface SignedIssuerList {
  listBytes: Uint8Array;
  signatures: Readonly<Record<RootName, Uint8Array | null>>;
}

export function encodeSignedIssuerList(signed: SignedIssuerList): Uint8Array {
  return new Uint8Array(encodeCbor([SIGNED_ISSUER_LIST_DOMAIN, signed.listBytes, ...ROOT_NAMES.map((name) => signed.signatures[name])]));
}

export function readSignedIssuerList(file: Uint8Array): SignedIssuerList {
  if (file.length > MAX_ISSUER_LIST_BYTES + 512) throw new RangeError("a signed issuer list is too long");
  assertFlat(file, 2 + ROOT_NAMES.length);
  const [domain, listBytes, ...slots] = decodeCbor(file) as unknown[];
  if (domain !== SIGNED_ISSUER_LIST_DOMAIN) throw new UnknownFormat(`${SIGNED_ISSUER_LIST_DOMAIN} was expected`);
  if (!(listBytes instanceof Uint8Array)) throw new RangeError("a signed issuer list needs its list");
  const slot = (i: number): Uint8Array | null => {
    const value = slots[i];
    if (value === null) return null;
    if (!(value instanceof Uint8Array) || value.length !== ROOT_SIGNATURE_BYTES) throw new RangeError(`a root signature must be ${ROOT_SIGNATURE_BYTES} bytes, r then s`);
    return new Uint8Array(value);
  };
  const signed: SignedIssuerList = { listBytes: new Uint8Array(listBytes), signatures: { enclave: slot(0), kms: slot(1), paper: slot(2) } };
  if (!equalBytes(encodeSignedIssuerList(signed), file)) throw new RangeError("this signed issuer list's bytes aren't canonical");
  return signed;
}

export const issuerListSigningMessage = (listBytes: Uint8Array): Uint8Array => frame("cello-issuer-list", listBytes);

// Real ones are the Mac's Secure Enclave, Cloud KMS and the paper key, none of which this code holds. Returns the raw 64-byte signature:
// r then s for P-256 over SHA-256 of the message, which is how the verifier below reads it.
export interface RootSigner {
  root: RootName;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

async function rootSignatureVerifies(key: RootKey, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    if (key.algorithm === "ed25519") return ed25519.verify(signature, message, key.publicKey, { zip215: false });
    const imported = await webcrypto.subtle.importKey("raw", new Uint8Array(key.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, imported, new Uint8Array(signature), new Uint8Array(message));
  } catch {
    return false;
  }
}

// Adds one root's signature to a new or partly signed file, and refuses one that doesn't verify against that root.
export async function addRootSignature(existing: SignedIssuerList | { listBytes: Uint8Array }, signer: RootSigner, roots: readonly RootKey[]): Promise<SignedIssuerList> {
  const key = rootKeysFrom(asConfig(roots)).find((candidate) => candidate.name === signer.root);
  if (!key) throw new RootKeysNotConfigured(`no root is named ${String(signer.root)}`);
  decodeIssuerList(existing.listBytes);
  const signature = await signer.sign(issuerListSigningMessage(existing.listBytes));
  if (!(signature instanceof Uint8Array) || signature.length !== ROOT_SIGNATURE_BYTES || !(await rootSignatureVerifies(key, issuerListSigningMessage(existing.listBytes), signature))) {
    throw new Error(`that signature doesn't verify against the ${signer.root} root key. Nothing was written.`);
  }
  const before = "signatures" in existing ? existing.signatures : { enclave: null, kms: null, paper: null };
  return { listBytes: existing.listBytes, signatures: { ...before, [signer.root]: signature } };
}

const asConfig = (roots: readonly RootKey[]): Record<RootName, RootKey | null> => ({
  enclave: roots.find((root) => root.name === "enclave") ?? null,
  kms: roots.find((root) => root.name === "kms") ?? null,
  paper: roots.find((root) => root.name === "paper") ?? null,
});

export type IssuerListFault = "malformed" | "unknown_format" | "not_enough_signatures" | "expired";
export type IssuerListCheck = { ok: true; list: IssuerList } | { ok: false; fault: IssuerListFault; message: string };

// A bad root configuration throws: that's this installation's fault, never the file's, and it must not read as a bad list.
export async function verifyIssuerList(file: Uint8Array, roots: readonly RootKey[], now: number): Promise<IssuerListCheck> {
  const keys = rootKeysFrom(asConfig(roots));
  let signed: SignedIssuerList;
  let list: IssuerList;
  try {
    signed = readSignedIssuerList(file);
    list = decodeIssuerList(signed.listBytes);
  } catch (err: unknown) {
    return { ok: false, fault: err instanceof UnknownFormat ? "unknown_format" : "malformed", message: err instanceof Error ? err.message : String(err) };
  }
  const message = issuerListSigningMessage(signed.listBytes);
  let valid = 0;
  for (const key of keys) {
    const signature = signed.signatures[key.name];
    if (signature && (await rootSignatureVerifies(key, message, signature))) valid += 1;
  }
  if (valid < REQUIRED_ROOT_SIGNATURES) return { ok: false, fault: "not_enough_signatures", message: `this list has ${valid} valid root signature${valid === 1 ? "" : "s"}, and it needs ${REQUIRED_ROOT_SIGNATURES}` };
  if (list.expires_at <= now) return { ok: false, fault: "expired", message: `this issuer list expired at ${list.expires_at}` };
  return { ok: true, list };
}

// Matches both keys and the domain the signal states, exactly, so a listed issuer can't sign under another's name.
// Null means unknown, or expired from the list.
export function recognisedIssuer(list: IssuerList, issuer: PublicIdentity, issuerAddress: string, now: number): IssuerEntry | null {
  return list.issuers.find((entry) => entry.name === issuerAddress && equalBytes(entry.ed, issuer.ed) && equalBytes(entry.pq, issuer.pq) && entry.expires_at > now) ?? null;
}

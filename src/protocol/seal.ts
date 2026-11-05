// A seal record, and the check anyone can run on one: public keys only, with no server, daemon or database.
// The reader supplies the seal key's id. A record checked only against a key it carries proves nothing,
// because anyone can make a key and sign whatever they like with it.
import { ZERO_HASH, equalBytes, toHex } from "./encode.ts";
import { type DualSignature, type PublicIdentity, identityId, verifySignature } from "./identity.ts";
import { verifyConsistency, verifyInclusion } from "./merkle.ts";
import {
  type DeliveryAckFields,
  type SealCertificateFields,
  type SealLogHeadFields,
  type SealRequestFields,
  sealKeyBindingBytes,
  structureHash,
} from "./structures.ts";
import { type Signed, type WireSigned, WireError, fromB64, identityCodec, readInt, readObjectField, signatureCodec, signedDeliveryAck, signedSealCertificate, signedSealLogHead, signedSealRequest, toB64 } from "./wire.ts";

export const SEAL_RECORD_FORMAT = "cello-seal";

export interface SealRecordOnWire {
  format: typeof SEAL_RECORD_FORMAT;
  certificate: WireSigned;
  request: WireSigned;
  // Null when the counterparty has acknowledged nothing.
  deliveryAck: WireSigned | null;
  // Links the root the counterparty signed to the sealed root. Empty when the two are the same position.
  deliveryProof: string[];
  sealer: Record<string, string | number>;
  counterparty: Record<string, string | number>;
  sealKey: Record<string, string | number>;
  server: Record<string, string | number>;
  sealKeyBinding: Record<string, string | number>;
  log: { index: number; head: WireSigned; path: string[] };
}

export interface SealRecord {
  certificate: Signed<SealCertificateFields>;
  request: Signed<SealRequestFields>;
  deliveryAck: Signed<DeliveryAckFields> | null;
  deliveryProof: Uint8Array[];
  sealer: PublicIdentity;
  counterparty: PublicIdentity;
  sealKey: PublicIdentity;
  server: PublicIdentity;
  sealKeyBinding: DualSignature;
  log: { index: number; head: Signed<SealLogHeadFields>; path: Uint8Array[] };
}

function readHashes(value: unknown, name: string): Uint8Array[] {
  if (!Array.isArray(value)) throw new RangeError(`${name} isn't a list`);
  return value.map((hash, i) => fromB64(hash, `${name}[${i}]`));
}

export function encodeHashes(hashes: readonly Uint8Array[]): string[] {
  return hashes.map(toB64);
}

// Throws on anything malformed. checkSealRecord turns that into a named fault.
export function decodeSealRecord(raw: unknown): SealRecord {
  const value = readObjectField(raw, "record");
  if (value["format"] !== SEAL_RECORD_FORMAT) throw new RangeError(`this isn't a ${SEAL_RECORD_FORMAT} record`);
  const log = readObjectField(value["log"], "log");
  return {
    certificate: signedSealCertificate.decode(value["certificate"], "certificate"),
    request: signedSealRequest.decode(value["request"], "request"),
    deliveryAck: value["deliveryAck"] === null ? null : signedDeliveryAck.decode(value["deliveryAck"], "deliveryAck"),
    deliveryProof: readHashes(value["deliveryProof"], "deliveryProof"),
    sealer: identityCodec.decode(value["sealer"], "sealer"),
    counterparty: identityCodec.decode(value["counterparty"], "counterparty"),
    sealKey: identityCodec.decode(value["sealKey"], "sealKey"),
    server: identityCodec.decode(value["server"], "server"),
    sealKeyBinding: signatureCodec.decode(value["sealKeyBinding"], "sealKeyBinding"),
    log: { index: readInt(log["index"], "log.index"), head: signedSealLogHead.decode(log["head"], "log.head"), path: readHashes(log["path"], "log.path") },
  };
}

// A seal's id is its place in the seal log: the hash of what the seal key signed.
export function sealId(certificateBytes: Uint8Array): Uint8Array {
  return structureHash(certificateBytes);
}

export type SealFault =
  | "malformed_record"
  | "unknown_format"
  | "wrong_seal_key"
  | "bad_seal_key_binding"
  | "bad_seal_signature"
  | "wrong_sealer_keys"
  | "bad_seal_request"
  | "seal_request_mismatch"
  | "wrong_counterparty_keys"
  | "impossible_positions"
  | "delivery_ack_mismatch"
  | "bad_delivery_ack_signature"
  | "delivery_proof_failed"
  | "bad_log_head_signature"
  | "log_proof_failed";

const FAULT_MESSAGES: Record<SealFault, string> = {
  malformed_record: "This file isn't a readable seal record",
  unknown_format: "This record is in a format this reader doesn't know. That says nothing about whether it's genuine, so use a newer reader",
  wrong_seal_key: "This record's seal key isn't the one you named, so it says nothing about that server",
  bad_seal_key_binding: "The server's identity doesn't vouch for this seal key",
  bad_seal_signature: "The certificate has been changed, or wasn't signed by this seal key",
  wrong_sealer_keys: "The sealer's keys in this record don't match the certificate",
  bad_seal_request: "The sealer didn't sign the request behind this certificate",
  seal_request_mismatch: "The certificate differs from what the sealer asked to have sealed",
  wrong_counterparty_keys: "The counterparty's keys in this record don't match the certificate",
  impossible_positions: "The certificate's positions can't be true together",
  delivery_ack_mismatch: "The number received doesn't match the counterparty's signed delivery ack",
  bad_delivery_ack_signature: "The counterparty didn't sign this delivery ack",
  delivery_proof_failed: "What the counterparty signed isn't a part of the same history as the sealed root",
  bad_log_head_signature: "The seal log's state wasn't signed by this seal key",
  log_proof_failed: "This seal isn't in the seal log state it claims",
};

export type SealCheck = { ok: true; record: SealRecord } | { ok: false; fault: SealFault; message: string };

function fail(fault: SealFault, detail?: string): SealCheck {
  return { ok: false, fault, message: detail ? `${FAULT_MESSAGES[fault]}: ${detail}` : FAULT_MESSAGES[fault] };
}

async function findFault(record: SealRecord, sealKeyId: Uint8Array): Promise<SealCheck | null> {
  const cert = record.certificate.fields;
  const actualKeyId = identityId(record.sealKey);
  if (!equalBytes(actualKeyId, sealKeyId) || !equalBytes(cert.sealKeyId, sealKeyId)) return fail("wrong_seal_key", `it carries ${toHex(actualKeyId)}`);
  if (!equalBytes(identityId(record.server), cert.serverId)) return fail("bad_seal_key_binding");
  if (!(await verifySignature(record.server, "cello-seal-key-binding", sealKeyBindingBytes({ serverId: cert.serverId, sealKeyId }), record.sealKeyBinding))) return fail("bad_seal_key_binding");
  if (!(await verifySignature(record.sealKey, "cello-seal-certificate", record.certificate.bytes, record.certificate.signature))) return fail("bad_seal_signature");

  if (!equalBytes(identityId(record.sealer), cert.sealerId)) return fail("wrong_sealer_keys");
  const request = record.request.fields;
  const requestBytes = record.request.bytes;
  if (!(await verifySignature(record.sealer, "cello-seal-request", requestBytes, record.request.signature))) return fail("bad_seal_request");
  const asked = equalBytes(structureHash(requestBytes), cert.requestHash)
    && equalBytes(request.sealerId, cert.sealerId)
    && equalBytes(request.sessionId, cert.sessionId)
    && equalBytes(request.serverId, cert.serverId)
    && equalBytes(request.root, cert.root)
    && request.throughPosition === cert.throughPosition;
  if (!asked) return fail("seal_request_mismatch");

  if (!equalBytes(identityId(record.counterparty), cert.counterpartyId)) return fail("wrong_counterparty_keys");
  if (equalBytes(cert.sealerId, cert.counterpartyId)) return fail("impossible_positions", "the sealer and the counterparty are the same");
  const positionsPossible = cert.throughPosition >= 1 && cert.tip >= cert.throughPosition && cert.receivedThrough <= cert.throughPosition;
  if (!positionsPossible) return fail("impossible_positions");

  const deliveryFault = await findDeliveryFault(record);
  if (deliveryFault) return deliveryFault;

  const head = record.log.head;
  if (!equalBytes(head.fields.sealKeyId, sealKeyId) || !(await verifySignature(record.sealKey, "cello-seal-log-head", head.bytes, head.signature))) return fail("bad_log_head_signature");
  if (!verifyInclusion(sealId(record.certificate.bytes), record.log.index, head.fields.size, head.fields.root, record.log.path)) return fail("log_proof_failed");
  return null;
}

// M counts delivery acks only, and the check runs on the counterparty's own signature, never the server's word.
async function findDeliveryFault(record: SealRecord): Promise<SealCheck | null> {
  const cert = record.certificate.fields;
  const signed = record.deliveryAck;
  if (!signed) {
    if (cert.receivedThrough !== 0 || !equalBytes(cert.deliveryAckHash, ZERO_HASH)) return fail("delivery_ack_mismatch", "there's no delivery ack behind this number");
    return record.deliveryProof.length === 0 ? null : fail("delivery_proof_failed");
  }
  const ack = signed.fields;
  const { bytes } = signed;
  if (!equalBytes(structureHash(bytes), cert.deliveryAckHash)) return fail("delivery_ack_mismatch", "the certificate names a different ack");
  if (!equalBytes(ack.readerId, cert.counterpartyId) || !equalBytes(ack.sessionId, cert.sessionId)) return fail("delivery_ack_mismatch", "this ack isn't the counterparty's, for this session");
  if (Math.min(ack.throughPosition, cert.throughPosition) !== cert.receivedThrough || cert.receivedThrough < 1) {
    return fail("delivery_ack_mismatch", `the certificate says ${cert.receivedThrough}, and the counterparty signed through ${ack.throughPosition}`);
  }
  if (!(await verifySignature(record.counterparty, "cello-delivery-ack", bytes, signed.signature))) return fail("bad_delivery_ack_signature");
  const linked = ack.throughPosition <= cert.throughPosition
    ? verifyConsistency(ack.throughPosition, cert.throughPosition, ack.root, cert.root, record.deliveryProof)
    : verifyConsistency(cert.throughPosition, ack.throughPosition, cert.root, ack.root, record.deliveryProof);
  return linked ? null : fail("delivery_proof_failed");
}

// Never throws on a bad record: every bad input is a named fault.
export async function checkSealRecord(raw: unknown, sealKeyId: Uint8Array): Promise<SealCheck> {
  let record: SealRecord;
  try {
    record = decodeSealRecord(raw);
    identityId(record.sealKey);
    identityId(record.server);
    identityId(record.sealer);
    identityId(record.counterparty);
  } catch (err: unknown) {
    if (err instanceof WireError && err.code === "unsupported_version") return fail("unknown_format", err.message);
    return fail("malformed_record", err instanceof Error ? err.message : String(err));
  }
  return (await findFault(record, sealKeyId)) ?? { ok: true, record };
}

// What the seal does and doesn't show, for a person to read. Neutral on agreement, always.
export function describeSeal(record: SealRecord): Record<string, string> {
  const cert = record.certificate.fields;
  const n = cert.throughPosition;
  const m = cert.receivedThrough;
  const beyond = cert.tip - n;
  return {
    meaning: "A seal attests that this conversation took place. It says nothing about whether the parties agreed.",
    proven_without_trusting_the_server: m > 0
      ? `Positions 1 to ${m}: the counterparty's own signature says its machine stored and decrypted these, in this order. That rests on its key, not on the server. Received means stored and decrypted, not read.`
      : "Nothing: the counterparty has signed no delivery ack for any of this.",
    rests_on_the_server: `${m < n
      ? `Positions ${m + 1} to ${n}: only the sealer and the server say these were witnessed in this order. The counterparty hasn't confirmed receiving them. `
      : "Every position is covered by the counterparty's signature. "}Also the time, how many positions the session had, and whether it had closed: no counterparty signature stands behind those.`,
    how_much_this_covers: `${beyond > 0 ? `This is a partial seal. The server says the session had ${cert.tip} positions when sealed, and this covers ${n}, so ${beyond} more exist that it doesn't cover.` : `The server says the session had ${n} positions when sealed, and this covers all of them.`} ${cert.closed === 1 ? "The server says the session had closed on both sides." : "The server says the session hadn't closed, so more may have followed."}`,
    who_signed: "Check that session_id is the conversation you mean, and that counterparty_id is who you expect. The same two parties can have other sessions. The signature behind the received number is that key's, and an id is all it proves.",
    seal_log: "This seal is in its server's own log. Nobody outside witnesses that log yet, so its operator could rewrite it.",
    contents: "This record holds hashes and signatures only. It doesn't show what was said.",
  };
}

// A time inside a signed record comes from outside, and a number too large for a date shouldn't crash the reader.
export function readableTime(time: number): string | null {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function sealSummary(record: SealRecord): Record<string, unknown> {
  const cert = record.certificate.fields;
  return {
    seal_id: toHex(sealId(record.certificate.bytes)),
    seal_key: toHex(cert.sealKeyId),
    session_id: toHex(cert.sessionId),
    sealer_id: toHex(cert.sealerId),
    counterparty_id: toHex(cert.counterpartyId),
    root: toHex(cert.root),
    witnessed_through: cert.throughPosition,
    received_through: cert.receivedThrough,
    tip_when_sealed: cert.tip,
    partial: cert.throughPosition < cert.tip,
    session_closed: cert.closed === 1,
    sealed_at: readableTime(cert.time),
    log_index: record.log.index,
    log_size: record.log.head.fields.size,
  };
}

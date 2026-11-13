// The wallet: signals about this daemon's agents. Rules from cello-client's trust-signal-store.ts: see COPIED.md.
// A signal names one agent's key, so a row belongs to that agent. It's stored under its hash, so a repeat changes nothing.
// `type` and `payload` stay opaque here: a type this client has never seen stores and reads like a known one.
import { toHex } from "../protocol/encode.ts";
import type { SignedSignal } from "../protocol/signal.ts";
import { logEvent } from "./log.ts";
import type { Store } from "./store.ts";

export type SignalStatus = "active" | "superseded";
// The wallet's `public` column: 0 not public, 1 public, 2 public on the server but being taken back.
export const PUBLIC_NO = 0;
export const PUBLIC_YES = 1;
export const PUBLIC_WITHDRAWING = 2;
export const CONSENT_ACCEPTED = "accepted";
// The type the issuer gives every endorsement, whoever wrote it.
const ENDORSEMENT = "endorsement";

export interface WalletRow {
  agent_id: Uint8Array;
  signal_hash: string;
  file: Uint8Array;
  subject_kind: string;
  issuer_kind: string;
  issuer_pubkey: string;
  issuer_address: string;
  type: string;
  schema_version: number;
  payload: Uint8Array;
  issued_at: number;
  expires_at: number | null;
  supersedes_hash: string | null;
  same_operator: number;
  status: SignalStatus;
  received_at: number;
  default_present: number;
  consent_state: string;
  public: number;
}

export interface TrustedIssuerRow { issuer_address: string; issuer_pubkey: string; added_at: number }

export function ensureSignalSchema(db: Store): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS signal_wallet (
  agent_id        BLOB NOT NULL REFERENCES agents(agent_id),
  signal_hash     TEXT NOT NULL,
  file            BLOB NOT NULL,
  subject_kind    TEXT NOT NULL,
  issuer_kind     TEXT NOT NULL,
  issuer_pubkey   TEXT NOT NULL,
  issuer_address  TEXT NOT NULL,
  type            TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  payload         BLOB NOT NULL,
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER,
  supersedes_hash TEXT,
  same_operator   INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  received_at     INTEGER NOT NULL,
  default_present INTEGER NOT NULL,
  consent_state   TEXT NOT NULL CHECK (consent_state IN ('pending', 'accepted', 'refused')),
  public          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, signal_hash)
);
-- Who this machine's owner chose to trust beyond the signed list. Only a person at a terminal adds one.
CREATE TABLE IF NOT EXISTS trusted_issuers (
  issuer_address TEXT NOT NULL,
  issuer_pubkey  TEXT NOT NULL,
  added_at       INTEGER NOT NULL,
  PRIMARY KEY (issuer_address, issuer_pubkey)
);`);
}

export class SignalStore {
  readonly #db: ReturnType<Store["raw"]>;

  constructor(store: Store) {
    this.#db = store.raw();
  }

  // Issued about the agent by an issuer it asked: accepted. Issued by another agent: it waits for the subject's decision.
  put(agentId: Uint8Array, signal: SignedSignal, file: Uint8Array): boolean {
    const e = signal.envelope;
    const hash = toHex(signal.hash);
    if (this.get(agentId, hash)) return false;
    const supersedes = e.supersedes_hash === null ? null : toHex(e.supersedes_hash);
    const consent = e.issuer_kind === "agent" ? "pending" : CONSENT_ACCEPTED;
    // A renewal keeps the person's choice: the signal it replaces says whether it was shown. A new one follows the type's default:
    // identifying signals and Usage's detailed variety are left out, so standard Usage is what's shown unless the person changes it.
    // An issuer that doesn't name what it replaces still replaces its current signal of the same type, so that one's choice carries.
    // Endorsements are one per author under one issuer key, so only a named supersedes says which one this replaces.
    const named = supersedes === null ? undefined : this.get(agentId, supersedes);
    const replaced = (named?.issuer_pubkey === e.issuer_pubkey ? named : undefined)
      ?? (e.type === ENDORSEMENT ? undefined : this.list(agentId).find((r) => r.status === "active" && r.type === e.type && r.issuer_pubkey === e.issuer_pubkey && r.subject_kind === e.subject_kind));
    const shownByDefault = replaced !== undefined
      ? replaced.default_present
      : e.type.endsWith("_id") || e.type === "usage_detailed" ? 0 : 1;
    this.#db.run(
      `INSERT INTO signal_wallet (agent_id, signal_hash, file, subject_kind, issuer_kind, issuer_pubkey, issuer_address, type, schema_version, payload, issued_at, expires_at, supersedes_hash, same_operator, status, received_at, default_present, consent_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [agentId, hash, file, e.subject_kind, e.issuer_kind, e.issuer_pubkey, e.issuer_address, e.type, e.schema_version, e.payload, e.issued_at, e.expires_at, supersedes, e.same_operator ? 1 : 0, Date.now(), shownByDefault, consent],
    );
    logEvent("signal.wallet.stored", { signal: hash, type: e.type, subject_kind: e.subject_kind, issuer_kind: e.issuer_kind });
    if (consent === CONSENT_ACCEPTED) this.#applySupersession(agentId, hash, e.type, e.subject_kind, e.issuer_pubkey, supersedes);
    return true;
  }

  // Only the same issuer can replace its own signal: a stranger's isn't a newer version of yours because it shares a type.
  #applySupersession(agentId: Uint8Array, hash: string, type: string, subjectKind: string, issuerPubkey: string, supersedes: string | null): void {
    if (supersedes) {
      const target = this.get(agentId, supersedes);
      if (target?.issuer_pubkey === issuerPubkey) this.#db.run("UPDATE signal_wallet SET status = 'superseded' WHERE agent_id = ? AND signal_hash = ?", [agentId, supersedes]);
      else logEvent("signal.supersede.refused", { signal: hash, supersedes, reason: target ? "issuer_mismatch" : "target_not_held" });
    }
    // Any other signal of the same type from the same issuer is an older version, except endorsements: the issuer holds one current
    // endorsement per author, so a new one from Carol must not retire Bob's. Those are replaced only by name, above.
    if (type !== ENDORSEMENT) {
      this.#db.run(
        "UPDATE signal_wallet SET status = 'superseded' WHERE agent_id = ? AND subject_kind = ? AND type = ? AND signal_hash != ? AND issuer_pubkey = ? AND status = 'active'",
        [agentId, subjectKind, type, hash, issuerPubkey],
      );
    }
    // A replaced signal must not stay public reading as current. The server still holds it, so it's marked for taking back (public = 2).
    this.#db.run("UPDATE signal_wallet SET public = ? WHERE agent_id = ? AND status = 'superseded' AND public = ?", [PUBLIC_WITHDRAWING, agentId, PUBLIC_YES]);
  }

  // Public on the server and meant to come back off it: what a replaced signal waits as until the server has confirmed.
  withdrawing(agentId: Uint8Array): WalletRow[] {
    return this.#db.all("SELECT * FROM signal_wallet WHERE agent_id = ? AND public = ?", [agentId, PUBLIC_WITHDRAWING]) as WalletRow[];
  }

  get(agentId: Uint8Array, hash: string): WalletRow | undefined {
    return this.#db.get("SELECT * FROM signal_wallet WHERE agent_id = ? AND signal_hash = ?", [agentId, hash]) as WalletRow | undefined;
  }

  list(agentId: Uint8Array): WalletRow[] {
    return this.#db.all("SELECT * FROM signal_wallet WHERE agent_id = ? ORDER BY issued_at DESC, received_at DESC", [agentId]) as WalletRow[];
  }

  // A hash has one spelling, so a prefix is only ever hex, and this says when it means more than one signal.
  byPrefix(agentId: Uint8Array, prefix: string): { row?: WalletRow; matches: number } {
    const rows = this.#db.all("SELECT * FROM signal_wallet WHERE agent_id = ? AND signal_hash LIKE ?", [agentId, `${prefix}%`]) as WalletRow[];
    return { row: rows.length === 1 ? rows[0] : undefined, matches: rows.length };
  }

  setDefaultPresent(agentId: Uint8Array, hash: string, value: boolean): void {
    this.#db.run("UPDATE signal_wallet SET default_present = ? WHERE agent_id = ? AND signal_hash = ?", [value ? 1 : 0, agentId, hash]);
  }

  setPublic(agentId: Uint8Array, hash: string, value: boolean): void {
    this.#db.run("UPDATE signal_wallet SET public = ? WHERE agent_id = ? AND signal_hash = ?", [value ? PUBLIC_YES : PUBLIC_NO, agentId, hash]);
  }

  // Active, unexpired and accepted, about the owner, from this issuer: what can vouch for a new agent on this daemon.
  accountLevel(agentId: Uint8Array, issuerAddress: string, nowSec: number): WalletRow | undefined {
    return this.#db.get(
      `SELECT * FROM signal_wallet WHERE agent_id = ? AND issuer_address = ? AND subject_kind = 'account' AND status = 'active' AND consent_state = '${CONSENT_ACCEPTED}'
       AND (expires_at IS NULL OR expires_at > ?) ORDER BY issued_at DESC LIMIT 1`,
      [agentId, issuerAddress, nowSec],
    ) as WalletRow | undefined;
  }

  ofType(agentId: Uint8Array, type: string, nowSec: number): WalletRow | undefined {
    return this.#db.get(
      `SELECT * FROM signal_wallet WHERE agent_id = ? AND type = ? AND status = 'active' AND consent_state = '${CONSENT_ACCEPTED}' AND (expires_at IS NULL OR expires_at > ?) ORDER BY issued_at DESC LIMIT 1`,
      [agentId, type, nowSec],
    ) as WalletRow | undefined;
  }

  trusted(): TrustedIssuerRow[] {
    return this.#db.all("SELECT * FROM trusted_issuers ORDER BY added_at", []) as TrustedIssuerRow[];
  }

  trust(issuerAddress: string, issuerPubkey: string): void {
    this.#db.run("INSERT OR IGNORE INTO trusted_issuers (issuer_address, issuer_pubkey, added_at) VALUES (?, ?, ?)", [issuerAddress, issuerPubkey, Date.now()]);
  }

  untrust(issuerAddress: string, issuerPubkey: string): void {
    this.#db.run("DELETE FROM trusted_issuers WHERE issuer_address = ? AND issuer_pubkey = ?", [issuerAddress, issuerPubkey]);
  }
}

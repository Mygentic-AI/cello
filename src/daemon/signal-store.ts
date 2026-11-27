// The wallet: signals about this daemon's agents.
// A signal names one agent's key, so a row belongs to that agent. It's stored under its hash, so a repeat changes nothing.
// `type` and `payload` stay opaque here: a type this client has never seen stores and reads like a known one.
import { toHex } from "../protocol/encode.ts";
import type { SignedSignal } from "../protocol/signal.ts";
import { logEvent } from "./log.ts";
import type { Store } from "./store.ts";

// withdrawn: an endorsement its author took back, or one the issuer no longer holds as current. It's never shown again.
export type SignalStatus = "active" | "superseded" | "withdrawn";
// The wallet's `public` column: 0 not public, 1 public, 2 public on the server but being taken back.
export const PUBLIC_NO = 0;
export const PUBLIC_YES = 1;
export const PUBLIC_WITHDRAWING = 2;
export const CONSENT_ACCEPTED = "accepted";
// The type the issuer gives every endorsement, whoever wrote it.
export const ENDORSEMENT = "endorsement";

// Words about this agent that someone else wrote wait for its human operator: another agent's signal, and every endorsement,
// which an issuer signs but another agent wrote.
export const needsConsent = (e: { issuer_kind: string; type: string }): boolean => e.issuer_kind === "agent" || e.type === ENDORSEMENT;

export interface GivenRow {
  agent_id: Uint8Array;
  signal_hash: string;
  subject: string;
  statement: string;
  same_operator: number | null;
  issuer_address: string;
  issued_at: number;
  withdrawn_at: number | null;
  superseded_by: string | null;
}

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

// Before endorsements could be withdrawn, status allowed two values in a CHECK. SQLite can't change a CHECK, so the table is made
// again with the same rows, in one transaction.
function allowWithdrawn(db: Store): void {
  const made = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'signal_wallet'").get() as { sql: string } | undefined;
  if (!made || made.sql.includes("'withdrawn'")) return;
  db.transaction(() => {
    const rebuilt = made.sql.replace(/^CREATE TABLE (IF NOT EXISTS )?"?signal_wallet"?/, "CREATE TABLE signal_wallet_rebuilt").replace(/CHECK \(status IN \('active', 'superseded'\)\)/, "CHECK (status IN ('active', 'superseded', 'withdrawn'))");
    if (!rebuilt.includes("signal_wallet_rebuilt") || !rebuilt.includes("'withdrawn'")) throw new Error(`the wallet's table can't be updated to allow withdrawn endorsements; its definition is: ${made.sql}`);
    db.exec(rebuilt);
    db.exec("INSERT INTO signal_wallet_rebuilt SELECT * FROM signal_wallet");
    db.exec("DROP TABLE signal_wallet");
    db.exec("ALTER TABLE signal_wallet_rebuilt RENAME TO signal_wallet");
  });
  logEvent("signal.wallet.rebuilt", { rows: (db.prepare("SELECT count(*) AS c FROM signal_wallet").get() as { c: number }).c });
}

export function ensureSignalSchema(db: Store): void {
  allowWithdrawn(db);
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
  status          TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'withdrawn')),
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
);
-- Endorsements this machine's agents gave. The issuer keeps no list an author can read, so this is the only way to find one to withdraw.
CREATE TABLE IF NOT EXISTS endorsements_given (
  agent_id       BLOB NOT NULL REFERENCES agents(agent_id),
  signal_hash    TEXT NOT NULL,
  subject        TEXT NOT NULL,
  statement      TEXT NOT NULL,
  same_operator  INTEGER,
  issuer_address TEXT NOT NULL,
  issued_at      INTEGER NOT NULL,
  withdrawn_at   INTEGER,
  superseded_by  TEXT,
  PRIMARY KEY (agent_id, signal_hash)
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
    const consent = needsConsent(e) ? "pending" : CONSENT_ACCEPTED;
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

  // The subject's human operator agreed: now it can be shown, and it replaces the one it names, as an accepted signal would have on arrival.
  accept(agentId: Uint8Array, hash: string): void {
    const row = this.get(agentId, hash);
    if (!row) return;
    this.#db.run("UPDATE signal_wallet SET consent_state = ? WHERE agent_id = ? AND signal_hash = ?", [CONSENT_ACCEPTED, agentId, hash]);
    if (row.status === "active") this.#applySupersession(agentId, hash, row.type, row.subject_kind, row.issuer_pubkey, row.supersedes_hash);
  }

  // Never shown, and if it was public it's marked for taking back.
  refuse(agentId: Uint8Array, hash: string): void {
    this.#db.run("UPDATE signal_wallet SET consent_state = 'refused', default_present = 0, public = CASE WHEN public = ? THEN ? ELSE public END WHERE agent_id = ? AND signal_hash = ?", [PUBLIC_YES, PUBLIC_WITHDRAWING, agentId, hash]);
  }

  // Its author took it back. If it was public it's marked for taking back, the same way a replaced one is.
  withdraw(agentId: Uint8Array, hash: string): void {
    this.#db.run("UPDATE signal_wallet SET status = 'withdrawn', public = CASE WHEN public = ? THEN ? ELSE public END WHERE agent_id = ? AND signal_hash = ?", [PUBLIC_YES, PUBLIC_WITHDRAWING, agentId, hash]);
  }

  // A newer held signal names this one as what it replaces, whether or not the subject has accepted the newer one yet.
  replacedByHeld(agentId: Uint8Array, hash: string): boolean {
    return this.#db.get("SELECT 1 AS x FROM signal_wallet WHERE agent_id = ? AND supersedes_hash = ?", [agentId, hash]) !== undefined;
  }

  // One given endorsement per subject is current, as at the issuer: a new one marks the last superseded.
  recordGiven(row: Omit<GivenRow, "withdrawn_at" | "superseded_by">): void {
    this.#db.transaction(() => {
      this.#db.run("UPDATE endorsements_given SET superseded_by = ? WHERE agent_id = ? AND subject = ? AND superseded_by IS NULL AND withdrawn_at IS NULL AND signal_hash != ?", [row.signal_hash, row.agent_id, row.subject, row.signal_hash]);
      this.#db.run(
        "INSERT OR IGNORE INTO endorsements_given (agent_id, signal_hash, subject, statement, same_operator, issuer_address, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [row.agent_id, row.signal_hash, row.subject, row.statement, row.same_operator, row.issuer_address, row.issued_at],
      );
    });
  }

  given(agentId: Uint8Array): GivenRow[] {
    return this.#db.all("SELECT * FROM endorsements_given WHERE agent_id = ? ORDER BY issued_at DESC", [agentId]) as GivenRow[];
  }

  givenWithdrawn(agentId: Uint8Array, hash: string): void {
    this.#db.run("UPDATE endorsements_given SET withdrawn_at = ? WHERE agent_id = ? AND signal_hash = ? AND withdrawn_at IS NULL", [Date.now(), agentId, hash]);
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

// A local issuer for tests only. It reads requests with cello-issuer's own checking code and signs real signals, so
// a format that drifts from that repo fails here. Its caps and codes are a small copy of that repo's rules, not the real thing.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { toHex } from "../src/protocol/encode.ts";
import { type DualSignature, type PublicIdentity, type Signer, generateIdentitySeeds, identityId, signerFromSeeds } from "../src/protocol/identity.ts";
import { type TrustSignalEnvelope, MAX_SIGNAL_LIFETIME_SECONDS, SIGNAL_ID_BYTES, SIGNED_SIGNAL_DOMAIN, TRUST_SIGNAL_DOMAIN, checkSignal, issuerPubkeyField, signSignal } from "../src/protocol/signal.ts";

const DAY = 86_400;
export const AGENT_CAP = 3;
export const EMAIL_CLAIM = "This agent's owner has an email address verified by this issuer.";

type Fields = { code: string | null; agent: PublicIdentity; holder: PublicIdentity | null; holderSignal: Uint8Array | null };
interface RealContract {
  agentRequestFromWire(body: unknown): { bytes: Uint8Array; signatures: { agent: DualSignature; holder?: DualSignature } };
  checkAgentRequest(bytes: Uint8Array, signatures: { agent: DualSignature }, expected: { action: string; issuerAddress: string; now: number }): Promise<{ ok: true; request: { fields: Fields; agentId: string } } | { ok: false; fault: string; message: string }>;
  verifyAgentSignature(pub: PublicIdentity, bytes: Uint8Array, signature: DualSignature): Promise<boolean>;
}

export interface EnvelopeChange { type?: string; expiresAt?: number | null; claim?: string; subjectKind?: "account" | "agent"; subject?: string; address?: string; badSignature?: boolean }

export class StandInIssuer {
  readonly codes = new Map<string, "good" | "used">();
  readonly owners = new Map<string, string>();
  readonly requests: { route: string; agentId?: string }[] = [];
  readonly extras = new Map<string, EnvelopeChange[]>();
  // Burn the code, then lose the answer: what a dropped connection looks like from the daemon.
  dropNextRedeemAnswer = false;
  #server!: Server;
  #signer!: Signer;
  #contract!: RealContract;
  #port = 0;

  static async start(issuerDir: string): Promise<StandInIssuer> {
    const issuer = new StandInIssuer();
    issuer.#contract = await import(pathToFileURL(join(issuerDir, "src/server/trust/agent-request.ts")).href) as RealContract;
    issuer.#signer = await signerFromSeeds(generateIdentitySeeds());
    issuer.#server = createServer((req, res) => void issuer.#handle(req, res));
    await new Promise<void>((resolve) => issuer.#server.listen(0, "127.0.0.1", resolve));
    issuer.#port = (issuer.#server.address() as { port: number }).port;
    return issuer;
  }

  get url(): string { return `http://127.0.0.1:${this.#port}`; }
  get keyHex(): string { return toHex(this.#signer.id); }
  stop(): void { this.#server.closeAllConnections(); this.#server.close(); }

  async sign(agentId: string, change: EnvelopeChange = {}): Promise<Uint8Array> {
    const now = Math.floor(Date.now() / 1000);
    const envelope: TrustSignalEnvelope = {
      subject_kind: change.subjectKind ?? "account",
      subject: change.subject ?? agentId,
      issuer_kind: "issuer",
      issuer_pubkey: issuerPubkeyField(this.#signer.publicIdentity),
      type: change.type ?? "email",
      schema_version: 1,
      payload: new Uint8Array(encodeCbor({ claim: change.claim ?? EMAIL_CLAIM, verified_at: now })),
      issued_at: now,
      same_operator: false,
      expires_at: change.expiresAt === undefined ? now + 180 * DAY : change.expiresAt,
      supersedes_hash: null,
      issuer_address: change.address ?? "127.0.0.1",
      signal_id: new Uint8Array(randomBytes(SIGNAL_ID_BYTES)),
    };
    const file = envelope.expires_at !== null && envelope.expires_at - now > MAX_SIGNAL_LIFETIME_SECONDS ? await this.#tooLong(envelope) : await signSignal(envelope, this.#signer);
    if (change.badSignature) file[file.length - 1] = (file[file.length - 1] as number) ^ 0xff;
    return file;
  }

  // Our own encoder refuses a date this far off, so a dishonest issuer's file is built by hand.
  async #tooLong(e: TrustSignalEnvelope): Promise<Uint8Array> {
    const bytes = new Uint8Array(encodeCbor([TRUST_SIGNAL_DOMAIN, e.subject_kind, e.subject, e.issuer_kind, e.issuer_pubkey, e.type, e.schema_version, e.payload, e.issued_at, e.expires_at, e.supersedes_hash, e.same_operator, e.issuer_address, e.signal_id]));
    const signature = await this.#signer.sign("cello-signal", bytes);
    return new Uint8Array(encodeCbor([SIGNED_SIGNAL_DOMAIN, bytes, signature.ed, signature.pq]));
  }

  async #files(agentId: string): Promise<string[]> {
    const files = [await this.sign(agentId)];
    for (const change of this.extras.get(agentId) ?? []) files.push(await this.sign(agentId, change));
    return files.map((file) => Buffer.from(file).toString("base64"));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const refuse = (status: number, reason: string, guidance: string): void => send(status, { ok: false, reason, guidance });
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const route = (req.url ?? "").replace("/api/issuer/", "");
    const action = route === "agents" ? "add_agent" : route;
    const read = this.#contract.agentRequestFromWire(JSON.parse(raw));
    const checked = await this.#contract.checkAgentRequest(read.bytes, read.signatures, { action, issuerAddress: "127.0.0.1", now: Math.floor(Date.now() / 1000) });
    if (!checked.ok) return refuse(401, checked.fault, checked.message);
    const { fields, agentId } = checked.request;
    this.requests.push({ route, agentId });
    if (route === "redeem") {
      const state = fields.code === null ? undefined : this.codes.get(fields.code);
      if (!state) return refuse(403, "code_unknown", "This code can't be used.");
      if (state === "used") return refuse(403, "code_used", "This code can't be used.");
      this.codes.set(fields.code as string, "used");
      this.owners.set(agentId, fields.code as string);
      if (this.dropNextRedeemAnswer) {
        this.dropNextRedeemAnswer = false;
        res.destroy();
        return;
      }
      return send(200, { ok: true, agentId, signals: await this.#files(agentId) });
    }
    if (route === "collect") {
      if (!this.owners.has(agentId)) return refuse(404, "unknown_agent", "This issuer doesn't know this agent. Redeem a code first.");
      return send(200, { ok: true, agentId, signals: await this.#files(agentId) });
    }
    const holderSignature = read.signatures.holder;
    if (!fields.holder || !fields.holderSignal || !holderSignature) return refuse(400, "holder_required", "This request needs the holder's keys, signal and signature.");
    if (!(await this.#contract.verifyAgentSignature(fields.holder, read.bytes, holderSignature))) return refuse(401, "bad_signature", "The holder's signatures don't verify over this request.");
    const holderId = toHex(identityId(fields.holder));
    const held = await checkSignal(fields.holderSignal, { subject: holderId, now: Math.floor(Date.now() / 1000) });
    if (!held.ok || held.signal.envelope.subject_kind !== "account") return refuse(403, "holder_signal_forged", "This signal can't vouch for anyone.");
    const owner = this.owners.get(holderId) as string;
    if ([...this.owners.values()].filter((o) => o === owner).length >= AGENT_CAP) return refuse(403, "agent_cap", "This owner has reached its agent limit. Verifying a phone raises it.");
    this.owners.set(agentId, owner);
    return send(200, { ok: true, agentId, signals: await this.#files(agentId) });
  }
}

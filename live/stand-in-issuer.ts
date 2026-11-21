// A local issuer for tests only. It reads requests with the issuer's own checking code (from CELLO_ISSUER_DIR) and signs real signals, so
// a format that drifts from that repo fails here. Its caps and codes are a small copy of that repo's rules, not the real thing.
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { equalBytes, toHex } from "../src/protocol/encode.ts";
import { type DualSignature, type PublicIdentity, type Signer, identityId, signerFromSeeds, verifySignature } from "../src/protocol/identity.ts";
import { USAGE_FACTS_DOMAIN } from "../src/protocol/structures.ts";
import { identityCodec, signedUsageFacts } from "../src/protocol/wire.ts";
import { type TrustSignalEnvelope, MAX_SIGNAL_LIFETIME_SECONDS, SIGNAL_ID_BYTES, SIGNED_SIGNAL_DOMAIN, TRUST_SIGNAL_DOMAIN, checkSignal, issuerPubkeyField, signSignal } from "../src/protocol/signal.ts";

const DAY = 86_400;
export const AGENT_CAP = 3;
export const EMAIL_CLAIM = "This agent's owner has an email address verified by this issuer.";
export const PHONE_CLAIM = "This agent's owner has a phone number verified by this issuer.";

type Fields = { code: string | null; agent: PublicIdentity; holder: PublicIdentity | null; holderSignal: Uint8Array | null };
interface RealContract {
  agentRequestFromWire(body: unknown): { bytes: Uint8Array; signatures: { agent: DualSignature; holder?: DualSignature } };
  checkAgentRequest(bytes: Uint8Array, signatures: { agent: DualSignature }, expected: { action: string; issuerAddress: string; now: number }): Promise<{ ok: true; request: { fields: Fields; agentId: string } } | { ok: false; fault: string; message: string }>;
  verifyAgentSignature(pub: PublicIdentity, bytes: Uint8Array, signature: DualSignature): Promise<boolean>;
}

export interface EnvelopeChange { type?: string; expiresAt?: number | null; claim?: string; payload?: Record<string, unknown>; subjectKind?: "account" | "agent"; subject?: string; address?: string; badSignature?: boolean }

// Fixed, and public here, so a test server can be told to count this issuer before it starts.
const seed = (name: string): Uint8Array => sha256(new TextEncoder().encode(`cello stand-in issuer: ${name}`));
export const standInKeys = (): Promise<Signer> => signerFromSeeds({ ed: seed("ed"), pq: seed("pq") });

// A signal from the stand-in for a test that talks to a server by bare socket, with no daemon to collect one.
export async function standInSignal(agentId: string): Promise<string> {
  const issuer = new StandInIssuer();
  return Buffer.from(await issuer.sign(agentId, {}, await standInKeys())).toString("base64url");
}

export class StandInIssuer {
  readonly codes = new Map<string, "good" | "used">();
  // Invite codes: a small copy of the real issuer's rules (one per agent, reused when asked again), and every use made.
  readonly invites = new Map<string, { agentId: string; name: string }>();
  readonly inviteUses: { code: string; inviter: string; invitee: string; name: unknown }[] = [];
  readonly owners = new Map<string, string>();
  readonly requests: { route: string; agentId?: string }[] = [];
  readonly extras = new Map<string, EnvelopeChange[]>();
  // What an owner (keyed as `owners` keys them: a code, or "email:<address>") proved. Unset is an email.
  // "both, email unlisted": an email signal under an address no server counts, and a phone one it does, so which one the client sent shows.
  readonly proved = new Map<string, "email" | "phone" | "none" | "both, email unlisted">();
  // Email signup: the code each key was last sent, and every email "sent", newest last.
  readonly enrolling = new Map<string, { email: string; code: string; tries: number }>();
  readonly mail: { to: string; code: string; agentId: string }[] = [];
  // An issuer from before email signup answers its routes with a bare 404.
  enrollOffered = true;
  // Burn the code, then lose the answer: what a dropped connection looks like from the daemon.
  dropNextRedeemAnswer = false;
  #server!: Server;
  #signer!: Signer;
  #contract!: RealContract;
  #port = 0;
  // For tests about something else: any "live-" code is good, and no owner has a limit.
  #open = false;

  static async start(issuerDir: string, opts: { open?: boolean } = {}): Promise<StandInIssuer> {
    const issuer = new StandInIssuer();
    issuer.#open = opts.open === true;
    issuer.#contract = await import(pathToFileURL(join(issuerDir, "src/server/trust/agent-request.ts")).href) as RealContract;
    issuer.#signer = await standInKeys();
    issuer.#server = createServer((req, res) => void issuer.#handle(req, res));
    await new Promise<void>((resolve) => issuer.#server.listen(0, "127.0.0.1", resolve));
    issuer.#port = (issuer.#server.address() as { port: number }).port;
    return issuer;
  }

  get url(): string { return `http://127.0.0.1:${this.#port}`; }
  get keyHex(): string { return toHex(this.#signer.id); }
  stop(): void { this.#server.closeAllConnections(); this.#server.close(); }

  async sign(agentId: string, change: EnvelopeChange = {}, signer: Signer = this.#signer): Promise<Uint8Array> {
    const now = Math.floor(Date.now() / 1000);
    const envelope: TrustSignalEnvelope = {
      subject_kind: change.subjectKind ?? "account",
      subject: change.subject ?? agentId,
      issuer_kind: "issuer",
      issuer_pubkey: issuerPubkeyField(signer.publicIdentity),
      type: change.type ?? "email",
      schema_version: 1,
      payload: new Uint8Array(encodeCbor(change.payload ?? { claim: change.claim ?? EMAIL_CLAIM, verified_at: now })),
      issued_at: now,
      same_operator: false,
      expires_at: change.expiresAt === undefined ? now + 180 * DAY : change.expiresAt,
      supersedes_hash: null,
      issuer_address: change.address ?? "127.0.0.1",
      signal_id: new Uint8Array(randomBytes(SIGNAL_ID_BYTES)),
    };
    const file = envelope.expires_at !== null && envelope.expires_at - now > MAX_SIGNAL_LIFETIME_SECONDS ? await this.#tooLong(envelope) : await signSignal(envelope, signer);
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
    // The real issuer gives an owner who signed up in a chat app a phone signal and no email. "none" plays an answer with neither.
    const proved = this.proved.get(this.owners.get(agentId) ?? "") ?? "email";
    const phone = (): Promise<Uint8Array> => this.sign(agentId, { type: "phone", claim: PHONE_CLAIM });
    const files = proved === "none" ? []
      : proved === "phone" ? [await phone()]
      : proved === "both, email unlisted" ? [await this.sign(agentId, { address: "unlisted.example" }), await phone()]
      : [await this.sign(agentId)];
    for (const change of this.extras.get(agentId) ?? []) files.push(await this.sign(agentId, change));
    return files.map((file) => Buffer.from(file).toString("base64"));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const refuse = (status: number, reason: string, guidance: string): void => send(status, { ok: false, reason, guidance });
    if (req.method === "GET") return refuse(404, "not_found", "No list here.");
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const route = (req.url ?? "").replace("/api/issuer/", "");
    if (route.startsWith("enroll/") && !this.enrollOffered) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<!DOCTYPE html><title>404</title>");
      return;
    }
    const action = route === "agents" ? "add_agent" : route === "usage" ? "request_usage" : route === "invites" ? "invite_make" : route === "invites/use" ? "invite_use" : route.replace("/", "_");
    const body = JSON.parse(raw) as { usageFacts?: unknown; usageServer?: unknown; name?: unknown; replace?: unknown; revoke?: unknown };
    const read = this.#contract.agentRequestFromWire(body);
    const checked = await this.#contract.checkAgentRequest(read.bytes, read.signatures, { action, issuerAddress: "127.0.0.1", now: Math.floor(Date.now() / 1000) });
    if (!checked.ok) return refuse(401, checked.fault, checked.message);
    const { fields, agentId } = checked.request;
    this.requests.push({ route, agentId });
    if (route === "redeem") {
      if (this.#open && fields.code?.startsWith("live-")) this.codes.set(fields.code, "good");
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
    // A small copy of the real issuer's enroll rules: a code bound to the key that asked, five tries, the newest only, and
    // the agent limit at verify without spending the code. Its words are the real issuer's.
    if (route === "enroll/start") {
      const email = (fields.code ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return refuse(400, "bad_email", "That doesn't look like an email address.");
      const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
      this.enrolling.set(agentId, { email, code, tries: 0 });
      this.mail.push({ to: email, code, agentId });
      return send(200, { ok: true, sent: true });
    }
    if (route === "enroll/verify") {
      if (!/^\d{6}$/.test(fields.code ?? "")) return refuse(400, "bad_code", "The code is six digits.");
      const pending = this.enrolling.get(agentId);
      if (!pending) return refuse(403, "enroll_code_expired", "That code has expired or was already used. Run cello setup again for a new one.");
      if (fields.code !== pending.code) {
        pending.tries += 1;
        if (pending.tries >= 5) {
          this.enrolling.delete(agentId);
          return refuse(403, "enroll_code_expired", "Too many wrong tries, so that code no longer works. Run cello setup again for a new one.");
        }
        const left = 5 - pending.tries;
        return refuse(403, "enroll_code_wrong", `That code isn't right. You have ${left} ${left === 1 ? "try" : "tries"} left.`);
      }
      const owner = `email:${pending.email}`;
      if (!this.owners.has(agentId)) {
        if (!this.#open && [...this.owners.values()].filter((o) => o === owner).length >= AGENT_CAP) {
          return refuse(403, "agent_cap", `You're at your limit of ${AGENT_CAP} agents. Verify your phone to raise it to 50.`);
        }
        this.owners.set(agentId, owner);
      }
      this.enrolling.delete(agentId);
      return send(200, { ok: true, agentId, signals: await this.#files(agentId) });
    }
    if (route === "invites") {
      if (!this.owners.has(agentId)) return refuse(404, "unknown_agent", "This agent isn't enrolled with this issuer, so it can't have an invite code.");
      let code = [...this.invites.entries()].find(([, v]) => v.agentId === agentId)?.[0];
      if (body.revoke === true) {
        if (code) this.invites.delete(code);
        return send(200, { ok: true, revoked: code !== undefined });
      }
      if (typeof body.name !== "string") return refuse(400, "bad_name", "Give the agent's name with the request.");
      if (!code || body.replace === true) {
        if (code) this.invites.delete(code);
        code = Array.from(randomBytes(7), (b) => "23456789ABCDEFGHJKMNPQRSTUVWXYZ"[b % 31]).join("");
      }
      this.invites.set(code, { agentId, name: body.name });
      return send(200, { ok: true, code, link: `https://t.me/JoinCelloBot?start=${code}` });
    }
    if (route === "invites/use") {
      const code = (fields.code ?? "").toUpperCase().replace(/[\s-]+/g, "");
      const invite = this.invites.get(code);
      if (!this.owners.has(agentId)) return refuse(404, "unknown_agent", "This agent isn't enrolled with this issuer, so it can't use an invite code.");
      if (!invite) return refuse(404, "unknown", "That invite code isn't one we know.");
      if (invite.agentId === agentId) return refuse(409, "own", "That's your own invite code.");
      this.inviteUses.push({ code, inviter: invite.agentId, invitee: agentId, name: body.name });
      return send(200, { ok: true, agent_id: invite.agentId, address: invite.agentId, name: invite.name });
    }
    if (route === "collect") {
      if (!this.owners.has(agentId)) return refuse(404, "unknown_agent", "This issuer doesn't know this agent. Redeem a code first.");
      return send(200, { ok: true, agentId, signals: await this.#files(agentId) });
    }
    // A small copy of the real issuer's Usage checks and counting, not its wording.
    if (route === "usage") {
      if (!this.owners.has(agentId)) return refuse(404, "unknown_agent", "This issuer doesn't know this agent. Redeem a code first.");
      let facts: ReturnType<typeof signedUsageFacts.decode>;
      let server: PublicIdentity;
      try {
        facts = signedUsageFacts.decode(body.usageFacts, "usageFacts");
        server = identityCodec.decode(body.usageServer, "usageServer");
      } catch (err: unknown) {
        return refuse(400, "usage_malformed", `The usage count couldn't be read: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!equalBytes(facts.fields.serverId, identityId(server))) return refuse(400, "usage_server_mismatch", "The count names a different server from the one that sent its keys.");
      if (!(await verifySignature(server, USAGE_FACTS_DOMAIN, facts.bytes, facts.signature))) return refuse(403, "usage_forged", "The server's signature on that count doesn't verify.");
      if (toHex(facts.fields.agentId) !== agentId) return refuse(403, "usage_wrong_agent", "That count is about a different agent.");
      if (facts.fields.conversations === 0) return refuse(409, "usage_nothing_to_count", "Nothing to count yet. Your agent needs one conversation where both sides wrote.");
      const owner = this.owners.get(agentId);
      const ids: string[] = [];
      for (let at = 0; at < facts.fields.counterparties.length; at += 32) ids.push(toHex(facts.fields.counterparties.subarray(at, at + 32)));
      const otherOwners = ids.filter((id) => this.owners.has(id) && this.owners.get(id) !== owner).length;
      const counts = { as_of: facts.fields.asOf, conversations: facts.fields.conversations, agents: ids.length, other_owner_agents: otherOwners, median_messages: facts.fields.medianMessages };
      const claim = `${counts.conversations} conversations with ${counts.agents} different agents, ${counts.other_owner_agents} of them other owners'.`;
      const usage = [
        await this.sign(agentId, { type: "usage", subjectKind: "agent", payload: { claim, ...counts } }),
        await this.sign(agentId, { type: "usage_detailed", subjectKind: "agent", payload: { claim, ...counts, messages_sent: facts.fields.messagesSent, messages_received: facts.fields.messagesReceived, months: facts.fields.months } }),
      ].map((file) => Buffer.from(file).toString("base64"));
      return send(200, { ok: true, agentId, signals: [...(await this.#files(agentId)), ...usage] });
    }
    const holderSignature = read.signatures.holder;
    if (!fields.holder || !fields.holderSignal || !holderSignature) return refuse(400, "holder_required", "This request needs the holder's keys, signal and signature.");
    if (!(await this.#contract.verifyAgentSignature(fields.holder, read.bytes, holderSignature))) return refuse(401, "bad_signature", "The holder's signatures don't verify over this request.");
    const holderId = toHex(identityId(fields.holder));
    const held = await checkSignal(fields.holderSignal, { subject: holderId, now: Math.floor(Date.now() / 1000) });
    if (!held.ok || held.signal.envelope.subject_kind !== "account") return refuse(403, "holder_signal_forged", "This signal can't vouch for anyone.");
    const owner = this.owners.get(holderId) as string;
    if (!this.#open && [...this.owners.values()].filter((o) => o === owner).length >= AGENT_CAP) return refuse(403, "agent_cap", `You're at your limit of ${AGENT_CAP} agents. Verify your phone to raise it to 50.`);
    this.owners.set(agentId, owner);
    return send(200, { ok: true, agentId, signals: await this.#files(agentId) });
  }
}

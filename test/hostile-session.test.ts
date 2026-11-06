// A server and a counterparty that both lie, against a real daemon, through a whole session. None of this shows against an honest server.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { IpcClient } from "../src/ipc/client.ts";
import { openSessionContent, sealSessionContent } from "../src/protocol/aead.ts";
import { provesTwoAcks } from "../src/protocol/chain.ts";
import { ZERO_HASH, toHex } from "../src/protocol/encode.ts";
import { type Signer, generateIdentitySeeds, signerFromSeeds } from "../src/protocol/identity.ts";
import { deriveSessionSecrets, generateSessionEphemeral } from "../src/protocol/key-agreement.ts";
import { EMPTY_ROOT, RunningMerkle } from "../src/protocol/merkle.ts";
import { mlKemDecapsulate } from "../src/protocol/ml-kem.ts";
import { deriveSessionSalt, generateSaltContribution, saltedContentHash } from "../src/protocol/salt.ts";
import { EntryKind, EntryMode, type EntryFields, ackBytes, assignmentBytes, bodyBytes, readRefusedList, ciphertextHash, confirmBytes, entryBytes, entryHash, offerBytes, serverAuthBytes, structureHash } from "../src/protocol/structures.ts";
import { PROTOCOL_VERSION, type WireSigned, fromB64, identityCodec, signatureCodec, signedAccept, signedAck, signedAssignment, signedConfirm, signedDeliveryAck, signedEntry, signedOffer, toB64 } from "../src/protocol/wire.ts";

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => new Uint8Array([...a, ...b]);

interface Item { entry: WireSigned; ack: WireSigned; ciphertext: string | null }

// One daemon, one agent, and a lying server playing the other party too.
class Scene {
  server!: Signer;
  mallory!: Signer;
  wss!: WebSocketServer;
  socket!: WebSocket;
  agent = "";
  targetIdentity: Record<string, string | number> = {};
  sessionId = new Uint8Array(randomBytes(16));
  key: Uint8Array = new Uint8Array(0);
  salt: Uint8Array = new Uint8Array(0);
  tree = new RunningMerkle();
  roots: Uint8Array[] = [EMPTY_ROOT];
  items: Item[] = [];
  malloryHead: { seq: number; hash: Uint8Array } = { seq: 0, hash: ZERO_HASH };
  refuseAppends = false;
  refused: WireSigned[] = [];
  deliveryAcks: number[] = [];
  refusals: number[][] = [];
  appended: WireSigned[] = [];
  accepted: ((accept: WireSigned) => void) | undefined;
  daemon!: ChildProcess;
  client!: IpcClient;
  time = 1_000_000;

  send(frame: unknown): void { this.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...(frame as object) })); }

  async start(): Promise<void> {
    this.server = await signerFromSeeds(generateIdentitySeeds());
    this.mallory = await signerFromSeeds(generateIdentitySeeds());
    const serverNonce = new Uint8Array(randomBytes(32));
    this.wss = new WebSocketServer({ port: 0 });
    await new Promise((resolve) => this.wss.once("listening", resolve));
    this.wss.on("connection", (socket) => {
      socket.on("message", (raw: Buffer) => { void (async () => {
        const frame = JSON.parse(raw.toString()) as { id: number; method: string; params: Record<string, unknown> };
        const p = frame.params;
        const reply = (body: object): void => socket.send(JSON.stringify({ v: PROTOCOL_VERSION, id: frame.id, ...body }));
        const answer = (result: unknown): void => reply({ ok: true, result });
        const refuse = (code: string, message: string): void => reply({ ok: false, error: { code, message, tip: this.items.length } });
        switch (frame.method) {
          case "hello": {
            const signature = await this.server.sign("cello-server-auth", serverAuthBytes({ serverId: this.server.id, clientNonce: fromB64(p["clientNonce"], "n"), serverNonce }));
            return answer({ server: identityCodec.encode(this.server.publicIdentity), serverNonce: toB64(serverNonce), signature: signatureCodec.encode(signature) });
          }
          case "register": this.targetIdentity = p["identity"] as Record<string, string | number>; return answer({ agentId: "" });
          case "auth": if (p["long"] !== true) this.socket = socket; this.agent = toHex(fromB64(p["agentId"], "agentId")); return answer({ ok: true, standing: { status: "active", reason: "none", record: null } });
          case "session.list": return answer({ sessions: [] });
          case "session.accept": this.accepted?.(p["accept"] as WireSigned); return answer({ ok: true });
          case "entry.fetch": return answer({ items: this.items.slice(p["after"] as number), tip: this.items.length, longNext: false });
          case "delivery.ack": { const d = signedDeliveryAck.decode(p["deliveryAck"]).fields; this.deliveryAcks.push(d.throughPosition); this.refusals.push(readRefusedList(d.refused)); } return answer({});
          case "entry.append": {
            const entry = p["entry"] as WireSigned;
            this.appended.push(entry);
            if (this.refuseAppends) { this.refused.push(entry); return refuse("not_current", "something has arrived that this agent hasn't read"); }
            return answer({ ack: (await this.land(entry, null)).ack });
          }
          default: return answer({});
        }
      })(); });
    });
    const port = (this.wss.address() as { port: number }).port;
    const home = mkdtempSync(join(tmpdir(), "cello-hostile-session-"));
    this.daemon = spawn(process.execPath, [fileURLToPath(new URL("../src/daemon/main.ts", import.meta.url)), `ws://127.0.0.1:${port}/`], { env: { ...process.env, CELLO_V2_HOME: home }, stdio: process.env["SHOW_DAEMON"] ? "inherit" : "ignore" });
    this.client = await until("the daemon's socket", async () => {
      try { return await IpcClient.connect(join(home, "daemon.sock")); } catch { return false; }
    });
    await this.client.call("create_agent", { name: "Target" });
    await until("the agent to authenticate", () => this.agent);
    // Nobody's attached to this agent, and the away visit would answer and close on the first message.
    await this.client.call("settings_set", { agent: this.agent, name: "away.answering", value: "false" });
    await this.open();
  }

  async open(): Promise<void> {
    const eph = await generateSessionEphemeral();
    const targetId = fromB64(this.agent.length ? Buffer.from(this.agent, "hex").toString("base64url") : "", "t");
    const offerFields = { serverId: this.server.id, sessionId: this.sessionId, callerId: this.mallory.id, calleeId: targetId, x25519Public: eph.publicKey, mlKemPublic: eph.mlKemPublic, expiresAt: Date.now() + 600_000 };
    const offer = signedOffer.encode({ fields: offerFields, signature: await this.mallory.sign("cello-session-offer", offerBytes(offerFields)) });
    const wire = { offer, accept: null as WireSigned | null, confirm: null as WireSigned | null, assignment: null as WireSigned | null, refusal: null, greeting: null, callerIdentity: identityCodec.encode(this.mallory.publicIdentity), calleeIdentity: this.targetIdentity, state: "offered", tip: 0, stopped: false };
    const acceptWire = await new Promise<WireSigned>((resolve) => { this.accepted = resolve; this.send({ push: "session", agent: this.agent, data: wire }); });
    const accept = signedAccept.decode(acceptWire).fields;
    const shared = await mlKemDecapsulate(eph.mlKemSeed, accept.mlKemCiphertext);
    this.key = deriveSessionSecrets({ ownEphemeralSecret: eph.secretKey, peerEphemeralPublic: accept.x25519Public, sessionId: this.sessionId, extraSharedSecret: shared, pqTranscript: concat(accept.mlKemCiphertext, eph.mlKemPublic) }).contentKey;
    const ownSalt = generateSaltContribution();
    this.salt = deriveSessionSalt(ownSalt, openSessionContent(this.key, accept.sealedSalt) as Uint8Array);
    const confirmFields = { acceptHash: structureHash(signedAccept.decode(acceptWire).bytes), sealedSalt: sealSessionContent(this.key, ownSalt), sealedName: sealSessionContent(this.key, new TextEncoder().encode("Mallory")) };
    const confirmBytesNow = confirmBytes(confirmFields);
    const confirm = signedConfirm.encode({ fields: confirmFields, signature: await this.mallory.sign("cello-session-confirm", confirmBytesNow) });
    const assignmentFields = { serverId: this.server.id, sessionId: this.sessionId, callerId: this.mallory.id, calleeId: targetId, confirmHash: structureHash(confirmBytesNow), time: this.time };
    const assignment = signedAssignment.encode({ fields: assignmentFields, signature: await this.server.sign("cello-session-assignment", assignmentBytes(assignmentFields)) });
    this.send({ push: "session", agent: this.agent, data: { ...wire, accept: acceptWire, confirm, assignment, state: "active" } });
    await until("the session to go active", async () => {
      const list = await this.client.call("sessions", { agent: this.agent }) as { sessions: { state: string }[] };
      return list.sessions[0]?.state === "active";
    });
  }

  get hex(): string { return toHex(this.sessionId); }

  // Assigns the next position, as the server, and remembers it.
  async land(entry: WireSigned, ciphertext: string | null): Promise<Item> {
    const hash = structureHash(signedEntry.decode(entry).bytes);
    const root = this.tree.append(hash);
    this.roots.push(root);
    this.time += 1;
    const fields = { serverId: this.server.id, sessionId: this.sessionId, position: this.items.length + 1, entryHash: hash, root, time: this.time };
    const item = { entry, ack: signedAck.encode({ fields, signature: await this.server.sign("cello-ack", ackBytes(fields)) }), ciphertext };
    this.items.push(item);
    return item;
  }

  // A message from Mallory, optionally with a hash of words other than the ones encrypted.
  async fromMallory(text: string, signedWords = text): Promise<void> {
    const n = new Uint8Array(randomBytes(16));
    const sent = bodyBytes({ n, text, signal: "over", est_minutes: null });
    const signed = bodyBytes({ n, text: signedWords, signal: "over", est_minutes: null });
    const ciphertext = sealSessionContent(this.key, sent);
    const position = this.items.length;
    const fields: EntryFields = { serverId: this.server.id, sessionId: this.sessionId, authorId: this.mallory.id, authorSeq: this.malloryHead.seq + 1, prevOwnHash: this.malloryHead.hash, readPosition: position, readRoot: this.roots[position] as Uint8Array, kind: EntryKind.message, mode: EntryMode.notice, contentHash: saltedContentHash(this.salt, signed), ciphertextHash: ciphertextHash(ciphertext), notAfter: 2_000_000_000_000 };
    this.malloryHead = { seq: fields.authorSeq, hash: entryHash(fields) };
    const entry = signedEntry.encode({ fields, signature: await this.mallory.sign("cello-entry", entryBytes(fields)) });
    const item = await this.land(entry, toB64(ciphertext));
    this.send({ push: "entry", agent: this.agent, data: item });
  }

  async evidence(): Promise<{ frozen: boolean; evidence: { kind: string; position: number; entry: WireSigned | null; ack: WireSigned; other_ack: WireSigned | null; ciphertext: string | null }[] }> {
    return await this.client.call("evidence", { agent: this.agent, session_id: this.hex }) as never;
  }

  async verified(): Promise<number> {
    return (await this.client.call("verify_session", { agent: this.agent, session_id: this.hex }) as { position: number }).position;
  }

  stop(): void {
    this.daemon.kill("SIGKILL");
    this.client.close();
    this.wss.close();
  }
}

const scenes: Scene[] = [];
after(() => { for (const scene of scenes) scene.stop(); });
async function scene(): Promise<Scene> {
  const s = new Scene();
  scenes.push(s);
  await s.start();
  return s;
}

test("a refused message a server lands anyway doesn't stand as your word, and you're told", { timeout: 60_000 }, async () => {
  const s = await scene();
  await s.client.call("use_agent", { agent: s.agent, caller: "t" }).catch(() => undefined);
  s.refuseAppends = true;
  const sent = await s.client.call("send", { agent: s.agent, caller: "t", session_id: s.hex, text: "Yes, proceed", signal: "over" }).catch((err: unknown) => err) as Record<string, unknown>;
  assert.ok(s.refused.length === 1, `the daemon offered it: ${JSON.stringify(sent)}`);
  s.refuseAppends = false;

  const item = await s.land(s.refused[0] as WireSigned, null);
  s.send({ push: "entry", agent: s.agent, data: item });

  const kept = await until("the proof to be kept", async () => (await s.evidence()).evidence.find((e) => e.kind === "refused_entry_landed"));
  assert.equal(kept.position, 1);
  assert.deepEqual(kept.entry, s.refused[0]);
  assert.equal(await s.verified(), 0, "the refused message isn't in this agent's record");
  const inbox = await s.client.call("receive", { agent: s.agent, caller: "t" }) as { notices: { text: string }[] };
  assert.ok(inbox.notices.some((n) => /you were told was refused/.test(n.text)), JSON.stringify(inbox.notices));
  const listed = await s.client.call("sessions", { agent: s.agent }) as { sessions: { fault: string | null }[] };
  assert.equal(listed.sessions[0]?.fault, "refused_entry_landed");
});

test("one bad message from the other side doesn't stop the reader, keeps its proof, and is signed as refused", { timeout: 60_000 }, async () => {
  const s = await scene();
  await s.fromMallory("first");
  await until("the first message", async () => (await s.verified()) === 1);
  await until("its delivery ack", () => s.deliveryAcks.includes(1));

  await s.fromMallory("what I really encrypted", "I agree to pay $1M");
  const proof = await until("the proof", async () => (await s.evidence()).evidence.find((e) => e.kind === "unverifiable_text"));
  assert.equal(proof.position, 2);
  assert.equal(proof.ciphertext, s.items[1]?.ciphertext, "the exact bytes are kept");

  await s.fromMallory("third");
  await until("reading to carry on past it", async () => (await s.verified()) === 3);
  await until("an ack past it", () => s.deliveryAcks.includes(3));
  for (const [i, through] of s.deliveryAcks.entries()) assert.deepEqual(s.refusals[i], through >= 2 ? [2] : [], `an ack through ${through} must refuse position 2`);

  const read = await until("the third to be screened", async () => {
    const r = await s.client.call("receive", { agent: s.agent, caller: "t", session_id: s.hex }) as { messages: { text: string | null }[]; notices: { text: string }[] };
    return r.messages.some((m) => m.text === "third") ? r : false;
  });
  assert.ok(!JSON.stringify(read.messages).includes("I agree to pay"), "the hash's claimed words aren't shown");
  assert.ok(!JSON.stringify(read.messages).includes("really encrypted"), "nor the unmatched text");
});

test("two signed acks at one position are kept as proof a stranger can check, and freeze sending", { timeout: 60_000 }, async () => {
  const s = await scene();
  await s.fromMallory("hello");
  await until("the message", async () => (await s.verified()) === 1);

  // Junk at a held position, not signed by the server: dropped, and it freezes nothing.
  const first = signedAck.decode((s.items[0] as Item).ack);
  const junkFields = { ...first.fields, time: first.fields.time + 5 };
  const junk = signedAck.encode({ fields: junkFields, signature: await s.mallory.sign("cello-ack", ackBytes(junkFields)) });
  s.send({ push: "entry", agent: s.agent, data: { ...s.items[0], ack: junk } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await s.evidence()).frozen, false, "a frame the server didn't sign can't freeze anything");

  const secondFields = { ...first.fields, entryHash: new Uint8Array(32).fill(9), time: first.fields.time + 5 };
  const second = signedAck.encode({ fields: secondFields, signature: await s.server.sign("cello-ack", ackBytes(secondFields)) });
  s.send({ push: "entry", agent: s.agent, data: { ...s.items[0], ack: second } });
  const held = await until("the proof", async () => { const e = await s.evidence(); return e.frozen ? e : false; });
  const proof = held.evidence[0];
  assert.equal(proof?.kind, "two_acks");
  assert.equal(await provesTwoAcks(s.server.publicIdentity, signedAck.decode(proof?.ack), signedAck.decode(proof?.other_ack)), true, "a stranger with the server's public key can check it");
  assert.equal(await provesTwoAcks(s.server.publicIdentity, signedAck.decode(proof?.ack), signedAck.decode(proof?.ack)), false);

  await assert.rejects(s.client.call("send", { agent: s.agent, caller: "t", session_id: s.hex, text: "more", signal: "over" }), /frozen|two different/);
  await s.client.call("close_session", { agent: s.agent, caller: "t", session_id: s.hex });
  await until("the frozen side's close", () => s.appended.some((entry) => signedEntry.decode(entry).fields.kind === EntryKind.close));
});

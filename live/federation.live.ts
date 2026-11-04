// Two servers that have never heard of each other. An agent on one holds a real conversation with an agent on the other,
// and neither server learns more than it should. Run it with scripts/federation-test.sh, which cleans up whatever happens.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type ConnectedServer, ServerLink, ServerRefused } from "../src/daemon/link.ts";
import { type Signer, generateIdentitySeeds, signerFromSeeds } from "../src/protocol/identity.ts";
import { generateSessionEphemeral } from "../src/protocol/key-agreement.ts";
import { agentAuthBytes, offerBytes, registerBytes } from "../src/protocol/structures.ts";
import { identityCodec, signatureCodec, signedOffer, toB64 } from "../src/protocol/wire.ts";
import { checkLogsClean } from "./log-check.ts";

const serverDir = process.env["CELLO_SERVER_DIR"] ?? new URL("../../cello-server", import.meta.url).pathname;
const pidsFile = process.env["CELLO_FED_PIDS"];
const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
const evidence = join(homedir(), "cello-v2-live-runs", `federation-${stamp}`);
mkdirSync(evidence, { recursive: true });

const A = { name: "cello-v2-fed-a", port: 18400, url: "ws://127.0.0.1:18400/v1" };
const B = { name: "cello-v2-fed-b", port: 18401, url: "ws://127.0.0.1:18401/v1" };
type Server = typeof A;

const report: Record<string, unknown> = { started: stamp };
const earlierLogs = new Map<string, string>();

function say(line: string): void {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
}

function up(server: Server, env: Record<string, string> = {}): { server: string; seal_key: string; federation: string } {
  saveLogs(server);
  const output = execFileSync(join(serverDir, "scripts/server.sh"), ["up", "--name", server.name, "--port", String(server.port)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  return JSON.parse(output.trim().split("\n").at(-1) as string) as { server: string; seal_key: string; federation: string };
}

function currentLogs(server: Server): string {
  const run = spawnSync("docker", ["logs", `${server.name}-server-1`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return run.status === 0 ? run.stdout + run.stderr : "";
}

// A restart with new settings replaces the container, and its logs with it.
function saveLogs(server: Server): void {
  earlierLogs.set(server.name, (earlierLogs.get(server.name) ?? "") + currentLogs(server));
}

const logsOf = (server: Server): string => (earlierLogs.get(server.name) ?? "") + currentLogs(server);

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

const dbDump = (server: Server): string => docker("exec", `${server.name}-postgres-1`, "pg_dump", "-U", "cello_owner", "-d", "cello", "--data-only");
const sql = (server: Server, query: string): string => docker("exec", `${server.name}-postgres-1`, "psql", "-U", "cello_owner", "-d", "cello", "-tAc", query).trim();

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, tries = 450): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Run { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
interface Status { pid: number; connected: boolean; visiting: { server: string; connected: boolean; agents: number }[]; agents: { online: boolean; unread: number }[] }

const everyone: { run(args: string[]): Run }[] = [];

// One owner's machine: its own daemon, in its own folder, with its own caller.
function side(name: string, home: Server) {
  const dir = mkdtempSync(join(tmpdir(), `cello-v2-fed-${name}-`));
  const run = (args: string[]): Run => {
    const done = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env: { ...process.env, CELLO_V2_HOME: dir, CELLO_CALLER: `shell-${name}` } });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(done.stdout || done.stderr) as Record<string, unknown>;
    } catch {
      // login and logout answer in words.
    }
    return { status: done.status, stdout: done.stdout, stderr: done.stderr, json };
  };
  const must = (args: string[]): Record<string, unknown> => {
    const done = run(args);
    assert.equal(done.status, 0, `${name}: cello-v2 ${args.join(" ")} failed: ${done.stdout}${done.stderr}`);
    return done.json;
  };
  const self = {
    name,
    dir,
    run,
    must,
    act: (...args: string[]) => must([...args, "--agent", name]),
    refused: (...args: string[]) => {
      const done = run([...args, "--agent", name]);
      assert.equal(done.status, 1, `${name}: expected a refusal from ${args.join(" ")}: ${done.stdout}${done.stderr}`);
      return done.json["error"];
    },
    status: () => must(["status"]) as unknown as Status,
    login: () => {
      must(["login", "--server", home.url]);
      if (pidsFile) appendFileSync(pidsFile, `${self.status().pid}\n`);
    },
    kill: () => process.kill(self.status().pid, "SIGKILL"),
    unread: () => (must(["status"]) as unknown as Status).agents[0]?.unread ?? 0,
    read: () => must(["receive", "--agent", name]) as { messages: { text?: string; signal?: string; closed_their_side?: boolean }[] },
    // The ports this daemon really has connections to: the operating system's answer, not the daemon's.
    ports: () => {
      const listed = spawnSync("lsof", ["-nP", "-a", "-p", String(self.status().pid), "-iTCP", "-sTCP:ESTABLISHED", "-Fn"], { encoding: "utf8" }).stdout;
      return [...new Set([...listed.matchAll(/->[^:\n]+:(\d+)/g)].map((m) => Number(m[1])))].sort();
    },
  };
  everyone.push(self);
  return self;
}

async function create(who: ReturnType<typeof side>): Promise<{ id: string; address: string }> {
  who.login();
  const made = who.must(["create-agent", who.name]);
  await until(`${who.name} online`, () => who.status().agents.every((a) => a.online));
  return { id: made["agent_id"] as string, address: made["address"] as string };
}

async function gets(who: ReturnType<typeof side>, count = 1): Promise<void> {
  await until(`${count} to reach ${who.name}`, () => who.unread() >= count);
}

function textsRead(read: { messages: { text?: string }[] }): (string | undefined)[] {
  return read.messages.map((m) => m.text);
}

// A client with no daemon, for what a stranger's software could send. It holds only keys.
class Stranger {
  readonly signer: Signer;
  readonly link: ServerLink;
  readonly server: Promise<ConnectedServer>;
  constructor(signer: Signer, url: string) {
    this.signer = signer;
    let connected: (server: ConnectedServer) => void = () => undefined;
    this.server = new Promise((resolve) => { connected = resolve; });
    this.link = new ServerLink(url, { checkIdentity: () => null, connected: async (server) => connected(server), disconnected: () => undefined, push: () => undefined });
    this.link.start();
  }
  static async at(url: string): Promise<Stranger> {
    const stranger = new Stranger(await signerFromSeeds(generateIdentitySeeds()), url);
    await stranger.server;
    return stranger;
  }
  async visitParams(serverId?: Uint8Array): Promise<Record<string, unknown>> {
    const server = await this.server;
    const proveFor = serverId ?? server.id;
    const clientNonce = new Uint8Array(randomBytes(32));
    const identity = this.signer.publicIdentity;
    return {
      identity: identityCodec.encode(identity),
      name: "Stranger",
      clientNonce: toB64(clientNonce),
      nameSignature: signatureCodec.encode(await this.signer.sign("cello-v2-visit", registerBytes({ serverId: proveFor, identity, name: "Stranger" }))),
      signature: signatureCodec.encode(await this.signer.sign("cello-v2-agent-auth", agentAuthBytes({ serverId: proveFor, agentId: this.signer.id, serverNonce: server.nonce, clientNonce }))),
    };
  }
  async visit(): Promise<void> {
    await this.link.call("visit", await this.visitParams());
  }
  async offer(calleeId: string, serverId?: Uint8Array): Promise<ReturnType<typeof signedOffer.encode>> {
    const server = await this.server;
    const own = await generateSessionEphemeral();
    const fields = { serverId: serverId ?? server.id, sessionId: new Uint8Array(randomBytes(16)), callerId: this.signer.id, calleeId: new Uint8Array(Buffer.from(calleeId, "hex")), x25519Public: own.publicKey, mlKemPublic: own.mlKemPublic, expiresAt: Date.now() + 60_000 };
    return signedOffer.encode({ fields, signature: await this.signer.sign("cello-v2-session-offer", offerBytes(fields)) });
  }
  send(offer: ReturnType<typeof signedOffer.encode>): Promise<unknown> {
    return this.link.call("session.offer", { agent: toB64(this.signer.id), offer });
  }
}

async function refusedWith(work: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(work, (err: unknown) => err instanceof ServerRefused && err.code === code, `expected the refusal ${code}`);
}

function saveEvidence(): void {
  writeFileSync(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const server of [A, B]) writeFileSync(join(evidence, `${server.name}.log`), logsOf(server));
}

after(() => {
  saveEvidence();
  for (const who of everyone) who.run(["logout"]);
  say(`evidence: ${evidence}`);
});

test("an agent on one server talks to an agent on another, and neither server learns more than it should", { timeout: 400_000 }, async () => {
  // ---- Each server knows only its own software. Neither is told about the other. ----
  const started = Date.now();
  const healthA = up(A);
  const healthB = up(B);
  report["seconds_to_two_servers"] = Math.round((Date.now() - started) / 1000);
  assert.notEqual(healthA.server, healthB.server);
  assert.notEqual(healthA.seal_key, healthB.seal_key);
  assert.deepEqual([healthA.federation, healthB.federation], ["open", "open"]);
  say(`two servers up in ${report["seconds_to_two_servers"] as number}s`);

  const ann = side("Ann", A);
  const bob = side("Bob", B);
  const annAgent = await create(ann);
  const bobAgent = await create(bob);
  assert.equal(annAgent.address, `${annAgent.id}@127.0.0.1:18400`);
  assert.equal(bobAgent.address, `${bobAgent.id}@127.0.0.1:18401`);
  assert.deepEqual([ann.ports(), bob.ports()], [[18400], [18401]], "each daemon starts connected only to its own server");

  // ---- Ann calls Bob by key plus server. The conversation lives on Bob's server. ----
  const lines = ["ann first: the quarterly figure is seven", "bob: looking into the figure now", "bob again: confirmed, the figure stands", "ann while her server is down: thank you", "ann while bob is away: one more thing", "bob: that wraps it up from my side"];
  const started2 = ann.act("initiate-session", bobAgent.address);
  assert.equal(started2["state"], "active");
  const session = started2["session_id"] as string;
  const hostedOn = (who: ReturnType<typeof side>): unknown => (who.act("sessions") as { sessions: { hosted_on: string }[] }).sessions[0]?.hosted_on;
  assert.deepEqual([hostedOn(ann), hostedOn(bob)], [B.url, B.url]);
  say("Ann called Bob across servers");

  // The called daemon dials nobody: being called can't make it reveal where it is.
  assert.deepEqual(ann.ports(), [18400, 18401], "the caller connects to the callee's server directly");
  assert.deepEqual(bob.ports(), [18401], "the callee's daemon has connected to nothing but its own server");

  // over.
  assert.deepEqual(ann.act("send", session, lines[0] as string, "--over"), { sent: true, position: 1 });
  await gets(bob);
  assert.deepEqual(textsRead(bob.read()), [lines[0]]);

  // standby, and a blind reply refused.
  bob.act("send", session, lines[1] as string, "--standby", "2");
  await gets(ann);
  assert.equal(ann.refused("send", session, "a blind reply", "--over"), "session_not_current");
  const standby = ann.read();
  assert.deepEqual(standby.messages.map((m) => [m.text, m.signal]), [[lines[1], "standby"]]);

  // Ann's daemon dies, then her own server goes too. Bob speaks meanwhile. Her conversation doesn't depend on her own server.
  ann.kill();
  bob.act("send", session, lines[2] as string, "--over");
  docker("stop", `${A.name}-server-1`);
  ann.login();
  await until("Ann back on Bob's server", () => ann.status().visiting.some((v) => v.server === B.url && v.agents === 1));
  assert.equal(ann.status().connected, false, "her own server must really be down for this to mean anything");
  await gets(ann);
  assert.deepEqual(textsRead(ann.read()), [lines[2]]);
  assert.deepEqual(ann.act("send", session, lines[3] as string, "--over"), { sent: true, position: 4 });
  docker("start", `${A.name}-server-1`);
  await until("Ann's own server back", () => ann.status().connected && ann.status().agents.every((a) => a.online));
  await gets(bob);
  assert.deepEqual(textsRead(bob.read()), [lines[3]]);
  say("carried on through Ann's daemon dying with her own server down");

  // Bob's daemon dies too, and what was sent meanwhile is waiting for it.
  bob.kill();
  assert.deepEqual(ann.act("send", session, lines[4] as string, "--over"), { sent: true, position: 5 });
  bob.login();
  await until("Bob back", () => bob.status().agents.every((a) => a.online));
  await gets(bob);
  assert.deepEqual(textsRead(bob.read()), [lines[4]]);

  // wrap, then a close from each side, which seals.
  bob.act("send", session, lines[5] as string, "--wrap");
  await gets(ann);
  assert.deepEqual(ann.read().messages.map((m) => m.signal), ["wrap"]);
  const annClosed = ann.act("close-session", session) as { closed: boolean; seal: { sealed: boolean; seal_id: string } };
  assert.deepEqual([annClosed.closed, annClosed.seal.sealed], [true, true]);
  await gets(bob);
  assert.equal(bob.read().messages[0]?.closed_their_side, true);
  const bobClosed = bob.act("close-session", session) as { state: string; seal: { sealed: boolean; seal_id: string; session_closed: boolean; witnessed_through: number } };
  assert.deepEqual([bobClosed.state, bobClosed.seal.sealed, bobClosed.seal.session_closed, bobClosed.seal.witnessed_through], ["closed", true, true, 8]);
  say("closed and sealed on both sides");

  // ---- The record checks out on both sides, with nothing but public keys. ----
  const checkA = ann.act("verify-session", session);
  const checkB = bob.act("verify-session", session);
  assert.deepEqual([checkA["ok"], checkB["ok"], checkA["position"]], [true, true, 8]);
  assert.equal(checkA["root"], checkB["root"]);
  const files = mkdtempSync(join(tmpdir(), "cello-v2-fed-files-"));
  const saved = (name: string, value: unknown): string => {
    const path = join(files, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  // A stranger with an empty folder, no daemon and no server checks both sides' seals. The seal key comes from the hosting server.
  const reader = side("Reader", A);
  const annSeal = saved("ann-seal.json", ann.act("export-seal", annClosed.seal.seal_id));
  const bobSeal = saved("bob-seal.json", bob.act("export-seal", bobClosed.seal.seal_id));
  for (const file of [annSeal, bobSeal]) assert.equal(reader.must(["verify-seal", file, "--seal-key", healthB.seal_key])["ok"], true);
  const wrongServer = reader.run(["verify-seal", annSeal, "--seal-key", healthA.seal_key]);
  assert.deepEqual([wrongServer.status, wrongServer.json["fault"]], [1, "wrong_seal_key"], "a seal from Bob's server doesn't pass as one from Ann's");
  const proof = join(files, "transcript.json");
  ann.act("export-transcript", session, "--all", "--out", proof);
  const checked = reader.must(["verify-transcript", proof, "--seal-key", healthB.seal_key]) as { ok: boolean; messages: { position: number; text?: string }[] };
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.messages.slice(0, 6).map((m) => m.text), lines);
  say("the record verifies on both sides, and offline");

  // Bob's server holds no encrypted text once it's confirmed stored. It never held readable text at all.
  await until("the encrypted text to go", () => sql(B, `SELECT count(*) FROM entries WHERE ciphertext IS NOT NULL AND session_id = '\\x${session}'`) === "0");

  // ---- Up to here, Ann's server has had no part in this. It must know nothing of Bob or the conversation. ----
  const logsSoFarA = logsOf(A);
  const dumpSoFarA = dbDump(A);
  assert.match(logsSoFarA, /agent\.connected/, "the check must be reading the real log");
  for (const [secret, what] of [[bobAgent.id, "Bob's key"], [session, "the session"], [healthB.server, "Bob's server"]] as const) {
    assert.ok(!logsSoFarA.includes(secret), `${what} is in Ann's server's logs`);
    assert.ok(!dumpSoFarA.includes(secret), `${what} is in Ann's server's database`);
  }

  // ---- And back: Bob calls Ann at her server, which now hosts. ----
  const backLines = ["bob calling back: one question", "ann answering on her own server"];
  const back = bob.act("initiate-session", annAgent.address);
  assert.equal(back["state"], "active");
  const backSession = back["session_id"] as string;
  bob.act("send", backSession, backLines[0] as string, "--over");
  await gets(ann);
  assert.deepEqual(textsRead(ann.read()), [backLines[0]]);
  ann.act("send", backSession, backLines[1] as string, "--wrap");
  await gets(bob);
  assert.deepEqual(textsRead(bob.read()), [backLines[1]]);
  assert.deepEqual(bob.ports(), [18400, 18401], "now Bob is the one who dialled out");
  const bobBack = bob.act("close-session", backSession) as { seal: { sealed: boolean; seal_id: string } };
  assert.equal(bobBack.seal.sealed, true);
  await gets(ann);
  ann.read();
  const annBack = ann.act("close-session", backSession) as { state: string; seal: { sealed: boolean; seal_id: string } };
  assert.deepEqual([annBack.state, annBack.seal.sealed], ["closed", true]);
  assert.equal(reader.must(["verify-seal", saved("back.json", ann.act("export-seal", annBack.seal.seal_id)), "--seal-key", healthA.seal_key])["ok"], true);
  assert.deepEqual([bob.act("verify-session", backSession)["ok"], ann.act("verify-session", backSession)["ok"]], [true, true]);
  say("Bob called back, hosted on Ann's server, and it sealed");

  // A visit ends with its conversations.
  await until("the finished visits to end", () => ann.status().visiting.length === 0 && bob.status().visiting.length === 0, 500);
  await until("each daemon to be back to its own server alone", () => ann.ports().join() === "18400" && bob.ports().join() === "18401");

  // ---- Where an agent can and can't be called. ----
  const cara = side("Cara", B);
  await create(cara);
  assert.equal(ann.refused("initiate-session", `${bobAgent.id}@127.0.0.1:18400`), "unknown_agent", "Ann's server doesn't hold Bob, and doesn't relay for his");
  assert.equal(cara.refused("initiate-session", annAgent.address.replace("18400", "18401")), "unknown_agent", "Ann is only a visitor on Bob's server, so she can't be called there");
  assert.equal(ann.refused("initiate-session", `${bobAgent.id}@127.0.0.1:18419`), "server_unreachable", "an address nobody answers at fails by name");
  assert.equal(ann.refused("initiate-session", `${bobAgent.id}@not a server`), "bad_argument");

  // ---- What a stranger's own software can try. ----
  const stranger = await Stranger.at(B.url);
  const rowsBefore = sql(B, "SELECT count(*) FROM agents");
  await refusedWith(stranger.link.call("lookup", { agent: toB64(stranger.signer.id), target: Buffer.from(bobAgent.id, "hex").toString("base64url") }), "not_authenticated");
  // A proof made out to another server can't be forwarded here, and neither can a proof with the wrong keys.
  await refusedWith(stranger.link.call("visit", await stranger.visitParams(new Uint8Array(Buffer.from(healthA.server, "hex")))), "bad_signature");
  const otherKeys = await signerFromSeeds(generateIdentitySeeds());
  await refusedWith(stranger.link.call("visit", { ...await stranger.visitParams(), identity: identityCodec.encode(otherKeys.publicIdentity) }), "bad_signature");
  await stranger.visit();
  assert.equal(sql(B, "SELECT count(*) FROM agents"), rowsBefore, "proving a key costs the server no storage");
  await refusedWith(stranger.send(await stranger.offer(bobAgent.id, new Uint8Array(Buffer.from(healthA.server, "hex")))), "bad_request");
  await refusedWith(stranger.send(await stranger.offer(annAgent.id)), "unknown_agent");

  // ---- The limits. Dana's daemon is off, so calls to her stay unanswered. ----
  const dana = side("Dana", B);
  const danaAgent = await create(dana);
  dana.kill();
  stranger.link.stop();
  up(B, { CELLO_VISITOR_PENDING_PER_RECIPIENT: "2" });
  await until("Bob back after his server restarts", () => bob.status().agents.every((a) => a.online), 600);
  const pester = await Stranger.at(B.url);
  await pester.visit();
  const firstCall = await pester.offer(danaAgent.id);
  await pester.send(firstCall);
  await pester.send(await pester.offer(danaAgent.id));
  await refusedWith(pester.send(await pester.offer(danaAgent.id)), "too_many_pending");
  await pester.send(firstCall);
  assert.equal(sql(B, "SELECT count(*) FROM sessions WHERE from_visitor AND state = 'offered'"), "2", "a repeat isn't a new call, and a refused one left nothing");
  pester.link.stop();

  const spent = sql(B, "SELECT count(*) FROM sessions WHERE from_visitor");
  up(B, { CELLO_VISITOR_CALLS_PER_HOUR: spent });
  await until("Bob back", () => bob.status().agents.every((a) => a.online), 600);
  const late = await Stranger.at(B.url);
  await late.visit();
  await refusedWith(late.send(await late.offer(bobAgent.id)), "visitor_budget_spent");
  late.link.stop();
  say("the per-recipient cap and the shared budget both refused by name");

  // One setting closes federation. The server's own agents go on as before.
  const closedHealth = up(B, { CELLO_FEDERATION: "closed" });
  assert.equal(closedHealth.federation, "closed");
  await until("Bob and Cara back", () => bob.status().agents.every((a) => a.online) && cara.status().agents.every((a) => a.online), 600);
  assert.equal(ann.refused("initiate-session", bobAgent.address), "federation_closed");
  const inside = cara.act("initiate-session", bobAgent.id);
  assert.equal(inside["state"], "active", "the server's own agents don't need federation");
  say("closing federation refused the outsider and left the insiders talking");

  // ---- What the logs and databases hold. ----
  const logsA = logsOf(A);
  const logsB = logsOf(B);
  assert.match(logsB, /session\.active/, "the check must be reading the real log");
  assert.match(logsB, /agent\.visiting/);
  assert.match(logsA, /session\.active/);
  assert.match(logsA, /agent\.visiting/);
  const allLines = [...lines, ...backLines];
  // The only addresses a container here can see are its network's gateway and this machine's.
  const gateways = [A, B].map((server) => docker("network", "inspect", `${server.name}_default`, "--format", "{{(index .IPAM.Config 0).Gateway}}").trim());
  assert.ok(gateways.every((gateway) => /^\d+\.\d+\.\d+\.\d+$/.test(gateway)), `the gateways must be real addresses: ${gateways.join()}`);
  await assert.rejects(checkLogsClean(`${logsA}\n${lines[0] as string}`, allLines, gateways), /message's text/, "the check catches a planted message");
  await assert.rejects(checkLogsClean(`${logsA}\n${gateways[0] as string}`, allLines, gateways), /an address/, "the check catches a planted address");
  const checkedA = await checkLogsClean(logsA, allLines, gateways);
  const checkedB = await checkLogsClean(logsB, allLines, gateways);
  report["addresses_checked"] = { a: checkedA, b: checkedB, gateways };
  for (const logs of [logsA, logsB]) assert.equal(logs.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)?.[0], undefined, "no log line holds any IPv4 address");
  const dumpA = dbDump(A);
  const dumpB = dbDump(B);
  for (const line of allLines) {
    for (const [what, content] of [["logs", logsA + logsB], ["databases", dumpA + dumpB]] as const) assert.ok(!content.includes(line), `readable text in the ${what}: ${line}`);
  }
  // Neither server learned the other exists: not its address, not its key.
  for (const [content, other] of [[logsA + dumpA, B], [logsB + dumpB, A]] as const) {
    assert.ok(!content.includes(`:${other.port}/`) && !content.includes(`127.0.0.1:${other.port}`), `one server's records hold the other's address, port ${other.port}`);
  }
  assert.ok(!(logsA + dumpA).includes(healthB.server), "Ann's server holds the identity of Bob's");
  assert.ok(!(logsB + dumpB).includes(healthA.server), "Bob's server holds the identity of Ann's");
  // What a hosting server does learn, by design: the visitor's key and name. Stated here so that a change shows.
  assert.equal(sql(B, `SELECT count(*) FROM agents WHERE agent_id = '\\x${annAgent.id}' AND NOT resident`), "1");

  report["session"] = session;
  report["back_session"] = backSession;
  report["passed"] = true;
  say("PASSED");
});

// The kill switch, with real daemons on two real servers. Run it with scripts/status-test.sh, which cleans up whatever happens.
import { REAL_CLI, cliFor } from "./cli-path.ts";
import { signedAck } from "../src/protocol/wire.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type ConnectedServer, ServerLink, ServerRefused } from "../src/daemon/link.ts";
import { OPERATIONS } from "../src/ipc/operations.ts";
import { type Signer, generateIdentitySeeds, signerFromSeeds } from "../src/protocol/identity.ts";
import { generateSessionEphemeral } from "../src/protocol/key-agreement.ts";
import { STATUS_DOMAIN } from "../src/protocol/status.ts";
import { AgentStatus, StatusIssuer, StatusReason, type StatusStatementFields, agentAuthBytes, offerBytes, registerBytes, statusStatementBytes } from "../src/protocol/structures.ts";
import { toHex } from "../src/protocol/encode.ts";
import { standInSignal } from "./stand-in-issuer.ts";
import { identityCodec, signatureCodec, signedOffer, signedStatusStatement, toB64 } from "../src/protocol/wire.ts";

const serverDir = process.env["CELLO_SERVER_DIR"] ?? new URL("../../cello-server", import.meta.url).pathname;
const pidsFile = process.env["CELLO_STATUS_PIDS"];
const cliPath = REAL_CLI;
const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
const evidence = join(homedir(), "cello-v2-live-runs", `status-${stamp}`);
mkdirSync(evidence, { recursive: true });

// A run beside another one sets its own names and ports. The first of the two ports is A's.
const project = process.env["CELLO_STATUS_PROJECT"] ?? "cello-v2-status";
const firstPort = Number(process.env["CELLO_STATUS_PORT"] ?? 18800);
const A = { name: `${project}-a`, port: firstPort, url: `ws://127.0.0.1:${firstPort}/v1` };
const B = { name: `${project}-b`, port: firstPort + 1, url: `ws://127.0.0.1:${firstPort + 1}/v1` };
type Server = typeof A;
const report: Record<string, unknown> = { started: stamp };
const LONG_TEXT = "a long message on the second connection ".repeat(600);

function say(line: string): void {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
}

function server(args: string[], env: Record<string, string> = {}): string {
  return execFileSync(join(serverDir, "scripts/server.sh"), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
}

// The operator's own command, at the machine the server runs on.
function operator(at: Server, verb: string, id: string): { status: string; records: unknown[] } {
  return JSON.parse(server(["agent", verb, id, "--name", at.name]).trim().split("\n").at(-1) as string) as { status: string; records: unknown[] };
}

const sql = (at: Server, query: string): string => execFileSync("docker", ["exec", `${at.name}-postgres-1`, "psql", "-U", "cello_owner", "-d", "cello", "-tAc", query], { encoding: "utf8" }).trim();
const statusOn = (at: Server, id: string): string => sql(at, `SELECT status FROM agent_status WHERE agent_id = '\\x${id}'`);

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, tries = 300): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A real terminal, because a pipe isn't a person. It types whatever code the command shows.
const TERMINAL = `
import os, pty, re, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
answer = sys.argv[1]
out = ""
sent = False
deadline = time.time() + 35
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if fd in ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        out += data.decode(errors="replace")
    asked = re.search(r"type ([0-9a-f]{6}):", out)
    if asked and not sent:
        sent = True
        os.write(fd, ((asked.group(1) if answer == "right" else answer) + "\\n").encode())
os.close(fd)
print(out)
`;

interface Run { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
interface Status { pid: number; agents: { online: boolean; unread: number; status: string }[] }
const everyone: { run(args: string[]): Run }[] = [];

function side(name: string, home: Server) {
  const dir = mkdtempSync(join(tmpdir(), `cello-v2-status-${name}-`));
  const env = { ...process.env, CELLO_HOME: dir, CELLO_CALLER: `shell-${name}` };
  const run = (args: string[], input?: string): Run => {
    const done = spawnSync(process.execPath, [cliFor(args), ...args], { encoding: "utf8", env, ...(input === undefined ? {} : { input }) });
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
    assert.equal(done.status, 0, `${name}: cello ${args.join(" ")} failed: ${done.stdout}${done.stderr}`);
    return done.json;
  };
  const self = {
    name,
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
    unread: () => (must(["status"]) as unknown as Status).agents[0]?.unread ?? 0,
    read: () => must(["receive", "--agent", name]) as { messages: { text?: string }[]; notices: { text: string }[] },
    // At a person's terminal, in a shell with no CELLO_CALLER.
    atTerminal: (args: string[], answer = "right", caller?: string): string => {
      const terminal: NodeJS.ProcessEnv = { ...env };
      delete terminal["CELLO_CALLER"];
      if (caller) terminal["CELLO_CALLER"] = caller;
      const done = spawnSync("python3", ["-c", TERMINAL, answer, process.execPath, cliFor(args), ...args], { encoding: "utf8", timeout: 40_000, env: terminal });
      assert.equal(done.status, 0, `the terminal didn't run: ${done.stderr}`);
      return done.stdout;
    },
    statusLog: () => self.act("agent-status") as { status_here: string; servers: { server: string; status: string; reachable: boolean; verified: boolean; log: { status: string; reason: string; issuer: string; witnessed_at: string }[] }[] },
  };
  everyone.push(self);
  return self;
}
type Side = ReturnType<typeof side>;

async function create(who: Side): Promise<{ id: string; address: string }> {
  who.login();
  const made = who.must(["create-agent", who.name]);
  // Nobody is attached here, and an away visit would answer and close on the first message, which isn't what this tests.
  who.must(["settings-set", "away.answering", "false", "--agent", who.name]);
  await until(`${who.name} online`, () => who.status().agents.every((a) => a.online));
  return { id: made["agent_id"] as string, address: made["address"] as string };
}

const gets = (who: Side): Promise<boolean> => until(`something to reach ${who.name}`, () => who.unread() >= 1);

// Sends and hands the turn over, with the other side reading it.
async function talk(from: Side, to: Side, session: string, text: string): Promise<void> {
  const sent = spawnSync(process.execPath, [cliPath, "send", session, "-", "--over", "--agent", from.name], { encoding: "utf8", input: text, env: { ...process.env, CELLO_HOME: homeOf(from), CELLO_CALLER: `shell-${from.name}` } });
  assert.equal(sent.status, 0, `${from.name} couldn't send: ${sent.stdout}${sent.stderr}`);
  await gets(to);
  const read = to.read();
  assert.ok(read.messages.some((m) => m.text === text), `${to.name} didn't get what ${from.name} sent`);
}
const homeOf = (who: Side): string => (who.status() as unknown as { home: string }).home;

// What software other than our daemon could send: real keys and a real socket, and no daemon being polite about it.
class Raw {
  readonly signer: Signer;
  readonly link: ServerLink;
  readonly long: ServerLink;
  readonly #first: Promise<ConnectedServer>;
  readonly #second: Promise<ConnectedServer>;
  constructor(signer: Signer, url: string) {
    this.signer = signer;
    const open = (): [ServerLink, Promise<ConnectedServer>] => {
      let connected: (server: ConnectedServer) => void = () => undefined;
      const up = new Promise<ConnectedServer>((resolve) => { connected = resolve; });
      return [new ServerLink(url, { checkIdentity: () => null, connected: async (server) => connected(server), disconnected: () => undefined, push: () => undefined }), up];
    };
    [this.link, this.#first] = open();
    [this.long, this.#second] = open();
    this.link.start();
    this.long.start();
  }
  static async at(url: string): Promise<Raw> {
    const raw = new Raw(await signerFromSeeds(generateIdentitySeeds()), url);
    await Promise.all([raw.#first, raw.#second]);
    return raw;
  }
  get id(): string {
    return Buffer.from(this.signer.id).toString("hex");
  }
  get agent(): string {
    return toB64(this.signer.id);
  }
  async register(): Promise<void> {
    const server = await this.#first;
    const identity = this.signer.publicIdentity;
    await this.link.call("register", { identity: identityCodec.encode(identity), signature: signatureCodec.encode(await this.signer.sign("cello-register", registerBytes({ serverId: server.id, identity }))), signal: await standInSignal(toHex(this.signer.id)) });
  }
  async #proof(server: ConnectedServer): Promise<{ clientNonce: string; signature: unknown }> {
    const clientNonce = new Uint8Array(randomBytes(32));
    return { clientNonce: toB64(clientNonce), signature: signatureCodec.encode(await this.signer.sign("cello-agent-auth", agentAuthBytes({ serverId: server.id, agentId: this.signer.id, serverNonce: server.nonce, clientNonce }))) };
  }
  async auth(): Promise<{ standing: { status: string } }> {
    return await this.link.call("auth", { agentId: this.agent, ...await this.#proof(await this.#first) }) as { standing: { status: string } };
  }
  async authLong(): Promise<unknown> {
    return this.long.call("auth", { agentId: this.agent, ...await this.#proof(await this.#second), long: true });
  }
  async visit(): Promise<{ standing: { status: string } }> {
    const server = await this.#first;
    const identity = this.signer.publicIdentity;
    return await this.link.call("visit", {
      identity: identityCodec.encode(identity),
      ...await this.#proof(server),
      nameSignature: signatureCodec.encode(await this.signer.sign("cello-visit", registerBytes({ serverId: server.id, identity }))),
    }) as { standing: { status: string } };
  }
  async offer(calleeId: string): Promise<unknown> {
    const server = await this.#first;
    const own = await generateSessionEphemeral();
    const fields = { serverId: server.id, sessionId: new Uint8Array(randomBytes(16)), callerId: this.signer.id, calleeId: new Uint8Array(Buffer.from(calleeId, "hex")), x25519Public: own.publicKey, mlKemPublic: own.mlKemPublic, expiresAt: Date.now() + 600_000, signalsCiphertext: new Uint8Array(0), sealedSignals: new Uint8Array(0) };
    return this.link.call("session.offer", { agent: this.agent, offer: signedOffer.encode({ fields, signature: await this.signer.sign("cello-session-offer", offerBytes(fields)) }) });
  }
  stop(): void {
    this.link.stop();
    this.long.stop();
  }
}

async function refusedWith(work: Promise<unknown>, code: string, what: string): Promise<void> {
  await assert.rejects(work, (err: unknown) => err instanceof ServerRefused && err.code === code, `${what}: expected the refusal ${code}`);
}

async function statement(signer: Signer, issuer: number, agentId: Uint8Array, status: number, reason: number, issuedAt = Date.now()) {
  const fields = { agentId, status, reason, issuer, issuerId: signer.id, issuedAt } as StatusStatementFields;
  return signedStatusStatement.encode({ fields, signature: await signer.sign(STATUS_DOMAIN, statusStatementBytes(fields)) });
}

after(() => {
  writeFileSync(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const who of everyone) who.run(["logout"]);
  say(`evidence: ${evidence}`);
});

test("the kill switch stops an agent at once, on each server, and leaves it able to seal", { timeout: 400_000 }, async () => {
  const portal = await signerFromSeeds(generateIdentitySeeds());
  const portalEnv = { CELLO_TRUSTED_ISSUERS: JSON.stringify([...JSON.parse(process.env["CELLO_TRUSTED_ISSUERS"] as string) as unknown[], { address: "issuer.status-test.example", ...identityCodec.encode(portal.publicIdentity) }]) };
  server(["up", "--name", A.name, "--port", String(A.port), "--no-build"], portalEnv);
  server(["up", "--name", B.name, "--port", String(B.port), "--no-build"], portalEnv);
  say("two servers up");

  // These are person-only: no tool exists for any of them.
  for (const command of ["suspend", "retire", "remove-agent", "publish-status"]) assert.ok(OPERATIONS.find((op) => op.command === command)?.personOnly, `${command} must have no tool`);

  // ---- An open conversation, with a long message on the second connection first. ----
  const cara = side("Cara", A);
  const dana = side("Dana", A);
  const eve = side("Eve", A);
  const caraAgent = await create(cara);
  const danaAgent = await create(dana);
  await create(eve);
  const session = cara.act("initiate-session", "--anyway", danaAgent.id)["session_id"] as string;
  await talk(cara, dana, session, "short, before anything happens");
  await talk(dana, cara, session, LONG_TEXT);
  await talk(cara, dana, session, LONG_TEXT);
  await talk(dana, cara, session, "and back to you");
  say("an open conversation, with long messages both ways");

  // ---- The switch flips mid-conversation. ----
  const flipped = operator(A, "suspend", caraAgent.id);
  const flippedAt = Date.now();
  assert.equal(flipped.status, "suspended");
  assert.equal(cara.refused("send", session, "after the flip", "--over"), "agent_suspended");
  assert.equal(cara.refused("receive"), "agent_suspended");
  report["ms_from_operator_command_to_refused_send_and_receive"] = Date.now() - flippedAt;
  assert.equal(cara.refused("initiate-session", "--anyway", danaAgent.id), "agent_suspended");
  assert.equal(cara.refused("close-session", session), "agent_suspended");
  assert.equal(cara.refused("wait"), "agent_suspended");
  assert.equal(cara.refused("channel-create", "after-the-flip", "--type", "public"), "agent_suspended");
  const longSend = spawnSync(process.execPath, [cliPath, "send", session, "-", "--over", "--agent", "Cara"], { encoding: "utf8", input: LONG_TEXT, env: { ...process.env, CELLO_HOME: homeOf(cara), CELLO_CALLER: "shell-Cara" } });
  assert.match(longSend.stderr, /agent_suspended/, "a long message stops too");
  say(`the next send and receive both stopped, by name, ${report["ms_from_operator_command_to_refused_send_and_receive"] as number} ms after the command`);

  // The other side is told only that the conversation stopped.
  const told = await until("Dana to be told", () => {
    const read = dana.read();
    return read.notices.length > 0 && read;
  });
  assert.match(told.notices[0]?.text as string, /conversation has stopped/);
  const refusedDana = dana.run(["send", session, "are you there", "--over", "--agent", "Dana"]);
  assert.equal(refusedDana.json["error"], "conversation_stopped");
  const danaSaw = JSON.stringify([told, refusedDana.json, dana.act("sessions")]);
  assert.ok(!/suspend|retire|compromise|lost_machine/i.test(danaSaw), `the other side learned why: ${danaSaw}`);
  assert.equal((dana.act("sessions") as { sessions: { stopped: boolean }[] }).sessions[0]?.stopped, true);
  // A new call to a suspended agent says no more than that.
  const eveCalls = eve.run(["initiate-session", "--anyway", caraAgent.id, "--agent", "Eve"]);
  assert.equal(eveCalls.json["error"], "agent_unavailable");
  assert.ok(!/suspend/i.test(eveCalls.stderr), eveCalls.stderr);
  say("the other side heard only that the conversation stopped");

  // A suspended agent can still seal what's witnessed.
  const sealed = cara.act("seal", session) as { sealed: boolean; seal_id: string };
  assert.equal(sealed.sealed, true, "a suspended agent must be able to seal");
  const health = JSON.parse(server(["up", "--name", A.name, "--port", String(A.port), "--no-build"], portalEnv).trim().split("\n").at(-1) as string) as { seal_key: string };
  await until("Cara back after the server's restart check", () => cara.status().agents[0]?.online);
  const file = join(mkdtempSync(join(tmpdir(), "cello-v2-status-seal-")), "seal.json");
  writeFileSync(file, JSON.stringify(cara.act("export-seal", sealed.seal_id)));
  assert.equal(side("Reader", A).must(["verify-seal", file, "--seal-key", health.seal_key])["ok"], true);
  say("the suspended agent sealed, and the seal verifies offline");

  // The log shows when it began. Every message witnessed is before that moment, by the server's own signatures.
  const logged = cara.statusLog().servers[0];
  assert.equal(logged?.verified, true);
  const began = logged?.log.at(-1);
  assert.deepEqual([began?.status, began?.issuer], ["suspended", "server"]);
  const lastAck = signedAck.decode(JSON.parse(sql(A, `SELECT ack FROM entries WHERE session_id = '\\x${session}' ORDER BY position DESC LIMIT 1`))).fields.time;
  assert.ok(lastAck <= Date.parse(began?.witnessed_at as string), "the last message is dated after the suspension");
  report["suspension_witnessed_at"] = began?.witnessed_at;
  say("the signed log shows when it began, and all the witnessed messages are before it");

  // A restart doesn't lift it. The daemon knows from its database, and the server from its row.
  cara.must(["logout"]);
  cara.login();
  assert.equal(cara.refused("send", session, "after a restart", "--over"), "agent_suspended");
  await until("Cara online, for sealing", () => cara.status().agents[0]?.online);

  // Lifting it: the operator can, and everything comes back, with the second connection proved again.
  assert.equal(operator(A, "resume", caraAgent.id).status, "active");
  await until("Cara to hear she's lifted", () => cara.status().agents[0]?.status === "active");
  await until("Dana to hear it can carry on", () => (dana.act("sessions") as { sessions: { stopped: boolean }[] }).sessions[0]?.stopped === false);
  dana.read();
  await talk(cara, dana, session, LONG_TEXT);
  await talk(dana, cara, session, "good to have you back");
  say("the operator lifted it, and long and short messages both work again");

  // ---- What the server itself refuses, with no daemon being polite. The second connection is cut, and refuses a new proof. ----
  const raw = await Raw.at(A.url);
  await raw.register();
  assert.equal((await raw.auth()).standing.status, "active");
  await raw.authLong();
  const list = { agent: raw.agent };
  await raw.long.call("session.list", list);
  operator(A, "suspend", raw.id);
  await refusedWith(raw.link.call("session.list", list), "agent_suspended", "the first connection");
  await refusedWith(raw.long.call("session.list", list), "agent_suspended", "the second connection");
  await refusedWith(raw.authLong(), "agent_suspended", "a new proof on the second connection");
  await refusedWith(raw.offer(danaAgent.id), "agent_suspended", "calling");
  await refusedWith(raw.link.call("channel.create", list), "agent_suspended", "a channel action");
  assert.equal((await raw.auth()).standing.status, "suspended", "it can prove itself on its first connection, to seal");
  // A thief with the keys can't lift it, or come back with an old statement.
  await refusedWith(raw.link.call("agent.status", { statement: await statement(raw.signer, StatusIssuer.agent, raw.signer.id, AgentStatus.active, StatusReason.none) }), "status_not_allowed", "an agent lifting itself");
  await refusedWith(raw.link.call("agent.status", { statement: await statement(portal, StatusIssuer.portal, raw.signer.id, AgentStatus.active, StatusReason.none, Date.now() - 3_600_000) }), "status_stale", "an old lifting");
  operator(A, "resume", raw.id);
  await raw.authLong();
  await raw.long.call("session.list", list);
  operator(A, "retire", raw.id);
  await refusedWith(raw.link.call("session.list", list), "agent_retired", "a retired agent's first connection");
  await refusedWith(raw.long.call("session.list", list), "agent_retired", "a retired agent's second connection");
  await refusedWith(raw.auth(), "agent_retired", "a retired agent proving itself");
  await refusedWith(raw.authLong(), "agent_retired", "a retired agent on the second connection");
  await assert.rejects(async () => { operator(A, "resume", raw.id); }, "nothing lifts retired");
  assert.equal(statusOn(A, raw.id), "retired");
  assert.equal(eve.refused("initiate-session", "--anyway", raw.id), "agent_retired", "a retired agent is refused by name");
  raw.stop();
  say("the server refused both connections itself, and nothing lifts retired");

  // ---- A forged statement. ----
  const target = await Raw.at(A.url);
  await target.register();
  const forger = await signerFromSeeds(generateIdentitySeeds());
  const forgeries: [string, unknown, string][] = [
    ["signed by a key claiming to be the portal", await statement(forger, StatusIssuer.portal, target.signer.id, AgentStatus.retired, StatusReason.compromise), "bad_signature"],
    ["signed by a key claiming to be the agent", await statement(forger, StatusIssuer.agent, target.signer.id, AgentStatus.suspended, StatusReason.none), "bad_signature"],
    ["signed by a key claiming to be this server", await statement(forger, StatusIssuer.server, target.signer.id, AgentStatus.suspended, StatusReason.none), "bad_signature"],
  ];
  const genuine = await statement(portal, StatusIssuer.portal, target.signer.id, AgentStatus.suspended, StatusReason.none);
  const alteredFields = signedStatusStatement.decode(genuine);
  forgeries.push(["altered after a real signature", signedStatusStatement.encode({ fields: { ...alteredFields.fields, status: AgentStatus.retired }, signature: alteredFields.signature }), "bad_signature"]);
  const dir = mkdtempSync(join(tmpdir(), "cello-v2-status-forged-"));
  for (const [what, forged, code] of forgeries) {
    const path = join(dir, `${code}-${forgeries.findIndex((f) => f[0] === what)}.json`);
    writeFileSync(path, JSON.stringify(forged));
    assert.match(eve.atTerminal(["publish-status", path, "--server", A.url]), new RegExp(code), what);
  }
  assert.equal(statusOn(A, target.id), "", "no forgery changed anything");
  // An unknown identity can't write a row with its own keys. Proving a key still costs the server no storage.
  const passer = await signerFromSeeds(generateIdentitySeeds());
  await refusedWith(target.link.call("agent.status", { statement: await statement(passer, StatusIssuer.agent, passer.id, AgentStatus.suspended, StatusReason.none) }), "unknown_agent", "fresh keys");
  // The real one, from the portal's configured key, carried by anybody.
  const path = join(dir, "genuine.json");
  writeFileSync(path, JSON.stringify(genuine));
  assert.match(eve.atTerminal(["publish-status", path, "--server", A.url]), /"ok":true/);
  assert.equal(statusOn(A, target.id), "suspended");
  target.stop();
  say("four forged statements refused, and the portal's real one taken");

  // ---- Only a person, at a terminal. ----
  const fay = side("Fay", A);
  const fayAgent = await create(fay);
  const faySession = eve.act("initiate-session", "--anyway", fayAgent.id)["session_id"] as string;
  await talk(eve, fay, faySession, "are you there");
  assert.equal(fay.run(["retire", "--reason", "compromise", "--agent", "Fay"]).json["error"], "person_required", "a pipe isn't a person");
  assert.match(fay.atTerminal(["retire", "--agent", "Fay"], "right", "agent-shell"), /person_required/, "an agent's shell isn't a person");
  assert.match(fay.atTerminal(["retire", "--agent", "Fay"], "000000"), /not_confirmed/);
  assert.equal(fay.status().agents[0]?.status, "active", "none of those changed anything");

  // A person burns it. It can't be called, can't reconnect, and the record stays.
  assert.match(fay.atTerminal(["retire", "--reason", "compromise", "--agent", "Fay"]), /"status":"retired"/);
  assert.equal(fay.refused("send", faySession, "still here", "--over"), "agent_retired");
  assert.equal(fay.refused("receive"), "agent_retired");
  assert.equal(eve.refused("initiate-session", "--anyway", fayAgent.id), "agent_retired");
  assert.equal(sql(A, `SELECT reason FROM agent_status WHERE agent_id = '\\x${fayAgent.id}'`), "compromise");
  await until("Eve to be told", () => (eve.act("sessions") as { sessions: { session_id: string; stopped: boolean }[] }).sessions.find((s) => s.session_id === faySession)?.stopped);
  assert.equal(eve.refused("send", faySession, "hello?", "--over"), "conversation_stopped");
  fay.must(["logout"]);
  fay.login();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual([fay.status().agents[0]?.online, fay.status().agents[0]?.status], [false, "retired"], "a retired agent doesn't reconnect");
  assert.equal(fay.refused("seal", faySession), "agent_retired");
  assert.equal(fay.statusLog().servers[0]?.log.at(-1)?.reason, "compromise", "its log can still be read");
  assert.ok((fay.act("transcript", faySession) as { entries: unknown[] }).entries.length > 0, "its record stays readable");
  say("a person burned an agent: it can't be called or reconnect, and its record stays");

  // remove-agent also frees the name.
  const gus = side("Gus", A);
  const gusAgent = await create(gus);
  assert.match(gus.atTerminal(["remove-agent", "--agent", "Gus"]), /"removed":true/);
  assert.deepEqual((gus.must(["agents"]) as { agents: unknown[] }).agents, []);
  assert.equal(statusOn(A, gusAgent.id), "retired");
  const again = gus.must(["create-agent", "Gus"]);
  assert.notEqual(again["agent_id"], gusAgent.id);
  say("remove-agent retired it and freed the name");

  // ---- A waiting call re-checks its caller at delivery. ----
  const hal = side("Hal", A);
  const halAgent = await create(hal);
  hal.must(["logout"]);
  const caller = await Raw.at(A.url);
  await caller.register();
  await caller.auth();
  await caller.offer(halAgent.id);
  operator(A, "suspend", caller.id);
  hal.login();
  await until("Hal online", () => hal.status().agents[0]?.online);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual((hal.act("sessions") as { sessions: unknown[] }).sessions, [], "a suspended caller's waiting call isn't delivered");
  caller.stop();
  say("a waiting call from a caller since suspended wasn't delivered");

  // ---- Across two servers, which never talk to each other. The conversation lives on Bob's. ----
  const ann = side("Ann", A);
  const bob = side("Bob", B);
  const annAgent = await create(ann);
  const bobAgent = await create(bob);
  const across = ann.act("initiate-session", "--anyway", bobAgent.address)["session_id"] as string;
  const atHome = ann.act("initiate-session", "--anyway", danaAgent.id)["session_id"] as string;
  await talk(ann, bob, across, "ann on her server, talking on bob's");
  await talk(bob, ann, across, LONG_TEXT);
  await talk(ann, bob, across, LONG_TEXT);
  await talk(bob, ann, across, "long messages cross between servers too");
  await talk(ann, dana, atHome, "and ann on her own server");
  assert.equal(statusOn(B, annAgent.id), "");

  // Bob's operator stops her on his server. That's his to do, and her own server carries on: his word doesn't reach her elsewhere.
  operator(B, "suspend", annAgent.id);
  assert.equal(ann.refused("send", across, "hello bob", "--over"), "agent_suspended");
  await talk(dana, ann, atHome, "ann is still fine here");
  await talk(ann, dana, atHome, "yes, still fine here");
  operator(B, "resume", annAgent.id);
  await until("Ann lifted on Bob's server", () => ann.run(["send", across, "back on bob's server", "--over", "--agent", "Ann"]).status === 0);
  await gets(bob);
  bob.read();
  say("one server's operator stopped her there, and her own server carried on");

  // The portal's statement, handed to her own server alone. Her daemon carries it to Bob's, which checks it for itself.
  const portalStop = join(dir, "portal-ann.json");
  writeFileSync(portalStop, JSON.stringify(await statement(portal, StatusIssuer.portal, new Uint8Array(Buffer.from(annAgent.id, "hex")), AgentStatus.suspended, StatusReason.compromise)));
  assert.match(eve.atTerminal(["publish-status", portalStop, "--server", A.url]), /"ok":true/);
  await until("the statement to reach Bob's server", () => statusOn(B, annAgent.id) === "suspended");
  assert.equal(ann.refused("send", across, "hello bob", "--over"), "agent_suspended");
  assert.equal(ann.refused("send", atHome, "hello dana", "--over"), "agent_suspended");
  assert.equal(bob.refused("send", across, "hello ann", "--over"), "conversation_stopped");
  const sealedAcross = ann.act("seal", across) as { sealed: boolean };
  assert.equal(sealedAcross.sealed, true, "she can still seal on the server hosting it");
  const portalLift = join(dir, "portal-ann-lift.json");
  writeFileSync(portalLift, JSON.stringify(await statement(portal, StatusIssuer.portal, new Uint8Array(Buffer.from(annAgent.id, "hex")), AgentStatus.active, StatusReason.none)));
  assert.match(eve.atTerminal(["publish-status", portalLift, "--server", A.url]), /"ok":true/);
  await until("the lifting to reach Bob's server", () => statusOn(B, annAgent.id) === "active");
  await until("Ann lifted", () => ann.status().agents[0]?.status === "active");
  say("the portal's statement stopped her on both servers, and lifted her on both");

  // The portal's word holds for an identity a server has never seen: the thief who moves to a new server.
  const thief = await Raw.at(B.url);
  const thiefStop = await statement(portal, StatusIssuer.portal, thief.signer.id, AgentStatus.suspended, StatusReason.compromise);
  await thief.link.call("agent.status", { statement: thiefStop });
  assert.equal((await thief.visit()).standing.status, "suspended");
  await refusedWith(thief.offer(bobAgent.id), "agent_suspended", "a suspended identity calling on a server it has never used");
  thief.stop();
  say("a portal statement stopped an identity on a server it had never used");

  // Her server's operator, with the machine lost. Her own daemon stops everywhere. Bob's server isn't told: nothing carries an operator's word to a server that doesn't trust it.
  operator(A, "suspend", annAgent.id);
  await until("Ann's daemon to stop", () => ann.status().agents[0]?.status === "suspended");
  assert.equal(ann.refused("send", across, "hello bob", "--over"), "agent_suspended");
  assert.equal(statusOn(B, annAgent.id), "active", "KNOWN LIMIT: a thief's own daemon could still talk on Bob's server");
  operator(A, "resume", annAgent.id);
  await until("Ann lifted", () => ann.status().agents[0]?.status === "active");

  // Her own signed suspend, by a person at her terminal, reaches both.
  const own = ann.atTerminal(["suspend", "--agent", "Ann", "--reason", "compromise"]);
  assert.match(own, /"status":"suspended"/);
  assert.match(own, new RegExp(`"told":\\[[^\\]]*${A.port}[^\\]]*${B.port}|"told":\\[[^\\]]*${B.port}[^\\]]*${A.port}`), own);
  assert.deepEqual([statusOn(A, annAgent.id), statusOn(B, annAgent.id)], ["suspended", "suspended"]);
  assert.equal(bob.refused("send", across, "hello ann", "--over"), "conversation_stopped");
  const both = ann.statusLog().servers;
  assert.equal(both.length, 2);
  assert.ok(both.every((s) => s.verified && s.log.at(-1)?.status === "suspended" && s.log.at(-1)?.issuer === "agent"), JSON.stringify(both));
  // Lifting needs each server's own operator, since she can't lift herself.
  operator(A, "resume", annAgent.id);
  operator(B, "resume", annAgent.id);
  await until("Ann lifted", () => ann.status().agents[0]?.status === "active");
  // Retiring reaches both, and she can't come back to either.
  assert.match(ann.atTerminal(["retire", "--agent", "Ann", "--reason", "compromise"]), /"status":"retired"/);
  assert.deepEqual([statusOn(A, annAgent.id), statusOn(B, annAgent.id)], ["retired", "retired"]);
  assert.equal(bob.refused("initiate-session", "--anyway", annAgent.address), "agent_retired");
  ann.must(["logout"]);
  ann.login();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(ann.status().agents[0]?.online, false);
  say("her own signed suspend and retire reached both servers");

  report["passed"] = true;
  say("PASSED");
});

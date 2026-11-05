// Real daemons as separate processes, the real server, the real database. Start it with scripts/live-test.sh.
// The restart is SIGKILL by captured process id, because a clean shutdown wouldn't test anything.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NO_SESSION_GUIDANCE, OTHER_AGENTS_SESSION_GUIDANCE, OVER_GUIDANCE, SESSION_CLOSED_GUIDANCE, TRUNCATED_SESSION_GUIDANCE, noAgentGuidance, STANDBY_GUIDANCE, WRAP_GUIDANCE, replyLagGuidance, unreadWarning } from "../src/guidance.ts";
import { IpcClient } from "../src/ipc/client.ts";
import type { IpcNotification } from "../src/ipc/protocol.ts";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18090/v1";
const serverDir = process.env["CELLO_SERVER_DIR"] ?? "../cello-server";
const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

function compose(...args: string[]): string {
  return execFileSync("docker", ["compose", ...args], { cwd: serverDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function sql(query: string): string {
  return compose("exec", "-T", "postgres", "psql", "-U", "cello_owner", "-d", "cello", "-tAc", query).trim();
}

interface AgentStatus { name: string; agent_id: string; online: boolean; unread: number; sessions: { session_id: string; state: string; position: number; own_closed: boolean; peer_closed: boolean; fault: string | null }[] }
interface Status { pid: number; connected: boolean; agents: AgentStatus[] }

class Daemon {
  readonly home = mkdtempSync(join(tmpdir(), "cello-v2-live-"));
  cli(...args: string[]): string {
    return execFileSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env: { ...process.env, CELLO_V2_HOME: this.home } });
  }
  login(): void {
    this.cli("login", "--server", url);
  }
  status(): Status {
    return JSON.parse(this.cli("status")) as Status;
  }
  kill(): void {
    process.kill(this.status().pid, "SIGKILL");
  }
  createAgent(name: string): string {
    const id = (JSON.parse(this.cli("create-agent", name)) as { agent_id: string }).agent_id;
    // These tests hold conversations with agents nobody has selected, so nothing answers for them.
    this.cli("settings-set", "away.answering", "false", "--agent", name);
    return id;
  }
  log(): string {
    return readFileSync(join(this.home, "daemon.log"), "utf8");
  }
  async attach(agent: string): Promise<Session> {
    const client = await IpcClient.connect(join(this.home, "daemon.sock"));
    const session = new Session(client, agent);
    await session.call("subscribe");
    return session;
  }
}

let nextCaller = 1;

// Each call carries its agent and caller. Nothing is kept on the connection.
class Session {
  readonly bells: IpcNotification[] = [];
  readonly client: IpcClient;
  readonly agent: string;
  readonly caller = `test:${nextCaller++}`;
  constructor(client: IpcClient, agent: string) {
    this.client = client;
    this.agent = agent;
    client.onNotification = (frame) => this.bells.push(frame);
  }
  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.client.call(method, { agent: this.agent, caller: this.caller, ...params });
  }
  async bell(type: string): Promise<IpcNotification> {
    return until(`a ${type} doorbell`, () => {
      const at = this.bells.findIndex((b) => b.notification === type);
      if (at < 0) return undefined;
      return this.bells.splice(at, 1)[0];
    });
  }
  async receive(): Promise<{ messages: { position: number; text?: string; signal?: string; est_minutes?: number; closed_their_side?: boolean; session_id: string }[]; notices: { text: string }[]; guidance?: { session_id: string; text: string }[] }> {
    return await this.call("receive") as never;
  }
  send(sessionId: string, text: string, signal: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    return this.call("send", { session_id: sessionId, text, signal, ...extra });
  }
}

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const started: Daemon[] = [];
function newDaemon(): Daemon {
  const daemon = new Daemon();
  started.push(daemon);
  return daemon;
}

after(() => {
  for (const daemon of started) {
    try {
      daemon.cli("logout");
    } catch {
      // Already stopped.
    }
  }
});

const online = (daemon: Daemon, name: string) => until(`${name} online`, () => daemon.status().agents.find((a) => a.name === name && a.online));

test("two agents through one daemon: every signal, a daemon killed twice, and a close", async () => {
  const daemon = newDaemon();
  daemon.login();
  daemon.login();
  const aliceId = daemon.createAgent("Alice");
  const bobId = daemon.createAgent("Bob");
  assert.throws(() => daemon.createAgent("Alice"), /agent_name_taken/);
  await online(daemon, "Alice");
  await online(daemon, "Bob");

  let alice = await daemon.attach("Alice");
  let bob = await daemon.attach("Bob");
  // The holder is a caller, not a socket: the same caller on a new socket is fine, and another caller isn't.
  const newSocket = await IpcClient.connect(join(daemon.home, "daemon.sock"));
  await assert.rejects(newSocket.call("receive", { agent: "Alice", caller: "someone-else" }), { code: "agent_held" });
  assert.deepEqual(await newSocket.call("receive", { agent: "Alice", caller: alice.caller }), { messages: [], notices: [] });
  await assert.rejects(newSocket.call("receive", { agent: "Alice" }), { code: "bad_argument" }, "a call must say who's calling");
  newSocket.close();

  // Starting a session wakes the other side.
  const started = await alice.call("initiate_session", { target: bobId }) as { session_id: string; state: string };
  assert.equal(started.state, "active");
  const sessionId = started.session_id;
  const hello = await bob.bell("session_started");
  assert.equal(hello.data["session_id"], sessionId);
  assert.equal(hello.data["from_id"], aliceId);

  // All three signals, each waking the reader. A signal is required, and standby needs a time.
  await assert.rejects(alice.call("send", { session_id: sessionId, text: "no signal" }), { code: "missing_signal" });
  await assert.rejects(alice.send(sessionId, "no time", "standby"), { code: "missing_est_minutes" });

  assert.deepEqual(await alice.send(sessionId, "the launch code is purple-walrus", "over"), { sent: true, position: 1 });
  assert.equal((await bob.bell("message")).data["session_id"], sessionId);
  const first = await bob.receive();
  assert.deepEqual(first.messages.map((m) => [m.position, m.text, m.signal]), [[1, "the launch code is purple-walrus", "over"]]);
  assert.deepEqual(first.guidance, [{ session_id: sessionId, text: OVER_GUIDANCE }]);

  await bob.send(sessionId, "working on it", "standby", { est_minutes: 5 });
  await alice.bell("message");

  // Replying blind is refused by the daemon. As a notice, it goes. Read first, and a reply goes too.
  await assert.rejects(alice.send(sessionId, "an answer written blind", "over"), { code: "session_not_current" });
  await alice.send(sessionId, "stop, actually", "over", { notice: true });
  await bob.bell("message");
  const unread = await alice.receive();
  assert.deepEqual(unread.messages.map((m) => [m.text, m.signal, m.est_minutes]), [["working on it", "standby", 5]]);
  assert.deepEqual(unread.guidance, [{ session_id: sessionId, text: STANDBY_GUIDANCE }]);
  const stop = await bob.receive();
  assert.deepEqual(stop.messages.map((m) => m.text), ["stop, actually"]);
  await bob.send(sessionId, "stopped", "over");
  await alice.bell("message");

  // The first kill, mid-conversation with a message waiting for Alice. Nothing is lost.
  const firstPid = daemon.status().pid;
  daemon.kill();
  // This client's socket can still look open just after the kill, so it can't tell "never sent" from "cut off", and it
  // says whichever it knows. The position asserted after the restart proves this send never landed.
  await assert.rejects(alice.send(sessionId, "the daemon is gone", "over"), (err: { code: string }) => ["daemon_not_running", "daemon_stopped_during_call"].includes(err.code));
  daemon.login();
  assert.notEqual(daemon.status().pid, firstPid);
  await online(daemon, "Alice");
  await online(daemon, "Bob");
  alice = await daemon.attach("Alice");
  bob = await daemon.attach("Bob");
  const stillWaiting = await alice.receive();
  assert.deepEqual(stillWaiting.messages.map((m) => m.text), ["stopped"], "the unread message survived the restart");
  assert.deepEqual(await alice.send(sessionId, "carrying on after the restart", "over"), { sent: true, position: 5 });
  await bob.bell("message");
  assert.deepEqual((await bob.receive()).messages.map((m) => m.text), ["carrying on after the restart"]);

  // The second kill, with a message that couldn't reach the server. It lands once on restart, and says so.
  compose("stop", "server");
  await until("the daemon to see the server gone", () => !daemon.status().connected);
  const saved = await bob.send(sessionId, "written while the server was down", "over") as { sent: boolean; status: string };
  assert.deepEqual([saved.sent, saved.status], [false, "not_sent_yet"]);
  daemon.kill();
  compose("start", "server");
  daemon.login();
  await online(daemon, "Alice");
  await online(daemon, "Bob");
  alice = await daemon.attach("Alice");
  bob = await daemon.attach("Bob");
  const landed = await until("Bob's notice", async () => {
    const received = await bob.receive();
    return received.notices.length > 0 ? received : undefined;
  });
  assert.match(landed.notices[0]?.text as string, /written while the server was down.*landed at position 6/);
  const delivered = await until("Alice's copy", async () => {
    const received = await alice.receive();
    return received.messages.length > 0 ? received : undefined;
  });
  assert.deepEqual(delivered.messages.map((m) => m.text), ["written while the server was down"]);
  assert.equal(sql(`SELECT count(*) FROM entries WHERE session_id = '\\x${sessionId}'`), "6", "it landed exactly once");

  // Close, with the signal that says so first.
  await alice.send(sessionId, "that's all from me", "wrap");
  await bob.bell("message");
  assert.deepEqual((await bob.receive()).guidance, [{ session_id: sessionId, text: WRAP_GUIDANCE }]);
  const closedA = await bob.call("close_session", { session_id: sessionId }) as { closed: boolean; state: string };
  assert.deepEqual([closedA.closed, closedA.state], [true, "active"]);
  await alice.bell("peer_closed");
  assert.deepEqual((await alice.receive()).messages.map((m) => m.closed_their_side), [true]);
  await assert.rejects(bob.send(sessionId, "after my close", "over"), (err: Error & { code: string }) => err.code === "session_closed" && err.message.includes(SESSION_CLOSED_GUIDANCE));
  const closedB = await alice.call("close_session", { session_id: sessionId }) as { state: string };
  assert.equal(closedB.state, "closed");
  await bob.bell("session_closed");

  // A wrong id or agent says where to look, and which mistake it was.
  await assert.rejects(alice.call("receive", { session_id: "00".repeat(16) }), { code: "unknown_session", message: NO_SESSION_GUIDANCE });
  await assert.rejects(alice.call("receive", { session_id: sessionId.slice(0, 8) }), { code: "unknown_session", message: TRUNCATED_SESSION_GUIDANCE });
  await assert.rejects(alice.call("receive", { agent: "Nobody" }), { code: "unknown_agent", message: noAgentGuidance("Nobody") });
  const outsider = await alice.call("create_agent", { name: "Outsider" }) as { agent_id: string };
  await online(daemon, "Outsider");
  const outsiderHeld = await daemon.attach("Outsider");
  await assert.rejects(outsiderHeld.call("receive", { session_id: sessionId }), { code: "unknown_session", message: OTHER_AGENTS_SESSION_GUIDANCE });
  assert.equal(outsider.agent_id.length, 64);

  // Too big says to split it, and the session carries on.
  const roomy = await alice.call("initiate_session", { target: bobId }) as { session_id: string };
  await bob.bell("session_started");
  await assert.rejects(alice.send(roomy.session_id, "words ".repeat(250_000), "over"), (err: Error & { code: string }) => err.code === "too_large" && /Split it.*Nothing was sent/.test(err.message));

  // A notice skips the read-first rule, so it can answer something older. The reader is told.
  const crossing = await alice.call("initiate_session", { target: bobId }) as { session_id: string };
  await bob.bell("session_started");
  await alice.send(crossing.session_id, "did you get my question", "over");
  await bob.bell("message");
  await bob.send(crossing.session_id, "written without reading yours", "over", { notice: true });
  // Polled, because an earlier read in this test took its message without taking that message's doorbell.
  const crossed = await until("Bob's notice", async () => {
    const received = await alice.receive();
    return received.messages.length > 0 ? received : undefined;
  });
  assert.ok(crossed.guidance?.some((g) => g.text === replyLagGuidance(1, 1)), JSON.stringify(crossed.guidance));
  await bob.receive();
  await alice.send(crossing.session_id, "fine", "wrap");
  await bob.bell("message");
  assert.equal((await bob.receive()).guidance?.some((g) => g.text.startsWith("Their last")), false, "a reply that saw everything has no lag");

  // Closing with something unread still closes, and says what was never read. Their close doesn't count as a message.
  const second = await alice.call("initiate_session", { target: bobId }) as { session_id: string };
  await bob.bell("session_started");
  await alice.send(second.session_id, "you never read this", "over");
  await bob.bell("message");
  const closedUnread = await bob.call("close_session", { session_id: second.session_id }) as { closed: boolean; unread_count: number; unread_warning: string };
  assert.deepEqual([closedUnread.closed, closedUnread.unread_count, closedUnread.unread_warning], [true, 1, unreadWarning(1, second.session_id)]);
  await alice.bell("peer_closed");
  const closedRead = await alice.call("close_session", { session_id: second.session_id }) as { unread_warning?: string };
  assert.equal(closedRead.unread_warning, undefined, "their close alone isn't an unread message");
  await assert.rejects(alice.send(sessionId, "after both closed", "over"), { code: "session_closed", message: SESSION_CLOSED_GUIDANCE });

  // The encrypted text is gone from the server, and the chain is kept.
  await until("the encrypted text to go", () => sql(`SELECT count(*) FROM entries WHERE session_id = '\\x${sessionId}' AND ciphertext IS NOT NULL`) === "0");
  assert.equal(sql(`SELECT state FROM sessions WHERE session_id = '\\x${sessionId}'`), "closed");
  assert.equal(sql(`SELECT count(*) FROM entries WHERE session_id = '\\x${sessionId}'`), "9");

  // Each side's own record checks out with public keys only, and the two agree.
  const reportA = JSON.parse(daemon.cli("verify-session", sessionId, "--agent", "Alice")) as { ok: boolean; position: number; root: string };
  const reportB = JSON.parse(daemon.cli("verify-session", sessionId, "--agent", "Bob")) as { ok: boolean; position: number; root: string };
  assert.deepEqual([reportA.ok, reportA.position], [true, 9]);
  assert.deepEqual([reportB.ok, reportB.position], [true, 9]);
  assert.equal(reportA.root, reportB.root);

  // No message text reached the daemon's log, in either run.
  assert.doesNotMatch(daemon.log(), /purple-walrus/);
});

test("a message waits on the server for a laptop that's shut, unreadable, then goes once it's stored", async () => {
  const mine = newDaemon();
  const theirs = newDaemon();
  mine.login();
  theirs.login();
  mine.createAgent("Dana");
  const erinId = theirs.createAgent("Erin");
  await online(mine, "Dana");
  await online(theirs, "Erin");
  const dana = await mine.attach("Dana");
  const started = await dana.call("initiate_session", { target: erinId }) as { session_id: string; state: string };
  assert.equal(started.state, "active");

  theirs.kill();
  await dana.send(started.session_id, "the secret word is zebra-lantern", "over");
  const row = `session_id = '\\x${started.session_id}' AND position = 1`;
  assert.equal(sql(`SELECT ciphertext IS NOT NULL FROM entries WHERE ${row}`), "t", "the server holds it until it's received");
  assert.equal(sql(`SELECT position(convert_to('zebra-lantern', 'UTF8') IN ciphertext) FROM entries WHERE ${row}`), "0", "and it can't read it");
  assert.equal(sql(`SELECT count(*) FROM entries WHERE entry::text LIKE '%zebra%' OR ack::text LIKE '%zebra%'`), "0");

  theirs.login();
  const erin = await theirs.attach("Erin");
  const received = await until("Erin's message", async () => {
    const got = await erin.receive();
    return got.messages.length > 0 ? got : undefined;
  });
  assert.deepEqual(received.messages.map((m) => m.text), ["the secret word is zebra-lantern"]);
  await until("the encrypted text to go", () => sql(`SELECT ciphertext IS NULL FROM entries WHERE ${row}`) === "t");

  // Real encrypted conversations passed through the server, and no text or address went into its log.
  const logs = compose("logs", "--no-log-prefix", "server");
  assert.match(logs, /session\.active/, "the check must be reading the real log");
  assert.doesNotMatch(logs, /zebra-lantern|purple-walrus/);
  assert.doesNotMatch(logs, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, "the server's log holds an IP address");
  assert.doesNotMatch(logs, /\b[0-9a-f]{1,4}(:[0-9a-f]{1,4}){7}\b|\b[0-9a-f]{1,4}::[0-9a-f:]*[0-9a-f]\b/i, "the server's log holds an IPv6 address");
});

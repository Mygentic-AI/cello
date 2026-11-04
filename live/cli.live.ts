// A whole conversation by command line alone, with no MCP anywhere: real processes, one call each.
// This is what any agent that can run a shell command gets. Run it with scripts/live-test.sh.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { IpcClient } from "../src/ipc/client.ts";
import { OPERATIONS } from "../src/ipc/operations.ts";
import { signerFromSeeds } from "../src/protocol/identity.ts";
import { RunningMerkle } from "../src/protocol/merkle.ts";
import { type SealRecordOnWire, encodeHashes } from "../src/protocol/seal.ts";
import { sealCertificateBytes } from "../src/protocol/structures.ts";
import { fromB64, signedSealCertificate } from "../src/protocol/wire.ts";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18090/v1";
const home = mkdtempSync(join(tmpdir(), "cello-v2-cli-"));
const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const serverDir = process.env["CELLO_SERVER_DIR"] ?? new URL("../../cello-server", import.meta.url).pathname;

function compose(...args: string[]): string {
  return execFileSync("docker", ["compose", ...args], { cwd: serverDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function sql(query: string): string {
  return compose("exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "cello_owner", "-d", "cello", "-tAc", query).trim();
}

interface Run { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }

function cello(args: string[], input?: string, caller?: string, inHome = home): Run {
  const run = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", input, env: { ...process.env, CELLO_V2_HOME: inHome, ...(caller ? { CELLO_CALLER: caller } : {}) } });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(run.stdout || run.stderr) as Record<string, unknown>;
  } catch {
    // Not every command answers in JSON: login and logout answer in words.
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, json };
}

function ok(args: string[], input?: string): Record<string, unknown> {
  const run = cello(args, input);
  assert.equal(run.status, 0, `cello-v2 ${args.join(" ")} failed: ${run.stderr}`);
  return run.json;
}

function okIn(inHome: string, args: string[]): Record<string, unknown> {
  const run = cello(args, undefined, undefined, inHome);
  assert.equal(run.status, 0, `cello-v2 ${args.join(" ")} failed: ${run.stderr}`);
  return run.json;
}

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

after(() => {
  cello(["logout"]);
});

test("a whole conversation with no MCP: start, all three signals, a daemon kill, a close, and a checked record", async () => {
  ok(["login", "--server", url]);
  const gail = ok(["create-agent", "Gail"]);
  const hugo = ok(["create-agent", "Hugo"]);
  await until("both agents online", () => (ok(["status"]) as { agents: { online: boolean }[] }).agents.every((a) => a.online));

  // Nothing works unnamed until an agent is chosen, and then it's still in each call.
  const unnamed = cello(["receive"]);
  assert.deepEqual([unnamed.status, unnamed.json["error"]], [1, "no_current_agent"]);
  ok(["use-agent", "--agent", "Gail"]);
  assert.deepEqual(ok(["receive"]), { messages: [], notices: [] }, "use-agent is remembered for later commands");

  const started = ok(["initiate-session", hugo["agent_id"] as string, "--agent", "Gail"]);
  assert.equal(started["state"], "active");
  const session = started["session_id"] as string;

  // A mistyped option or a missing signal is refused rather than guessed at.
  assert.equal(cello(["send", session, "x", "--agent", "Gail"]).status, 2);
  assert.equal(cello(["send", session, "x", "--over", "--wrap", "--agent", "Gail"]).status, 2);
  assert.equal(cello(["send", session, "x", "--over", "--agnet", "Gail"]).status, 2);
  assert.equal(cello(["send", session, "x", "--standby", "--agent", "Gail"]).status, 2);

  // Help: one line per command at the top, and details per command, with no agent or daemon needed for either.
  const overview = cello(["-h"]);
  assert.equal(overview.status, 0);
  for (const op of OPERATIONS) {
    assert.ok(overview.stdout.includes(`  ${op.command}`), `${op.command} is missing from the help`);
    const own = cello([op.command, "--help"]);
    assert.equal(own.status, 0);
    assert.match(own.stdout, new RegExp(`^Usage: cello-v2 ${op.command}`));
  }
  assert.ok(overview.stdout.split("\n").every((line) => line.length <= 120), "the list stays short");

  // over, from standard input, with a text that starts with dashes.
  assert.deepEqual(ok(["send", session, "-", "--over", "--agent", "Gail"], "--hello from a pipe"), { sent: true, position: 1 });

  // The inbox says who wrote, with no text, and looking doesn't count as reading.
  await until("the message to reach Hugo", () => ((ok(["inbox", "--agent", "Hugo"]) as { waiting: unknown[] }).waiting.length === 1));
  const inbox = ok(["inbox", "--agent", "Hugo"]) as { waiting: { from_id: string; unread: number }[] };
  assert.deepEqual(inbox.waiting.map((w) => [w.from_id, w.unread]), [[gail["agent_id"], 1]]);
  assert.doesNotMatch(JSON.stringify(inbox), /hello from a pipe/);
  const peek = ok(["transcript", session, "--agent", "Hugo"]) as { entries: { text: string }[]; read_position: number };
  assert.deepEqual([peek.entries.map((e) => e.text), peek.read_position], [["--hello from a pipe"], 0], "a transcript doesn't count as reading");
  assert.equal((ok(["sessions", "--agent", "Hugo"]) as { sessions: { unread: number }[] }).sessions[0]?.unread, 1);
  assert.deepEqual((ok(["agents"]) as { agents: { name: string; online: boolean }[] }).agents.map((a) => [a.name, a.online]), [["Gail", true], ["Hugo", true]]);

  // wait is how an agent with no doorbell learns something arrived.
  const woke = ok(["wait", "--agent", "Hugo", "--timeout-seconds", "20"]);
  assert.equal(woke["event"], "unread");
  const read = ok(["receive", "--agent", "Hugo"]) as { messages: { text: string; signal: string; from_id: string }[] };
  assert.deepEqual(read.messages.map((m) => [m.text, m.signal, m.from_id]), [["--hello from a pipe", "over", gail["agent_id"]]]);

  // With nothing unread, wait blocks until something happens, and ends when asked.
  const quiet = cello(["wait", "--agent", "Hugo", "--timeout-seconds", "1"]);
  assert.deepEqual([quiet.status, quiet.json["event"]], [3, "timeout"]);

  // standby, with its time.
  ok(["send", session, "looking into it", "--standby", "2", "--agent", "Hugo"]);
  const blind = cello(["send", session, "a blind reply", "--over", "--agent", "Gail"]);
  await until("the message to reach Gail", () => (ok(["status"]) as { agents: { name: string; unread: number }[] }).agents.find((a) => a.name === "Gail")?.unread === 1);
  const refused = blind.status === 1 ? blind : cello(["send", session, "a blind reply", "--over", "--agent", "Gail"]);
  assert.equal(refused.json["error"], "session_not_current");
  const standby = ok(["receive", "--agent", "Gail"]) as { messages: { text: string; signal: string; est_minutes: number }[] };
  assert.deepEqual(standby.messages.map((m) => [m.text, m.signal, m.est_minutes]), [["looking into it", "standby", 2]]);

  // A kill mid-conversation. Each command is its own process, so there's nothing to reconnect.
  const pid = (ok(["status"]) as { pid: number }).pid;
  process.kill(pid, "SIGKILL");
  assert.equal(cello(["status"]).json["error"], "daemon_not_running");
  ok(["login", "--server", url]);
  await until("both agents back online", () => (ok(["status"]) as { agents: { online: boolean }[] }).agents.every((a) => a.online));
  assert.deepEqual(ok(["send", session, "still with you", "--over", "--agent", "Gail"]), { sent: true, position: 3 });
  ok(["wait", "--agent", "Hugo", "--timeout-seconds", "20"]);
  assert.deepEqual((ok(["receive", "--agent", "Hugo"]) as { messages: { text: string }[] }).messages.map((m) => m.text), ["still with you"]);

  // wrap, then a close from each side.
  ok(["send", session, "that's all from me", "--wrap", "--agent", "Hugo"]);
  ok(["wait", "--agent", "Gail", "--timeout-seconds", "20"]);
  assert.deepEqual((ok(["receive", "--agent", "Gail"]) as { messages: { signal: string }[] }).messages.map((m) => m.signal), ["wrap"]);
  assert.equal(ok(["close-session", session, "--agent", "Gail"])["closed"], true);
  ok(["wait", "--agent", "Hugo", "--timeout-seconds", "20"]);
  assert.deepEqual((ok(["receive", "--agent", "Hugo"]) as { messages: { closed_their_side: boolean }[] }).messages.map((m) => m.closed_their_side), [true]);
  assert.equal(ok(["close-session", session, "--agent", "Hugo"])["state"], "closed");

  const reportG = ok(["verify-session", session, "--agent", "Gail"]);
  const reportH = ok(["verify-session", session, "--agent", "Hugo"]);

  // After closing, the whole conversation can still be read, both sides of it, with the same order on each side.
  const fullG = ok(["transcript", session, "--agent", "Gail"]) as { state: string; entries: { position: number; own: boolean; text?: string; signal?: string; closed_their_side?: boolean }[] };
  const fullH = ok(["transcript", session, "--agent", "Hugo"]) as typeof fullG;
  assert.equal(fullG.state, "closed");
  assert.deepEqual(fullG.entries.map((e) => [e.position, e.text, e.signal]).slice(0, 4), [
    [1, "--hello from a pipe", "over"],
    [2, "looking into it", "standby"],
    [3, "still with you", "over"],
    [4, "that's all from me", "wrap"],
  ]);
  assert.deepEqual(fullG.entries.map((e) => e.own), fullH.entries.map((e) => !e.own), "each side knows which are its own");
  assert.equal(fullG.entries.filter((e) => e.closed_their_side).length, 2);
  assert.deepEqual((ok(["sessions", "--agent", "Gail"]) as { sessions: unknown[] }).sessions, [], "closed sessions are hidden by default");
  assert.equal((ok(["sessions", "--all", "--agent", "Gail"]) as { sessions: unknown[] }).sessions.length, 1);
  assert.deepEqual([reportG["ok"], reportG["position"]], [true, 6]);
  assert.equal(reportG["root"], reportH["root"]);
  assert.doesNotMatch(readFileSync(join(home, "daemon.log"), "utf8"), /still with you/);
});

test("the holder is a caller: the command line is refused an agent a session holds, unless it forces", async () => {
  ok(["create-agent", "Iris"]);
  await until("Iris online", () => (ok(["status"]) as { agents: { name: string; online: boolean }[] }).agents.find((a) => a.name === "Iris")?.online);
  const session = await IpcClient.connect(join(home, "daemon.sock"));
  const bells: string[] = [];
  session.onNotification = (frame) => bells.push(frame.notification);
  await session.call("subscribe", { agent: "Iris", caller: "some-session" });

  const refused = cello(["receive", "--agent", "Iris"]);
  assert.deepEqual([refused.status, refused.json["error"]], [1, "agent_held"]);
  assert.match(refused.json["message"] as string, /"some-session" holds Iris/);
  assert.equal(cello(["verify-session", "00000000000000000000000000000000", "--agent", "Iris"]).json["error"], "unknown_session", "reading a record isn't refused for being held");

  assert.deepEqual(ok(["receive", "--agent", "Iris", "--force"]), { messages: [], notices: [] });
  await until("the displaced session to be told", () => bells.includes("agent_displaced"));
  await assert.rejects(session.call("receive", { agent: "Iris", caller: "some-session" }), { code: "agent_held" });

  // Letting go hands it back with no force, and a session's hold ends when it can no longer be reached.
  ok(["stop-using-agent", "--agent", "Iris"]);
  await session.call("subscribe", { agent: "Iris", caller: "some-session" });
  session.close();
  await until("the hold to end with the session", () => cello(["receive", "--agent", "Iris"]).status === 0);

  // A session that dies while waiting must not leave the agent locked, even having selected it twice.
  ok(["stop-using-agent", "--agent", "Iris"]);
  const crashing = await IpcClient.connect(join(home, "daemon.sock"));
  await crashing.call("subscribe", { agent: "Iris", caller: "crashing-session" });
  await crashing.call("subscribe", { agent: "Iris", caller: "crashing-session" });
  const waiting = crashing.call("wait", { agent: "Iris", caller: "crashing-session", timeout_seconds: 60 }).catch(() => undefined);
  assert.equal(cello(["receive", "--agent", "Iris"]).json["error"], "agent_held");
  crashing.close();
  await waiting;
  await until("the dead session's hold to end", () => cello(["receive", "--agent", "Iris"]).status === 0);

  // Two shell agents with their own names are kept apart, just as sessions are. Each remembers its own choice.
  ok(["stop-using-agent", "--agent", "Iris"]);
  assert.equal(cello(["use-agent", "--agent", "Iris"], undefined, "shell-a").status, 0);
  const otherShell = cello(["receive", "--agent", "Iris"], undefined, "shell-b");
  assert.deepEqual([otherShell.status, otherShell.json["error"]], [1, "agent_held"]);
  assert.match(otherShell.json["message"] as string, /"shell-a" holds Iris/);
  assert.equal(cello(["receive"], undefined, "shell-a").status, 0, "shell-a remembers its choice");
  assert.equal(cello(["receive"], undefined, "shell-b").json["error"], "no_current_agent", "and shell-b doesn't inherit it");
  assert.equal(cello(["receive", "--agent", "Iris", "--force"], undefined, "shell-b").status, 0);
  assert.equal(cello(["receive"], undefined, "shell-a").json["error"], "agent_held", "shell-a has been displaced");
});

interface SealOutput {
  sealed: boolean;
  status?: string;
  seal_id: string;
  seal_key: string;
  witnessed_through: number;
  received_through: number;
  tip_when_sealed: number;
  partial: boolean;
  session_closed: boolean;
  statement: Record<string, string>;
}

const scratch = mkdtempSync(join(tmpdir(), "cello-v2-seal-files-"));
let nextFile = 0;

function saved(content: unknown): string {
  const path = join(scratch, `seal-${nextFile++}.json`);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

function verify(file: string, sealKey: string, inHome = home): Record<string, unknown> {
  const run = cello(["verify-seal", file, "--seal-key", sealKey], undefined, undefined, inHome);
  assert.equal(run.status, run.json["ok"] ? 0 : 1, `verify-seal exits by its answer: ${run.stderr}`);
  return run.json;
}

test("seals: one party, partial, across a daemon kill, and checked offline with tampering caught", { timeout: 200_000 }, async () => {
  // Two machines' worth of state: each agent has its own daemon, so one can really be offline.
  const kitHome = mkdtempSync(join(tmpdir(), "cello-v2-cli-kit-"));
  okIn(kitHome, ["login", "--server", url]);
  const kit = okIn(kitHome, ["create-agent", "Kit"]);
  ok(["create-agent", "Jan"]);
  await until("both online", () => {
    const jan = (ok(["status"]) as { agents: { name: string; online: boolean }[] }).agents.find((a) => a.name === "Jan");
    return jan?.online && (okIn(kitHome, ["status"]) as { agents: { online: boolean }[] }).agents.every((a) => a.online);
  });
  const session = ok(["initiate-session", kit["agent_id"] as string, "--agent", "Jan"])["session_id"] as string;
  assert.ok(session);
  const secret = "the price is forty-two";

  // Nothing witnessed yet, so there's nothing to seal.
  assert.equal(cello(["seal", session, "--agent", "Jan"]).json["error"], "nothing_to_seal");

  // Positions 1 to 3 reach Kit, and he confirms them by machine, not by reading.
  ok(["send", session, secret, "--over", "--agent", "Jan"]);
  await until("Kit's copy", () => (okIn(kitHome, ["inbox", "--agent", "Kit"]) as { waiting: unknown[] }).waiting.length === 1);
  okIn(kitHome, ["receive", "--agent", "Kit"]);
  okIn(kitHome, ["send", session, "understood", "--over", "--agent", "Kit"]);
  await until("Jan's copy", () => (ok(["inbox", "--agent", "Jan"]) as { waiting: unknown[] }).waiting.length === 1);
  ok(["receive", "--agent", "Jan"]);
  ok(["send", session, "third", "--over", "--agent", "Jan"]);
  const hexSession = `\\x${session}`;
  await until("Kit's delivery ack through 3", () => sql(`SELECT count(*) FROM delivery_acks WHERE session_id = '${hexSession}' AND reader_id = '\\x${kit["agent_id"] as string}' AND through_position = 3`) === "1");

  // Kit goes offline, and position 4 is witnessed but never reaches him.
  const kitPid = (okIn(kitHome, ["status"]) as { pid: number }).pid;
  process.kill(kitPid, "SIGKILL");
  assert.deepEqual(ok(["send", session, "fourth, while Kit is away", "--over", "--agent", "Jan"]), { sent: true, position: 4 });

  // A whole seal, by one party alone.
  const whole = ok(["seal", session, "--agent", "Jan"]) as unknown as SealOutput;
  assert.equal(whole.sealed, true);
  assert.deepEqual([whole.witnessed_through, whole.received_through, whole.tip_when_sealed, whole.partial, whole.session_closed], [4, 3, 4, false, false]);
  assert.match(whole.statement["proven_without_trusting_the_server"] as string, /Positions 1 to 3/);
  assert.match(whole.statement["rests_on_the_server"] as string, /Positions 4 to 4/);
  assert.match(whole.statement["meaning"] as string, /says nothing about whether the parties agreed/);

  // The seal key a stranger would use comes from the server, apart from the file.
  const health = await fetch(url.replace(/^ws/, "http").replace(/\/v1$/, "/healthz"));
  const sealKey = (await health.json() as { seal_key: string }).seal_key;
  assert.equal(whole.seal_key, sealKey);

  // A repeat with nothing changed is the same seal.
  assert.equal((ok(["seal", session, "--agent", "Jan"]) as unknown as SealOutput).seal_id, whole.seal_id);

  const exported = ok(["export-seal", whole.seal_id, "--agent", "Jan"]);
  assert.doesNotMatch(JSON.stringify(exported), /forty-two/, "a seal holds none of what was said");
  const wholeFile = saved(exported);
  const wholeCheck = verify(wholeFile, sealKey);
  assert.deepEqual([wholeCheck["ok"], wholeCheck["witnessed_through"], wholeCheck["received_through"]], [true, 4, 3]);

  // A partial seal shows it's partial. Kit's ack through 3 covers position 2.
  const partial = ok(["seal", session, "--through", "2", "--agent", "Jan"]) as unknown as SealOutput;
  assert.deepEqual([partial.witnessed_through, partial.received_through, partial.tip_when_sealed, partial.partial], [2, 2, 4, true]);
  const partialCheck = verify(saved(ok(["export-seal", partial.seal_id, "--agent", "Jan"])), sealKey) as unknown as SealOutput;
  assert.equal(partialCheck.partial, true);
  assert.match(partialCheck.statement["how_much_this_covers"] as string, /partial seal.*4 positions.*covers 2.*2 more exist/);
  assert.equal(cello(["seal", session, "--through", "99", "--agent", "Jan"]).json["error"], "seal_beyond_held");
  assert.equal(cello(["seal", session, "--through", "0", "--agent", "Jan"]).json["error"], "bad_argument");

  // ---- Tampering, on the real file. ----
  const tampered = (edit: (r: SealRecordOnWire) => void): string => {
    const copy = structuredClone(exported) as unknown as SealRecordOnWire;
    edit(copy);
    return saved(copy);
  };
  const fieldsOf = (r: SealRecordOnWire) => r.certificate.fields as Record<string, string | number>;
  assert.equal(verify(tampered((r) => { fieldsOf(r)["tip"] = 3; }), sealKey)["fault"], "bad_seal_signature", "a changed certificate");
  assert.equal(verify(tampered((r) => { fieldsOf(r)["receivedThrough"] = 4; }), sealKey)["fault"], "bad_seal_signature", "a forged M");
  assert.equal(verify(tampered((r) => { r.deliveryAck = null; }), sealKey)["fault"], "delivery_ack_mismatch", "M with no ack behind it");
  assert.equal(verify(wholeFile, "00".repeat(32))["fault"], "wrong_seal_key", "a wrong key");
  assert.equal(verify(saved("not json"), sealKey)["fault"], "unreadable_file");
  assert.equal(verify(join(scratch, "no-such-file"), sealKey)["fault"], "unreadable_file");
  assert.equal(verify(wholeFile, "not hex")["fault"], "bad_seal_key");

  // The worst case: someone has stolen the real seal key and signs a forged M with it. Kit's own signature still says 3.
  const stolen = JSON.parse(compose("exec", "-T", "server", "cat", "/data/seal-key.json")) as { ed: string; pq: string };
  const thief = await signerFromSeeds({ ed: fromB64(stolen.ed, "ed"), pq: fromB64(stolen.pq, "pq") });
  assert.equal(Buffer.from(thief.id).toString("hex"), sealKey, "the test must hold the real key");
  const forged = structuredClone(exported) as unknown as SealRecordOnWire;
  const certificate = signedSealCertificate.decode(forged.certificate).fields;
  certificate.receivedThrough = 4;
  forged.certificate = signedSealCertificate.encode({ fields: certificate, signature: await thief.sign("cello-v2-seal-certificate", sealCertificateBytes(certificate)) });
  assert.equal(verify(saved(forged), sealKey)["fault"], "delivery_ack_mismatch", "a stolen seal key can't raise M");

  // ---- A daemon kill. The server is down, the seal is saved, the daemon dies, and it finishes by itself. ----
  compose("stop", "server");
  await until("the daemon to see the server gone", () => !(ok(["status"]) as { connected: boolean }).connected);
  const waiting = ok(["seal", session, "--through", "3", "--agent", "Jan"]);
  assert.deepEqual([waiting["sealed"], waiting["status"]], [false, "not_sealed_yet"], "never reports sealed without the proof");
  const listed = ok(["seals", "--session-id", session, "--agent", "Jan"]) as { seals: { witnessed_through: number }[]; waiting: { through: number }[] };
  assert.deepEqual(listed.waiting.map((w) => w.through), [3]);
  assert.ok(!listed.seals.some((s) => s.witnessed_through === 3));
  process.kill((ok(["status"]) as { pid: number }).pid, "SIGKILL");
  compose("start", "server");
  await until("the server back", async () => {
    try {
      return (await fetch(url.replace(/^ws/, "http").replace(/\/v1$/, "/healthz"))).ok;
    } catch {
      return false;
    }
  });
  ok(["login", "--server", url]);
  const afterKill = await until("the saved seal to finish", () => {
    const now = ok(["seals", "--session-id", session, "--agent", "Jan"]) as { seals: { seal_id: string; witnessed_through: number; received_through: number }[]; waiting: unknown[] };
    return now.waiting.length === 0 && now.seals.find((s) => s.witnessed_through === 3);
  });
  assert.equal(afterKill.received_through, 3);
  assert.equal(verify(saved(ok(["export-seal", afterKill.seal_id, "--agent", "Jan"])), sealKey)["ok"], true);
  const notices = ok(["receive", "--agent", "Jan"]) as { notices: { text: string }[] };
  assert.ok(notices.notices.some((n) => n.text.includes(`Your seal through position 3 is done`)), "the agent is told it finished");

  // Kit comes back. Closing seals each side's copy by itself, and the second closer's seal says it has closed.
  okIn(kitHome, ["login", "--server", url]);
  await until("Kit's catch-up", () => (okIn(kitHome, ["inbox", "--agent", "Kit"]) as { waiting: unknown[] }).waiting.length === 1);
  okIn(kitHome, ["receive", "--agent", "Kit"]);
  const kitClosed = okIn(kitHome, ["close-session", session, "--agent", "Kit"]) as { seal: SealOutput };
  assert.deepEqual([kitClosed.seal.sealed, kitClosed.seal.session_closed, kitClosed.seal.witnessed_through], [true, false, 5]);
  await until("Jan's copy of the close", () => (ok(["inbox", "--agent", "Jan"]) as { waiting: unknown[] }).waiting.length === 1);
  ok(["receive", "--agent", "Jan"]);
  const janClosed = ok(["close-session", session, "--agent", "Jan"]) as { state: string; seal: SealOutput };
  assert.equal(janClosed.state, "closed");
  assert.deepEqual([janClosed.seal.sealed, janClosed.seal.session_closed, janClosed.seal.witnessed_through, janClosed.seal.partial], [true, true, 6, false]);
  // Repeatable, and it gets better: sealing again once Jan's ack and Kit's copy of the end are in.
  await until("Jan's delivery ack through 5", () => sql(`SELECT count(*) FROM delivery_acks WHERE session_id = '${hexSession}' AND through_position = 5`) === "1");
  const again = await until("Kit's whole copy", () => {
    const seal = cello(["seal", session, "--agent", "Kit"], undefined, undefined, kitHome);
    return seal.json["witnessed_through"] === 6 && (seal.json as unknown as SealOutput);
  });
  assert.deepEqual([again.sealed, again.session_closed, again.received_through], [true, true, 5]);

  // An operator rewrites the hash log, and keeps its stored root in step. The party's own root is what stops the seal.
  sql(`UPDATE entries SET entry_hash = sha256('tampered'::bytea) WHERE session_id = '${hexSession}' AND position = 1`);
  const rewritten = new RunningMerkle();
  for (const hex of sql(`SELECT encode(entry_hash, 'hex') FROM entries WHERE session_id = '${hexSession}' AND position <= 3 ORDER BY position`).split("\n")) rewritten.append(new Uint8Array(Buffer.from(hex, "hex")));
  sql(`UPDATE entries SET root = '\\x${Buffer.from(rewritten.root()).toString("hex")}' WHERE session_id = '${hexSession}' AND position = 3`);
  const mismatch = cello(["seal", session, "--through", "3", "--agent", "Jan"]);
  assert.deepEqual([mismatch.status, mismatch.json["error"]], [1, "seal_root_mismatch"], mismatch.stdout + mismatch.stderr);

  // A log that no longer rebuilds its own root yields no seal, names the server as the cause, and isn't retried forever.
  const broken = cello(["seal", session, "--through", "2", "--agent", "Jan"]);
  assert.deepEqual([broken.status, broken.json["error"]], [1, "seal_log_inconsistent"], broken.stdout + broken.stderr);
  assert.deepEqual((ok(["seals", "--session-id", session, "--agent", "Jan"]) as { waiting: unknown[] }).waiting, []);

  // Offline: both daemons gone, the server down, and a home with nothing in it. The file still checks out.
  okIn(kitHome, ["logout"]);
  ok(["logout"]);
  compose("stop", "server");
  const stranger = mkdtempSync(join(tmpdir(), "cello-v2-stranger-"));
  assert.equal(cello(["status"], undefined, undefined, stranger).json["error"], "daemon_not_running");
  const offline = verify(wholeFile, sealKey, stranger) as unknown as SealOutput;
  assert.deepEqual([offline.witnessed_through, offline.received_through], [4, 3]);
  assert.equal(verify(tampered((r) => { fieldsOf(r)["tip"] = 3; }), sealKey, stranger)["fault"], "bad_seal_signature");
  compose("start", "server");
});

test("a standby past its time tells each side once, across restarts, and changes nothing else", { timeout: 240_000 }, async () => {
  interface Standby { by: string; position: number; due_at: string; overdue: boolean }
  interface Read { messages: { text?: string }[]; notices: { session_id: string; text: string }[] }

  // Two machines' worth of state, each shell with its own caller.
  const side = (agent: string) => {
    const inHome = mkdtempSync(join(tmpdir(), `cello-v2-cli-${agent}-`));
    const caller = `shell-${agent}`;
    const must = (args: string[]): Record<string, unknown> => {
      const done = cello(args, undefined, caller, inHome);
      assert.equal(done.status, 0, `${agent}: cello-v2 ${args.join(" ")} failed: ${done.stderr}`);
      return done.json;
    };
    const act = (...args: string[]): Record<string, unknown> => must([...args, "--agent", agent]);
    const online = (): boolean => (must(["status"]) as { agents: { online: boolean }[] }).agents.every((a) => a.online);
    return {
      inHome,
      must,
      act,
      read: () => act("receive") as unknown as Read,
      unread: () => (act("inbox") as { waiting: { unread: number }[] }).waiting[0]?.unread ?? 0,
      standbys: () => (act("sessions") as { sessions: { standbys: Standby[] }[] }).sessions[0]?.standbys,
      statusStandbys: () => (must(["status"]) as { agents: { sessions: { standbys: Standby[] }[] }[] }).agents[0]?.sessions[0]?.standbys,
      kill: () => process.kill((must(["status"]) as { pid: number }).pid, "SIGKILL"),
      online,
      restart: async () => {
        must(["login", "--server", url]);
        await until(`${agent} online`, online);
      },
      // A command that blocks, so this test can carry on while it does.
      wait: () => new Promise<Run>((resolve) => {
        execFile(process.execPath, [cliPath, "wait", "--agent", agent, "--timeout-seconds", "30"], { encoding: "utf8", env: { ...process.env, CELLO_V2_HOME: inHome, CELLO_CALLER: caller } }, (err, stdout, stderr) => {
          resolve({ status: err ? (err.code as number) : 0, stdout, stderr, json: JSON.parse(stdout) as Record<string, unknown> });
        });
      }),
    };
  };
  const nora = side("Nora");
  const owen = side("Owen");
  await nora.restart();
  nora.must(["create-agent", "Nora"]);
  await owen.restart();
  const owenId = owen.must(["create-agent", "Owen"])["agent_id"] as string;
  await until("both online", () => nora.online() && owen.online());
  const session = nora.act("initiate-session", owenId)["session_id"] as string;
  assert.ok(session);

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const THREE_SECONDS = "0.05";
  const SIX_SECONDS = "0.1";
  const WELL_PAST_THREE = 3500;
  const FOR_ANY_LATE_NOTICE = 1500;
  const noraGets = (count: number): Promise<boolean> => until(`${count} to reach Nora`, () => nora.unread() === count);
  // Owen makes a promise that Nora has read. Returns the position, so a check can name it.
  const promised = async (minutes: string): Promise<number> => {
    const position = owen.act("send", session, "back in a moment", "--standby", minutes)["position"] as number;
    await noraGets(1);
    nora.read();
    return position;
  };
  const settle = async (): Promise<void> => {
    owen.act("send", session, "here it is", "--over");
    await noraGets(1);
    nora.read();
    await until("both sides to see it settled", () => nora.standbys()?.length === 0 && owen.standbys()?.length === 0);
  };
  const toldOnce = (read: Read, words: RegExp, who: string): void => {
    assert.equal(read.notices.length, 1, `${who} is told once: ${JSON.stringify(read.notices)}`);
    assert.match(read.notices[0]?.text as string, words);
    assert.equal(read.notices[0]?.session_id, session);
  };
  const READER = /other side said it would follow up by now.*it hasn't/;
  const AUTHOR = /You said you'd follow up by now/;

  // A follow-up in time tells nobody, and the fractional minutes are accepted.
  owen.act("send", session, "back in a moment", "--standby", THREE_SECONDS);
  owen.act("send", session, "that was quick", "--over");
  await noraGets(2);
  await sleep(WELL_PAST_THREE);
  assert.deepEqual([nora.read().messages.length, nora.standbys()], [2, []]);
  assert.deepEqual([owen.read().notices, owen.standbys()], [[], []]);
  assert.deepEqual(nora.read().notices, [], "nothing reached the reader either");

  // Open, and both sides work out the same due time. Then it passes, and a wait ends on it for each side.
  const position = await promised(SIX_SECONDS);
  const [noraSees] = nora.standbys() as [Standby];
  const [owenSees] = owen.standbys() as [Standby];
  assert.deepEqual([noraSees.by, noraSees.position, noraSees.overdue], ["other_side", position, false]);
  assert.deepEqual([owenSees.by, owenSees.position, owenSees.overdue], ["you", position, false]);
  assert.equal(noraSees.due_at, owenSees.due_at);
  assert.deepEqual(nora.statusStandbys(), [noraSees]);
  const [noraWoke, owenWoke] = await Promise.all([nora.wait(), owen.wait()]);
  for (const woke of [noraWoke, owenWoke]) {
    assert.deepEqual([woke.status, woke.json["event"], woke.json["session_id"]], [0, "standby_overdue", session], woke.stdout + woke.stderr);
    assert.doesNotMatch(woke.stdout, /back in a moment/);
  }
  assert.doesNotMatch(noraWoke.stdout, /Owen/, "a doorbell carries no name from the other party");
  assert.deepEqual(nora.standbys(), [{ ...noraSees, overdue: true }]);
  assert.deepEqual(owen.statusStandbys(), [{ ...owenSees, overdue: true }]);

  // It doesn't count as a message: with the notice unread, the reader can still reply. That doesn't settle Owen's promise.
  assert.equal(nora.act("send", session, "any news?", "--over")["sent"], true);
  toldOnce(nora.read(), READER, "the reader");
  const owenRead = owen.read();
  toldOnce(owenRead, AUTHOR, "the author");
  assert.deepEqual(owenRead.messages.map((m) => m.text), ["any news?"]);
  assert.equal(owen.standbys()?.length, 1);

  // A restart after it fired doesn't repeat it, and the standby still shows.
  nora.kill();
  owen.kill();
  await Promise.all([nora.restart(), owen.restart()]);
  await sleep(FOR_ANY_LATE_NOTICE);
  assert.deepEqual([nora.read().notices, owen.read().notices], [[], []]);
  assert.equal(nora.standbys()?.[0]?.overdue, true);
  await settle();

  // Killed before it falls due, and back after: both are still told, once.
  await promised(SIX_SECONDS);
  assert.equal(owen.standbys()?.[0]?.overdue, false, "the kill must come before it falls due");
  nora.kill();
  owen.kill();
  await sleep(6500);
  await Promise.all([nora.restart(), owen.restart()]);
  await until("the reader's notice", () => nora.unread() === 0 && (nora.must(["status"]) as { agents: { unread: number }[] }).agents[0]?.unread === 1);
  toldOnce(nora.read(), READER, "the reader");
  toldOnce(owen.read(), AUTHOR, "the author");
  assert.deepEqual([nora.read().notices, owen.read().notices], [[], []]);

  // A new promise replaces the old one. It fires and nobody has read the notice when the kill comes: it's neither lost nor repeated.
  await promised(THREE_SECONDS);
  await Promise.all([nora.wait(), owen.wait()]);
  nora.kill();
  owen.kill();
  await Promise.all([nora.restart(), owen.restart()]);
  await sleep(FOR_ANY_LATE_NOTICE);
  toldOnce(nora.read(), READER, "the reader");
  toldOnce(owen.read(), AUTHOR, "the author");
  await settle();

  // The reader is away while the promise is kept. Coming back after its time, it reads the follow-up and hears no false alarm.
  nora.kill();
  owen.act("send", session, "back in a moment", "--standby", THREE_SECONDS);
  owen.act("send", session, "done, while you were away", "--over");
  await sleep(WELL_PAST_THREE);
  await nora.restart();
  await noraGets(2);
  await sleep(FOR_ANY_LATE_NOTICE);
  const backRead = nora.read();
  assert.deepEqual([backRead.messages.length, backRead.notices, nora.standbys()], [2, [], []]);
  assert.deepEqual(owen.read().notices, []);

  // With the server gone, the author is still told. The reader can't know, so its session shows overdue and the notice waits.
  await promised("0.3");
  compose("stop", "server");
  await until("the reader to see the server gone", () => !(nora.must(["status"]) as { connected: boolean }).connected);
  const [dueSoon] = nora.standbys() as [Standby];
  assert.equal(dueSoon.overdue, false, "the server must be gone before it falls due");
  await sleep(Date.parse(dueSoon.due_at) - Date.now() + 500);
  toldOnce(await until("the author's notice with no server", () => {
    const read = owen.read();
    return read.notices.length > 0 && read;
  }), AUTHOR, "the author");
  assert.deepEqual([nora.read().notices, nora.standbys()?.[0]?.overdue], [[], true]);
  compose("start", "server");
  toldOnce(await until("the reader's notice once the server is back", () => {
    const read = nora.read();
    return read.notices.length > 0 && read;
  }), READER, "the reader");
  await until("both back online", () => nora.online() && owen.online());
  assert.deepEqual([nora.read().notices, owen.read().notices], [[], []]);

  // Closing settles it, on both sides.
  owen.act("send", session, "back in a moment", "--standby", THREE_SECONDS);
  const owenClosed = owen.act("close-session", session) as { closed: boolean };
  assert.equal(owenClosed.closed, true);
  await noraGets(2);
  assert.deepEqual([nora.standbys(), owen.standbys()], [[], []]);
  await sleep(WELL_PAST_THREE);
  const late = /follow up/;
  assert.deepEqual(nora.read().notices.filter((n) => late.test(n.text)), []);
  assert.deepEqual(owen.read().notices.filter((n) => late.test(n.text)), []);

  // Nothing about any of this went on the record, or in a log as text.
  nora.act("close-session", session);
  await until("the session closed on both sides", () => (owen.act("sessions", "--all") as { sessions: { state: string }[] }).sessions[0]?.state === "closed");
  const reports = [nora, owen].map((who) => who.act("verify-session", session));
  assert.deepEqual([reports[0]?.["ok"], reports[1]?.["ok"], reports[0]?.["root"]], [true, true, reports[1]?.["root"]]);
  assert.doesNotMatch(JSON.stringify(nora.act("transcript", session)), /follow up by now/);
  assert.doesNotMatch(readFileSync(join(nora.inHome, "daemon.log"), "utf8"), /back in a moment/);
  nora.must(["logout"]);
  owen.must(["logout"]);
});

// A proxy in front of the real server, which rewrites its answers to seal requests. An honest server would never show these.
async function lyingProxy(rewrite: { current: ((answer: { record: SealRecordOnWire; logProof: string[] | null }) => void) | null }): Promise<{ url: string; close(): void }> {
  const wss = new WebSocketServer({ port: 0, maxPayload: 2_000_000 });
  await new Promise((resolve) => wss.once("listening", resolve));
  wss.on("connection", (client) => {
    const server = new WebSocket(url, { maxPayload: 2_000_000 });
    const queued: Buffer[] = [];
    const sealCalls = new Set<number>();
    server.on("open", () => { for (const frame of queued.splice(0)) server.send(frame.toString()); });
    client.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as { id: number; method: string };
      if (frame.method === "seal.request") sealCalls.add(frame.id);
      if (server.readyState === server.OPEN) server.send(raw.toString());
      else queued.push(raw);
    });
    server.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as { id?: number; ok?: boolean; result?: { record: SealRecordOnWire; logProof: string[] | null } };
      if (frame.id !== undefined && sealCalls.delete(frame.id) && frame.ok && frame.result && rewrite.current) rewrite.current(frame.result);
      if (client.readyState === client.OPEN) client.send(JSON.stringify(frame));
    });
    server.on("ping", () => client.ping());
    server.on("close", () => client.close());
    server.on("error", () => client.close());
    client.on("close", () => server.close());
    client.on("error", () => server.close());
  });
  return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}/v1`, close: () => { for (const socket of wss.clients) socket.terminate(); wss.close(); } };
}

test("a server that lies about a seal gets a named refusal, and nothing is reported or stored as sealed", { timeout: 120_000 }, async () => {
  const rewrite: Parameters<typeof lyingProxy>[0] = { current: null };
  const proxy = await lyingProxy(rewrite);
  const liarHome = mkdtempSync(join(tmpdir(), "cello-v2-cli-liar-"));
  // The proxy lives in this process, so a command mustn't block it the way spawnSync would.
  const run = (args: string[]): Promise<Run> => new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { encoding: "utf8", env: { ...process.env, CELLO_V2_HOME: liarHome } }, (err, stdout, stderr) => {
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(stdout || stderr) as Record<string, unknown>;
      } catch {
        // login and logout answer in words.
      }
      resolve({ status: err ? (err.code as number) : 0, stdout, stderr, json });
    });
  });
  const must = async (args: string[]): Promise<Record<string, unknown>> => {
    const done = await run(args);
    assert.equal(done.status, 0, `cello-v2 ${args.join(" ")} failed: ${done.stderr}`);
    return done.json;
  };
  try {
    await must(["login", "--server", proxy.url]);
    await must(["create-agent", "Lea"]);
    const mo = await must(["create-agent", "Mo"]);
    await until("both online", async () => (await must(["status"]) as { agents: { online: boolean }[] }).agents.every((a) => a.online));
    const session = (await must(["initiate-session", mo["agent_id"] as string, "--agent", "Lea"]))["session_id"] as string;
    await must(["send", session, "hello", "--over", "--agent", "Lea"]);

    let seenSeals = 0;
    const refusedWith = async (fault: string): Promise<void> => {
      const done = await run(["seal", session, "--agent", "Lea"]);
      assert.deepEqual([done.status, done.json["error"]], [1, fault], done.stdout + done.stderr);
      const held = await must(["seals", "--agent", "Lea"]) as { seals: unknown[]; waiting: unknown[] };
      assert.deepEqual(held.waiting, [], "a final refusal isn't retried forever");
      assert.equal(held.seals.length, seenSeals, "nothing was stored");
    };

    // No proof of a place in the log: not sealed.
    rewrite.current = (answer) => { answer.record.log.path = encodeHashes([new Uint8Array(32)]); };
    await refusedWith("log_proof_failed");
    // A certificate that doesn't match what this agent asked to have sealed.
    rewrite.current = (answer) => { (answer.record.certificate.fields as Record<string, unknown>)["root"] = Buffer.alloc(32, 9).toString("base64url"); };
    await refusedWith("bad_seal_signature");

    // An honest one goes through, and pins the log's state.
    rewrite.current = null;
    assert.equal((await must(["seal", session, "--agent", "Lea"]))["sealed"], true);
    seenSeals = 1;

    // A second message, so the next seal is new. A log that can't show it still holds what it showed is a rewritten log.
    await must(["send", session, "again", "--over", "--agent", "Lea"]);
    rewrite.current = (answer) => { answer.logProof = null; };
    await refusedWith("seal_log_rewritten");

    rewrite.current = null;
    assert.equal((await must(["seal", session, "--agent", "Lea"]))["sealed"], true);
  } finally {
    await must(["logout"]);
    proxy.close();
  }
});

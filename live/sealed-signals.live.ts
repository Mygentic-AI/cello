// Signals sealed with a call, through the real path: separate daemons, a real server, one command per call.
// A caller's set goes to the callee sealed to its published key, the callee's comes back sealed in the accept, and each side reads what the other showed.
import { cliFor } from "./cli-path.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { EMAIL_CLAIM } from "./stand-in-issuer.ts";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18700/v1";
type Json = Record<string, unknown>;
interface Signal { signal_hash: string; type: string; public?: boolean; counts_as_verified: boolean; issuer_standing: string; notes: string[]; payload?: unknown }

class Machine {
  readonly home = mkdtempSync(join(tmpdir(), "cello-pub-"));
  run(args: string[], input?: string): { status: number | null; stdout: string; stderr: string; json: Json } {
    const run = spawnSync(process.execPath, [cliFor(args), ...args], { encoding: "utf8", input: input ?? "", maxBuffer: 64_000_000, env: { ...process.env, CELLO_HOME: this.home } });
    let json: Json = {};
    try { json = JSON.parse(run.stdout || run.stderr) as Json; } catch { /* plain words */ }
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, json };
  }
  ok(args: string[]): Json {
    const run = this.run(args);
    assert.equal(run.status, 0, `cello ${args.join(" ")} failed: ${run.stderr}`);
    return run.json;
  }
  refused(args: string[], code: string): Json {
    const run = this.run(args);
    assert.equal(run.status, 1, `cello ${args.join(" ")} should have been refused`);
    assert.equal(run.json["error"], code, `cello ${args.join(" ")} said ${run.stderr}`);
    return run.json;
  }
  // A real terminal: the code is read off the screen and typed back.
  person(args: string[]): string {
    const run = spawnSync("python3", ["-c", TERMINAL, process.execPath, cliFor(args), ...args], { encoding: "utf8", timeout: 40_000, env: { ...process.env, CELLO_HOME: this.home } });
    assert.equal(run.status, 0, `the terminal didn't run: ${run.stderr}`);
    return run.stdout;
  }
}

const TERMINAL = `
import os, pty, re, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
out, sent, end = "", False, time.time() + 30
while time.time() < end:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
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
        os.write(fd, (asked.group(1) + "\\n").encode())
os.close(fd)
print(out)
`;

const started: Machine[] = [];
function machine(): Machine {
  const m = new Machine();
  m.run(["login", "--server", url]);
  started.push(m);
  return m;
}
after(() => { for (const m of started) m.run(["logout"]); });

interface Presented { session_id: string; from: string; theirs: Signal[]; refused: { fault: string }[]; theirs_unreadable: boolean; yours_sent: number }
const signalsOf = (m: Machine, agent: string): Signal[] => (m.ok(["signals", "list", "--json", "--agent", agent]) as unknown as { signals: Signal[] }).signals;
const presented = (m: Machine, agent: string, session: string): Presented => m.ok(["signals", "presented", session, "--json", "--agent", agent]) as never;
const agentOn = (m: Machine, name: string): { encryption_key: string; online: boolean } => (m.ok(["status"]) as unknown as { agents: { name: string; encryption_key: string; online: boolean }[] }).agents.find((a) => a.name === name) as never;

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, tries = 300): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// These conversations are with agents nobody has selected, so nothing answers for them. live/away.live.ts tests that.
const create = (m: Machine, name: string): string => {
  const id = m.ok(["create-agent", name])["agent_id"] as string;
  m.ok(["settings-set", "away.answering", "false", "--agent", name]);
  return id;
};
async function call(a: Machine, aName: string, bId: string, extra: string[] = []): Promise<Json> {
  const made = a.ok(["initiate-session", bId, "--anyway", "--agent", aName, ...extra]);
  const session = made["session_id"] as string;
  await until("the session to open", () => (a.ok(["sessions", "--agent", aName]) as unknown as { sessions: { session_id: string; state: string }[] }).sessions.find((s) => s.session_id === session)?.state === "active");
  return made;
}

test("each side shows its signals with a call, sealed, and each reads what the other showed, checked again", async () => {
  const ann = machine();
  const bea = machine();
  create(ann, "Ann");
  const beaId = create(bea, "Bea");
  // A caller can only seal to a key the callee has published, and that happens just after the callee comes online.
  await until("Bea's key to reach the server", () => agentOn(bea, "Bea").encryption_key === "published");
  await until("Ann's key to reach the server", () => agentOn(ann, "Ann").encryption_key === "published");
  const annEmail = signalsOf(ann, "Ann").find((s) => s.type === "email") as Signal;
  const beaEmail = signalsOf(bea, "Bea").find((s) => s.type === "email") as Signal;

  // The default set goes both ways.
  const first = await call(ann, "Ann", beaId);
  assert.equal(first["signals_sent"], 1);
  assert.equal(first["signals_note"], undefined);
  const session = first["session_id"] as string;
  const atBea = presented(bea, "Bea", session);
  assert.equal(atBea.theirs.length, 1, "Bea reads what Ann showed");
  assert.equal(atBea.theirs[0]?.signal_hash, annEmail.signal_hash, "the very signal Ann holds, checked again by Bea's daemon");
  assert.equal(atBea.theirs[0]?.counts_as_verified, false, "the stand-in issuer isn't on the signed list");
  assert.match((atBea.theirs[0] as Signal).notes.join("\n"), /Unverified claim/);
  assert.ok((atBea.theirs[0] as Signal).notes.join("\n").includes(EMAIL_CLAIM));
  assert.equal(atBea.theirs[0]?.payload, undefined, "no payload comes with a presented signal");
  assert.equal(atBea.theirs_unreadable, false);
  assert.equal(atBea.yours_sent, 1);
  const atAnn = presented(ann, "Ann", session);
  assert.equal(atAnn.theirs.length, 1, "Ann reads what Bea sent back in the accept");
  assert.equal(atAnn.theirs[0]?.signal_hash, beaEmail.signal_hash);
  assert.equal(atAnn.yours_sent, 1);
  const plain = bea.run(["signals", "presented", session, "--agent", "Bea"]).stdout;
  assert.match(plain, /UNKNOWN/);
  assert.match(plain, /Unverified claim/);

  // A caller chooses per call: none, or exactly these.
  const none = await call(ann, "Ann", beaId, ["--signals", "none"]);
  assert.equal(none["signals_sent"], 0);
  const noneAtBea = presented(bea, "Bea", none["session_id"] as string);
  assert.deepEqual(noneAtBea.theirs, [], "nothing sent reads as none");
  assert.equal(noneAtBea.theirs_unreadable, false, "and not as something that wouldn't open");
  assert.equal(presented(ann, "Ann", none["session_id"] as string).theirs.length, 1, "Bea's own set still came back");
  const chosen = await call(ann, "Ann", beaId, ["--signals", annEmail.signal_hash.slice(0, 12)]);
  assert.equal(chosen["signals_sent"], 1);
  assert.equal(presented(bea, "Bea", chosen["session_id"] as string).theirs[0]?.signal_hash, annEmail.signal_hash);

  // The callee can show nothing too, by switching its signal off, and Ann is told it sent none rather than left to guess.
  bea.ok(["signals", "disable", beaEmail.signal_hash, "--agent", "Bea"]);
  // A third caller, because Bea limits a stranger to three open conversations, and that is not what this is about.
  const cy = machine();
  create(cy, "Cy");
  const quiet = await call(cy, "Cy", beaId);
  assert.deepEqual(presented(cy, "Cy", quiet["session_id"] as string).theirs, []);
  assert.equal(presented(bea, "Bea", quiet["session_id"] as string).yours_sent, 0);

  // Refused before anything is sent: a hash that isn't hers, and one that isn't fit to show.
  ann.refused(["initiate-session", beaId, "--anyway", "--signals", "deadbeefdeadbeef", "--agent", "Ann"], "signal_not_found");
  ann.refused(["initiate-session", beaId, "--anyway", "--signals", beaEmail.signal_hash, "--agent", "Ann"], "signal_not_found");
});

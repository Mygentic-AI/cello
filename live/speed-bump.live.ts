// The initiate speed bump through the real path: separate daemons, a real server, one command per call.
// Ann calls Bea, a stranger to her, and is stopped on her own machine before Bea hears anything. Then each way past it.
import { cliFor } from "./cli-path.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18700/v1";
type Json = Record<string, unknown>;

class Machine {
  readonly home = mkdtempSync(join(tmpdir(), "cello-v2-bump-"));
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

const sessionsOf = (m: Machine, agent: string): unknown[] => (m.ok(["sessions", "--all", "--agent", agent]) as { sessions: unknown[] }).sessions;
const SESSION_ID = /^[0-9a-f]{32}$/;

test("a call to a stranger stops on the caller's machine, says what to do, and each way past it works", () => {
  const ann = machine();
  const bea = machine();
  const annId = ann.ok(["create-agent", "Ann"])["agent_id"] as string;
  const beaId = bea.ok(["create-agent", "Bea"])["agent_id"] as string;
  bea.ok(["settings-set", "away.answering", "false", "--agent", "Bea"]);

  // Stopped, in words that say whose rule it is and what comes next, and Bea has nothing.
  const words = String(ann.refused(["initiate-session", beaId, "--agent", "Ann"], "check_first")["message"]);
  console.log(`check_first, as the agent reads it:\n${words}`);
  assert.match(words, /your operator's own setting, not a refusal from the other agent, which hasn't been contacted/);
  assert.match(words, /unknown to Ann/);
  assert.ok(words.includes(`cello signals lookup ${beaId} --agent ${annId}`), "names the lookup, ready to run");
  assert.match(words, /--anyway/);
  assert.ok(words.includes(`cello contact-add ${beaId} --agent ${annId}`), "names how to skip it next time");
  assert.deepEqual(sessionsOf(ann, "Ann"), []);
  assert.deepEqual(sessionsOf(bea, "Bea"), [], "the callee was never contacted");

  // The lookup it recommends runs, and starts nothing.
  assert.deepEqual((ann.ok(["signals", "lookup", beaId, "--json", "--agent", "Ann"]) as { signals: unknown[] }).signals, []);
  assert.deepEqual(sessionsOf(bea, "Bea"), []);
  assert.match(ann.run(["initiate-session", "--help"]).stdout, /--anyway/);

  // Anyway goes ahead, and a contact is past it for good.
  assert.match(String(ann.ok(["initiate-session", beaId, "--anyway", "--agent", "Ann"])["session_id"]), SESSION_ID);
  ann.ok(["contact-add", beaId, "--agent", "Ann"]);
  assert.match(String(ann.ok(["initiate-session", beaId, "--agent", "Ann"])["session_id"]), SESSION_ID);
  assert.equal(sessionsOf(bea, "Bea").length, 2, "Bea got exactly the two calls that went ahead");
});

test("the tier is the owner's setting: raising it is free, lowering it takes a person, and a block keeps its own stop", () => {
  const ann = machine();
  const bea = machine();
  const cid = machine();
  const annId = ann.ok(["create-agent", "Ann"])["agent_id"] as string;
  const beaId = bea.ok(["create-agent", "Bea"])["agent_id"] as string;
  const cidId = cid.ok(["create-agent", "Cid"])["agent_id"] as string;
  bea.ok(["settings-set", "away.answering", "false", "--agent", "Bea"]);
  cid.ok(["settings-set", "away.answering", "false", "--agent", "Cid"]);
  ann.ok(["contact-add", beaId, "--agent", "Ann"]);

  // Raised to whitelisted: a known contact now stops too, and the way to skip it names the tier.
  ann.ok(["settings-set", "calling.check_below", "whitelisted", "--agent", "Ann"]);
  const words = String(ann.refused(["initiate-session", beaId, "--agent", "Ann"], "check_first")["message"]);
  assert.match(words, /known to Ann, and your operator asks for a check before calling anyone below whitelisted/);
  assert.ok(words.includes(`cello contact-set-tier ${beaId} --tier whitelisted --agent ${annId}`));
  ann.refused(["settings-set", "calling.check_below", "nonsense", "--agent", "Ann"], "bad_setting");

  // Lowering it loosens, so an agent can't, and a person at a terminal can.
  ann.refused(["settings-set", "calling.check_below", "unknown", "--agent", "Ann"], "person_required");
  ann.refused(["initiate-session", cidId, "--agent", "Ann"], "check_first");
  ann.person(["settings-set", "calling.check_below", "unknown", "--agent", "Ann"]);
  assert.match(String(ann.ok(["initiate-session", cidId, "--agent", "Ann"])["session_id"]), SESSION_ID, "off: a stranger is called with no check");

  // A block still has its own stop, which anyway doesn't pass.
  ann.ok(["contact-set-tier", cidId, "--tier", "blocked", "--agent", "Ann"]);
  ann.refused(["initiate-session", cidId, "--anyway", "--agent", "Ann"], "person_required");
});

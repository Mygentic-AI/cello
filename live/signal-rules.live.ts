// Signal rules through the real path: separate daemons, a real server, one command per call. Who may call an agent, and who it may call, by the signals shown.
// The stand-in issuer isn't on the signed list, so a signal from it counts only once a person at a terminal trusts it: which is also the point being tested.
import { cliFor } from "./cli-path.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

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

const signalsOf = (m: Machine, agent: string): Signal[] => (m.ok(["signals", "list", "--json", "--agent", agent]) as unknown as { signals: Signal[] }).signals;
const agentOn = (m: Machine, name: string): { encryption_key: string } => (m.ok(["status"]) as unknown as { agents: { name: string; encryption_key: string }[] }).agents.find((a) => a.name === name) as never;
async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, tries = 300): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const create = (m: Machine, name: string): string => {
  const id = m.ok(["create-agent", name])["agent_id"] as string;
  m.ok(["settings-set", "away.answering", "false", "--agent", name]);
  return id;
};
const state = async (a: Machine, aName: string, target: string, extra: string[] = []): Promise<Json> => {
  const made = a.ok(["initiate-session", target, "--anyway", "--agent", aName, ...extra]);
  if (made["state"] === "refused") return made;
  await until("the session to open or be refused", () => {
    const row = (a.ok(["sessions", "--agent", aName]) as unknown as { sessions: { session_id: string; state: string }[] }).sessions.find((s) => s.session_id === made["session_id"]);
    return row?.state === "active" || row?.state === "closed";
  });
  const row = (a.ok(["sessions", "--agent", aName]) as unknown as { sessions: { session_id: string; state: string }[] }).sessions.find((s) => s.session_id === made["session_id"]);
  return { ...made, state: row?.state };
};

test("an inbound rule turns a caller away until it shows what is asked, and an outbound rule declines an answer that shows too little", async () => {
  const ann = machine();
  const bea = machine();
  const annId = create(ann, "Ann");
  const beaId = create(bea, "Bea");
  await until("both keys on the server", () => agentOn(bea, "Bea").encryption_key === "published" && agentOn(ann, "Ann").encryption_key === "published");
  const beaEmail = signalsOf(bea, "Bea").find((s) => s.type === "email") as Signal;
  const annEmail = signalsOf(ann, "Ann").find((s) => s.type === "email") as Signal;

  // No rule: nothing is asked. Then Bea asks for an email signal: an agent may ask for more.
  // A third caller makes this call, because Bea limits a stranger to three open conversations and Ann needs her share for what follows.
  const cy = machine();
  create(cy, "Cy");
  assert.equal((await state(cy, "Cy", beaId, ["--signals", "none"]))["state"], "active", "no rule, no requirement, even showing nothing");
  assert.deepEqual((bea.ok(["signal-rules", "--agent", "Bea"]) as { rules: unknown[] }).rules, []);
  const set = bea.ok(["signal-rule-set", "--direction", "inbound", "--scope", "default", "--require-types", "email", "--agent", "Bea"]);
  assert.equal(set["loosened"], false);

  // Ann shows her email signal, but Bea doesn't recognise its issuer, so it doesn't count. The refusal is the fixed sentence, which says nothing about the rule.
  const unrecognised = await state(ann, "Ann", beaId);
  assert.equal(unrecognised["state"], "refused");
  assert.match(unrecognised["message"] as string, /asks for signals your call didn't show/);
  assert.ok(!(unrecognised["message"] as string).includes("email"), "the refusal doesn't name the rule");
  assert.ok(!(unrecognised["message"] as string).includes("require"), "or give its shape");
  // Showing none is refused the same way.
  assert.equal((await state(ann, "Ann", beaId, ["--signals", "none"]))["state"], "refused");

  // Bea's owner, at a terminal, trusts that issuer for her own machine. Now Ann's signal counts, and the same call goes through.
  bea.refused(["issuer-trust", beaEmail.signal_hash, "--agent", "Bea"], "person_required");
  bea.person(["issuer-trust", beaEmail.signal_hash, "--agent", "Bea"]);
  assert.equal((await state(ann, "Ann", beaId))["state"], "active", "an issuer her owner trusts counts");
  assert.equal((await state(ann, "Ann", beaId, ["--signals", "none"]))["state"], "refused", "showing nothing is still refused");

  // An agent can't loosen the rule. A person can, and then showing nothing is enough.
  bea.refused(["signal-rule-clear", "--direction", "inbound", "--scope", "default", "--agent", "Bea"], "person_required");
  assert.equal((await state(ann, "Ann", beaId, ["--signals", "none"]))["state"], "refused", "a refused loosening changed nothing");
  bea.person(["signal-rule-clear", "--direction", "inbound", "--scope", "default", "--agent", "Bea"]);
  assert.equal((bea.ok(["signal-rules", "--agent", "Bea"]) as { rules: unknown[] }).rules.length, 0);

  // The other way: Ann asks the same of whoever she calls. Bea shows her email signal, and Ann doesn't recognise its issuer yet, so the call isn't confirmed.
  ann.ok(["signal-rule-set", "--direction", "outbound", "--scope", "default", "--require-types", "email", "--agent", "Ann"]);
  const declined = await state(ann, "Ann", beaId);
  assert.equal(declined["state"], "refused");
  assert.match(declined["message"] as string, /answered, but didn't show the signals your outbound rule asks for/);
  assert.match(declined["message"] as string, /doesn't recognise/, "and says why a signal that was shown didn't count");
  ann.person(["issuer-trust", annEmail.signal_hash, "--agent", "Ann"]);
  assert.equal((await state(ann, "Ann", beaId))["state"], "active", "once Ann trusts the issuer, what came back counts");
  // Ann asking for something Bea has no signal of is declined however much is trusted.
  ann.ok(["signal-rule-set", "--direction", "outbound", "--scope", "default", "--require-types", "email,github", "--agent", "Ann"]);
  const missing = await state(ann, "Ann", beaId);
  assert.equal(missing["state"], "refused");
  assert.match(missing["message"] as string, /types it didn't show: github/);
  void annId;
});

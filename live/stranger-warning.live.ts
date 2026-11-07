// Calling a stranger through the real path: separate daemons, a real server, one command per call.
// Ann calls Bea, a stranger to her. The call goes ahead with a warning naming the command to add Bea; a contact gets none.
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
  readonly home = mkdtempSync(join(tmpdir(), "cello-stranger-"));
  run(args: string[]): { status: number | null; stdout: string; stderr: string; json: Json } {
    const run = spawnSync(process.execPath, [cliFor(args), ...args], { encoding: "utf8", input: "", maxBuffer: 64_000_000, env: { ...process.env, CELLO_HOME: this.home } });
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
}

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

test("a call to a stranger goes ahead with a warning that names the add command, and a contact gets none", () => {
  const ann = machine();
  const bea = machine();
  const annId = ann.ok(["create-agent", "Ann"])["agent_id"] as string;
  const beaId = bea.ok(["create-agent", "Bea"])["agent_id"] as string;
  bea.ok(["settings-set", "away.answering", "false", "--agent", "Bea"]);

  const first = ann.ok(["initiate-session", beaId, "--agent", "Ann"]);
  assert.match(String(first["session_id"]), SESSION_ID, "the call went ahead");
  const warning = String(first["warning"]);
  console.log(`the warning, as the agent reads it:\n${warning}`);
  assert.ok(warning.startsWith("Unknown agent: not in your contacts. Be careful what you share."));
  assert.ok(warning.includes(`cello contact-add ${beaId} --agent ${annId}`), "names the add command, ready to run");

  ann.ok(["contact-add", beaId, "--agent", "Ann"]);
  const second = ann.ok(["initiate-session", beaId, "--agent", "Ann"]);
  assert.match(String(second["session_id"]), SESSION_ID);
  assert.equal(second["warning"], undefined, "a contact is called with no warning");
  assert.equal(sessionsOf(bea, "Bea").length, 2, "Bea got both calls");
});

test("a block still has its own stop", () => {
  const ann = machine();
  const cid = machine();
  ann.ok(["create-agent", "Ann"]);
  const cidId = cid.ok(["create-agent", "Cid"])["agent_id"] as string;
  ann.ok(["contact-set-tier", cidId, "--tier", "blocked", "--agent", "Ann"]);
  ann.refused(["initiate-session", cidId, "--agent", "Ann"], "person_required");
});

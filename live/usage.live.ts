// Usage through the real path: separate daemons, a real server, the stand-in issuer, one command per call.
// Ann talks with Bea (another owner, on her own daemon) and with Ann2 (her own second agent), then asks for Usage for every agent.
import { cliFor } from "./cli-path.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18700/v1";
type Json = Record<string, unknown>;
interface UsageLine { conversations: number; agents: number; other_owner_agents: number }
interface PerAgent { agent: string; ok: boolean; usage?: UsageLine; error?: string; message?: string }

class Machine {
  readonly home = mkdtempSync(join(tmpdir(), "cello-usage-"));
  run(args: string[]): { status: number | null; stdout: string; stderr: string; json: Json } {
    const run = spawnSync(process.execPath, [cliFor(args), ...args], { encoding: "utf8", maxBuffer: 64_000_000, env: { ...process.env, CELLO_HOME: this.home } });
    let json: Json = {};
    try { json = JSON.parse(run.stdout || run.stderr) as Json; } catch { /* plain words */ }
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, json };
  }
  ok(args: string[]): Json {
    const run = this.run(args);
    assert.equal(run.status, 0, `cello ${args.join(" ")} failed: ${run.stderr}`);
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

async function until<T>(what: string, check: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Nobody selects these agents, so nothing answers for them: away answering off, as the other live tests do.
const create = (m: Machine, name: string): string => {
  const id = m.ok(["create-agent", name])["agent_id"] as string;
  m.ok(["settings-set", "away.answering", "false", "--agent", name]);
  return id;
};

// One message each way, so the conversation counts: only conversations where both sides wrote do.
async function talk(a: Machine, aName: string, b: Machine, bName: string, bId: string): Promise<void> {
  const session = a.ok(["initiate-session", bId, "--agent", aName])["session_id"] as string;
  await until("the session to open", () => (a.ok(["sessions", "--agent", aName]) as unknown as { sessions: { session_id: string; state: string }[] }).sessions.find((s) => s.session_id === session)?.state === "active");
  a.ok(["send", session, `hello ${bName}`, "--over", "--agent", aName]);
  b.ok(["wait", "--agent", bName, "--timeout-seconds", "30"]);
  b.ok(["receive", "--agent", bName]);
  b.ok(["send", session, `hello ${aName}`, "--over", "--agent", bName]);
  a.ok(["wait", "--agent", aName, "--timeout-seconds", "30"]);
  a.ok(["receive", "--agent", aName]);
}

test("Usage for every agent on a daemon: counted by the server, other owners counted by the issuer, and nothing to count is said so", { timeout: 200_000 }, async () => {
  const ann = machine();
  const bea = machine();
  create(ann, "Ann");
  const ann2Id = create(ann, "Ann2");
  const beaId = create(bea, "Bea");

  // Before any conversation: told so, by name, and no signal.
  const nothing = ann.run(["signals", "request", "usage", "--agent", "Ann", "--json"]);
  assert.equal(nothing.status, 1);
  assert.equal(nothing.json["error"], "usage_nothing_to_count", nothing.stderr);

  await talk(ann, "Ann", bea, "Bea", beaId);

  // Every agent, while Ann2 still has nothing to count: Ann's line is ready, Ann2's says why not, and one stops neither.
  const mixed = ann.ok(["signals", "request", "usage", "--json"]) as { agents: PerAgent[] };
  assert.deepEqual(mixed.agents.map((a) => [a.agent, a.ok, a.error ?? null]).sort(), [["Ann", true, null], ["Ann2", false, "usage_nothing_to_count"]]);
  const mixedPlain = ann.run(["signals", "request", "usage"]).stdout;
  assert.match(mixedPlain, /^Ann: ready, 1 conversation with 1 agent\.$/m);
  assert.match(mixedPlain, /^Ann2: Nothing to count yet\. Your agent needs one conversation where both sides wrote\.$/m);

  await talk(ann, "Ann", ann, "Ann2", ann2Id);

  // No agent named: every agent on Ann's daemon, never Bea's. Ann talked with two agents, one of them another owner's (Bea).
  const all = ann.ok(["signals", "request", "usage", "--json"]) as { agents: PerAgent[] };
  assert.deepEqual(all.agents.map((a) => a.agent).sort(), ["Ann", "Ann2"]);
  const annLine = all.agents.find((a) => a.agent === "Ann") as PerAgent;
  assert.equal(annLine.ok, true, annLine.message ?? "Ann's request failed");
  assert.deepEqual(annLine.usage, { conversations: 2, agents: 2, other_owner_agents: 1 });
  const ann2Line = all.agents.find((a) => a.agent === "Ann2") as PerAgent;
  assert.deepEqual(ann2Line.usage, { conversations: 1, agents: 1, other_owner_agents: 0 }, "Ann is Ann2's own owner, so not another owner");

  // In words, one line per agent.
  const plain = ann.run(["signals", "request", "usage"]).stdout;
  assert.match(plain, /^Ann: ready, 2 conversations with 2 agents\.$/m);
  assert.match(plain, /^Ann2: ready, 1 conversation with 1 agent\.$/m);

  // Both varieties are in the wallet, once each however often it's asked. Standard is shown, detailed is left out.
  interface Held { type: string; signal_hash: string; default_present: boolean }
  const held = (): Held[] => (ann.ok(["signals", "list", "--json", "--agent", "Ann"]) as { signals: Held[] }).signals;
  const usageHeld = held().filter((s) => s.type.startsWith("usage"));
  assert.deepEqual(usageHeld.map((s) => [s.type, s.default_present]).sort(), [["usage", true], ["usage_detailed", false]]);
  // The person switches to detailed; asking again keeps that choice in the renewed pair.
  ann.ok(["signals", "disable", usageHeld.find((s) => s.type === "usage")!.signal_hash, "--agent", "Ann"]);
  ann.ok(["signals", "enable", usageHeld.find((s) => s.type === "usage_detailed")!.signal_hash, "--agent", "Ann"]);
  ann.ok(["signals", "request", "usage", "--agent", "Ann", "--json"]);
  const renewed = held().filter((s) => s.type.startsWith("usage"));
  assert.deepEqual(renewed.map((s) => [s.type, s.default_present]).sort(), [["usage", false], ["usage_detailed", true]], "a renewal keeps the person's choice");

  // One agent named: that agent's answer alone.
  const one = bea.ok(["signals", "request", "usage", "--agent", "Bea", "--json"]) as { usage: UsageLine };
  assert.deepEqual(one.usage, { conversations: 1, agents: 1, other_owner_agents: 1 });
  assert.match(bea.run(["signals", "request", "usage", "--agent", "Bea"]).stdout, /^Requested\. Bea's Usage signal is ready\. 1 conversation with 1 agent\.$/m);

  // collect with no agent is every agent on the daemon too, each answered on its own.
  const collected = ann.ok(["signals", "collect", "--json"]) as { agents: PerAgent[] };
  assert.deepEqual(collected.agents.map((a) => [a.agent, a.ok]).sort(), [["Ann", true], ["Ann2", true]]);
});

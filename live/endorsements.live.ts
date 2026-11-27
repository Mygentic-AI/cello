// Endorsements through the real path: separate daemons, a real server and the stand-in issuer, one command per call.
// A and C are agents of one owner on one machine; B and D are other owners'. The whole loop: endorse, accept, show, require,
// withdraw, refuse, and the same-owner flag.
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
  readonly home = mkdtempSync(join(tmpdir(), "cello-endorse-"));
  run(args: string[], input?: string): { status: number | null; stdout: string; stderr: string; json: Json } {
    const run = spawnSync(process.execPath, [cliFor(args), ...args], { encoding: "utf8", input: input ?? "", maxBuffer: 64_000_000, env: { ...process.env, CELLO_HOME: this.home } });
    let json: Json = {};
    try { json = JSON.parse(run.stdout || run.stderr) as Json; } catch { /* plain words */ }
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, json };
  }
  // As an agent's shell would: CELLO_CALLER names the caller, so nothing here counts as a human operator.
  asAgent(args: string[]): { status: number | null; json: Json } {
    const run = spawnSync(process.execPath, [cliFor(args), ...args], { encoding: "utf8", input: "", env: { ...process.env, CELLO_HOME: this.home, CELLO_CALLER: "claude" } });
    let json: Json = {};
    try { json = JSON.parse(run.stdout || run.stderr) as Json; } catch { /* plain words */ }
    return { status: run.status, json };
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
  const made = a.ok(["initiate-session", target, "--agent", aName, ...extra]);
  if (made["state"] === "refused") return made;
  await until("the session to open or be refused", () => {
    const row = (a.ok(["sessions", "--agent", aName]) as unknown as { sessions: { session_id: string; state: string }[] }).sessions.find((s) => s.session_id === made["session_id"]);
    return row?.state === "active" || row?.state === "closed";
  });
  const row = (a.ok(["sessions", "--agent", aName]) as unknown as { sessions: { session_id: string; state: string }[] }).sessions.find((s) => s.session_id === made["session_id"]);
  return { ...made, state: row?.state };
};

interface Wallet { signals: (Signal & { status: string; consent_state: string; same_operator?: boolean; endorsed_by?: string; waiting_for?: string })[] }
const wallet = (m: Machine, agent: string, all = false): Wallet["signals"] => (m.ok(["signals", "list", "--json", "--agent", agent, ...(all ? ["--all"] : [])]) as unknown as Wallet).signals;
const endorsementsOf = (m: Machine, agent: string, all = false) => wallet(m, agent, all).filter((s) => s.type === "endorsement");
// What a human operator's terminal printed, read back for the answer's fields.
const field = (out: string, name: string): string | undefined => new RegExp(`"${name}":\\s*"?([0-9a-z_]+)"?`).exec(out)?.[1];

test("the endorsement loop: endorse, accept, show, require, withdraw, refuse, and the same-owner flag", async () => {
  const ma = machine();
  const mb = machine();
  const md = machine();
  const aId = create(ma, "Ann");
  const bId = create(mb, "Bea");
  create(md, "Dee");
  const cId = create(ma, "Cy");
  await until("keys on the server", () => ["Ann", "Cy"].every((n) => agentOn(ma, n).encryption_key === "published") && agentOn(mb, "Bea").encryption_key === "published" && agentOn(md, "Dee").encryption_key === "published");
  const words = "Bea's agent has handled our invoices for a year.";

  // 1. An agent can't vouch in its owner's name: refused, with the command for its human operator.
  const asAgent = ma.asAgent(["signals", "endorse", bId, words, "--agent", "Ann"]);
  assert.equal(asAgent.status, 1);
  assert.equal(asAgent.json["error"], "person_required");
  assert.match(asAgent.json["message"] as string, /cello signals endorse/);
  assert.equal(ma.asAgent(["signals", "accept", "0000000000000000", "--agent", "Ann"]).json["error"], "person_required");

  // 2. The human operator endorses Bea as Ann.
  const given = ma.person(["signals", "endorse", bId, words, "--agent", "Ann"]);
  const hash = field(given, "signal_hash") as string;
  assert.match(hash ?? "", /^[0-9a-f]{64}$/, given);
  assert.equal(field(given, "same_operator"), "false");

  // 3. Bea collects: it waits for her operator, and can't be shown.
  mb.ok(["signals", "collect", "--agent", "Bea"]);
  const pending = endorsementsOf(mb, "Bea").find((s) => s.signal_hash === hash);
  assert.equal(pending?.consent_state, "pending");
  assert.equal(pending?.endorsed_by, aId);
  assert.match(pending?.waiting_for ?? "", /cello signals accept/);
  mb.refused(["signals", "enable", hash, "--agent", "Bea"], "consent_pending");
  mb.refused(["signals", "publish", hash, "--agent", "Bea"], "consent_pending");

  // 4. Her operator accepts; she shows and publishes it.
  mb.person(["signals", "accept", hash, "--agent", "Bea"]);
  assert.equal(endorsementsOf(mb, "Bea").find((s) => s.signal_hash === hash)?.consent_state, "accepted");
  mb.ok(["signals", "enable", hash, "--agent", "Bea"]);
  mb.ok(["signals", "publish", hash, "--agent", "Bea"]);

  // 5. A third agent looks Bea up and sees the endorsement, its words and its author.
  const looked = md.ok(["signals", "lookup", bId, "--json", "--agent", "Dee"]) as unknown as { signals: { type: string; statement?: string; endorsed_by?: string }[] };
  const seen = looked.signals.find((s) => s.type === "endorsement");
  assert.equal(seen?.statement, words);
  assert.equal(seen?.endorsed_by, aId);

  // 6. Ann requires an endorsement of agents that start conversations with her. Her operator trusts the stand-in issuer, so it counts.
  const annEmail = wallet(ma, "Ann").find((s) => s.type === "email") as Signal;
  ma.person(["issuer-trust", annEmail.signal_hash, "--agent", "Ann"]);
  ma.ok(["signal-rule-set", "--direction", "inbound", "--scope", "default", "--require-types", "endorsement", "--agent", "Ann"]);
  assert.equal((await state(md, "Dee", aId))["state"], "refused", "no endorsement, no conversation");
  const through = await state(mb, "Bea", aId);
  assert.equal(through["state"], "active", "Bea shows one");
  const presented = ma.ok(["signals", "presented", through["session_id"] as string, "--json", "--agent", "Ann"]) as unknown as { theirs: { type: string; statement?: string }[] };
  assert.equal(presented.theirs.find((s) => s.type === "endorsement")?.statement, words);
  ma.person(["signal-rule-clear", "--direction", "inbound", "--scope", "default", "--agent", "Ann"]);

  // 7. Ann lists what she gave, then withdraws. Bea's next collect marks it withdrawn and takes it out of public view.
  const list = ma.ok(["signals", "endorsements", "--agent", "Ann"]) as unknown as { endorsements: { signal_hash: string; status: string; subject: string }[] };
  assert.deepEqual(list.endorsements.map((e) => [e.signal_hash, e.status, e.subject]), [[hash, "current", bId]]);
  ma.ok(["signals", "withdraw", bId, "--agent", "Ann"]);
  const collected = mb.ok(["signals", "collect", "--json", "--agent", "Bea"]);
  assert.deepEqual(collected["withdrawn"], [hash]);
  assert.equal(endorsementsOf(mb, "Bea", true).find((s) => s.signal_hash === hash)?.status, "withdrawn");
  await until("the public copy to be taken back", () => !(md.ok(["signals", "lookup", bId, "--json", "--agent", "Dee"]) as unknown as { signals: { type: string }[] }).signals.some((s) => s.type === "endorsement"));

  // 8. Ann endorses again; Bea refuses; Ann can't endorse her again.
  const again = field(ma.person(["signals", "endorse", bId, "Still true.", "--agent", "Ann"]), "signal_hash") as string;
  mb.ok(["signals", "collect", "--agent", "Bea"]);
  const refused = mb.ok(["signals", "refuse", again, "--agent", "Bea"]);
  assert.equal(refused["issuer_told"], true);
  const blocked = ma.person(["signals", "endorse", bId, "Please.", "--agent", "Ann"]);
  assert.match(blocked, /refused_by_subject/);

  // 9. Cy, Ann's sibling on the same account, endorses Ann: same_operator, and the co-ownership note on read.
  const sibling = ma.person(["signals", "endorse", aId, "My sibling agent.", "--agent", "Cy"]);
  assert.equal(field(sibling, "same_operator"), "true");
  const siblingHash = field(sibling, "signal_hash") as string;
  ma.ok(["signals", "collect", "--agent", "Ann"]);
  const own = endorsementsOf(ma, "Ann").find((s) => s.signal_hash === siblingHash);
  assert.equal(own?.same_operator, true);
  assert.equal(own?.endorsed_by, cId);
  const viewed = ma.ok(["signals", "view", siblingHash, "--json", "--agent", "Ann"]) as { payload?: { co_ownership_note?: string } };
  assert.match(viewed.payload?.co_ownership_note ?? "", /same account/);
});

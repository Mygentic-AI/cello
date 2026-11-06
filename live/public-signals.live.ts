// Public signals through the real path: separate daemons, a real server, one command per call.
// Ann makes her email signal public, Bea (on another daemon) looks her up, and each thing a reader or the server must refuse is tried.
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
  readonly home = mkdtempSync(join(tmpdir(), "cello-v2-pub-"));
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
const lookup = (m: Machine, agent: string, address: string): { agent: string; signals: Signal[]; refused: { fault: string }[] } => m.ok(["signals", "lookup", address, "--json", "--agent", agent]) as never;

test("an agent makes a signal public, another daemon looks it up and checks it, and taking it back removes it", async () => {
  const ann = machine();
  const bea = machine();
  const annId = ann.ok(["create-agent", "Ann"])["agent_id"] as string;
  bea.ok(["create-agent", "Bea"]);
  const email = signalsOf(ann, "Ann").find((s) => s.type === "email") as Signal;
  assert.ok(email, "Ann holds the email signal she registered with");
  assert.equal(email.public ?? false, false);

  // Nothing public yet, and saying so is an answer.
  assert.deepEqual(lookup(bea, "Bea", annId).signals, []);
  assert.match(bea.run(["signals", "lookup", annId, "--agent", "Bea"]).stdout, /none\. An agent with no public signals proves nothing either way/);

  // Publishing: the wallet says public, and the repeat changes nothing.
  assert.deepEqual(ann.ok(["signals", "publish", email.signal_hash, "--agent", "Ann"]), { signal_hash: email.signal_hash, public: true });
  assert.deepEqual(ann.ok(["signals", "publish", email.signal_hash.slice(0, 12), "--agent", "Ann"]), { signal_hash: email.signal_hash, public: true });
  assert.equal(signalsOf(ann, "Ann").find((s) => s.signal_hash === email.signal_hash)?.public, true);
  assert.match(ann.run(["signals", "list", "--agent", "Ann"]).stdout, /public/);

  // Bea, on her own daemon, reads it. The issuer is the stand-in one, which isn't on the signed list, so it's unknown to her and its claim is quoted, not trusted.
  const first = lookup(bea, "Bea", annId);
  assert.equal(first.agent, annId);
  assert.equal(first.signals.length, 1);
  const seen = first.signals[0] as Signal;
  assert.equal(seen.type, "email");
  assert.equal(seen.signal_hash, email.signal_hash, "the same signal, checked again by Bea's daemon");
  assert.equal(seen.counts_as_verified, false);
  assert.equal(seen.issuer_standing, "unknown");
  assert.match(seen.notes.join("\n"), /Unverified claim/);
  assert.ok(seen.notes.join("\n").includes(EMAIL_CLAIM), "the claim is shown, inside its note");
  assert.equal(seen.payload, undefined, "no payload comes with a lookup");
  const plain = bea.run(["signals", "lookup", annId, "--agent", "Bea"]).stdout;
  assert.match(plain, /UNKNOWN/);
  assert.match(plain, /Unverified claim/);

  // Bea's owner trusts that issuer, at a terminal, using her own copy of its signal. Now it counts, on her machine.
  const beaEmail = signalsOf(bea, "Bea").find((s) => s.type === "email") as Signal;
  bea.refused(["issuer-trust", beaEmail.signal_hash, "--agent", "Bea"], "person_required");
  assert.match(bea.person(["issuer-trust", beaEmail.signal_hash, "--agent", "Bea"]), /trusted/);
  const trusted = lookup(bea, "Bea", annId).signals[0] as Signal;
  assert.equal(trusted.issuer_standing, "trusted_by_owner");
  assert.equal(trusted.counts_as_verified, true);

  // Taking it back: gone for readers at once, still held by Ann, and a repeat is fine.
  assert.deepEqual(ann.ok(["signals", "unpublish", email.signal_hash, "--agent", "Ann"]), { signal_hash: email.signal_hash, public: false });
  assert.deepEqual(lookup(bea, "Bea", annId).signals, []);
  assert.equal(signalsOf(ann, "Ann").find((s) => s.signal_hash === email.signal_hash)?.public ?? false, false);
  ann.ok(["signals", "unpublish", email.signal_hash, "--agent", "Ann"]);
});

test("what can't be made public or looked up is refused by name, and nothing changes", async () => {
  const ann = machine();
  const bea = machine();
  const annId = ann.ok(["create-agent", "Ann"])["agent_id"] as string;
  bea.ok(["create-agent", "Bea"]);
  ann.refused(["signals", "publish", "deadbeefdeadbeef", "--agent", "Ann"], "signal_not_found");
  ann.refused(["signals", "publish", "zz", "--agent", "Ann"], "bad_argument");
  ann.refused(["signals", "unpublish", "deadbeefdeadbeef", "--agent", "Ann"], "signal_not_found");
  bea.refused(["signals", "lookup", "ab".repeat(32), "--agent", "Bea"], "unknown_agent");
  bea.refused(["signals", "lookup", "nonsense", "--agent", "Bea"], "bad_argument");
  bea.refused(["signals", "lookup", `${annId}@ws://plain.example:1234/v1`, "--agent", "Bea"], "plain_text_server");
  // Bea can't publish or take back Ann's signal by hash: a hash only finds what her own wallet holds.
  const email = signalsOf(ann, "Ann").find((s) => s.type === "email") as Signal;
  bea.refused(["signals", "publish", email.signal_hash, "--agent", "Bea"], "signal_not_found");
  assert.deepEqual(lookup(bea, "Bea", annId).signals, []);
});

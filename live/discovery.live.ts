// Discovery through the real path: separate daemons, a real server, the stand-in issuer, one command per call (DISCOVERY-PLAN.md).
// Ann earns a Usage signal, makes it public, lists herself and a channel; Bea, on another daemon, finds both and gets an address to use.
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
  readonly home = mkdtempSync(join(tmpdir(), "cello-discover-"));
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
  refused(args: string[], code: string): Json {
    const run = this.run(args);
    assert.equal(run.status, 1, `cello ${args.join(" ")} should have been refused: ${run.stdout}`);
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

async function until<T>(what: string, check: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = check();
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

// One message each way, so the conversation counts toward Usage.
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

interface Found { name: string; address?: string; agent_id?: string; channel?: string; name_self_declared?: boolean; signals?: { count: number; of: number; slots: string[] }; tags: string[]; language: string; access?: string; preview: string }
const search = (m: Machine, agent: string, kind: "agents" | "channels", ...args: string[]): { results: Found[]; unverified?: number } =>
  m.ok(["discover", kind, ...args, "--json", "--agent", agent]) as never;

test("discovery end to end: an agent with a public Usage signal lists itself and a channel, and another daemon finds both", { timeout: 220_000 }, async () => {
  const ann = machine();
  const bea = machine();
  const annId = create(ann, "Ann");
  const beaId = create(bea, "Bea");
  const tag = `t${Date.now().toString(36)}`;

  // No Usage signal yet: refused, and the words say what's missing.
  const none = bea.refused(["listing", "publish", "--name", "Bea_helper", "--tags", tag, "--agent", "Bea"], "listing_needs_usage");
  assert.match(String(none["message"]), /none public/);

  // A conversation earns Usage; made public, it opens a listing.
  await talk(ann, "Ann", bea, "Bea", beaId);
  ann.ok(["signals", "request", "usage", "--agent", "Ann", "--json"]);
  const usageHash = (): string => ((ann.ok(["signals", "list", "--json", "--agent", "Ann"]) as { signals: { type: string; signal_hash: string; status?: string }[] }).signals.find((s) => s.type === "usage"))!.signal_hash;
  ann.ok(["signals", "publish", usageHash(), "--agent", "Ann"]);

  // A reserved name is refused; a plain one is listed.
  ann.refused(["listing", "publish", "--name", "CeLLo_helper", "--agent", "Ann"], "listing_name_reserved");
  const listed = ann.ok(["listing", "publish", "--name", "Ann_helper", "--description", "Books meetings for a small firm.", "--tags", `calendar, ${tag}`, "--agent", "Ann"]);
  assert.equal(listed["review"], "approved");
  assert.equal(listed["revision"], 1);

  // Bea finds Ann by tag and by a word, with the address to call, the self-declared label, English by default and "1 of 6".
  const byTag = search(bea, "Bea", "agents", "--tags", tag).results;
  assert.equal(byTag.length, 1);
  assert.equal(byTag[0]?.agent_id, annId);
  assert.match(byTag[0]?.address ?? "", new RegExp(`^${annId}@`));
  assert.equal(byTag[0]?.name_self_declared, true);
  assert.equal(byTag[0]?.language, "en");
  assert.deepEqual(byTag[0]?.signals, { count: 1, of: 6, slots: ["usage"] });
  assert.ok(search(bea, "Bea", "agents", "meetings", "--tags", tag).results.some((r) => r.agent_id === annId));
  // In words for a person: the name, marked self-declared, and the count.
  const plain = bea.run(["discover", "agents", "--tags", tag, "--agent", "Bea"]).stdout;
  assert.match(plain, /Ann_helper \(self-declared\)/);
  assert.match(plain, /1 of 6 trust signals/);

  assert.match(plain, new RegExp(`More: cello discover show ${annId}@`));

  // One agent in full, by its address: the whole description, and each public signal with what it says.
  const address = byTag[0]?.address as string;
  const shown1 = bea.ok(["discover", "show", address, "--json", "--agent", "Bea"]) as { listed: boolean; description: string; signals: { type: string; claim: string | null }[]; talk: string; expires_at?: string };
  assert.equal(shown1.listed, true);
  assert.equal(shown1.description, "Books meetings for a small firm.");
  assert.ok(shown1.expires_at, "it says when the listing expires");
  const usageClaim = shown1.signals.find((s) => s.type === "usage")?.claim ?? "";
  assert.match(usageClaim, /conversation/, "the Usage signal shows what it counts, not only that it exists");
  assert.equal(shown1.talk, `cello initiate-session ${address}`);
  const showPlain = bea.run(["discover", "show", address, "--agent", "Bea"]).stdout;
  assert.match(showPlain, /^Ann_helper {2}\(name chosen by its owner, not checked\)$/m);
  // This test's stand-in issuer is trusted by the server but not on Bea's machine, so her daemon marks the Usage signal as only the
  // agent's own claim and doesn't count it: the reader decides. On production both read the same signed list.
  assert.match(showPlain, /^Trust signals: 0 of 6$/m);
  assert.match(showPlain, /^Missing: Usage, GitHub, X, Email, Phone, Passkey$/m);
  assert.match(showPlain, /^• usage, from an issuer this machine doesn't recognise .*: only the agent's own claim: .*conversation/m);
  // The owner's view, asked for an agent that isn't on this machine, points to discover show instead of saying "create it".
  const notMine = bea.refused(["listing", "show", "--agent", annId], "not_your_agent");
  assert.match(String(notMine["message"]), /cello discover show/);
  // signals lookup shows what each signal says, under a name a person reads.
  const lookupPlain = bea.run(["signals", "lookup", address, "--agent", "Bea"]).stdout;
  assert.match(lookupPlain, /^ {2}Usage {2,}/m);
  assert.match(lookupPlain, /conversation/);

  // An edit replaces it; the owner's view shows the newer revision.
  ann.ok(["listing", "publish", "--name", "Ann_helper", "--description", "Books meetings and answers client email.", "--tags", tag, "--language", "pt-BR", "--agent", "Ann"]);
  const shown = ann.ok(["listing", "show", "--agent", "Ann"]);
  assert.deepEqual([shown["revision"], shown["review"], shown["language"], shown["suspended"]], [2, "approved", "pt-BR", false]);

  // A Usage renewal stays public, so the listing doesn't drop out.
  const firstUsage = usageHash();
  ann.ok(["signals", "request", "usage", "--agent", "Ann", "--json"]);
  // Collecting settles before it answers: the renewal is a new signal, and it's the one that's public.
  const usageRows = (ann.ok(["signals", "list", "--json", "--agent", "Ann"]) as { signals: { type: string; signal_hash: string; public?: boolean }[] }).signals.filter((s) => s.type === "usage");
  const publicUsage = usageRows.filter((s) => s.public === true);
  assert.equal(publicUsage.length, 1, "exactly one Usage signal public after the renewal");
  assert.notEqual(publicUsage[0]?.signal_hash, firstUsage, "the public one is the renewal, not the old one");
  assert.equal(search(bea, "Bea", "agents", "--tags", tag).results[0]?.agent_id, annId, "still found after the Usage signal renewed");

  // Renew keeps it as it was.
  const renewed = ann.ok(["listing", "renew", "--agent", "Ann"]);
  assert.ok(new Date(String(renewed["expires_at"])).getTime() > Date.now() + 180 * 86_400_000);

  // A channel Ann runs, listed with its key and found by Bea, who then joins it with that key.
  const channelId = ann.ok(["channel-create", "release-notes", "--type", "public", "--agent", "Ann"])["channel_id"] as string;
  ann.ok(["listing", "publish", "--channel", channelId, "--name", "release-notes", "--description", "Announcements, one poster.", "--tags", tag, "--agent", "Ann"]);
  bea.refused(["listing", "publish", "--channel", channelId, "--name", "not-mine", "--agent", "Bea"], "not_the_admin");
  const channels = search(bea, "Bea", "channels", "--tags", tag).results;
  assert.deepEqual(channels.map((c) => [c.channel, c.access, c.name]), [[channelId, "public", "release-notes"]]);
  bea.ok(["channel-join", channelId, "--agent", "Bea"]);

  // Unlisted: gone from search, and a repeat changes nothing.
  assert.equal(ann.ok(["listing", "unpublish", "--agent", "Ann"])["removed"], true);
  assert.equal(ann.ok(["listing", "unpublish", "--agent", "Ann"])["removed"], false);
  assert.deepEqual(search(bea, "Bea", "agents", "--tags", tag).results, []);
});

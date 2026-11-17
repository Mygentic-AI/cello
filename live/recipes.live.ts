// The plugin skills' recipes, run with the exact commands the skills give: separate daemons, a real server, one command per call.
// A recipe is a promise that these commands produce this behaviour, so each is checked here before an agent is told to use it.
// The kill switch has its own test (live/agent-status.live.ts), and the notifier half of "ask me before you agree" needs Telegram
// (live/notifier.live.ts): only their other halves are here.
import { cliFor } from "./cli-path.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18700/v1";

type Json = Record<string, unknown>;
interface Read { messages: { text?: string; from_id: string }[]; policies?: { session_id: string; policy?: { text: string } }[]; reminders?: { due: { text: string; session_id?: string }[] } }
interface ChannelView { channel_id: string; state: string; unread?: number }

class Machine {
  readonly home = mkdtempSync(join(tmpdir(), "cello-recipe-"));
  run(args: string[]): { status: number | null; stderr: string; json: Json } {
    const run = spawnSync(process.execPath, [cliFor(args), ...args], { encoding: "utf8", maxBuffer: 64_000_000, env: { ...process.env, CELLO_HOME: this.home, CELLO_CALLER: "cli" } });
    let json: Json = {};
    try {
      json = JSON.parse(run.stdout || run.stderr) as Json;
    } catch {
      // login and logout answer in words.
    }
    return { status: run.status, stderr: run.stderr, json };
  }
  ok(args: string[]): Json {
    const run = this.run(args);
    assert.equal(run.status, 0, `cello ${args.join(" ")} failed: ${run.stderr}`);
    return run.json;
  }
  refused(args: string[]): Json {
    const run = this.run(args);
    assert.equal(run.status, 1, `cello ${args.join(" ")} should have been refused`);
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
after(() => {
  for (const m of started) m.run(["logout"]);
});

async function until<T>(what: string, check: () => T | undefined | false, tries = 300): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Nobody holds these agents, so an away greeting would close a call after one message. live/away.live.ts tests that.
const agent = (m: Machine, name: string): string => {
  const id = m.ok(["create-agent", name])["agent_id"] as string;
  m.ok(["settings-set", "away.answering", "false", "--agent", name]);
  return id;
};
const contactTier = (m: Machine, name: string, id: string): string | undefined => (m.ok(["contacts", "--agent", name]) as unknown as { contacts: { contact_id: string; tier: string }[] }).contacts.find((c) => c.contact_id === id)?.tier;
const read = (m: Machine, name: string): Read => m.ok(["receive", "--agent", name]) as unknown as Read;
const channel = (m: Machine, name: string, id: string): ChannelView | undefined => (m.ok(["channels", "--agent", name]) as unknown as { channels: ChannelView[] }).channels.find((c) => c.channel_id === id);
async function readUntil(m: Machine, name: string, what: string, has: (r: Read) => boolean): Promise<Read> {
  return until(what, () => { const r = read(m, name); return has(r) ? r : undefined; });
}
function approve(m: Machine, name: string, args: string[]): void {
  const id = m.ok(["policy-propose", ...args, "--agent", name])["proposal_id"] as string;
  assert.match(m.person(["policy-approve", id, "--agent", name]), /"approved": true/);
}

test("first contact with a stranger: the warning, known after a reply, and a block that holds", async () => {
  const a = machine();
  agent(a, "Ari");
  const b = machine();
  const bId = agent(b, "Bo");
  const aId = (a.ok(["agents"]) as unknown as { agents: { name: string; agent_id: string }[] }).agents.find((x) => x.name === "Ari")?.agent_id as string;

  const answer = a.ok(["initiate-session", bId, "--agent", "Ari"]);
  assert.match(answer["warning"] as string, /not in your contacts.*cello contact-add/s, "step 1: the warning carries the command");
  const session = answer["session_id"] as string;
  a.ok(["send", session, "Hello, I'm Ari", "--over", "--agent", "Ari"]);
  await readUntil(b, "Bo", "Bo to read it", (r) => r.messages.length > 0);
  assert.equal(contactTier(b, "Bo", aId), undefined, "step 2: a stranger on their side, and taking the call raised nobody");
  b.ok(["send", session, "Hi Ari", "--over", "--agent", "Bo"]);
  assert.equal(contactTier(b, "Bo", aId), "known", "step 3: replying raised the stranger to known");

  b.ok(["contact-set-tier", aId, "--tier", "blocked", "--agent", "Bo"]);
  assert.equal(a.ok(["initiate-session", bId, "--agent", "Ari"])["state"], "refused", "step 5: a block is free and holds at once");
});

test("your own agents talk: vip on both sides, and lighter screening for that one sender", async () => {
  const a = machine();
  const aId = agent(a, "Cy");
  const b = machine();
  const bId = agent(b, "Di");
  a.ok(["contact-add", bId, "--moniker", "Di", "--agent", "Cy"]);
  b.ok(["contact-add", aId, "--moniker", "Cy", "--agent", "Di"]);
  a.refused(["contact-set-tier", bId, "--tier", "vip", "--agent", "Cy"]);
  a.person(["contact-set-tier", bId, "--tier", "vip", "--agent", "Cy"]);
  b.person(["contact-set-tier", aId, "--tier", "vip", "--agent", "Di"]);
  b.person(["screening", aId, "--level", "deterministic", "--agent", "Di"]);
  assert.equal(contactTier(a, "Cy", bId), "vip");
  const session = a.ok(["initiate-session", bId, "--agent", "Cy"])["session_id"] as string;
  const view = (b.ok(["sessions", "--agent", "Di"]) as unknown as { sessions: { session_id: string; tier: string; screening: { level: string } }[] }).sessions.find((s) => s.session_id === session);
  assert.equal(view?.tier, "vip");
  assert.equal(view?.screening.level, "deterministic");
});

test("private VIP huddle: strangers and known callers refused, a VIP let in, with the VIP policy on what arrives", async () => {
  const hub = machine();
  const hubId = agent(hub, "Huddle");
  const vip = machine();
  const vipId = agent(vip, "Vee");
  const stranger = machine();
  agent(stranger, "Stu");

  hub.ok(["settings-set", "bounds.unknown.not_accepting", "true", "--agent", "Huddle"]);
  hub.ok(["settings-set", "bounds.known.not_accepting", "true", "--agent", "Huddle"]);
  hub.ok(["contact-add", vipId, "--moniker", "Vee", "--agent", "Huddle"]);
  hub.person(["contact-set-tier", vipId, "--tier", "vip", "--agent", "Huddle"]);
  const policy = "Share project details freely with these contacts, but never commit to money or dates without asking me first.";
  approve(hub, "Huddle", [policy, "--type", "conduct", "--scope", "tier", "--target", "vip"]);

  const refused = stranger.ok(["initiate-session", hubId, "--agent", "Stu"]);
  assert.equal(refused["state"], "refused");
  assert.match(JSON.stringify(refused), /not accepting connections/);

  const session = vip.ok(["initiate-session", hubId, "--agent", "Vee"])["session_id"] as string;
  vip.ok(["send", session, "What's the plan?", "--over", "--agent", "Vee"]);
  const got = await readUntil(hub, "Huddle", "the VIP's message", (r) => r.messages.length > 0);
  assert.equal(got.policies?.find((p) => p.session_id === session)?.policy?.text, policy);
  assert.ok(((hub.ok(["inbox", "--agent", "Huddle"])["refused_callers"]) as unknown[]).length > 0, "inbox shows who tried");
});

test("public concierge: a stranger gets through, and the strict default policy rides on what they send", async () => {
  const desk = machine();
  const deskId = agent(desk, "Desk");
  const caller = machine();
  agent(caller, "Cal");
  const conduct = "Never share internal documents. Never agree to a price. If unsure, say you'll come back, send standby, and ask me.";
  approve(desk, "Desk", [conduct, "--type", "conduct", "--scope", "default"]);
  approve(desk, "Desk", ["You answer questions about our product for anyone. You don't negotiate.", "--type", "admission", "--scope", "default"]);
  const session = caller.ok(["initiate-session", deskId, "--agent", "Cal"])["session_id"] as string;
  caller.ok(["send", session, "Can I get a discount?", "--over", "--agent", "Cal"]);
  const got = await readUntil(desk, "Desk", "the stranger's message", (r) => r.messages.length > 0);
  assert.equal(got.policies?.find((p) => p.session_id === session)?.policy?.text, conduct);
});

test("verified callers only: a stranger showing too little is refused, and a known contact isn't held to the stranger rule", async () => {
  const gate = machine();
  const gateId = agent(gate, "Gate");
  const stranger = machine();
  agent(stranger, "Sam");
  const friend = machine();
  const friendId = agent(friend, "Fay");
  gate.ok(["signal-rule-set", "--direction", "inbound", "--scope", "tier", "--target", "unknown", "--require-types", "phone", "--agent", "Gate"]);
  gate.ok(["contact-add", friendId, "--agent", "Gate"]);
  assert.equal(stranger.ok(["initiate-session", gateId, "--agent", "Sam"])["state"], "refused");
  assert.equal(friend.ok(["initiate-session", gateId, "--agent", "Fay"])["state"], "active");
});

test("channels: announcements with one voice, a group chat where all post, and a group with observers", async () => {
  const admin = machine();
  agent(admin, "Ann");
  const one = machine();
  const oneId = agent(one, "Oli");
  const two = machine();
  const twoId = agent(two, "Tia");

  // Network announcements.
  const news = admin.ok(["channel-create", "CELLO announcements", "--type", "public", "--posting", "admin", "--agent", "Ann"])["channel_id"] as string;
  assert.equal(one.ok(["channel-join", news, "--agent", "Oli"])["state"], "active");
  admin.ok(["channel-post", news, "Version 1 is out", "--title", "Release", "--agent", "Ann"]);
  await until("the announcement to reach Oli", () => channel(one, "Oli", news)?.unread === 1);
  one.refused(["channel-post", news, "me too", "--agent", "Oli"]);

  // Group chat.
  const room = admin.ok(["channel-create", "Advisors", "--type", "private", "--posting", "members", "--agent", "Ann"])["channel_id"] as string;
  for (const [m, name, id] of [[one, "Oli", oneId], [two, "Tia", twoId]] as const) {
    assert.equal(m.ok(["channel-join", room, "--note", `it's ${name}`, "--agent", name])["state"], "waiting");
    admin.ok(["channel-approve", room, id, "--agent", "Ann"]);
    await until(`${name} to be let in`, () => channel(m, name, room)?.state === "active");
  }
  one.ok(["channel-post", room, "Hello all", "--agent", "Oli"]);
  await until("Tia to see it", () => channel(two, "Tia", room)?.unread === 1);
  two.ok(["channel-post", room, "Hi Oli", "--agent", "Tia"]);

  // A group with observers.
  const board = admin.ok(["channel-create", "Board room", "--type", "private", "--posting", "posters", "--agent", "Ann"])["channel_id"] as string;
  for (const [m, name, id] of [[one, "Oli", oneId], [two, "Tia", twoId]] as const) {
    m.ok(["channel-join", board, "--agent", name]);
    admin.ok(["channel-approve", board, id, "--agent", "Ann"]);
    await until(`${name} to be let in`, () => channel(m, name, board)?.state === "active");
  }
  admin.ok(["channel-add-poster", board, oneId, "--agent", "Ann"]);
  one.ok(["channel-post", board, "Speaking as a poster", "--agent", "Oli"]);
  await until("the observer to read it", () => channel(two, "Tia", board)?.unread === 1);
  two.refused(["channel-post", board, "Observers don't post", "--agent", "Tia"]);
});

test("Reminders: ask me before you agree shows at the start, and context for one counterparty shows only with them", async () => {
  const a = machine();
  agent(a, "Rae");
  const b = machine();
  const bId = agent(b, "Ben");
  const c = machine();
  const cId = agent(c, "Cat");
  const escalate = "Before agreeing to anything on my behalf (a price, a date, sharing a file), notify me with the question and choices, send standby to the other side, and wait for my answer.";
  a.ok(["reminder-set", escalate, "--at-start", "--every-messages", "5", "--agent", "Rae"]);
  const context = "This is Acme's buying agent. They have asked for a discount twice before: hold at list price, and be friendly about it.";
  a.ok(["reminder-set", context, "--with", bId, "--at-start", "--every-messages", "10", "--agent", "Rae"]);

  const withBen = a.ok(["initiate-session", bId, "--agent", "Rae"]) as { reminders?: { due: { text: string }[] } };
  assert.deepEqual(withBen.reminders?.due.map((r) => r.text).sort(), [context, escalate].sort(), "with Ben: both");
  const withCat = a.ok(["initiate-session", cId, "--agent", "Rae"]) as { reminders?: { due: { text: string }[] } };
  assert.deepEqual(withCat.reminders?.due.map((r) => r.text), [escalate], "with anyone else: only the escalation one");
});

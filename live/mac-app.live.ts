// The CELLO Mac app's own code against a real daemon's operator door, with nothing on screen. cello-door-probe runs the
// app's Controller, the part that reads frames, keeps the state, picks the banner and the menu-bar look, and turns a
// click into a pick or a reply. Banners are only described, never posted. Run it with:
//   CELLO_SERVER_DIR=<server> CELLO_ISSUER_DIR=<cello-issuer> MAC_FILES=live/mac-app.live.ts scripts/mac-notifier-test.sh
import { cliFor } from "./cli-path.ts";
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18975/v1";
const home = mkdtempSync(join(tmpdir(), "cello-mac-app-"));
const door = join(home, "operator.sock");

type Event = Record<string, unknown>;
interface Read { from_your_operator?: { replies: { text: string; session_id: string | null; via: string }[] }; messages?: unknown[] }

function cello(args: string[], caller?: string): { status: number | null; json: Record<string, unknown>; out: string } {
  const run = spawnSync(process.execPath, [cliFor(args), ...args], { encoding: "utf8", env: { ...process.env, CELLO_HOME: home, ...(caller ? { CELLO_CALLER: caller } : {}) } });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(run.stdout || run.stderr) as Record<string, unknown>;
  } catch {
    // Login and logout answer in words.
  }
  return { status: run.status, json, out: run.stdout + run.stderr };
}

function ok(args: string[], caller?: string): Record<string, unknown> {
  const run = cello(args, caller);
  assert.equal(run.status, 0, `cello ${args.join(" ")} failed: ${run.out}`);
  return run.json;
}

async function until<T>(what: string, check: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// notify from an agent's shell, without blocking this process: the probe lives here and has to ack while notify waits.
function notify(args: string[], agent: string): Promise<Record<string, unknown>> {
  const full = ["notify", ...args, "--agent", agent];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFor(full), ...full], { env: { ...process.env, CELLO_HOME: home, CELLO_CALLER: `${agent.toLowerCase()}-shell` } });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (status) => (status === 0 ? resolve(JSON.parse(out) as Record<string, unknown>) : reject(new Error(`cello ${full.join(" ")}: ${out}`))));
  });
}

const replies = (agent: string): [string, string | null, string][] =>
  ((ok(["receive", "--agent", agent], `${agent.toLowerCase()}-shell`) as Read).from_your_operator?.replies ?? []).map((r) => [r.text, r.session_id, r.via]);

class Probe {
  readonly events: Event[] = [];
  readonly #child: ChildProcessWithoutNullStreams;
  #wakes = new Set<() => void>();

  constructor(binary: string) {
    this.#child = spawn(binary, ["--socket", door]);
    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      this.events.push(JSON.parse(line) as Event);
      for (const wake of [...this.#wakes]) wake();
    });
    this.#child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  }

  do(command: Event): void {
    this.#child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  waitFor(what: string, match: (e: Event) => boolean, from = 0, timeoutMs = 15_000): Promise<Event> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const found = this.events.slice(from).find(match);
        if (!found) return false;
        clearTimeout(timer);
        this.#wakes.delete(wake);
        resolve(found);
        return true;
      };
      const wake = (): void => { check(); };
      const timer = setTimeout(() => {
        this.#wakes.delete(wake);
        reject(new Error(`timed out waiting for ${what}. Events: ${JSON.stringify(this.events.slice(from))}`));
      }, timeoutMs);
      this.#wakes.add(wake);
      check();
    });
  }

  // Runs a command and waits for its own answer.
  async run(command: Event): Promise<Event> {
    const from = this.events.length;
    this.do(command);
    return this.waitFor(`the answer to ${String(command["do"])}`, (e) => (e["event"] === "done" && e["do"] === command["do"]) || (command["do"] === "state" && e["event"] === "state"), from);
  }

  stop(): void {
    this.#child.stdin.end();
    this.#child.kill();
  }
}

let probe: Probe | undefined;
after(() => {
  probe?.stop();
  cello(["logout"]);
});

test("the Mac app's own code shows, answers and catches up against a real daemon, with nothing on screen", async () => {
  const built = spawnSync(join(import.meta.dirname, "..", "widgets", "mac", "scripts", "build-probe.sh"), [join(home, "probe")], { encoding: "utf8" });
  assert.equal(built.status, 0, `the probe didn't build: ${built.stderr}`);
  const binary = built.stdout.trim().split("\n").at(-1) as string;

  ok(["login", "--server", url]);
  const ann = ok(["create-agent", "Ann"]);
  ok(["create-agent", "Bea"]);
  const cy = ok(["create-agent", "Cy"]);
  for (const name of ["Ann", "Bea", "Cy"]) ok(["settings-set", "away.answering", "false", "--agent", name]);
  await until("the agents online", () => (ok(["status"]) as { agents: { online: boolean }[] }).agents.every((a) => a.online));
  const annId = ann["agent_id"] as string;
  const cyId = cy["agent_id"] as string;
  await until("the operator's door", () => existsSync(door));
  ok(["notifier-add", "mac", "--route-only", "--agent", "Ann"], "ann-shell");

  // 1. Two waited before the app opened: one banner says how many, with a sound because one is a question.
  assert.equal((await notify(["Lunch: pizza or salad?", "--kind", "request", "--choices", "Pizza|Salad"], "Ann"))["sent"], "queued");
  assert.equal((await notify(["The quote came in 8% lower."], "Ann"))["sent"], "queued");
  const app = new Probe(binary);
  probe = app;
  const summary = await app.waitFor("the one banner for what waited", (e) => e["effect"] === "summary");
  assert.equal(summary["title"], "1 question waited while you were away");
  assert.match(summary["body"] as string, /^Ann, (just now|1 minute ago)\. Ann, (just now|1 minute ago)\.$/);
  assert.equal(summary["sound"], true);
  assert.ok(!app.events.some((e) => e["effect"] === "banner"), "no banner each");
  let state = await app.run({ do: "state" });
  assert.deepEqual([state["connection"], state["look"]], ["connected", "waiting"]);
  assert.deepEqual((state["agents"] as { name: string }[]).map((a) => a.name), ["Ann"]);
  assert.equal((state["waiting"] as unknown[]).length, 2);

  // 2. A question about a conversation, with two choices: the banner carries both and Reply, and the app's ack makes
  // notify answer sent: true. The card says who Ann is talking to, as a name Cy chose.
  const session = (ok(["initiate-session", cyId, "--agent", "Ann"], "ann-shell") as { session_id: string }).session_id;
  ok(["send", session, "Hello Ann, Cy here.", "--over", "--agent", "Cy"], "cy-shell");
  await until("Cy's message", () => ((ok(["receive", "--agent", "Ann"], "ann-shell") as Read).messages?.length ?? 0) > 0);
  const from2 = app.events.length;
  const asked = await notify(["Cy wants Thursday. May I agree?", "--kind", "request", "--choices", "Agree|Disagree", "--session-id", session], "Ann");
  assert.equal(asked["sent"], true, JSON.stringify(asked));
  const two = (await app.waitFor("the two-choice banner", (e) => e["effect"] === "banner", from2))["plan"] as { item_id: number; title: string; buttons: string[]; sound: boolean };
  assert.deepEqual([two.title, two.buttons, two.sound], ["Ann needs your decision", ["Agree", "Disagree", "Reply…"], true]);
  state = await app.run({ do: "state" });
  const card = (state["waiting"] as { id: number; talking: string }[]).find((w) => w.id === two.item_id);
  assert.equal(card?.talking, "Talking to “Cy”, a name it gave itself, not checked");

  // 3. Three choices: one Choose, which opens the panel, and Reply.
  const from3 = app.events.length;
  await notify(["Which room?", "--kind", "request", "--choices", "A|B|C", "--session-id", session], "Ann");
  const three = (await app.waitFor("the three-choice banner", (e) => e["effect"] === "banner", from3))["plan"] as { item_id: number; buttons: string[] };
  assert.deepEqual(three.buttons, ["Choose…", "Reply…"]);

  // 4. A pick reaches Ann as her operator's answer, for that session. The card says so for a few seconds, then folds
  // into Earlier today.
  const picked = await app.run({ do: "pick", id: two.item_id, choice: 1 });
  assert.equal(picked["ok"], true, JSON.stringify(picked));
  assert.deepEqual(replies("Ann"), [["Disagree", session, "mac"]]);
  state = await app.run({ do: "state" });
  assert.deepEqual(state["just_answered"], ["You chose “Disagree”. Ann has it."]);
  assert.ok(!(state["earlier"] as string[]).some((l) => l.includes("Disagree")), "not in Earlier today while the card shows");
  await new Promise((resolve) => setTimeout(resolve, 4_500));
  state = await app.run({ do: "state" });
  assert.deepEqual(state["just_answered"], []);
  assert.ok((state["earlier"] as string[]).some((l) => l.startsWith("Ann · You chose “Disagree”")), JSON.stringify(state["earlier"]));
  const late = await app.run({ do: "pick", id: two.item_id, choice: 0 });
  assert.deepEqual([late["ok"], late["line"]], [false, "This was already answered or cleared."]);

  // 5. Typed under the three-choice question: it answers it, the banner is taken away, and Ann gets the words once.
  const fromTyped = app.events.length;
  const typed = await app.run({ do: "reply", id: three.item_id, text: "None of them, the café." });
  assert.equal(typed["ok"], true, JSON.stringify(typed));
  await app.waitFor("the room banner withdrawn", (e) => e["effect"] === "withdraw" && e["item_id"] === three.item_id, fromTyped);
  assert.deepEqual(replies("Ann"), [["None of them, the café.", session, "mac"]]);

  // 6. A new agent joins quietly, and can be written to from the panel.
  const fromJoin = app.events.length;
  ok(["notifier-add", "mac", "--same-as", "Ann", "--agent", "Bea"], "bea-shell");
  const joined = await app.waitFor("Bea joining", (e) => e["effect"] === "joined", fromJoin);
  assert.equal(joined["title"], "Bea can reach you here now");
  assert.equal(joined["body"], "Not you? Open CELLO › Settings to remove Bea.");
  const beaId = (await app.run({ do: "state" }))["agents"] as { agent_id: string; name: string }[];
  const bea = beaId.find((a) => a.name === "Bea")?.agent_id as string;
  const wrote = await app.run({ do: "message", agent: bea, text: "Bea, book the room for Friday." });
  assert.equal(wrote["ok"], true);
  assert.match(wrote["line"] as string, /^Passed to Bea\./);
  assert.deepEqual(replies("Bea"), [["Bea, book the room for Friday.", null, "mac"]]);

  // 7. Paused: the look says so, a question arrives silently with no banner, and the agent hears its operator is away.
  // Opening the panel is what tells the door it's been seen.
  assert.equal((await app.run({ do: "pause", seconds: 600 }))["ok"], true);
  const pausedAt = Date.now();
  state = await app.run({ do: "state" });
  // "paused" shows beside the mark for a few seconds, and hovering says until when.
  assert.deepEqual([state["look"], state["paused_word"]], ["paused", "paused"]);
  assert.match(state["tooltip"] as string, /^Paused until \d{4}-/);
  const fromPause = app.events.length;
  const away = await notify(["Coffee or tea?", "--kind", "request", "--choices", "Coffee|Tea"], "Ann");
  assert.equal(away["sent"], "queued");
  // Waiting before it: the lunch question and the quote, from step 1.
  await app.waitFor("the quiet question in the panel", (e) => e["event"] === "status" && e["waiting"] === 3, fromPause);
  assert.ok(!app.events.slice(fromPause).some((e) => e["effect"] === "banner" || e["effect"] === "summary"), "no banner while paused");
  state = await app.run({ do: "state" });
  const unseen = (state["waiting"] as { id: number; text: string }[]).find((w) => w.text === "Coffee or tea?");
  assert.ok(unseen && !(state["acked"] as number[]).includes(unseen.id), "not told the door it's seen before the panel opens");
  await app.run({ do: "panel" });
  state = await app.run({ do: "state" });
  const coffee = (state["waiting"] as { id: number; text: string }[]).find((w) => w.text === "Coffee or tea?");
  assert.ok(coffee && (state["acked"] as number[]).includes(coffee.id), "acked once the panel showed it");
  // Then only the faded mark, still saying until when on hover.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, pausedAt + 4_500 - Date.now())));
  state = await app.run({ do: "state" });
  assert.deepEqual([state["look"], state["paused_word"]], ["paused", null]);
  assert.match(state["tooltip"] as string, /^Paused until /);
  assert.equal((await app.run({ do: "resume" }))["ok"], true);
  state = await app.run({ do: "state" });
  assert.deepEqual([state["look"], state["tooltip"]], ["waiting", null]);

  // 8. CELLO stops: the app sees it, and asks to start it again (the probe only reports that). When it's back, what
  // still waits comes again, and nothing already shown is bannered twice.
  const fromStop = app.events.length;
  ok(["logout"]);
  await app.waitFor("the app to see CELLO stop", (e) => e["event"] === "status" && e["connection"] === "connecting", fromStop);
  await app.waitFor("the app asking to start CELLO", (e) => e["event"] === "needs_start", fromStop);
  ok(["login"]);
  await app.waitFor("the app back", (e) => e["event"] === "status" && e["connection"] === "connected", fromStop, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.ok(!app.events.slice(fromStop).some((e) => e["effect"] === "banner" || e["effect"] === "summary"), `nothing bannered twice: ${JSON.stringify(app.events.slice(fromStop))}`);
  state = await app.run({ do: "state" });
  assert.deepEqual((state["waiting"] as { text: string }[]).map((w) => w.text).sort(), ["Coffee or tea?", "Lunch: pizza or salad?", "The quote came in 8% lower."].sort());

  // 8b. The app itself restarts, a fresh process: the door says each one was shown, the banner acks and the panel's
  // ack both landed, so nothing is bannered again.
  app.stop();
  const relaunched = new Probe(binary);
  probe = relaunched;
  await relaunched.waitFor("the relaunched app connected", (e) => e["event"] === "status" && e["connection"] === "connected");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const again = await relaunched.run({ do: "state" });
  assert.deepEqual((again["waiting"] as { text: string; shown: boolean }[]).map((w) => [w.text, w.shown]).sort(), [["Coffee or tea?", true], ["Lunch: pizza or salad?", true], ["The quote came in 8% lower.", true]].sort());
  assert.ok(!relaunched.events.some((e) => e["effect"] === "banner" || e["effect"] === "summary"), `nothing bannered on relaunch: ${JSON.stringify(relaunched.events)}`);

  // 8c. Settings takes one agent off: Bea goes from the app and is told, and Ann keeps the Mac.
  const app2 = relaunched;
  const offBea = await app2.run({ do: "remove_agent", agent: bea });
  assert.equal(offBea["ok"], true, JSON.stringify(offBea));
  assert.deepEqual(((await app2.run({ do: "state" }))["agents"] as { name: string }[]).map((a) => a.name), ["Ann"]);
  assert.deepEqual((ok(["notifier-list", "--agent", "Bea"]) as { notifiers: unknown[] }).notifiers, []);
  assert.equal((ok(["notifier-list", "--agent", "Ann"]) as { notifiers: unknown[] }).notifiers.length, 1);
  const told = ok(["receive", "--agent", "Bea"], "bea-shell") as { notices?: { text: string }[] };
  assert.ok(told.notices?.some((n) => /took you off CELLO on their Mac/.test(n.text)), JSON.stringify(told.notices));

  // 9. Remove takes the Mac off every agent.
  assert.equal((await app2.run({ do: "remove" }))["ok"], true);
  for (const name of ["Ann", "Bea"]) assert.deepEqual((ok(["notifier-list", "--agent", name]) as { notifiers: unknown[] }).notifiers, []);
  assert.equal(annId.length, 64);
});

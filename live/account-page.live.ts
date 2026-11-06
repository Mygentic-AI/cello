// The account page through the real path: a separate daemon on a real server, the link from a real terminal, and the page
// read over real HTTP. It also tries, from outside, to change something through the page and to reach it by another name.
import { cliFor } from "./cli-path.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18700/v1";

type Json = Record<string, unknown>;

class Machine {
  readonly home = mkdtempSync(join(tmpdir(), "cello-page-"));
  run(args: string[], input?: string): { status: number | null; stderr: string; json: Json } {
    const run = spawnSync(process.execPath, [cliFor(args), ...args], { encoding: "utf8", input: input ?? "", maxBuffer: 64_000_000, env: { ...process.env, CELLO_HOME: this.home } });
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
after(() => {
  for (const m of started) m.run(["logout"]);
});

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, tries = 100): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A port nobody holds right now. Other workers test on this machine, so the default isn't assumed free.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function http(port: number, path: string, opts: { token?: string; host?: string; method?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` };
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const linkOf = (m: Machine): { port: number; token: string } => {
  const found = /http:\/\/127\.0\.0\.1:(\d+)\/#([0-9a-f]{64})/.exec(m.person(["account"]));
  assert.ok(found, "cello account printed no link");
  return { port: Number(found[1]), token: found[2] as string };
};

const read = async (link: { port: number; token: string }, what: string): Promise<Json> => {
  const res = await http(link.port, `/api/${what}`, { token: link.token });
  assert.equal(res.status, 200, `${what}: ${res.body}`);
  return (JSON.parse(res.body) as { result: Json }).result;
};

// Logs in with the page on a port this run owns. A daemon setting takes effect at the next login.
async function machineWithPage(port: number): Promise<Machine> {
  const m = new Machine();
  started.push(m);
  m.run(["login", "--server", url]);
  m.ok(["settings-set", "account_page_port", String(port)]);
  m.run(["logout"]);
  m.run(["login", "--server", url]);
  return m;
}

test("the page shows this machine's own agents, signals, contacts, settings and guards, and only to someone with the link", async () => {
  const port = await freePort();
  const m = await machineWithPage(port);
  const ann = m.ok(["create-agent", "Ann"])["agent_id"] as string;
  const bea = m.ok(["create-agent", "Bea"])["agent_id"] as string;
  m.ok(["contact-add", bea, "--agent", "Ann"]);

  // The link comes only from a person at a terminal, and a pipe gets a refusal that says why.
  m.refused(["account"], "person_required");
  const link = linkOf(m);
  assert.equal(link.port, port);

  const status = m.ok(["status"]) as { account_page?: { listening: boolean; port: number } };
  assert.deepEqual(status.account_page, { listening: true, port });

  const agents = ((await read(link, "agents")) as { agents: { name: string; agent_id: string }[] }).agents;
  assert.deepEqual(agents.map((a) => [a.name, a.agent_id]).sort(), [["Ann", ann], ["Bea", bea]].sort());

  const signals = ((await read(link, `signals_list?agent=${ann}`)) as { signals: { signal_hash: string; status: string }[] }).signals;
  assert.ok(signals.length > 0, "Ann holds the email signal she registered with, so the page should list it");

  const contacts = ((await read(link, `contacts?agent=${ann}`)) as { contacts: { contact_id: string }[] }).contacts;
  assert.ok(contacts.some((c) => c.contact_id === bea), "the contact added at the terminal should show");

  const settings = (await read(link, `settings?agent=${ann}`)) as { settings: { name: string; value: number }[] };
  assert.equal(settings.settings.find((s) => s.name === "account_page_port")?.value, port);
  assert.ok(Array.isArray(((await read(link, `config?agent=${ann}`)) as { guards: unknown[] }).guards));

  // The page itself is a file anyone on this machine may fetch. What it shows needs the link.
  assert.equal((await http(port, "/")).status, 200);
  assert.equal((await http(port, "/api/agents")).status, 401);
  assert.equal((await http(port, "/api/agents", { token: "0".repeat(64) })).status, 401);
  assert.equal((await http(port, "/api/agents", { token: link.token, host: "evil.example" })).status, 421);
  assert.equal((await http(port, "/api/agents", { token: link.token, host: `evil.example:${port}` })).status, 421);
});

const CHROME = process.env["CHROME"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// The page's own script only runs in a browser, so a mistake in it would pass every request above.
test("a real browser opens the link and the page shows the agents, a signal and the contact", { skip: existsSync(CHROME) ? false : `no Chrome at ${CHROME}. Set CHROME to a browser to run this` }, async () => {
  const m = await machineWithPage(await freePort());
  const ann = m.ok(["create-agent", "Ann"])["agent_id"] as string;
  const bea = m.ok(["create-agent", "Bea"])["agent_id"] as string;
  m.ok(["contact-add", bea, "--agent", "Ann"]);
  const link = linkOf(m);
  const signal = ((await read(link, `signals_list?agent=${ann}`)) as { signals: { signal_hash: string }[] }).signals[0]?.signal_hash as string;

  const profile = mkdtempSync(join(tmpdir(), "cello-page-chrome-"));
  const run = spawnSync(CHROME, ["--headless=new", "--disable-gpu", `--user-data-dir=${profile}`, "--virtual-time-budget=8000", "--dump-dom", `http://127.0.0.1:${link.port}/#${link.token}`], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, `Chrome failed: ${run.stderr.slice(-400)}`);
  const dom = run.stdout;
  assert.match(dom, /<h2>Agents<\/h2>/);
  for (const name of ["Ann", "Bea"]) assert.ok(dom.includes(`>${name}<`), `${name} isn't on the page`);
  assert.ok(dom.includes(ann), "Ann's id isn't on the page");
  assert.ok(dom.includes(signal), "Ann's signal isn't on the page");
  assert.ok(dom.includes(bea), "the contact isn't on the page");
  assert.match(dom, /<h2>Track record<\/h2><p>Coming soon: how much you use CELLO and who you reach\.<\/p>/);
  assert.match(dom, /<p id="problem"[^>]*hidden/, "the page is showing a problem");
  assert.ok(!dom.includes(link.token), "the secret is left in the page's address or text");
});

// Names are limited to letters, digits, underscores and dashes, so the text a stranger or an owner can put on the page
// is an away message and a text setting. Both go in as markup that would run script if the page ever treated it as markup.
test("hostile text on the page is shown as text and runs nothing", { skip: existsSync(CHROME) ? false : `no Chrome at ${CHROME}. Set CHROME to a browser to run this` }, async () => {
  const m = await machineWithPage(await freePort());
  const ann = m.ok(["create-agent", "Ann"])["agent_id"] as string;
  const bea = m.ok(["create-agent", "Bea"])["agent_id"] as string;
  m.ok(["contact-add", bea, "--agent", "Ann"]);
  const away = `<img src=x onerror="document.title='pwned-away'"><script>document.title='pwned-script'</script>`;
  const setting = `<svg onload="document.title='pwned-setting'"></svg><iframe srcdoc="<script>parent.document.title='pwned-frame'</script>"></iframe>`;
  m.ok(["contact-set-away", bea, away, "--agent", "Ann"]);
  m.ok(["settings-set", "concierge_address", setting]);
  m.run(["logout"]);
  m.run(["login", "--server", url]);
  const link = await until("the page to come back", () => {
    try {
      return linkOf(m);
    } catch {
      return undefined;
    }
  });

  const profile = mkdtempSync(join(tmpdir(), "cello-page-chrome-"));
  const run = spawnSync(CHROME, ["--headless=new", "--disable-gpu", `--user-data-dir=${profile}`, "--virtual-time-budget=8000", "--dump-dom", `http://127.0.0.1:${link.port}/#${link.token}`], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, `Chrome failed: ${run.stderr.slice(-400)}`);
  const dom = run.stdout;
  // It reached the page, so the checks below aren't passing on an empty one.
  assert.ok(dom.includes(ann), "Ann isn't on the page");
  assert.ok(dom.includes("&lt;img src=x onerror="), "the away message isn't on the page as text");
  assert.ok(dom.includes("&lt;svg onload="), "the setting isn't on the page as text");
  // Nothing became an element, and no handler ran.
  assert.ok(!/<(img|svg|script|iframe)[\s>]/.test(dom.replace(/<script src="\/page\.js"><\/script>/, "")), "text became an element");
  assert.match(dom, /<title>CELLO<\/title>/, "script ran and changed the page");
});

test("nothing changes through the page, not even with the link", async () => {
  const m = await machineWithPage(await freePort());
  const ann = m.ok(["create-agent", "Ann"])["agent_id"] as string;
  const bea = m.ok(["create-agent", "Bea"])["agent_id"] as string;
  const link = linkOf(m);
  const before = JSON.stringify(m.ok(["contacts", "--agent", "Ann"]));

  for (const [method, path] of [
    ["POST", `/api/contact_add?agent=${ann}&contact=${bea}`],
    ["GET", `/api/contact_add?agent=${ann}&contact=${bea}`],
    ["GET", `/api/contact_set_tier?agent=${ann}&contact=${bea}&tier=vip`],
    ["GET", `/api/config_set?agent=${ann}&key=screening.level&value=off&person_confirmed=true`],
    ["GET", `/api/screening?agent=${ann}&level=off&person_confirmed=true`],
    ["GET", `/api/issuer_trust?agent=${ann}&hash=00000000&person_confirmed=true`],
    ["GET", `/api/remove_agent?agent=${ann}&person_confirmed=true`],
    ["GET", "/api/account?person_confirmed=true"],
  ] as const) {
    const res = await http(link.port, path, { token: link.token, method });
    assert.ok(res.status === 404 || res.status === 405, `${method} ${path} answered ${res.status}`);
  }
  assert.equal(JSON.stringify(m.ok(["contacts", "--agent", "Ann"])), before, "a contact changed");
  assert.equal(((await read(link, "agents")) as { agents: unknown[] }).agents.length, 2, "an agent was removed");
});

test("the link stays the same across a login, and a port someone else holds costs the page and nothing else", async () => {
  const port = await freePort();
  const m = await machineWithPage(port);
  m.ok(["create-agent", "Ann"]);
  const first = linkOf(m);

  m.run(["logout"]);
  m.run(["login", "--server", url]);
  const second = await until("the page to come back", () => {
    try {
      return linkOf(m);
    } catch {
      return undefined;
    }
  });
  assert.deepEqual(second, first, "the same link should still work after a login");

  const holder = createServer();
  const taken = await new Promise<number>((resolve) => holder.listen(0, "127.0.0.1", () => resolve((holder.address() as { port: number }).port)));
  try {
    m.ok(["settings-set", "account_page_port", String(taken)]);
    m.run(["logout"]);
    m.run(["login", "--server", url]);
    const status = await until("status to say why", () => {
      const s = m.run(["status"]);
      return s.status === 0 && (s.json["account_page"] as { listening?: boolean } | undefined)?.listening === false ? s.json : undefined;
    });
    assert.match(String((status["account_page"] as { problem: string }).problem), new RegExp(`port ${taken}`));
    assert.equal(((m.ok(["agents"]) as { agents: unknown[] }).agents).length, 1, "the daemon should carry on without the page");
    m.refused(["account"], "person_required");
    assert.match(m.person(["account"]), /account_page_unavailable|isn't running/);
  } finally {
    holder.close();
  }
});

// A Desktop chat on a remote connection lives in a 'hermes serve' backend, apart from the gateway that holds the agent.
// Two real processes with the real plugin in a real Hermes: the backend binds the session its chat opened, and the
// gateway hands that chat its reply. The desktop's table of live chats is the one stand-in, a function that records.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const checkout = process.env["HERMES_CHECKOUT"] ?? join(process.env["HOME"] as string, ".hermes", "hermes-agent");
const python = process.env["HERMES_PYTHON"] ?? join(checkout, "venv", "bin", "python3");
const driver = new URL("./hermes-handoff-driver.py", import.meta.url).pathname;
const plugin = new URL("../hermes/plugin/", import.meta.url).pathname;
const CHAT = "20261109_165416_46dc25";
const SESSION = "0123456789abcdef0123456789abcdef";

const launch = (mode: string): string[] => ["-I", "-c", `import sys, runpy; sys.path.insert(0, ${JSON.stringify(checkout)}); sys.argv = [${JSON.stringify(driver)}, ${JSON.stringify(mode)}]; runpy.run_path(${JSON.stringify(driver)}, run_name="__main__")`];

test("a reply reaches the Desktop chat that opened the session, through the backend that holds it", { skip: existsSync(python) ? false : `no Hermes python at ${python}: set HERMES_PYTHON` }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cello-ho-")));
  mkdirSync(join(home, "plugins", "cello"), { recursive: true });
  for (const file of ["plugin.yaml", "__init__.py"]) copyFileSync(join(plugin, file), join(home, "plugins", "cello", file));
  writeFileSync(join(home, "config.yaml"), "plugins:\n  enabled:\n    - cello\n  entries:\n    cello:\n      allow_gateway_injection: true\n");
  writeFileSync(join(home, ".env"), "CELLO_AGENT_NAME=Desk\n");
  const env = { ...process.env, HERMES_HOME: home, CELLO_AGENT_NAME: "Desk" };

  const client = spawn(python, launch("client"), { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  client.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  client.stderr.on("data", (d: Buffer) => { err += d.toString(); });
  try {
    for (let i = 0; i < 300 && !out.includes("\"ready\""); i++) {
      if (client.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(out, /"ready"/, `the backend didn't start: ${err}`);
    const bindings = JSON.parse(readFileSync(join(home, "cello", "session-bindings.json"), "utf8")) as Record<string, string>;
    assert.equal(bindings[SESSION], CHAT, "the session is bound to the chat that opened it");

    const gateway = spawnSync(python, launch("gateway"), { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(gateway.status, 0, gateway.stderr);
    const result = JSON.parse(gateway.stdout.trim().split("\n").at(-1) as string) as Record<string, unknown>;
    assert.deepEqual(result, { landing: CHAT, fallback: [], refused: false }, "the reply went to the Desktop chat, not the agent's own");
    assert.match(gateway.stderr, /chat_not_live_here/, "a refusal is logged with its reason");
    assert.equal(existsSync(join(home, "cello", "clients", "4000000000.sock")), false, "a dead backend's socket is cleared");

    // spawnSync held this loop, so the backend's lines are read now.
    for (let i = 0; i < 50 && !out.includes("content"); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const queued = out.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => "content" in line);
    assert.deepEqual(queued[0], { session_key: CHAT, content: `[CELLO] a reply on session ${SESSION}` });
  } finally {
    client.kill();
  }
});

// What a forgotten flag or a failed step does to an install. A live run wouldn't show these, because the public path needs the model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type BridgeOptions, type Exec, installBridge } from "../src/hermes-bridge.ts";

function recorder(failOn?: string): { calls: string[][]; exec: Exec } {
  const calls: string[][] = [];
  return {
    calls,
    exec: (_command, args) => {
      calls.push(args);
      if (failOn && args[0] === failOn && args[1] !== "list") return Promise.resolve({ code: 1, stdout: "", stderr: "no" });
      return Promise.resolve({ code: 0, stdout: args[1] === "list" ? "cello" : "", stderr: "" });
    },
  };
}

const options = (hermesHome: string, exec: Exec, more: Partial<BridgeOptions> = {}): BridgeOptions => ({
  agent: "Desk", hermesHome, public: false, allowInitiate: false, notPublic: false, modelReady: () => Promise.resolve(true), exec, ...more,
});
const toolsOf = (calls: string[][]): string | undefined => calls.find((c) => c[0] === "mcp" && c[1] === "add")?.find((a) => a.startsWith("CELLO_TOOLS="));

test("a private agent gets the plugin's shared skills, and a public one has them taken away", async () => {
  const home = mkdtempSync(join(tmpdir(), "cello-bt-"));
  const shared = ["cello-reach", "cello-channels", "cello-signals", "cello-operator"];
  assert.equal((await installBridge(options(home, recorder().exec))).ok, true);
  for (const skill of shared) {
    const copied = readFileSync(join(home, "skills", skill, "SKILL.md"), "utf8");
    assert.equal(copied, readFileSync(new URL(`../plugins/cello/skills/${skill}/SKILL.md`, import.meta.url), "utf8"), `${skill} is the plugin's own copy`);
  }
  assert.ok(existsSync(join(home, "skills", "cello-bridge-setup", "SKILL.md")));
  assert.equal(existsSync(join(home, "skills", "cello-receptionist")), false, "the bridge wakes Hermes, so no receptionist");

  assert.equal((await installBridge(options(home, recorder().exec, { public: true }))).ok, true);
  for (const skill of shared) assert.equal(existsSync(join(home, "skills", skill)), false, `a public agent has no ${skill}`);
  assert.ok(existsSync(join(home, "skills", "cello-bridge-setup", "SKILL.md")), "but keeps its own setup skill");
});

test("a public agent stays public when the installer runs again without the flag", async () => {
  const home = mkdtempSync(join(tmpdir(), "cello-bt-"));
  assert.equal((await installBridge(options(home, recorder().exec, { public: true, allowInitiate: true }))).ok, true);

  const again = recorder();
  assert.equal((await installBridge(options(home, again.exec))).ok, true);
  const env = readFileSync(join(home, ".env"), "utf8");
  assert.match(env, /CELLO_SESSION_SCOPE=peer/);
  assert.match(env, /CELLO_PUBLIC=1/);
  assert.match(toolsOf(again.calls) ?? "", /cello_initiate_session/);
  assert.doesNotMatch(toolsOf(again.calls) ?? "", /cello_create_agent/);

  const refused = await installBridge(options(home, recorder().exec, { sessionScope: "agent" }));
  assert.equal(refused.ok, false, "a public agent can't be put on one shared conversation");

  const noModel = await installBridge(options(home, recorder().exec, { modelReady: () => Promise.resolve(false) }));
  assert.equal(noModel.ok, false, "a re-run still needs the model");

  const ended = recorder();
  assert.equal((await installBridge(options(home, ended.exec, { notPublic: true }))).ok, true);
  assert.equal(toolsOf(ended.calls), undefined);
  const after = readFileSync(join(home, ".env"), "utf8");
  assert.match(after, /CELLO_SESSION_SCOPE=agent/);
  assert.doesNotMatch(after, /CELLO_PUBLIC|CELLO_TOOLS|CELLO_ALLOW_INITIATE/);
});

const landingIn = (home: string): unknown => JSON.parse(readFileSync(join(home, "cello", "landing-session.json"), "utf8")).session_id;

test("a public agent stays public after Hermes on Windows rewrites .env with CRLF line endings", async () => {
  const home = mkdtempSync(join(tmpdir(), "cello-bt-"));
  assert.equal((await installBridge(options(home, recorder().exec, { public: true, allowInitiate: true }))).ok, true);
  const envPath = join(home, ".env");
  writeFileSync(envPath, readFileSync(envPath, "utf8").replace(/\n/g, "\r\n"));
  const again = recorder();
  assert.equal((await installBridge(options(home, again.exec))).ok, true);
  assert.match(readFileSync(envPath, "utf8"), /CELLO_PUBLIC=1/);
  assert.doesNotMatch(toolsOf(again.calls) ?? "", /cello_create_agent/, "strangers don't get the full tool set");
});

test("an agent shell with CELLO_CALLER set can install and update its own bridge through the CLI", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const home = mkdtempSync(join(tmpdir(), "cello-bt-"));
  const bin = mkdtempSync(join(tmpdir(), "cello-bin-"));
  const log = join(bin, "calls.log");
  const shim = join(bin, "hermes");
  writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = "mcp" ] && [ "$2" = "list" ]; then echo "cello"; fi\n`);
  chmodSync(shim, 0o755);

  const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, CELLO_CALLER: "hermes", HERMES_SESSION_ID: "local-1e631a4ad46ac395c5d7ddedecc8378adcd37e5e40f8b6647b59dab8c098fdb9" };
  const installed = spawnSync(process.execPath, [cli, "bridge", "hermes", "--agent", "Desk", "--hermes-home", home], { encoding: "utf8", env });
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(existsSync(join(home, "plugins", "cello", "__init__.py")));
  assert.match(readFileSync(join(home, ".env"), "utf8"), /CELLO_AGENT_NAME=Desk/);
  const calls = readFileSync(log, "utf8");
  assert.match(calls, /mcp add cello/);
  assert.match(calls, /plugins enable cello/);

  const moved = spawnSync(process.execPath, [cli, "bridge", "hermes", "--agent", "Desk", "--hermes-home", home, "--landing-session", "current"], { encoding: "utf8", env });
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(landingIn(home), "local-1e631a4ad46ac395c5d7ddedecc8378adcd37e5e40f8b6647b59dab8c098fdb9");

  const reset = spawnSync(process.execPath, [cli, "bridge", "hermes", "--agent", "Desk", "--hermes-home", home, "--landing-session", "default"], { encoding: "utf8", env });
  assert.equal(reset.status, 0, reset.stderr);
  assert.equal(existsSync(join(home, "cello", "landing-session.json")), false);
});

test("an install takes current and default too, and refuses a landing session under peer scope", async () => {
  const home = mkdtempSync(join(tmpdir(), "cello-bt-"));
  assert.equal((await installBridge(options(home, recorder().exec, { landingSession: "20261107_075030_72e2f2e2" }))).ok, true);
  assert.equal(landingIn(home), "20261107_075030_72e2f2e2");
  assert.equal((await installBridge(options(home, recorder().exec, { landingSession: "default" }))).ok, true);
  assert.equal(existsSync(join(home, "cello", "landing-session.json")), false);
  assert.doesNotMatch(readFileSync(join(home, ".env"), "utf8"), /CELLO_LANDING_SESSION/);
  assert.equal((await installBridge(options(home, recorder().exec, { sessionScope: "peer", landingSession: "20261107_075030_72e2f2e2" }))).ok, false);
});

test("the plugin isn't enabled unless the tools it needs were added", async () => {
  const home = mkdtempSync(join(tmpdir(), "cello-bt-"));
  const failing = recorder("mcp");
  assert.equal((await installBridge(options(home, failing.exec))).ok, false);
  assert.equal(failing.calls.some((c) => c[0] === "plugins"), false);
});

const injectionOf = (calls: string[][]): string | undefined => calls.find((c) => c[0] === "config" && c[2] === "plugins.entries.cello.allow_gateway_injection")?.[3];

test("agent scope lets the plugin start a turn in a Desktop chat, and peer scope takes that back", async () => {
  const home = mkdtempSync(join(tmpdir(), "cello-bt-"));
  const agentScope = recorder();
  assert.equal((await installBridge(options(home, agentScope.exec))).ok, true);
  assert.equal(injectionOf(agentScope.calls), "true");
  const peerScope = recorder();
  assert.equal((await installBridge(options(home, peerScope.exec, { sessionScope: "peer" }))).ok, true);
  assert.equal(injectionOf(peerScope.calls), "false");
});

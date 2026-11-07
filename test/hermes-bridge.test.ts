// What a forgotten flag or a failed step does to an install. A live run wouldn't show these, because the public path needs the model.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type BridgeOptions, type Exec, installBridge, setLanding } from "../src/hermes-bridge.ts";

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

test("a public agent stays public when the installer runs again without the flag", async () => {
  const home = mkdtempSync(join(tmpdir(), "cv2-bt-"));
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

test("an agent moves its own notifications to the session it's in, and back, and nothing else", async () => {
  const home = mkdtempSync(join(tmpdir(), "cv2-bt-"));
  assert.equal(setLanding({ agent: "Desk", hermesHome: home, landingSession: "current" }).ok, false, "no bridge yet");
  assert.equal((await installBridge(options(home, recorder().exec))).ok, true);
  const before = readFileSync(join(home, ".env"), "utf8");

  const saved = process.env["HERMES_SESSION_ID"];
  try {
    delete process.env["HERMES_SESSION_ID"];
    assert.equal(setLanding({ agent: "Desk", hermesHome: home, landingSession: "current" }).ok, false, "current outside a Hermes session");
    process.env["HERMES_SESSION_ID"] = "local-1e631a4ad46ac395c5d7ddedecc8378adcd37e5e40f8b6647b59dab8c098fdb9";
    assert.equal(setLanding({ agent: "Desk", hermesHome: home, landingSession: "current" }).ok, true);
    assert.equal(landingIn(home), "local-1e631a4ad46ac395c5d7ddedecc8378adcd37e5e40f8b6647b59dab8c098fdb9");
  } finally {
    if (saved === undefined) delete process.env["HERMES_SESSION_ID"];
    else process.env["HERMES_SESSION_ID"] = saved;
  }
  assert.equal(readFileSync(join(home, ".env"), "utf8"), before, "only the landing file changes");

  assert.equal(setLanding({ agent: "Other", hermesHome: home, landingSession: "20261107_075030_72e2f2e2" }).ok, false, "never another profile's agent");
  assert.equal(setLanding({ agent: "Desk", hermesHome: home, landingSession: "no spaces allowed" }).ok, false);

  assert.equal(setLanding({ agent: "Desk", hermesHome: home, landingSession: "default" }).ok, true);
  assert.equal(landingIn(home), null, "default is written as null, so an older CELLO_LANDING_SESSION can't take over");
});

test("an install takes current and default too, and refuses a landing session under peer scope", async () => {
  const home = mkdtempSync(join(tmpdir(), "cv2-bt-"));
  assert.equal((await installBridge(options(home, recorder().exec, { landingSession: "20261107_075030_72e2f2e2" }))).ok, true);
  assert.equal(landingIn(home), "20261107_075030_72e2f2e2");
  assert.equal((await installBridge(options(home, recorder().exec, { landingSession: "default" }))).ok, true);
  assert.equal(existsSync(join(home, "cello", "landing-session.json")), false);
  assert.doesNotMatch(readFileSync(join(home, ".env"), "utf8"), /CELLO_LANDING_SESSION/);
  assert.equal((await installBridge(options(home, recorder().exec, { sessionScope: "peer", landingSession: "20261107_075030_72e2f2e2" }))).ok, false);
});

test("the plugin isn't enabled unless the tools it needs were added", async () => {
  const home = mkdtempSync(join(tmpdir(), "cv2-bt-"));
  const failing = recorder("mcp");
  assert.equal((await installBridge(options(home, failing.exec))).ok, false);
  assert.equal(failing.calls.some((c) => c[0] === "plugins"), false);
});

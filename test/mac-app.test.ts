// notifier-add mac puts the CELLO app on the Mac. Everything happens in a temporary home, and opening the app is only
// recorded: a test must never show anything on the screen of the Mac it runs on.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DaemonRefused } from "../src/ipc/client.ts";
import { type MacAppEnv, type Ran, addNotifier, appPath, launchFile, prebuiltPath } from "../src/mac-app.ts";

function fakeApp(at: string, binary = "binary-1", id = "ai.mygentic.cello"): void {
  mkdirSync(join(at, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(at, "Contents", "MacOS", "CELLO"), binary);
  writeFileSync(join(at, "Contents", "Info.plist"), `<plist><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`);
}

interface World { env: MacAppEnv; ran: string[][]; said: string[]; home: string; root: string; calls: Record<string, unknown>[] }

function world(opts: { prebuilt?: boolean; xcrun?: number; platform?: NodeJS.Platform } = {}): World {
  const home = mkdtempSync(join(tmpdir(), "cello-mac-home-"));
  const root = mkdtempSync(join(tmpdir(), "cello-mac-pkg-"));
  if (opts.prebuilt !== false) fakeApp(prebuiltPath(root));
  const ran: string[][] = [];
  const said: string[] = [];
  const run = (command: string, args: string[]): Ran => {
    ran.push([command, ...args]);
    if (command === "ditto") {
      cpSync(args[0] as string, args[1] as string, { recursive: true });
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "xcrun") return { status: opts.xcrun ?? 0, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const env: MacAppEnv = { home, celloHome: join(home, ".cello-test"), packageRoot: root, node: "/opt/node/bin/node", cli: join(root, "dist", "cli.js"), platform: opts.platform ?? "darwin", run, say: (line) => said.push(line) };
  return { env, ran, said, home, root, calls: [] };
}

function daemon(w: World, answer: Record<string, unknown> = { added: true, type: "mac", app: "not open" }): (fields: Record<string, unknown>) => Promise<unknown> {
  return (fields) => {
    w.calls.push(fields);
    return Promise.resolve(answer);
  };
}

const opened = (w: World): string[][] => w.ran.filter((r) => r[0] === "open");

test("notifier-add mac says each step and how to undo it, copies CELLO, notes where cello is, saves the route, then opens it", async () => {
  const w = world();
  const answer = await addNotifier({ type: "mac", agent: "Ann", caller: "cli" }, daemon(w), () => w.env) as Record<string, unknown>;
  assert.equal(answer["added"], true, "the daemon's own answer comes back");
  const install = answer["app_install"] as { copied: boolean; opened: boolean; app: string; steps: string[] };
  assert.deepEqual([install.copied, install.opened, install.app], [true, true, appPath(w.home)]);
  assert.ok(existsSync(join(appPath(w.home), "Contents", "MacOS", "CELLO")));
  assert.deepEqual(JSON.parse(readFileSync(launchFile(w.home), "utf8")), { cello_home: join(w.home, ".cello-test"), start: ["/opt/node/bin/node", join(w.root, "dist", "cli.js"), "login"] });
  // Every step is said before it's done, each with its undo, and what was said comes back for a tool.
  assert.equal(w.said[0], "CELLO will:");
  for (const n of [1, 2, 3, 4]) assert.match(w.said[n] ?? "", new RegExp(`^${n}\\. .*To undo: `));
  assert.ok(w.said.some((l) => l.includes("cello notifier-remove mac")));
  assert.deepEqual(install.steps, w.said);
  assert.equal(w.said.at(-1), "Opening CELLO…");
  // The route is saved before the app opens, and the install's own options never reach the daemon.
  assert.deepEqual(w.calls, [{ type: "mac", agent: "Ann", caller: "cli" }]);
  assert.deepEqual(opened(w), [["open", appPath(w.home)]]);
});

test("the same app already in Applications is left alone and not opened again; a different one replaces it", async () => {
  const w = world();
  await addNotifier({ type: "mac", agent: "Ann" }, daemon(w), () => w.env);
  w.ran.length = 0;
  const again = await addNotifier({ type: "mac", agent: "Ann" }, daemon(w), () => w.env) as { app_install: { copied: boolean; opened: boolean } };
  assert.deepEqual([again.app_install.copied, again.app_install.opened], [false, false]);
  assert.deepEqual(w.ran, [], "nothing copied, nothing opened");
  fakeApp(prebuiltPath(w.root), "binary-2");
  const newer = await addNotifier({ type: "mac", agent: "Ann" }, daemon(w), () => w.env) as { app_install: { copied: boolean } };
  assert.equal(newer.app_install.copied, true);
  assert.equal(readFileSync(join(appPath(w.home), "Contents", "MacOS", "CELLO"), "utf8"), "binary-2");
});

test("a further agent with same_as, or route_only, only saves the route", async () => {
  for (const params of [{ type: "mac", same_as: "Ann", agent: "Bea" }, { type: "mac", route_only: true, agent: "Bea" }]) {
    const w = world();
    const answer = await addNotifier(params, daemon(w), () => w.env) as Record<string, unknown>;
    assert.equal(answer["app_install"], undefined);
    assert.deepEqual([w.ran, w.said], [[], []]);
    assert.equal(existsSync(appPath(w.home)), false);
    assert.equal(w.calls[0]?.["route_only"], undefined, "route_only isn't the daemon's");
  }
});

test("route_only with build or app is a contradiction, refused before anything happens", async () => {
  const w = world();
  await assert.rejects(addNotifier({ type: "mac", route_only: true, build: true }, daemon(w), () => w.env), (err: unknown) => err instanceof DaemonRefused && err.code === "bad_argument");
  assert.deepEqual([w.calls, w.ran], [[], []]);
});

test("with no prebuilt app, or an app that isn't CELLO, it stops by name and saves nothing", async () => {
  const missing = world({ prebuilt: false });
  await assert.rejects(addNotifier({ type: "mac", agent: "Ann" }, daemon(missing), () => missing.env), (err: unknown) => err instanceof DaemonRefused && err.code === "mac_app_missing" && /--build.*--app/.test(err.message));
  assert.deepEqual(missing.calls, [], "the route isn't saved without the app");
  assert.equal(existsSync(launchFile(missing.home)), false);
  const other = world();
  const stranger = join(other.root, "Other.app");
  fakeApp(stranger, "x", "com.example.other");
  await assert.rejects(addNotifier({ type: "mac", app: stranger }, daemon(other), () => other.env), /isn't the CELLO app/);
  assert.deepEqual(opened(other), []);
});

test("a copy that fails leaves the CELLO that was there, whole", async () => {
  const w = world();
  await addNotifier({ type: "mac", agent: "Ann" }, daemon(w), () => w.env);
  fakeApp(prebuiltPath(w.root), "binary-2");
  const failing: MacAppEnv = { ...w.env, run: (command, args) => (command === "ditto" ? { status: 1, stdout: "", stderr: "No space left on device" } : w.env.run(command, args)) };
  await assert.rejects(addNotifier({ type: "mac", agent: "Ann" }, daemon(w), () => failing), (err: unknown) => err instanceof DaemonRefused && err.code === "mac_app_copy_failed" && err.message.includes("No space left"));
  assert.equal(readFileSync(join(appPath(w.home), "Contents", "MacOS", "CELLO"), "utf8"), "binary-1", "the old app is still there");
  assert.deepEqual(readdirSync(join(w.home, "Applications")), ["CELLO.app"], "nothing half-copied left beside it");
});

test("--app takes one the person built", async () => {
  const w = world({ prebuilt: false });
  const theirs = join(w.root, "mine", "CELLO.app");
  fakeApp(theirs, "hand-built");
  await addNotifier({ type: "mac", app: theirs, agent: "Ann" }, daemon(w), () => w.env);
  assert.equal(readFileSync(join(appPath(w.home), "Contents", "MacOS", "CELLO"), "utf8"), "hand-built");
});

test("--build without the Xcode command-line tools says to run xcode-select --install", async () => {
  const w = world({ xcrun: 1 });
  mkdirSync(join(w.root, "widgets", "mac", "scripts"), { recursive: true });
  writeFileSync(join(w.root, "widgets", "mac", "scripts", "assemble.sh"), "#!/bin/sh\nexit 0\n");
  await assert.rejects(addNotifier({ type: "mac", build: true, agent: "Ann" }, daemon(w), () => w.env), (err: unknown) => err instanceof DaemonRefused && err.code === "xcode_tools_missing" && err.message.includes("xcode-select --install"));
  assert.ok(!w.ran.some((r) => r[0]?.endsWith("assemble.sh")), "nothing was built");
});

test("--build in an install without the app's source says where to build it", async () => {
  const w = world();
  await assert.rejects(addNotifier({ type: "mac", build: true }, daemon(w), () => w.env), (err: unknown) => err instanceof DaemonRefused && err.code === "mac_app_source_missing");
});

test("off a Mac it's refused, and when the daemon refuses the route the app isn't opened", async () => {
  const linux = world({ platform: "linux" });
  await assert.rejects(addNotifier({ type: "mac" }, daemon(linux), () => linux.env), (err: unknown) => err instanceof DaemonRefused && err.code === "not_supported");
  const w = world();
  const refusing = (): Promise<unknown> => Promise.reject(new DaemonRefused("notifier_exists", "Ann already has one."));
  // The refusal says what did change: the app is in Applications, and launch.json was written.
  await assert.rejects(addNotifier({ type: "mac", agent: "Ann" }, refusing, () => w.env), (err: unknown) => err instanceof DaemonRefused && err.code === "notifier_exists"
    && err.message.startsWith("Ann already has one.") && err.message.includes(`CELLO is in ${appPath(w.home)} now`) && err.message.includes(launchFile(w.home)));
  assert.deepEqual(opened(w), []);
  // A refusal that a person confirms and retries is passed on untouched.
  const person = (): Promise<unknown> => Promise.reject(new DaemonRefused("person_required", "Adding a notifier takes a person. Nothing changed."));
  await assert.rejects(addNotifier({ type: "mac", agent: "Ann" }, person, () => w.env), (err: unknown) => err instanceof DaemonRefused && err.message === "Adding a notifier takes a person. Nothing changed.");
});

test("telegram passes straight through", async () => {
  const w = world();
  await addNotifier({ type: "telegram", bot_token: "t" }, daemon(w), () => w.env);
  assert.deepEqual([w.calls, w.ran, w.said], [[{ type: "telegram", bot_token: "t" }], [], []]);
});

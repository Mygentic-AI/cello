// notifier-add mac puts the CELLO app on the Mac. Everything happens in a temporary home, and opening the app is only
// recorded: a test must never show anything on the screen of the Mac it runs on.
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DaemonRefused } from "../src/ipc/client.ts";
import { MAC_APP_PACKAGE, type MacAppEnv, type Ran, addNotifier, appPath, findPackagedApp, launchFile } from "../src/mac-app.ts";

// Where the fake mac-app package holds its app.
const packaged = (root: string): string => join(root, "mac-app", "CELLO.app");

function fakeApp(at: string, binary = "binary-1", id = "com.celloprotocol.cello"): void {
  mkdirSync(join(at, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(at, "Contents", "MacOS", "CELLO"), binary, { mode: 0o755 });
  writeFileSync(join(at, "Contents", "Info.plist"), `<plist><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`);
}

interface World { env: MacAppEnv; ran: string[][]; said: string[]; home: string; root: string; calls: Record<string, unknown>[] }

// prebuilt: "installed" (the default) has the package and its app, "empty" the package without an app, "absent" no package.
function world(opts: { prebuilt?: "installed" | "empty" | "absent"; xcrun?: number; platform?: NodeJS.Platform } = {}): World {
  const home = mkdtempSync(join(tmpdir(), "cello-mac-home-"));
  const root = mkdtempSync(join(tmpdir(), "cello-mac-pkg-"));
  const prebuilt = opts.prebuilt ?? "installed";
  if (prebuilt === "installed") fakeApp(packaged(root));
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
  const env: MacAppEnv = { home, celloHome: join(home, ".cello-test"), packageRoot: root, node: "/opt/node/bin/node", cli: join(root, "dist", "cli.js"), platform: opts.platform ?? "darwin", packagedApp: () => (prebuilt === "absent" ? undefined : packaged(root)), run, say: (line) => said.push(line) };
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
  fakeApp(packaged(w.root), "binary-2");
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
  for (const prebuilt of ["absent", "empty"] as const) {
    const missing = world({ prebuilt });
    await assert.rejects(addNotifier({ type: "mac", agent: "Ann" }, daemon(missing), () => missing.env), (err: unknown) => err instanceof DaemonRefused && err.code === "mac_app_missing"
      && err.message.includes(MAC_APP_PACKAGE) && /--build.*--app/.test(err.message) && err.message.includes(prebuilt === "absent" ? "isn't installed" : "holds no CELLO app"));
    assert.deepEqual(missing.calls, [], "the route isn't saved without the app");
    assert.equal(existsSync(launchFile(missing.home)), false);
    assert.equal(existsSync(appPath(missing.home)), false);
  }
  const other = world();
  const stranger = join(other.root, "Other.app");
  fakeApp(stranger, "x", "com.example.other");
  await assert.rejects(addNotifier({ type: "mac", app: stranger }, daemon(other), () => other.env), /isn't the CELLO app/);
  assert.deepEqual(opened(other), []);
  // Signed and whole, but packed without its exec bit: macOS wouldn't start it, so it isn't copied.
  const flat = world();
  chmodSync(join(packaged(flat.root), "Contents", "MacOS", "CELLO"), 0o644);
  await assert.rejects(addNotifier({ type: "mac", agent: "Ann" }, daemon(flat), () => flat.env), (err: unknown) => err instanceof DaemonRefused && err.code === "mac_app_broken" && err.message.includes("isn't executable"));
  assert.deepEqual([flat.calls, existsSync(appPath(flat.home))], [[], false]);
});

test("a copy that fails leaves the CELLO that was there, whole", async () => {
  const w = world();
  await addNotifier({ type: "mac", agent: "Ann" }, daemon(w), () => w.env);
  fakeApp(packaged(w.root), "binary-2");
  const failing: MacAppEnv = { ...w.env, run: (command, args) => (command === "ditto" ? { status: 1, stdout: "", stderr: "No space left on device" } : w.env.run(command, args)) };
  await assert.rejects(addNotifier({ type: "mac", agent: "Ann" }, daemon(w), () => failing), (err: unknown) => err instanceof DaemonRefused && err.code === "mac_app_copy_failed" && err.message.includes("No space left"));
  assert.equal(readFileSync(join(appPath(w.home), "Contents", "MacOS", "CELLO"), "utf8"), "binary-1", "the old app is still there");
  assert.deepEqual(readdirSync(join(w.home, "Applications")), ["CELLO.app"], "nothing half-copied left beside it");
});

test("--app takes one the person built", async () => {
  const w = world({ prebuilt: "absent" });
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

test("the prebuilt app is found where npm puts the package, nested under cello or beside it, and not found when it isn't installed", () => {
  const top = mkdtempSync(join(tmpdir(), "cello-mac-find-"));
  const manifest = (dir: string, name: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.1" }));
  };
  // npm -g: lib/node_modules/@cello-protocol/cli/node_modules/@cello-protocol/mac-app
  const nested = join(top, "global", "node_modules", "@cello-protocol", "cli");
  manifest(nested, "@cello-protocol/cli");
  manifest(join(nested, "node_modules", "@cello-protocol", "mac-app"), MAC_APP_PACKAGE);
  assert.equal(findPackagedApp(nested), join(realpathSync(nested), "node_modules", "@cello-protocol", "mac-app", "CELLO.app"));
  // Hoisted beside it, as a local install or pnpm lays it out.
  const beside = join(top, "local", "node_modules", "@cello-protocol", "cli");
  manifest(beside, "@cello-protocol/cli");
  manifest(join(top, "local", "node_modules", "@cello-protocol", "mac-app"), MAC_APP_PACKAGE);
  assert.equal(findPackagedApp(beside), join(realpathSync(join(top, "local")), "node_modules", "@cello-protocol", "mac-app", "CELLO.app"));
  // On Linux, Windows, or with optional packages turned off, it isn't there.
  const alone = join(top, "alone", "node_modules", "@cello-protocol", "cli");
  manifest(alone, "@cello-protocol/cli");
  assert.equal(findPackagedApp(alone), undefined);
});

test("telegram passes straight through", async () => {
  const w = world();
  await addNotifier({ type: "telegram", bot_token: "t" }, daemon(w), () => w.env);
  assert.deepEqual([w.calls, w.ran, w.said], [[{ type: "telegram", bot_token: "t" }], [], []]);
});

// Putting the CELLO app on this Mac, for notifier-add mac. It runs in the caller's process, the command line or the MCP
// shim, because it copies into the person's own Applications folder and opens the app there. Each step is said, with
// how to undo it, and then done, with no prompt, so an agent can run it: the person's click in the app is the real gate.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DaemonRefused } from "./ipc/client.ts";

export const BUNDLE_ID = "ai.mygentic.cello";

export interface Ran { status: number | null; stdout: string; stderr: string }

export interface MacAppEnv {
  // The person's home folder: Applications and Library are in it.
  home: string;
  // CELLO's own folder, which the app reads operator.sock from.
  celloHome: string;
  // The folder holding package.json, and widgets/mac in a checkout.
  packageRoot: string;
  // How the app starts CELLO again when it isn't running: this node, this cello script, login.
  node: string;
  cli: string;
  platform: NodeJS.Platform;
  run: (command: string, args: string[]) => Ran;
  // Each step as it's taken. The command line prints them on standard error; a tool's answer carries them.
  say: (line: string) => void;
}

export function macAppEnv(cli: string, celloHome: string, say: (line: string) => void): MacAppEnv {
  return {
    home: homedir(),
    celloHome,
    packageRoot: resolve(dirname(cli), ".."),
    node: process.execPath,
    cli,
    platform: process.platform,
    run: (command, args) => {
      const ran = spawnSync(command, args, { encoding: "utf8" });
      return { status: ran.error ? null : ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? (ran.error?.message ?? "") };
    },
    say,
  };
}

export const appPath = (home: string): string => join(home, "Applications", "CELLO.app");
export const launchFile = (home: string): string => join(home, "Library", "Application Support", "CELLO", "launch.json");
// TODO(mac app): the prebuilt app becomes a macOS-only npm package (os: darwin), an optional dependency, per decision 6.
// Until then the only prebuilt one is what widgets/mac/scripts/assemble.sh leaves in a checkout.
export const prebuiltPath = (packageRoot: string): string => join(packageRoot, "widgets", "mac", "build", "CELLO.app");
const assembleScript = (packageRoot: string): string => join(packageRoot, "widgets", "mac", "scripts", "assemble.sh");

const refuse = (code: string, message: string): never => {
  throw new DaemonRefused(code, message);
};

// The same app twice is copied once: a second agent, or the command run again, leaves a running CELLO alone.
function fingerprint(app: string): string | undefined {
  const binary = join(app, "Contents", "MacOS", "CELLO");
  const plist = join(app, "Contents", "Info.plist");
  if (!existsSync(binary) || !existsSync(plist)) return undefined;
  return createHash("sha256").update(readFileSync(binary)).update(readFileSync(plist)).digest("hex");
}

function checkApp(app: string, from: string): void {
  const plist = join(app, "Contents", "Info.plist");
  if (!existsSync(join(app, "Contents", "MacOS", "CELLO")) || !existsSync(plist)) refuse("mac_app_missing", `${from} ${app} isn't a CELLO app: it has no Contents/MacOS/CELLO and Info.plist. Nothing was changed.`);
  if (!readFileSync(plist, "utf8").includes(`<string>${BUNDLE_ID}</string>`)) refuse("mac_app_missing", `${app} isn't the CELLO app: its Info.plist doesn't name ${BUNDLE_ID}. Nothing was changed.`);
}

function build(env: MacAppEnv, say: (line: string) => void): string {
  const script = assembleScript(env.packageRoot);
  if (!existsSync(script)) refuse("mac_app_source_missing", `This install of cello doesn't carry the app's source (${script}), so it can't build CELLO. Build it in a checkout of the cello repository with widgets/mac/scripts/assemble.sh, then run notifier-add mac --app <path to CELLO.app>. Nothing was changed.`);
  if (env.run("xcrun", ["--find", "swiftc"]).status !== 0) refuse("xcode_tools_missing", "Building CELLO needs the Xcode command-line tools, and they aren't installed. Run: xcode-select --install, then this again. Nothing was changed.");
  say("Building CELLO from widgets/mac. This takes a minute.");
  const out = join(env.packageRoot, "widgets", "mac", "build");
  const built = env.run(script, [out]);
  if (built.status !== 0) {
    const tail = `${built.stdout}\n${built.stderr}`.trim().split("\n").slice(-8).join("\n");
    refuse("mac_app_build_failed", `Building CELLO failed, so nothing was changed. The last lines:\n${tail}`);
  }
  return join(out, "CELLO.app");
}

export interface Installed {
  // Everything that was said, steps and outcomes, for a tool's answer.
  steps: string[];
  app: string;
  copied: boolean;
  launch_file: string;
  // Set by open(), after the route is saved.
  opened?: boolean;
}

// Says the steps, then puts CELLO in ~/Applications and writes launch.json. Opening it waits until the route is saved.
export function install(params: Record<string, unknown>, env: MacAppEnv): Installed {
  if (env.platform !== "darwin") refuse("not_supported", "The CELLO app runs on a Mac, so it can't be put on this machine. Nothing was changed.");
  const target = appPath(env.home);
  const launch = launchFile(env.home);
  const steps: string[] = [];
  const say = (line: string): void => {
    steps.push(line);
    env.say(line);
  };
  const plan = [
    "CELLO will:",
    `1. Put CELLO in your Applications folder: ${target}. To undo: move it to the Trash.`,
    `2. Note where cello is, so the app can start it again if it stops: ${launch}. To undo: delete that file.`,
    "3. Open it when you log in, if you leave that ticked when it opens. To undo: untick it in CELLO's Settings.",
    "4. Open it now to finish setting up. To undo: Quit CELLO in its Settings.",
    "To undo all of it: Remove CELLO from this Mac… in CELLO's Settings. To take one agent off: cello notifier-remove mac --agent <name>.",
  ];
  for (const line of plan) say(line);

  let source: string;
  if (typeof params["app"] === "string") {
    source = resolve(params["app"]);
    checkApp(source, "--app");
  } else if (params["build"] === true) {
    source = build(env, say);
    checkApp(source, "The build left");
  } else {
    source = prebuiltPath(env.packageRoot);
    if (!existsSync(source)) refuse("mac_app_missing", `This install of cello doesn't carry a prebuilt CELLO app yet (${source}). Build one with --build, in a checkout with the Xcode command-line tools, or give one you built with --app <path>. Nothing was changed.`);
    checkApp(source, "The prebuilt");
  }

  const before = fingerprint(target);
  const copied = before === undefined || before !== fingerprint(source);
  if (copied) {
    mkdirSync(dirname(target), { recursive: true });
    // Copied beside it first, so a copy that fails leaves the app that was there. ditto keeps the bundle and its
    // signature exactly as built.
    const incoming = `${target}.incoming-${process.pid}`;
    rmSync(incoming, { recursive: true, force: true });
    const ditto = env.run("ditto", [source, incoming]);
    if (ditto.status !== 0) {
      rmSync(incoming, { recursive: true, force: true });
      refuse("mac_app_copy_failed", `Copying CELLO to ${target} failed: ${ditto.stderr.trim() || `ditto exited with ${String(ditto.status)}`}. Nothing was changed.`);
    }
    const outgoing = `${target}.outgoing-${process.pid}`;
    if (existsSync(target)) renameSync(target, outgoing);
    renameSync(incoming, target);
    rmSync(outgoing, { recursive: true, force: true });
    say(before === undefined ? `Put CELLO in ${target}.` : `Replaced CELLO in ${target} with this version. If it was open, quit it in its Settings and open it again.`);
  } else {
    say(`CELLO is already in ${target}, this same version.`);
  }

  mkdirSync(dirname(launch), { recursive: true, mode: 0o700 });
  writeFileSync(launch, `${JSON.stringify({ cello_home: env.celloHome, start: [env.node, env.cli, "login"] }, null, 2)}\n`, { mode: 0o600 });
  return { steps, app: target, copied, launch_file: launch };
}

// After the route is saved, so the app finds its agents when it connects. A copy that was already there and the same is
// left as it is: it's open already, or the person closed it.
export function open(installed: Installed, env: MacAppEnv): void {
  if (!installed.copied) {
    installed.opened = false;
    return;
  }
  const say = (line: string): void => {
    installed.steps.push(line);
    env.say(line);
  };
  say("Opening CELLO…");
  const opened = env.run("open", [installed.app]);
  installed.opened = opened.status === 0;
  if (!installed.opened) say(`CELLO didn't open (${opened.stderr.trim() || `open exited with ${String(opened.status)}`}). Open it from ${installed.app} to finish.`);
}

// notifier-add, from the command line or a tool. A mac route also puts the app here, unless route_only is given or another
// agent's route is copied with same_as, since the app is one for every agent.
export async function addNotifier(params: Record<string, unknown>, call: (fields: Record<string, unknown>) => Promise<unknown>, env: () => MacAppEnv): Promise<unknown> {
  const { build: wantsBuild, app, route_only: routeOnly, ...fields } = params;
  const named = wantsBuild === true || app !== undefined;
  if (routeOnly === true && named) refuse("bad_argument", "route_only saves the route and touches nothing else, so it can't go with build or app. Nothing was changed.");
  if (fields["type"] !== "mac" || routeOnly === true || (fields["same_as"] !== undefined && !named)) return call(fields);
  const here = env();
  const installed = install({ build: wantsBuild, app }, here);
  let answer: Record<string, unknown>;
  try {
    answer = await call(fields) as Record<string, unknown>;
  } catch (err: unknown) {
    // The daemon's refusal says nothing was saved, which is true of the route. The app and launch.json did change,
    // and running this again finishes it. A person_required refusal is confirmed and retried, so it's left as it is.
    if (err instanceof DaemonRefused && err.code !== "person_required") {
      throw new DaemonRefused(err.code, `${err.message} The route wasn't saved, but CELLO is in ${installed.app}${installed.copied ? " now" : ""} and ${installed.launch_file} was written; neither is opened or used until the route is added.`);
    }
    throw err;
  }
  open(installed, here);
  return { ...answer, app_install: installed };
}

// What a stranger gets: the tarball from npm pack, installed into an empty prefix outside this repo, then only its
// binaries, with a home, PATH and working folder that can't reach this repo. It starts its own server from nothing, on its
// own project name and port, so it can run beside other live tests. No model turns: it doesn't prove a doorbell wakes a session.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { OPERATIONS } from "../src/ipc/operations.ts";

const repo = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const serverDir = process.env["CELLO_SERVER_DIR"] ?? join(repo, "..", "cello-server");
const port = process.env["CELLO_INSTALL_PORT"] ?? "18095";
const url = `ws://127.0.0.1:${port}/v1`;
const TESTS = 5;

// Short, because a daemon's socket path has a length limit of about 104 bytes here.
const work = realpathSync(mkdtempSync(join(tmpdir(), "cv2-inst-")));
const prefix = join(work, "prefix");
const home = join(work, "home");
const cwd = join(work, "cwd");
const npmCache = join(work, "npm-cache");
const packageDir = join(prefix, "lib", "node_modules", "cello-v2");
const binary = join(prefix, "bin", "cello-v2");
const mcpBinary = join(prefix, "bin", "cello-v2-mcp");
const compose = { ...process.env, COMPOSE_FILE: "docker-compose.yml:live/docker-compose.test.yml", CELLO_TEST_VOUCH: "1", COMPOSE_PROJECT_NAME: process.env["CELLO_INSTALL_PROJECT"] ?? "cello-v2-install", CELLO_PORT: port, POSTGRES_PASSWORD: randomHex(), CELLO_APP_PASSWORD: randomHex() };

let tarball = "";
let passed = 0;

function randomHex(): string {
  return execFileSync("openssl", ["rand", "-hex", "16"], { encoding: "utf8" }).trim();
}

// A tool the host has, found on a PATH with this repo's folders taken out, which pnpm and npm put there when running this.
function hostTool(name: string): string {
  const clean = (process.env["PATH"] ?? "").split(delimiter).filter((dir) => !dir.startsWith(repo)).join(delimiter);
  const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", env: { PATH: clean } }).stdout.trim();
  if (!found) throw new Error(`${name} isn't on this machine's PATH, and this test needs it`);
  return found;
}

const hostPath = (...dirs: string[]): string => [...dirs, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
// Built from nothing, so no npm_ or NODE_ setting from whatever started this test leaks in.
const installedEnv = (): Record<string, string> => ({ PATH: hostPath(join(prefix, "bin")), HOME: home, TMPDIR: tmpdir() });
const npmEnv = (): Record<string, string> => ({ PATH: hostPath(dirname(hostTool("npm"))), HOME: home, TMPDIR: tmpdir() });

function must(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): string {
  const run = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${run.status}:\n${run.stdout}\n${run.stderr}`);
  return run.stdout;
}

interface Run { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }

// Found by name on the installed PATH, as it would be for anyone.
function cello(args: string[], input?: string): Run {
  const run = spawnSync("cello-v2", args, { encoding: "utf8", input, cwd, env: installedEnv() });
  if (run.error) throw run.error;
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(run.stdout || run.stderr) as Record<string, unknown>;
  } catch {
    // login and logout answer in words.
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, json };
}

function ok(args: string[], input?: string): Record<string, unknown> {
  const run = cello(args, input);
  assert.equal(run.status, 0, `cello-v2 ${args.join(" ")} failed: ${run.stderr}`);
  assert.equal(run.stderr, "", `cello-v2 ${args.join(" ")} printed something a user would see on stderr`);
  return run.json;
}

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const allOnline = (): Promise<boolean> => until("the agents online", () => (ok(["status"]) as { agents: { online: boolean }[] }).agents.every((a) => a.online));

function assertDaemonIsInstalled(): void {
  const pid = (ok(["status"]) as { pid: number }).pid;
  const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  assert.ok(command.includes(join(packageDir, "dist", "daemon", "main.js")), `the running daemon isn't the installed one: ${command}`);
}

function sizeMegabytes(path: string): number {
  return Math.round(Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split("\t")[0]) / 1024);
}

function installTimed(args: string[], where: string): number {
  const started = Date.now();
  must(hostTool("npm"), ["install", "--cache", npmCache, "--no-audit", "--no-fund", ...args], { cwd: where, env: npmEnv() });
  return Math.round((Date.now() - started) / 100) / 10;
}

before(async () => {
  if (!existsSync(join(serverDir, "docker-compose.yml"))) throw new Error(`no server at ${serverDir}. Set CELLO_SERVER_DIR to a cello-server checkout.`);
  for (const dir of [prefix, home, cwd]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const up = spawnSync("docker", ["compose", "up", "-d", "--build", "--wait", "server"], { cwd: serverDir, env: compose, encoding: "utf8" });
  if (up.status !== 0) throw new Error(`the server didn't start. Is Docker running?\n${up.stderr}`);

  // prepack builds here, so what's packed can't be an old dist.
  must(hostTool("npm"), ["pack", "--pack-destination", work], { cwd: repo, env: { PATH: hostPath(dirname(hostTool("npm"))), HOME: process.env["HOME"] ?? home } });
  const packed = readdirSync(work).filter((name) => name.endsWith(".tgz"));
  assert.equal(packed.length, 1, `expected one tarball, found ${packed.join(", ")}`);
  tarball = join(work, packed[0] as string);

  // With an empty cache, this is the wait a new user has.
  const seconds = installTimed(["-g", "--prefix", prefix, tarball], cwd);
  process.stdout.write(`Install with an empty npm cache: ${seconds} s. Installed size: ${sizeMegabytes(packageDir)} MB. Tarball: ${Math.round(statSync(tarball).size / 1024)} KB.\n`);
}, { timeout: 600_000 });

after(() => {
  if (existsSync(join(home, ".cello-v2", "daemon.sock"))) cello(["logout"]);
  spawnSync("docker", ["compose", "down", "-v", "--remove-orphans"], { cwd: serverDir, env: compose });
  if (passed === TESTS) rmSync(work, { recursive: true, force: true });
  else process.stdout.write(`Kept for looking at: ${work}\n`);
}, { timeout: 120_000 });

test("the tarball holds compiled code and the plugin, and no source, tests or live code", () => {
  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n").map((path) => path.replace(/^package\//, "")).sort();
  const sourceFiles = (readdirSync(join(repo, "src"), { recursive: true }) as string[]).filter((path) => path.endsWith(".ts"));
  const expected = [
    ...sourceFiles.map((path) => join("dist", path.replace(/\.ts$/, ".js"))),
    ".claude-plugin/marketplace.json",
    "README.md",
    "package.json",
    "plugins/cello-v2/.claude-plugin/plugin.json",
    "plugins/cello-v2/.mcp.json",
    "plugins/cello-v2/skills/cello/SKILL.md",
  ].sort();
  assert.deepEqual(listing, expected, "the tarball holds exactly one compiled file per source file, plus these");

  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" })) as { private?: boolean; engines?: { node?: string }; bin?: Record<string, string> };
  assert.equal(manifest.private, true, "nothing can publish this by accident");
  assert.equal(manifest.engines?.node, ">=24.7");
  assert.deepEqual(manifest.bin, { "cello-v2": "./dist/cli.js", "cello-v2-mcp": "./dist/mcp.js" });

  for (const path of listing.filter((name) => name.endsWith(".js"))) {
    const code = readFileSync(join(packageDir, path), "utf8");
    assert.doesNotMatch(code, /from "\.[^"]*\.ts"|import "\.[^"]*\.ts"/, `${path} still imports TypeScript`);
  }
  // Nothing that was only for building came along.
  for (const name of ["typescript", "eslint", "@types"]) assert.equal(existsSync(join(packageDir, "node_modules", name)), false, `${name} was installed`);
  assert.equal(realpathSync(binary), join(packageDir, "dist", "cli.js"));
  assert.equal(spawnSync("sh", ["-c", "command -v cello-v2"], { encoding: "utf8", env: installedEnv() }).stdout.trim(), binary);
  assert.equal(relative(repo, work).startsWith(".."), true, "the install is outside this repo");
  passed++;
});

test("the installed binary holds a whole conversation, through a daemon kill, and it checks out", async () => {
  assert.equal(cello(["status"]).json["error"], "daemon_not_running");
  assert.match(cello(["login", "--server", url]).stdout, /connected/);
  assertDaemonIsInstalled();
  const gail = ok(["create-agent", "Gail"]);
  const hugo = ok(["create-agent", "Hugo"]);
  ok(["settings-set", "away.answering", "false", "--agent", "Hugo"]);
  await allOnline();
  // The real default home, and the database opens: this is the native SQLCipher loading from a plain npm install.
  assert.ok(existsSync(join(home, ".cello-v2", "cello.db")));

  const started = ok(["initiate-session", hugo["agent_id"] as string, "--agent", "Gail"]);
  const session = started["session_id"] as string;
  assert.equal(started["state"], "active");
  assert.deepEqual(ok(["send", session, "first", "--over", "--agent", "Gail"]), { sent: true, position: 1 });
  await until("the message to reach Hugo", () => (ok(["inbox", "--agent", "Hugo"]) as { waiting: unknown[] }).waiting.length === 1);
  ok(["wait", "--agent", "Hugo", "--timeout-seconds", "20"]);
  const read = ok(["receive", "--agent", "Hugo"]) as { messages: { text: string; from_id: string }[] };
  assert.deepEqual(read.messages.map((m) => [m.text, m.from_id]), [["first", gail["agent_id"]]]);
  ok(["send", session, "second", "--standby", "2", "--agent", "Hugo"]);

  process.kill((ok(["status"]) as { pid: number }).pid, "SIGKILL");
  assert.equal(cello(["status"]).json["error"], "daemon_not_running");
  assert.match(cello(["login", "--server", url]).stdout, /connected/);
  assertDaemonIsInstalled();
  await allOnline();

  ok(["wait", "--agent", "Gail", "--timeout-seconds", "20"]);
  assert.deepEqual((ok(["receive", "--agent", "Gail"]) as { messages: { text: string }[] }).messages.map((m) => m.text), ["second"]);
  assert.deepEqual(ok(["send", session, "still with you", "--over", "--agent", "Gail"]), { sent: true, position: 3 });
  ok(["wait", "--agent", "Hugo", "--timeout-seconds", "20"]);
  assert.deepEqual((ok(["receive", "--agent", "Hugo"]) as { messages: { text: string }[] }).messages.map((m) => m.text), ["still with you"]);
  ok(["send", session, "that's all", "--wrap", "--agent", "Hugo"]);
  ok(["wait", "--agent", "Gail", "--timeout-seconds", "20"]);
  ok(["receive", "--agent", "Gail"]);
  assert.equal(ok(["close-session", session, "--agent", "Gail"])["closed"], true);
  ok(["wait", "--agent", "Hugo", "--timeout-seconds", "20"]);
  ok(["receive", "--agent", "Hugo"]);
  assert.equal(ok(["close-session", session, "--agent", "Hugo"])["state"], "closed");

  const reportG = ok(["verify-session", session, "--agent", "Gail"]);
  const reportH = ok(["verify-session", session, "--agent", "Hugo"]);
  assert.deepEqual([reportG["ok"], reportH["ok"]], [true, true]);
  assert.equal(reportG["root"], reportH["root"]);
  const transcript = ok(["transcript", session, "--agent", "Gail"]) as { entries: { text?: string }[] };
  assert.deepEqual(transcript.entries.slice(0, 4).map((e) => e.text), ["first", "second", "still with you", "that's all"]);
  passed++;
});

test("the installed cello-v2-mcp speaks real stdio, starts before login, lists every tool and rings", async () => {
  ok(["stop-using-agent", "--agent", "Hugo"]);
  assert.match(cello(["logout"]).stdout, /stopped/);

  const ChannelEvent = z.object({ method: z.literal("notifications/claude/channel"), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) });
  const bells: z.infer<typeof ChannelEvent>["params"][] = [];
  const client = new Client({ name: "install-test", version: "0" });
  client.setNotificationHandler(ChannelEvent, async ({ params }) => { bells.push(params); });
  const stderr: string[] = [];
  const transport = new StdioClientTransport({ command: mcpBinary, env: installedEnv(), cwd, stderr: "pipe" });
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  await client.connect(transport);
  try {
    assert.ok(client.getServerCapabilities()?.experimental?.["claude/channel"], "it declares itself as a channel");
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, OPERATIONS.filter((op) => !op.personOnly).map((op) => op.tool).sort());

    const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[] };
      return JSON.parse(result.content[0]?.text as string) as Record<string, unknown>;
    };
    // A plugin user often opens Claude Code first, so no daemon has to say what to do. Then it attaches by itself.
    const early = await call("cello_status");
    assert.equal(early["error"], "daemon_not_running");
    assert.match(early["message"] as string, /cello-v2 login/);
    assert.match(cello(["login", "--server", url]).stdout, /connected/);
    await until("the server to attach to the daemon", async () => !(await call("cello_status"))["error"]);
    await allOnline();

    await call("cello_use_agent", { agent: "Gail" });
    const gailId = (ok(["agents"]) as { agents: { name: string; agent_id: string }[] }).agents.find((a) => a.name === "Gail")?.agent_id;
    const session = ok(["initiate-session", gailId as string, "--agent", "Hugo"])["session_id"] as string;
    ok(["send", session, "are you there", "--over", "--agent", "Hugo"]);
    const bell = await until("a message doorbell", () => bells.find((b) => b.meta["type"] === "message"));
    assert.doesNotMatch(JSON.stringify(bell), /are you there/);
    const read = await call("cello_receive", { agent: "Gail", session_id: session }) as { messages?: { text: string }[] };
    assert.deepEqual(read.messages?.map((m) => m.text), ["are you there"]);
    assert.equal(stderr.join(""), "", "the server printed something on stderr");
  } finally {
    await client.close();
  }
  passed++;
});

test("the plugin in the installed package installs into a clean Claude Code and its server connects", () => {
  const configDir = join(work, "claude-config");
  mkdirSync(configDir);
  const env = { PATH: hostPath(join(prefix, "bin"), dirname(hostTool("claude"))), HOME: home, TMPDIR: tmpdir(), CLAUDE_CONFIG_DIR: configDir };
  const claude = hostTool("claude");
  must(claude, ["plugin", "validate", packageDir], { cwd, env });
  must(claude, ["plugin", "marketplace", "add", packageDir], { cwd, env });
  must(claude, ["plugin", "install", "cello-v2@cello-v2"], { cwd, env });
  const servers = must(claude, ["mcp", "list"], { cwd, env });
  assert.match(servers, /cello-v2.*cello-v2-mcp.*Connected/, servers);
  passed++;
});

test("installing into someone's git repo leaves their hooks alone, and a missing daemon is named", () => {
  const project = join(work, "their-project");
  mkdirSync(project);
  must("git", ["init", "-q"], { cwd: project, env: npmEnv() });
  must("git", ["config", "core.hooksPath", "their-hooks"], { cwd: project, env: npmEnv() });
  const seconds = installTimed(["--no-save", tarball], project);
  process.stdout.write(`Install with a warm npm cache: ${seconds} s.\n`);
  const hooks = (): string => must("git", ["config", "core.hooksPath"], { cwd: project, env: npmEnv() }).trim();
  assert.equal(hooks(), "their-hooks");
  // Even if something does run prepare in the installed copy, where its script didn't ship.
  must(hostTool("npm"), ["run", "prepare"], { cwd: join(project, "node_modules", "cello-v2"), env: npmEnv() });
  assert.equal(hooks(), "their-hooks");

  assert.match(cello(["logout"]).stdout, /stopped/);
  rmSync(join(packageDir, "dist", "daemon", "main.js"));
  const broken = cello(["login", "--server", url]);
  assert.deepEqual([broken.status, broken.json["error"]], [1, "daemon_entry_missing"]);
  assert.ok((broken.json["message"] as string).includes(join("dist", "daemon", "main.js")));
  passed++;
});

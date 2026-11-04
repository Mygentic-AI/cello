#!/usr/bin/env node
// Everything an agent or a person can do. Each command is one process and one call, with its identity in the call.
import "./require-node.ts";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createInterface as createReadline } from "node:readline";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { celloHome, logPath, socketPath } from "./daemon/paths.ts";
import { DaemonGone, DaemonRefused, IpcClient } from "./ipc/client.ts";
import { DEFAULT_WAIT_SECONDS, OPERATIONS, type Operation, type Param } from "./ipc/operations.ts";
import { exportTranscript, runLocal } from "./local-operations.ts";
import { installModel } from "./screener/model-installer.ts";
import { SCREENER_RUNTIME_MODULE, describeScreenerState, runtimeAvailable, screenerModelDir, screenerRuntimeDir, screenerState } from "./screener/screener-state.ts";

const DOWNLOAD_MB = 241;
const DISK_MB = 618;

// Each shell session that sets CELLO_CALLER is its own caller, so one can't read another's messages by accident.
// Any stable string works: it's a label, not a proof. Without it, all of this machine's command lines are one caller.
const CALLER = process.env["CELLO_CALLER"] || "cli";
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_TIMEOUT = 3;

function flag(name: string): string {
  return `--${name.replaceAll("_", "-")}`;
}

// send takes its signal as one flag, which can't be mistyped into a wrong value.
const SIGNAL_FLAGS = "(--over | --standby <minutes> | --wrap)";
const isSignalParam = (op: Operation, param: Param): boolean => op.command === "send" && (param.name === "signal" || param.name === "est_minutes");

function usageLine(op: Operation): string {
  const positional = op.params.filter((p) => p.positional).map((p) => (p.required ? `<${p.name}>` : `[<${p.name}>]`));
  const flags = op.params.filter((p) => !p.positional && !isSignalParam(op, p)).map((p) => {
    const text = p.kind === "boolean" ? flag(p.name) : `${flag(p.name)} <${p.kind}>`;
    return p.required ? text : `[${text}]`;
  });
  const signal = op.command === "send" ? [SIGNAL_FLAGS] : [];
  const scoped = [...(op.scoped ? ["[--agent <name-or-id>]"] : []), ...(op.acts ? ["[--force]"] : [])];
  return `cello-v2 ${[op.command, ...positional, ...signal, ...flags, ...scoped].join(" ")}`;
}

function commandHelp(op: Operation): string {
  const details = op.params.filter((p) => !isSignalParam(op, p)).map((p) => `  ${(p.positional ? `<${p.name}>` : flag(p.name)).padEnd(20)} ${p.description}`);
  if (op.command === "send") {
    details.push(
      `  ${"--over".padEnd(20)} Your turn is done.`,
      `  ${"--standby <minutes>".padEnd(20)} You'll follow up in about that many minutes.`,
      `  ${"--wrap".padEnd(20)} Your final message.`,
    );
  }
  if (op.scoped) details.push(`  ${"--agent".padEnd(20)} The agent's name or id. Can be left out once chosen with use-agent.`);
  if (op.acts) details.push(`  ${"--force".padEnd(20)} Take the agent from another caller that holds it.`);
  return `Usage: ${usageLine(op)}\n\n${op.description}\n${details.length > 0 ? `\n${details.join("\n")}\n` : ""}`;
}

function overview(): string {
  const groups = new Map<string, string[]>([["Setup", [`  ${"login".padEnd(20)} Start the daemon, and connect it to a server.`, `  ${"logout".padEnd(20)} Stop the daemon. Conversations carry on after the next login.`, `  ${"screener".padEnd(20)} Install the optional screening model, or see if it's installed.`]]]);
  for (const op of OPERATIONS) {
    const lines = groups.get(op.group) ?? [];
    lines.push(`  ${op.command.padEnd(20)} ${op.summary}`);
    groups.set(op.group, lines);
  }
  const sections = [...groups].map(([group, lines]) => `${group}:\n${lines.join("\n")}`);
  return `CELLO: signed, encrypted conversations between agents.

First-time setup:  cello-v2 login --server <url>  →  cello-v2 create-agent <name>  →  cello-v2 status

Usage: cello-v2 <command> [args]

${sections.join("\n\n")}

Run 'cello-v2 <command> --help' for details on any command.
Commands print JSON on one line, and --pretty indents it.
A failure prints {"error","message"} on standard error and exits ${EXIT_REFUSED}.
A usage mistake exits ${EXIT_USAGE}, and wait exits ${EXIT_TIMEOUT} when its time runs out.
Any agent that can run a shell command can use all of this with no MCP.
Each agent's shell should set CELLO_CALLER to a stable name of its own, so that two can't share an agent by accident.
Where there's a tool, it has the same name: cello-v2 send ↔ cello_send.
`;
}

// Written synchronously, because process.exit can drop what process.stderr still holds, and the caller would get no reason.
function fail(text: string, code: number): never {
  const bytes = Buffer.from(text);
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(2, bytes, written);
    } catch (err: unknown) {
      // A full pipe that doesn't block asks to be tried again. Anything else means nobody is reading.
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") break;
    }
  }
  process.exit(code);
}

function usageError(message: string, op?: Operation): never {
  const hint = op ? `\n\n${usageLine(op)}\nRun 'cello-v2 ${op.command} --help' for details.` : "\n\nRun 'cello-v2 --help' for the list of commands.";
  fail(`${message}${hint}\n`, EXIT_USAGE);
}

// Per caller, so one caller's choice can't make another act as the wrong agent.
const currentAgentFile = (): string => join(celloHome(), CALLER === "cli" ? "current-agent" : `current-agent-${createHash("sha256").update(CALLER).digest("hex").slice(0, 16)}`);

function currentAgent(): string | undefined {
  return existsSync(currentAgentFile()) ? readFileSync(currentAgentFile(), "utf8").trim() || undefined : undefined;
}

function readValue(param: Param, raw: string): string | number {
  if (param.kind === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) usageError(`${flag(param.name)} must be a number, got ${raw}`);
    return value;
  }
  if (param.allowed && !param.allowed.includes(raw)) usageError(`${flag(param.name)} must be one of ${param.allowed.join(", ")}, got ${raw}`);
  return raw;
}

// One line by default, because the usual reader is a program or an agent paying for every character.
let pretty = false;
const render = (value: unknown): string => `${pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`;

// Fails on anything it doesn't recognise, so a mistyped flag can't quietly change what a command does.
function parse(op: Operation, args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const positional = op.params.filter((p) => p.positional);
  const given: string[] = [];
  let flagsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (flagsEnded || !arg.startsWith("--")) {
      given.push(arg);
      continue;
    }
    if (arg === "--") {
      flagsEnded = true;
      continue;
    }
    if (arg === "--pretty") {
      pretty = true;
      continue;
    }
    if (op.acts && arg === "--force") {
      params["force"] = true;
      continue;
    }
    if (op.scoped && arg === "--agent") {
      const value = args[++i];
      if (!value) usageError("--agent needs a value", op);
      params["agent"] = value;
      continue;
    }
    if (op.command === "send" && (arg === "--over" || arg === "--wrap" || arg === "--standby")) {
      if (params["signal"] !== undefined) usageError(`send takes one signal: ${SIGNAL_FLAGS}`, op);
      params["signal"] = arg.slice(2);
      if (arg === "--standby") {
        const minutes = Number(args[++i]);
        if (!(minutes > 0)) usageError("--standby needs a positive number of minutes", op);
        params["est_minutes"] = minutes;
      }
      continue;
    }
    const param = op.params.find((p) => !p.positional && !isSignalParam(op, p) && flag(p.name) === arg);
    if (!param) usageError(`${op.command} has no option ${arg}`, op);
    if (param.kind === "boolean") {
      params[param.name] = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined) usageError(`${arg} needs a value`, op);
    params[param.name] = readValue(param, value);
  }
  if (given.length > positional.length) usageError(`${op.command} takes ${positional.length} argument(s), got ${given.length}`, op);
  positional.forEach((param, i) => {
    const value = given[i];
    if (value !== undefined) params[param.name] = param.name === "text" && value === "-" ? readFileSync(0, "utf8") : value;
  });
  for (const param of op.params) {
    if (param.required && params[param.name] === undefined) usageError(`${op.command} needs ${isSignalParam(op, param) ? SIGNAL_FLAGS : param.positional ? `<${param.name}>` : flag(param.name)}`, op);
  }
  if (op.scoped) {
    params["agent"] ??= currentAgent();
    if (!params["agent"]) {
      fail(`${JSON.stringify({ error: "no_current_agent", message: "Name the agent with --agent, or choose one with: cello-v2 use-agent --agent <name>" })}\n`, EXIT_REFUSED);
    }
    params["caller"] = CALLER;
  }
  return params;
}

// The build doesn't rewrite a path held in a string, so the daemon is looked for in the form this file is running in:
// main.ts from source, main.js when installed.
function daemonEntry(): string {
  const here = fileURLToPath(import.meta.url);
  const entry = join(dirname(here), "daemon", `main${extname(here)}`);
  if (!existsSync(entry)) {
    fail(`${JSON.stringify({ error: "daemon_entry_missing", message: `The daemon's code isn't at ${entry}, so this install is incomplete. Install CELLO again.` })}\n`, EXIT_REFUSED);
  }
  return entry;
}

async function waitForDaemon(child: ReturnType<typeof spawn>): Promise<IpcClient> {
  let exited: number | null | undefined;
  child.once("exit", (code) => { exited = code; });
  for (let i = 0; i < 100; i++) {
    if (exited !== undefined) break;
    try {
      return await IpcClient.connect(socketPath());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const tail = readFileSync(logPath(), "utf8").trim().split("\n").slice(-5).join("\n");
  return fail(`The daemon didn't start. The last lines of ${logPath()}:\n${tail}\n`, EXIT_REFUSED);
}

async function login(args: string[]): Promise<void> {
  const at = args.indexOf("--server");
  const server = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !server) usageError("--server needs a value");
  try {
    const running = await IpcClient.connect(socketPath());
    const status = await running.call("status") as { pid: number; server: string };
    running.close();
    if (server && status.server !== server) {
      fail(`A daemon is already running for ${status.server}. Run: cello-v2 logout\n`, EXIT_REFUSED);
    }
    process.stdout.write(`Already running, process ${status.pid}.\n`);
    return;
  } catch (err: unknown) {
    if (!(err instanceof DaemonGone)) throw err;
  }
  const entry = daemonEntry();
  mkdirSync(celloHome(), { recursive: true, mode: 0o700 });
  const logFile = openSync(logPath(), "a", 0o600);
  const child = spawn(process.execPath, server ? [entry, server] : [entry], { detached: true, stdio: ["ignore", logFile, logFile] });
  closeSync(logFile);
  const client = await waitForDaemon(child);
  child.unref();
  // A far-away server takes a moment. Say what's true rather than implying it's ready.
  let status = await client.call("status") as { pid: number; server: string; connected: boolean; problem: string | null };
  for (let i = 0; i < 50 && !status.connected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    status = await client.call("status") as typeof status;
  }
  client.close();
  const state = status.connected ? "connected" : `not connected yet (${status.problem ?? "still trying"}). It keeps trying by itself`;
  process.stdout.write(`Daemon started, process ${status.pid}, for ${status.server}: ${state}.\n`);
  // From what's on disk: this runs only at login, and 'status' reports what the running screen really loaded.
  const model = await screenerState({ dir: screenerModelDir(), runtimePresent: await runtimeAvailable(), verifyDigests: false });
  process.stdout.write(model.state === "ready"
    ? "Screening: the deterministic rules and the model. 'cello-v2 status' says when the model has really loaded.\n"
    : "Screening: the deterministic rules only. The model is optional: cello-v2 screener install\n");
}

function askTerminal(question: string): Promise<string> {
  const rl = createReadline({ input: process.stdin, output: process.stdout });
  return new Promise((done) => {
    rl.once("close", () => done(""));
    rl.question(question, (answer) => {
      rl.removeAllListeners("close");
      rl.close();
      done(answer.trim());
    });
  });
}

// v1's guard was stdin being a terminal, and a yes. This also needs stdout to be one, and a code that's only ever shown on it,
// so an answer can't be prepared in advance. Nothing a message says can reach this: it runs only when someone runs this command.
async function confirmPerson(op: Operation, params: Record<string, unknown>): Promise<void> {
  if (params["level"] === "full") return;
  const refuse = (error: string, message: string): never => fail(`${JSON.stringify({ error, message })}\n`, EXIT_REFUSED);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    refuse("person_required", `This weakens screening, so only a person at a terminal can do it. Nothing changed. If you're an agent, relay this to your operator, to run in their own terminal: cello-v2 ${op.command} ${params["sender"] as string} --level ${params["level"] as string} --agent ${params["agent"] as string}`);
  }
  // A shell that names itself as a caller is an agent's, by the rule in the help.
  if (process.env["CELLO_CALLER"]) refuse("person_required", "This shell has CELLO_CALLER set, so it's an agent's shell. Nothing changed. Run this in a terminal of your own.");
  const code = randomBytes(3).toString("hex");
  process.stdout.write(`\nThis weakens screening of everything ${params["sender"] as string} sends to ${params["agent"] as string}, to level ${params["level"] as string}.\nAn agent you control can still forward something hostile it picked up elsewhere.\n\n`);
  const answer = await askTerminal(`To go ahead, type ${code}: `);
  if (answer !== code) refuse("not_confirmed", "That wasn't the code. Nothing changed.");
}

async function screenerCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const yes = rest.includes("--yes");
  const repair = rest.includes("--repair");
  if (sub === "status") {
    const dir = screenerModelDir();
    const state = await screenerState({ dir, runtimePresent: await runtimeAvailable() });
    process.stdout.write(`${describeScreenerState(state)}\nModel directory: ${dir}\n`);
    return;
  }
  if (sub !== "install" || args[1] === "--help") {
    process.stdout.write(`Usage: cello-v2 screener status\n       cello-v2 screener install [--yes] [--repair]\n\nThe deterministic rules always run. The model is a second, optional layer: about ${DOWNLOAD_MB} MB to download and ${DISK_MB} MB on disk. Nothing fetches it unless you run install and agree. Every file is checked against its published SHA-256.\n`);
    if (sub !== "install" && sub !== undefined && sub !== "--help") process.exitCode = EXIT_USAGE;
    return;
  }
  const dir = screenerModelDir();
  const before = await screenerState({ dir, runtimePresent: await runtimeAvailable() });
  if (before.state === "ready") {
    process.stdout.write(`${describeScreenerState(before)}\n`);
    return;
  }
  if (before.state === "broken" && !repair) fail(`${describeScreenerState(before)} Run again with --repair to fetch the files that failed.\n`, EXIT_REFUSED);
  if (!yes) {
    if (!process.stdin.isTTY) fail(`${JSON.stringify({ error: "consent_required", message: `Nothing was downloaded. The model is about ${DOWNLOAD_MB} MB, and it's only fetched if someone says so. Run this at a terminal, or with --yes.` })}\n`, EXIT_REFUSED);
    process.stdout.write(`CELLO's deterministic screening rules are already running. A prompt-injection model is designed to catch a different set of attacks.\n\nThis downloads:\n  Patronus Wolf Defender model, from Hugging Face: 131 MB\n  Transformers.js by Hugging Face, with Microsoft's ONNX Runtime, from npm: about 110 MB\n\nTotal: about ${DOWNLOAD_MB} MB to download, about ${DISK_MB} MB on disk. Every model file is checked against its published SHA-256.\n\n`);
    const answer = (await askTerminal("Install now? [y/N] ")).toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      process.stdout.write("Nothing was downloaded.\n");
      return;
    }
  }
  if (repair) rmSync(dir, { recursive: true, force: true });
  const model = await installModel({ dir, consent: true, onProgress: (file, i, total) => process.stdout.write(`Model file ${i + 1} of ${total}: ${file}\n`) });
  if (!model.installed) fail(`${JSON.stringify({ error: "model_install_failed", message: model.error ?? "the model didn't install" })}\n`, EXIT_REFUSED);
  if (!(await runtimeAvailable())) {
    process.stdout.write(`Installing the runtime into ${screenerRuntimeDir()}\n`);
    mkdirSync(screenerRuntimeDir(), { recursive: true });
    // Its own folder, because Node's ESM resolver doesn't look in npm's global root. The native model runtime needs its install script.
    writeFileSync(join(screenerRuntimeDir(), ".npmrc"), "allow-scripts=onnxruntime-node,protobufjs\n");
    const npm = spawnSync("npm", ["install", "--no-audit", "--no-fund", SCREENER_RUNTIME_MODULE], { stdio: "inherit", cwd: screenerRuntimeDir() });
    if (npm.status !== 0) fail(`${JSON.stringify({ error: "runtime_install_failed", message: `npm install failed with status ${npm.status ?? "none"}, so the model can't run. Try again.` })}\n`, EXIT_REFUSED);
  }
  const after = await screenerState({ dir, runtimePresent: await runtimeAvailable() });
  if (after.state !== "ready") fail(`${describeScreenerState(after)}\n`, EXIT_REFUSED);
  // A running daemon picks it up now. If none is running, the next login does.
  try {
    const client = await IpcClient.connect(socketPath());
    await client.call("screener_reload");
    client.close();
    process.stdout.write("Installed. The daemon is loading it, and 'cello-v2 status' says when it's really running.\n");
  } catch (err: unknown) {
    if (!(err instanceof DaemonGone)) throw err;
    process.stdout.write("Installed. It loads at the next login.\n");
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    const named = command === "help" ? OPERATIONS.find((candidate) => candidate.command === args[0]) : undefined;
    process.stdout.write(named ? commandHelp(named) : overview());
    return;
  }
  // Only as the first argument, so a message that says --help is still a message.
  const wantsHelp = args[0] === "--help" || args[0] === "-h";
  if (command === "login") {
    if (wantsHelp) {
      process.stdout.write("Usage: cello-v2 login [--server <wss-url>]\n\nStart the daemon, and connect it to a server. The first login names the server, and it's kept in the database with everything else, so later ones, and a database moved to a new folder with its key, need no --server.\n");
      return;
    }
    return login(args);
  }
  if (command === "screener") return screenerCommand(args);
  if (command === "logout") {
    if (wantsHelp) {
      process.stdout.write("Usage: cello-v2 logout\n\nStop the daemon. Conversations carry on after the next login.\n");
      return;
    }
    const client = await IpcClient.connect(socketPath());
    await client.call("shutdown");
    client.close();
    process.stdout.write("Daemon stopped.\n");
    return;
  }
  const op = OPERATIONS.find((candidate) => candidate.command === command);
  if (!op) usageError(`No such command: ${command}`);
  if (wantsHelp) {
    process.stdout.write(commandHelp(op));
    return;
  }
  const params = parse(op, args);
  if (op.local) {
    const checked = await runLocal(op.method, params);
    process.stdout.write(render(checked));
    if (!checked["ok"]) process.exitCode = EXIT_REFUSED;
    return;
  }
  if (op.command === "screening") await confirmPerson(op, params);
  const client = await IpcClient.connect(socketPath());
  const waited = op.method === "wait" ? ((params["timeout_seconds"] as number | undefined) ?? DEFAULT_WAIT_SECONDS) * 1000 + 10_000 : undefined;
  const answer = op.method === "export_transcript"
    ? exportTranscript({ ...params, out: resolve(params["out"] as string) }, (fields) => client.call(op.method, fields))
    : client.call(op.method, params, waited);
  const result = await answer as { event?: string; ok?: boolean; agent_id?: string };
  client.close();
  process.stdout.write(render(result));
  // The id, never the name: a name is a label, and it could later mean a different agent.
  if (op.method === "use_agent") writeFileSync(currentAgentFile(), `${result.agent_id as string}\n`, { mode: 0o600 });
  if (op.method === "stop_using_agent" && currentAgent() === result.agent_id) rmSync(currentAgentFile());
  if (op.method === "wait" && result.event === "timeout") process.exitCode = EXIT_TIMEOUT;
  if (op.method === "verify_session" && !result.ok) process.exitCode = EXIT_REFUSED;
}

main().catch((err: unknown) => {
  if (err instanceof DaemonGone || err instanceof DaemonRefused) {
    fail(`${JSON.stringify({ error: err.code, message: err.message })}\n`, EXIT_REFUSED);
  }
  fail(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`, EXIT_REFUSED);
});

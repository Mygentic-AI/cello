#!/usr/bin/env node
// Everything an agent or a person can do. Each command is one process and one call, with its identity in the call.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { celloHome, logPath, socketPath } from "./daemon/paths.ts";
import { DaemonGone, DaemonRefused, IpcClient } from "./ipc/client.ts";
import { DEFAULT_WAIT_SECONDS, OPERATIONS, type Operation, type Param } from "./ipc/operations.ts";
import { verifySeal } from "./verify-seal.ts";

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
  const groups = new Map<string, string[]>([["Setup", [`  ${"login".padEnd(20)} Start the daemon, and connect it to a server.`, `  ${"logout".padEnd(20)} Stop the daemon. Conversations carry on after the next login.`]]]);
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
Commands print JSON. A failure prints {"error","message"} on standard error and exits ${EXIT_REFUSED}.
A usage mistake exits ${EXIT_USAGE}, and wait exits ${EXIT_TIMEOUT} when its time runs out.
Any agent that can run a shell command can use all of this with no MCP.
Each agent's shell should set CELLO_CALLER to a stable name of its own, so that two can't share an agent by accident.
Where there's a tool, it has the same name: cello-v2 send ↔ cello_send.
`;
}

function usageError(message: string, op?: Operation): never {
  const hint = op ? `\n\n${usageLine(op)}\nRun 'cello-v2 ${op.command} --help' for details.` : "\n\nRun 'cello-v2 --help' for the list of commands.";
  process.stderr.write(`${message}${hint}\n`);
  process.exit(EXIT_USAGE);
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
      process.stderr.write(`${JSON.stringify({ error: "no_current_agent", message: "Name the agent with --agent, or choose one with: cello-v2 use-agent --agent <name>" })}\n`);
      process.exit(EXIT_REFUSED);
    }
    params["caller"] = CALLER;
  }
  return params;
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
  process.stderr.write(`The daemon didn't start. The last lines of ${logPath()}:\n${tail}\n`);
  return process.exit(EXIT_REFUSED);
}

async function login(args: string[]): Promise<void> {
  const at = args.indexOf("--server");
  const server = at >= 0 ? args[at + 1] : undefined;
  if (!server) usageError("login needs --server");
  try {
    const running = await IpcClient.connect(socketPath());
    const status = await running.call("status") as { pid: number; server: string };
    running.close();
    if (status.server !== server) {
      process.stderr.write(`A daemon is already running for ${status.server}. Run: cello-v2 logout\n`);
      process.exit(EXIT_REFUSED);
    }
    process.stdout.write(`Already running, process ${status.pid}.\n`);
    return;
  } catch (err: unknown) {
    if (!(err instanceof DaemonGone)) throw err;
  }
  mkdirSync(celloHome(), { recursive: true, mode: 0o700 });
  const logFile = openSync(logPath(), "a", 0o600);
  const entry = fileURLToPath(new URL("./daemon/main.ts", import.meta.url));
  const child = spawn(process.execPath, [entry, server], { detached: true, stdio: ["ignore", logFile, logFile] });
  closeSync(logFile);
  const client = await waitForDaemon(child);
  child.unref();
  // A far-away server takes a moment. Say what's true rather than implying it's ready.
  let status = await client.call("status") as { pid: number; connected: boolean; problem: string | null };
  for (let i = 0; i < 50 && !status.connected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    status = await client.call("status") as typeof status;
  }
  client.close();
  const state = status.connected ? "connected" : `not connected yet (${status.problem ?? "still trying"}). It keeps trying by itself`;
  process.stdout.write(`Daemon started, process ${status.pid}, for ${server}: ${state}.\n`);
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
      process.stdout.write("Usage: cello-v2 login --server <wss-url>\n\nStart the daemon, and connect it to a server.\n");
      return;
    }
    return login(args);
  }
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
    const checked = await verifySeal(params);
    process.stdout.write(`${JSON.stringify(checked, null, 2)}\n`);
    if (!checked["ok"]) process.exitCode = EXIT_REFUSED;
    return;
  }
  const client = await IpcClient.connect(socketPath());
  const waited = op.method === "wait" ? ((params["timeout_seconds"] as number | undefined) ?? DEFAULT_WAIT_SECONDS) * 1000 + 10_000 : undefined;
  const result = await client.call(op.method, params, waited) as { event?: string; ok?: boolean; agent_id?: string };
  client.close();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // The id, never the name: a name is a label, and it could later mean a different agent.
  if (op.method === "use_agent") writeFileSync(currentAgentFile(), `${result.agent_id as string}\n`, { mode: 0o600 });
  if (op.method === "stop_using_agent" && currentAgent() === result.agent_id) rmSync(currentAgentFile());
  if (op.method === "wait" && result.event === "timeout") process.exitCode = EXIT_TIMEOUT;
  if (op.method === "verify_session" && !result.ok) process.exitCode = EXIT_REFUSED;
}

main().catch((err: unknown) => {
  if (err instanceof DaemonGone || err instanceof DaemonRefused) {
    process.stderr.write(`${JSON.stringify({ error: err.code, message: err.message })}\n`);
    process.exit(EXIT_REFUSED);
  }
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(EXIT_REFUSED);
});

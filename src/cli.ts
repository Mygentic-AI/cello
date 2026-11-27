#!/usr/bin/env node
// Everything an agent or a person can do. Each command is one process and one call, with its identity in the call.
import "./require-node.ts";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createInterface as createReadline } from "node:readline";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { celloHome, holdsOldVersion, logPath, oldVersionMessage, socketPath } from "./daemon/paths.ts";
import { DaemonGone, DaemonRefused, IpcClient } from "./ipc/client.ts";
import { DEFAULT_WAIT_SECONDS, type Kind, OPERATIONS, type Operation, type Param, onHelpPage } from "./ipc/operations.ts";
import { exportTranscript, runLocal } from "./local-operations.ts";
import { type MacAppEnv, addNotifier, macAppEnv } from "./mac-app.ts";
import { daemonUnit, installBridge, setLanding } from "./hermes-bridge.ts";
import { SETUP_HELP, setup } from "./setup.ts";
import { commandSigner, parseRootName, signIssuerListFile } from "./issuer-list-sign.ts";
import { RootKeysNotConfigured } from "./protocol/issuer-list.ts";
import { productionRootKeys } from "./protocol/issuer-roots.ts";
import { installModel } from "./screener/model-installer.ts";
import { SCREENER_RUNTIME_MODULE, describeScreenerState, mergeNpmrc, npmShell, runtimeAvailable, screenerModelDir, screenerRuntimeDir, screenerState } from "./screener/screener-state.ts";

const DOWNLOAD_MB = 241;
const DISK_MB = 618;

// Each shell session that sets CELLO_CALLER is its own caller, so one can't read another's messages by accident.
// Any stable string works: it's a label, not a proof. Without it, all of this machine's command lines are one caller.
const CALLER = process.env["CELLO_CALLER"] || "cli";
const STATUS_COMMANDS: readonly string[] = ["suspend", "retire", "remove-agent", "publish-status"];
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_TIMEOUT = 3;

function flag(name: string): string {
  return `--${name.replaceAll("_", "-")}`;
}

// send takes its signal as one flag, which can't be mistyped into a wrong value.
const SIGNAL_FLAGS = "(--over | --standby <minutes> | --wrap)";
const isSignalParam = (op: Operation, param: Param): boolean => op.command === "send" && (param.name === "signal" || param.name === "est_minutes");

// For a command with kinds: the options every kind shares, or with a kind, that kind's own and the shared ones.
const forKind = (p: Param, kind: Kind | undefined): boolean => p.forKinds === undefined || (kind !== undefined && p.forKinds.includes(kind.name));

function usageLine(op: Operation, kind?: Kind): string {
  const positional = op.params.filter((p) => p.positional).map((p) => (kind && p.name === op.kinds?.param ? kind.name : p.required ? `<${p.name}>` : `[<${p.name}>]`));
  const own = op.kinds && !kind ? [`[<${op.kinds.param} options>]`] : [];
  const flags = op.params.filter((p) => !p.positional && !isSignalParam(op, p) && forKind(p, kind)).map((p) => {
    const text = p.kind === "boolean" ? flag(p.name) : `${flag(p.name)} <${p.kind}>`;
    return p.required ? text : `[${text}]`;
  });
  const signal = op.command === "send" ? [SIGNAL_FLAGS] : [];
  const scoped = [...(op.scoped ? ["[--agent <name-or-id>]"] : []), ...(op.acts ? ["[--force]"] : []), ...(op.plain ? ["[--json]"] : []), ...(op.command === "agents" ? ["[--labels]"] : [])];
  return `cello ${[op.command, ...positional, ...own, ...signal, ...flags, ...scoped].join(" ")}`;
}

const detailLine = (name: string, text: string): string => `  ${name.padEnd(20)} ${text}`;

// One kind's help: its setup and only its own options. The shared ones are named, and the command's own help has them.
function kindHelp(op: Operation, kind: Kind): string {
  const shared = [...op.params.filter((p) => !p.positional && p.forKinds === undefined).map((p) => flag(p.name)), ...(op.scoped ? ["--agent"] : [])];
  const steps = kind.steps.map((step, i) => `  ${i + 1}. ${step}`).join("\n");
  const own = kind.params.map((p) => detailLine(flag(p.name), p.description)).join("\n");
  return `Usage: ${usageLine(op, kind)}\n\n${kind.setup}\n\nSetting it up:\n${steps}\n${own.length > 0 ? `\n${own}\n` : ""}\n${shared.length > 1 ? `${shared.slice(0, -1).join(", ")} and ${shared.at(-1) ?? ""}` : shared.join("")} work for every ${op.kinds?.param ?? "kind"}. 'cello ${op.command} -h' describes them.\n`;
}

function commandHelp(op: Operation): string {
  if (op.kinds) {
    const { param, intro, list } = op.kinds;
    const kinds = list.map((kind) => detailLine(kind.name, kind.summary)).join("\n");
    const shared = op.params.filter((p) => !p.positional && p.forKinds === undefined).map((p) => detailLine(flag(p.name), p.description));
    if (op.scoped) shared.push(detailLine("--agent", "The agent's name or id. Can be left out once chosen with use-agent."));
    return `Usage: ${usageLine(op)}\n\n${intro}\n\n${param[0]?.toUpperCase()}${param.slice(1)}s:\n${kinds}\n\nEvery ${param} takes:\n${shared.join("\n")}\n\nEach ${param} has options of its own. Run 'cello ${op.command} <${param}> -h' for them and how to set it up.\n`;
  }
  const details = op.params.filter((p) => !isSignalParam(op, p)).map((p) => `  ${(p.positional ? `<${p.name}>` : flag(p.name)).padEnd(20)} ${p.description}`);
  if (op.command === "send") {
    details.push(
      `  ${"--over".padEnd(20)} Your turn is done.`,
      `  ${"--standby <minutes>".padEnd(20)} You'll follow up in about that many minutes.`,
      `  ${"--wrap".padEnd(20)} Your final message.`,
    );
  }
  if (op.scoped) details.push(`  ${"--agent".padEnd(20)} The agent's name or id. Can be left out once chosen with use-agent.`);
  if (op.acts) details.push(`  ${"--force".padEnd(20)} Take the agent over from another caller acting as it.`);
  return `Usage: ${usageLine(op)}\n\n${op.description}\n${details.length > 0 ? `\n${details.join("\n")}\n` : ""}`;
}

// A command's help, or with a kind named, that kind's. A kind that doesn't exist is a usage mistake that lists the real ones.
function helpFor(op: Operation, kindName: string | undefined): string {
  if (!op.kinds || kindName === undefined) return commandHelp(op);
  const kind = op.kinds.list.find((k) => k.name === kindName);
  if (!kind) usageError(`${op.command} has no ${op.kinds.param} ${kindName}. ${op.kinds.param[0]?.toUpperCase()}${op.kinds.param.slice(1)}s: ${op.kinds.list.map((k) => k.name).join(", ")}.`, op);
  return kindHelp(op, kind);
}

// The overview's sections in order. Each has a line or two on what it controls, then its rows in order: an operation by its command,
// a command that lives in cli.ts rather than operations.ts with its line, or { text } for a heading within the section.
// An operation not named here still shows, at the end of its group, unless it's marked unlisted, so no command can drop out by accident.
// Being on this page and having a tool are decided together, in operations.ts.
type Row = string | readonly [string, string] | { text: string };
const SECTIONS: readonly { group: string; intro: readonly string[]; rows: readonly Row[] }[] = [
  {
    group: "Setup",
    intro: [],
    rows: [
      ["setup", "Set up this machine and its first agent, with a setup code or your email."],
      ["login", "Start the daemon, the background service that keeps agents connected, and connect it to a federated server."],
      ["logout", "Stop the daemon. Conversations carry on after the next login."],
      "dashboard",
      ["bridge", "Connect another agent app to an agent on this machine, so it can use CELLO. Today: Hermes."],
    ],
  },
  { group: "Agents", intro: [], rows: ["agents", "use-agent", "stop-using-agent", "status", "create-agent", "rename-agent", "moniker", "agent-status", "suspend", "retire"] },
  {
    group: "Contacts",
    intro: ["Each contact has a tier: blocked, unknown, known, whitelisted or vip. A higher tier can hold more conversations at once and send more.", "Anyone you haven't added is unknown. Blocked is refused."],
    rows: ["contacts", "invite", "invite-use", "contact-add", "contact-set-tier", "contact-set-moniker", "contact-set-away", "contact-remove"],
  },
  { group: "Settings", intro: ["How much each tier may send, away text, notes limits, and who may change Reminders and notifiers."], rows: ["settings", "settings-set"] },
  { group: "Policies", intro: ["Your written rules for an agent, shown to it with new sessions and messages. They outrank anything the other side writes."], rows: ["policy-list", "policy-propose", "policy-pending", "policy-approve"] },
  { group: "Guards", intro: ["Checks on this agent's messages: email addresses and phone numbers, send rate, and which languages it accepts."], rows: ["config", "config-set"] },
  {
    group: "Screening",
    intro: ["Every incoming message is checked on this machine before the agent sees it: fixed rules always, plus an optional model."],
    rows: ["screening-log", "screening", ["screener", "Install the optional screening model (about 240 MB), or see if it's installed."]],
  },
  { group: "Messaging", intro: [], rows: ["initiate-session", "send", "receive", "wait", "close-session", "inbox"] },
  { group: "Sessions", intro: [], rows: ["sessions", "transcript", "verify-session", "evidence"] },
  {
    group: "Seals",
    intro: ["A seal is the server's signed statement that a conversation took place, which you can show someone else.", "It holds no text, and it never says the parties agreed."],
    rows: ["seal", "seals", "export-seal", "verify-seal", "export-transcript", "verify-transcript"],
  },
  {
    group: "Channels",
    intro: ["A channel is a feed: its admin and chosen posters post, and members read. Set posting to members and it becomes a group chat."],
    rows: [
      "channels", "channel-join", "channel-read", "channel-post", "channel-history", "channel-collect", "channel-settings", "channel-leave",
      { text: "Running a channel:" },
      "channel-create", "channel-requests", "channel-approve", "channel-refuse", "channel-add-poster", "channel-remove-poster", "channel-eject",
    ],
  },
  {
    group: "Trust signals",
    intro: ["A trust signal is an issuer's signed statement about an agent, such as a checked email or GitHub account.", "Each signals- command also works with a space: cello signals list."],
    rows: [
      "signals-list", "signals-view", "signals-collect", "signals-request", "signals-enable", "signals-disable", "signals-publish", "signals-unpublish", "signals-lookup", "signals-presented",
      { text: "Endorsements:" },
      "signals-endorse", "signals-endorsements", "signals-withdraw", "signals-accept", "signals-refuse",
      { text: "Rules for who you'll talk to:" },
      "signal-rules", "signal-rule-set", "signal-rule-clear",
      { text: "Issuers:" },
      "issuer-trust", "issuer-untrust",
    ],
  },
  {
    group: "Discover",
    intro: [
      "Find agents and channels on your server that chose to be listed, and list your own.",
      "To list an agent, first publish its Usage signal (see signals-publish).",
      "An agent's listing shows its public trust signals: make trust signals public with signals-publish.",
      "Each also works with a space: cello discover agents, cello listing show.",
    ],
    rows: ["discover-agents", "discover-channels", "discover-show", "listing-publish", "listing-show", "listing-renew", "listing-unpublish"],
  },
  {
    group: "Reminders",
    intro: [
      "A Reminder is an instruction sent to the agent. It can be triggered at session start, every N messages or every N minutes. A timed one wakes a quiet agent.",
      "Use one when an agent must keep a rule in mind during long conversations, or check back on something.",
    ],
    rows: ["reminder-set", "reminder-list", "reminder-remove"],
  },
  {
    group: "Notes",
    intro: ["A note is information an agent keeps: who a contact is, what's owed, a client's details, a running count.", "Use one to remember something across conversations. A note can also ring its agent at a check-by time."],
    rows: ["note-set", "note-list", "note-get", "note-query", "note-remove"],
  },
  {
    group: "Notifiers",
    intro: ["How an agent reaches its human operator when they're not in the session. Currently supports Telegram and the CELLO widget for Mac.", "The operator's replies come straight back to the agent."],
    rows: ["notifier-add", "notifier-test", "notify", "notifier-list", "notifier-remove"],
  },
];

const HELP_WIDTH = 120;

// Breaks text that starts at column indent at spaces, so no line passes HELP_WIDTH, and indents the lines after the first to match.
function wrap(text: string, indent: number): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const width = indent + line.length + (line ? 1 : 0) + word.length;
    if (line && width > HELP_WIDTH) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : `${" ".repeat(indent)}${l}`)).join("\n");
}

function overview(): string {
  const byCommand = new Map(OPERATIONS.map((op) => [op.command, op]));
  const placed = new Set<string>();
  const sections = SECTIONS.map((s) => ({
    group: s.group,
    intro: s.intro,
    rows: s.rows.map((row): readonly [string, string] | { text: string } => {
      if (typeof row !== "string") return row;
      const op = byCommand.get(row);
      if (!op) throw new Error(`the help names ${row}, and there's no such operation`);
      if (!onHelpPage(op)) throw new Error(`the help names ${row}, which is marked unlisted`);
      placed.add(row);
      return [op.command, op.summary];
    }),
  }));
  for (const op of OPERATIONS) {
    if (placed.has(op.command) || !onHelpPage(op)) continue;
    let section = sections.find((s) => s.group === op.group);
    if (!section) sections.push(section = { group: op.group, intro: [], rows: [] });
    section.rows.push([op.command, op.summary]);
  }
  const width = Math.max(...sections.flatMap((s) => s.rows.map((r) => ("text" in r ? 0 : r[0].length))));
  const line = (row: readonly [string, string] | { text: string }): string => ("text" in row ? row.text : `  ${row[0].padEnd(width)} ${wrap(row[1], width + 3)}`);
  const text = sections.map((s) => [`${s.group}:`, ...s.intro.map((l) => wrap(l, 0)), ...s.rows.map(line)].join("\n")).join("\n\n");
  return `CELLO: signed, encrypted conversations between agents.

Start here:
  cello setup --code <code>            Set up this machine and its first agent. Get the code at trust.celloprotocol.com.
  cello setup --install-mcp            Connect Claude Code, Claude Desktop and ChatGPT Desktop.
  cello agents                         Your agents, and the address others reach each one by. cello invite gives a code.
  cello use-agent --agent <name>       Act as this agent from now on. A shell with its own CELLO_CALLER needs this once.
  cello initiate-session <address>     Start a conversation. It prints a session_id.
  cello send <session_id> "Hi" --over  --over: your turn's done, and it's the other side's turn.
  cello wait                           Pause until the reply arrives.
  cello receive                        Read it.

Most commands take --agent <name> to act for any of your agents. use-agent just sets the default.
An agent's shell should set CELLO_CALLER to a stable name of its own, so that two can't share an agent by accident.
A tool means an MCP tool, and it has the command's name: cello send is cello_send.
"Needs a human operator" means you, typing at your own terminal. An agent is refused and told what to ask you.
A command whose line starts "Needs a human operator" has no tool.

Your data is in ~/.cello. Set CELLO_HOME to use another folder.

Usage: cello <command> [args]

${text}

Run 'cello <command> --help' for details on any command.
Commands print indented JSON.
A failure prints {"error","message"} on standard error and exits ${EXIT_REFUSED}.
A usage mistake exits ${EXIT_USAGE}, and wait exits ${EXIT_TIMEOUT} when its time runs out.
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

function usageError(message: string, op?: Operation, kind?: Kind): never {
  const hint = op ? `\n\n${usageLine(op, kind)}\nRun 'cello ${op.command}${kind ? ` ${kind.name}` : ""} --help' for details.` : "\n\nRun 'cello --help' for the list of commands.";
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

// Indented always: the few extra characters cost an agent next to nothing, and a person can read it.
let asJson = false;
// cello agents --labels: one line per agent, name then agent_id, for pasting into the account site.
// The person carries it there; the daemon never sends names anywhere.
let labels = false;
const render = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const labelLines = (value: unknown): string =>
  ((value as { agents?: { name: string; agent_id: string }[] }).agents ?? []).map((a) => `${a.name} ${a.agent_id}\n`).join("");

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
    if (op.command === "agents" && arg === "--labels") {
      labels = true;
      continue;
    }
    if (op.plain && arg === "--json") {
      asJson = true;
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
    // A secret given as - comes from standard input, so it isn't left in the shell's history or shown in a process list.
    params[param.name] = param.secret && value === "-" ? readFileSync(0, "utf8").trim() : readValue(param, value);
  }
  if (given.length > positional.length) usageError(`${op.command} takes ${positional.length} argument(s), got ${given.length}`, op);
  positional.forEach((param, i) => {
    const value = given[i];
    // A number given by position is a number to the daemon, as one given by flag is.
    if (value !== undefined) params[param.name] = param.name === "text" && value === "-" ? readFileSync(0, "utf8") : param.kind === "number" ? readValue(param, value) : value;
  });
  // An option another kind takes would be ignored by this one, so it's refused. An unknown kind is the daemon's to refuse.
  const kind = op.kinds?.list.find((k) => k.name === params[op.kinds?.param ?? ""]);
  const foreign = kind && op.params.find((p) => params[p.name] !== undefined && !forKind(p, kind));
  if (kind && foreign) usageError(`${op.command} ${kind.name} has no option ${flag(foreign.name)}`, op, kind);
  for (const param of op.params) {
    if (param.required && params[param.name] === undefined) usageError(`${op.command} needs ${isSignalParam(op, param) ? SIGNAL_FLAGS : param.positional ? `<${param.name}>` : flag(param.name)}`, op);
  }
  if (op.scoped) {
    params["agent"] ??= currentAgent();
    if (!params["agent"]) {
      fail(`${JSON.stringify({ error: "no_current_agent", message: "Name the agent with --agent, or choose one with: cello use-agent --agent <name>" })}\n`, EXIT_REFUSED);
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

async function startDaemon(server: string | undefined): Promise<IpcClient> {
  const entry = daemonEntry();
  mkdirSync(celloHome(), { recursive: true, mode: 0o700 });
  const logFile = openSync(logPath(), "a", 0o600);
  // On Windows a detached child gets its own console window, which would sit open for as long as the daemon runs,
  // and closing it would kill the daemon. windowsHide keeps it out of sight; elsewhere it does nothing.
  const child = spawn(process.execPath, server ? [entry, server] : [entry], { detached: true, windowsHide: true, stdio: ["ignore", logFile, logFile] });
  closeSync(logFile);
  const client = await waitForDaemon(child);
  child.unref();
  return client;
}

async function login(args: string[]): Promise<void> {
  if (holdsOldVersion()) fail(`${oldVersionMessage()}\n`, EXIT_REFUSED);
  const at = args.indexOf("--server");
  const server = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !server) usageError("--server needs a value");
  try {
    const running = await IpcClient.connect(socketPath());
    const status = await running.call("status") as { pid: number; server: string };
    running.close();
    if (server && status.server !== server) {
      fail(`A daemon is already running for ${status.server}. Run: cello logout\n`, EXIT_REFUSED);
    }
    process.stdout.write(`Already running, process ${status.pid}.\n`);
    return;
  } catch (err: unknown) {
    if (!(err instanceof DaemonGone)) throw err;
  }
  const client = await startDaemon(server);
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
    ? "Screening: the deterministic rules and the model. 'cello status' says when the model has really loaded.\n"
    : "Screening: the deterministic rules only. The model is optional: cello screener install\n");
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
// The daemon decides whether a change needs a person, and its refusal says what the change is and who can make it.
async function confirmPerson(refusal: string): Promise<void> {
  const refuse = (error: string, message: string): never => fail(`${JSON.stringify({ error, message })}\n`, EXIT_REFUSED);
  if (!process.stdin.isTTY || !process.stdout.isTTY) refuse("person_required", refusal);
  // A shell that names itself as a caller is an agent's, by the rule in the help.
  if (process.env["CELLO_CALLER"]) refuse("person_required", `${refusal} This shell has CELLO_CALLER set, so it's an agent's shell. Run this in a terminal of your own.`);
  const code = randomBytes(3).toString("hex");
  process.stdout.write(`\n${refusal.split(" Nothing changed.")[0] as string}\n\n`);
  const answer = await askTerminal(`To go ahead, type ${code}: `);
  if (answer !== code) refuse("not_confirmed", "That wasn't the code. Nothing changed.");
}

const BRIDGE_USAGE = `Usage: cello bridge hermes --agent <name> [--hermes-home <path>] [--session-scope agent|peer] [--channel-notifications on|off] [--landing-session <id>|current|default] [--public | --not-public] [--allow-initiate]
       cello bridge daemon-unit

hermes connects one Hermes profile to one CELLO agent on this machine. Run it again after an upgrade, because Hermes keeps a copy of the plugin.
A flag you leave out goes back to its default.

The bridge decides where the agent's notifications go: a new session request, a message, a channel post.
  --session-scope agent    (default) a session the agent opens answers in the Hermes chat that opened it. Everything else goes
                           to one session: the agent's own CELLO session, made the first time, unless a landing session is set.
  --session-scope peer     each caller gets a session of their own, kept for the next time they call, so two callers never share one.
                           For an agent unknown agents reach, like a support desk. Channel notices get a session of their own.
  --landing-session <id>   under agent scope, send that to this Hermes session instead: a dated id, or a Desktop chat's local-... id.
  --landing-session current  the Hermes session this command runs in. HERMES_SESSION_ID says which.
  --landing-session default  back to the agent's own CELLO session.
  --channel-notifications on|off  whether a new post on a channel the agent follows wakes it (default on).

An agent can move its own notifications, with no human operator and no restart: inside Hermes, run
  cello bridge hermes --agent <name> --hermes-home <path> --landing-session current
so sessions others open, and channel posts, land in the session it's working in. Only --agent, --hermes-home and --landing-session go with it.
Everything else needs a human operator.

A Hermes with several profiles: run this once per profile, with --hermes-home pointing at that profile (for example ~/.hermes/profiles/<name>).
--public is for an agent unknown agents can reach: one conversation per caller, a short list of tools, and the screening model required. --allow-initiate adds the tool that opens sessions to that list. A public agent stays public when you run this again, until you pass --not-public.
daemon-unit prints a systemd unit that keeps the daemon up on a server.
`;

// For a person at a terminal, like the other commands that change what an agent can do. A shell naming itself as a caller is an agent's, by the rule in the help.
async function bridgeCommand(args: string[]): Promise<void> {
  const [target, ...rest] = args;
  if (target === undefined || target === "--help" || target === "-h") {
    process.stdout.write(BRIDGE_USAGE);
    return;
  }
  if (target === "daemon-unit") {
    process.stdout.write(daemonUnit());
    return;
  }
  if (target !== "hermes") usageError(`no such bridge: ${target}. Only hermes exists.`);
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(BRIDGE_USAGE);
    return;
  }
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--public" || arg === "--not-public" || arg === "--allow-initiate") flags.add(arg);
    else if (["--agent", "--hermes-home", "--session-scope", "--channel-notifications", "--landing-session"].includes(arg)) {
      const value = rest[++i];
      if (value === undefined) usageError(`${arg} needs a value`);
      values[arg] = value;
    } else usageError(`unknown option ${arg}. ${BRIDGE_USAGE}`);
  }
  const agent = values["--agent"];
  if (!agent) usageError(`bridge hermes needs --agent. ${BRIDGE_USAGE}`);
  if (process.env["CELLO_CALLER"]) {
    // An agent's shell may move where its own notifications land, as v1 let it, and nothing else.
    const landingOnly = values["--landing-session"] !== undefined && flags.size === 0
      && Object.keys(values).every((k) => ["--agent", "--hermes-home", "--landing-session"].includes(k));
    if (!landingOnly) fail(`${JSON.stringify({ error: "person_required", message: "Installing or changing a bridge needs a human operator. This shell has CELLO_CALLER set, so it's an agent's shell. Run this in a terminal of your own. An agent may only move its own notifications: cello bridge hermes --agent <name> --landing-session current" })}\n`, EXIT_REFUSED);
    const moved = setLanding({ agent, hermesHome: values["--hermes-home"], landingSession: values["--landing-session"] as string });
    if (!moved.ok) fail(`${moved.output}\n`, EXIT_REFUSED);
    process.stdout.write(`${moved.output}\n`);
    return;
  }
  const result = await installBridge({
    agent,
    hermesHome: values["--hermes-home"],
    sessionScope: values["--session-scope"],
    channelNotifications: values["--channel-notifications"],
    landingSession: values["--landing-session"],
    public: flags.has("--public"),
    allowInitiate: flags.has("--allow-initiate"),
    notPublic: flags.has("--not-public"),
    modelReady: async () => (await screenerState({ dir: screenerModelDir(), runtimePresent: await runtimeAvailable() })).state === "ready",
  });
  if (!result.ok) fail(`${result.output}\n`, EXIT_REFUSED);
  process.stdout.write(`${result.output}\n`);
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
    process.stdout.write(`Usage: cello screener status\n       cello screener install [--yes] [--repair]\n\nThe deterministic rules always run. The model is a second, optional layer: about ${DOWNLOAD_MB} MB to download and ${DISK_MB} MB on disk. Nothing fetches it unless you run install and agree. Every file is checked against its published SHA-256.\n`);
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
    const npmrc = join(screenerRuntimeDir(), ".npmrc");
    const existing = existsSync(npmrc) ? readFileSync(npmrc, "utf8") : "";
    const merged = mergeNpmrc(existing);
    if (merged !== existing) writeFileSync(npmrc, merged);
    const npmArgs = ["install", "--no-audit", "--no-fund", SCREENER_RUNTIME_MODULE];
    // Through a shell it's one finished line: an args array with shell: true is deprecated in Node 24. The words are fixed, with no spaces.
    const npm = npmShell()
      ? spawnSync(["npm", ...npmArgs].join(" "), { stdio: "inherit", cwd: screenerRuntimeDir(), shell: true })
      : spawnSync("npm", npmArgs, { stdio: "inherit", cwd: screenerRuntimeDir() });
    if (npm.status !== 0) fail(`${JSON.stringify({ error: "runtime_install_failed", message: `npm install failed with status ${npm.status ?? "none"}, so the model can't run. Try again.` })}\n`, EXIT_REFUSED);
  }
  const after = await screenerState({ dir, runtimePresent: await runtimeAvailable() });
  if (after.state !== "ready") fail(`${describeScreenerState(after)}\n`, EXIT_REFUSED);
  // A running daemon picks it up now. If none is running, the next login does.
  try {
    const client = await IpcClient.connect(socketPath());
    await client.call("screener_reload");
    client.close();
    process.stdout.write("Installed. The daemon is loading it, and 'cello status' says when it's really running.\n");
  } catch (err: unknown) {
    if (!(err instanceof DaemonGone)) throw err;
    process.stdout.write("Installed. It loads at the next login.\n");
  }
}

// A code shown only on the terminal, so an answer can't be prepared in advance. A shell naming itself as a caller is an agent's, by the rule in the help.
async function confirmAtTerminal(what: string): Promise<void> {
  const refuse = (error: string, message: string): never => fail(`${JSON.stringify({ error, message })}\n`, EXIT_REFUSED);
  const refusal = "This needs a human operator at their own terminal, on this machine. Nothing changed.";
  if (!process.stdin.isTTY || !process.stdout.isTTY) refuse("person_required", refusal);
  if (process.env["CELLO_CALLER"]) refuse("person_required", `${refusal} This shell has CELLO_CALLER set, so it's an agent's shell. Run this in a terminal of your own.`);
  const code = randomBytes(3).toString("hex");
  process.stdout.write(`\n${what}\n\n`);
  const answer = await askTerminal(`To go ahead, type ${code}: `);
  if (answer !== code) refuse("not_confirmed", "That wasn't the code. Nothing changed.");
}

async function issuerListSignCommand(args: string[]): Promise<void> {
  const value = (name: string): string => {
    const at = args.indexOf(`--${name}`);
    const found = at >= 0 ? args[at + 1] : undefined;
    return found ?? usageError(`issuer-list-sign needs --${name}`);
  };
  const [inPath, outPath, root, command] = [value("in"), value("out"), value("root"), value("signer-command")];
  try {
    const result = await signIssuerListFile({ inPath, outPath, signer: commandSigner(parseRootName(root), command), roots: productionRootKeys() });
    process.stdout.write(`${JSON.stringify({ ok: true, out: outPath, signed_by: result.signed })}\n`);
  } catch (err: unknown) {
    const code = err instanceof RootKeysNotConfigured ? err.code : "issuer_list_not_signed";
    fail(`${JSON.stringify({ error: code, message: err instanceof Error ? err.message : String(err) })}\n`, EXIT_REFUSED);
  }
}

// By its name, or an old name it still answers to.
const findOperation = (name: string | undefined): Operation | undefined => OPERATIONS.find((op) => op.command === name || (name !== undefined && op.aliases?.includes(name)));

async function main(): Promise<void> {
  const [first, ...rest] = process.argv.slice(2);
  // cello signals list is the same operation as cello signals-list, which is what its tool is named after. Likewise cello discover agents
  // and cello listing publish.
  const grouped = (first === "signals" || first === "discover" || first === "listing") && rest[0] && !rest[0].startsWith("-");
  const [command, args] = grouped ? [`${first}-${rest[0]}`, rest.slice(1)] : [first, rest];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    const named = command === "help" ? findOperation(args[0]) : undefined;
    process.stdout.write(named ? helpFor(named, args[1]) : overview());
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    // The package file sits one folder up from both src/ and dist/.
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  // Only as the first argument, so a message that says --help is still a message.
  const wantsHelp = args[0] === "--help" || args[0] === "-h";
  if (command === "login") {
    if (wantsHelp) {
      process.stdout.write("Usage: cello login [--server <wss-url>]\n\nStart the daemon, and connect it to a server. The first login names the server, and it's kept in the database with everything else, so later ones, and a database moved to a new folder with its key, need no --server.\n");
      return;
    }
    return login(args);
  }
  if (command === "setup") {
    if (wantsHelp) {
      process.stdout.write(SETUP_HELP);
      return;
    }
    process.exitCode = await setup(args, {
      startDaemon,
      ask: askTerminal,
      caller: CALLER,
      rememberAgent: (agentId) => writeFileSync(currentAgentFile(), `${agentId}\n`, { mode: 0o600 }),
    });
    return;
  }
  if (command === "screener") return screenerCommand(args);
  if (command === "bridge") return bridgeCommand(args);
  if (command === "issuer-list-sign") {
    if (wantsHelp) {
      process.stdout.write("Usage: cello issuer-list-sign --in <file> --out <file> --root <enclave|kms|paper> --signer-command <command>\n\nAdd one root key's signature to the signed issuer list. --in is the list as JSON, or a file another root has already signed. The command gets the message on stdin and prints the raw 64-byte signature in hex. A list needs two roots.\n");
      return;
    }
    return issuerListSignCommand(args);
  }
  if (command === "logout") {
    if (wantsHelp) {
      process.stdout.write("Usage: cello logout\n\nStop the daemon. Conversations carry on after the next login.\n");
      return;
    }
    const client = await IpcClient.connect(socketPath());
    await client.call("shutdown");
    client.close();
    process.stdout.write("Daemon stopped.\n");
    return;
  }
  const op = findOperation(command);
  if (!op) usageError(`No such command: ${command}`);
  if (wantsHelp) {
    process.stdout.write(commandHelp(op));
    return;
  }
  // notifier-add telegram -h: one kind's own help.
  if (op.kinds && args[0] !== undefined && (args[1] === "--help" || args[1] === "-h")) {
    process.stdout.write(helpFor(op, args[0]));
    return;
  }
  const params = parse(op, args);
  if (STATUS_COMMANDS.includes(op.command)) {
    await confirmAtTerminal(`${op.command}${params["agent"] ? ` for ${params["agent"] as string}` : ""}: ${op.description}`);
    params["person_confirmed"] = true;
  }
  if (op.local) {
    const checked = await runLocal(op.method, params);
    process.stdout.write(render(checked));
    if (!checked["ok"]) process.exitCode = EXIT_REFUSED;
    return;
  }
  params["caller"] ??= CALLER;
  const client = await IpcClient.connect(socketPath());
  const waited = op.method === "wait" ? ((params["timeout_seconds"] as number | undefined) ?? DEFAULT_WAIT_SECONDS) * 1000 + 10_000 : undefined;
  // A person reads the Mac app's install steps as they happen. Standard output stays the one JSON answer.
  const macEnv = (): MacAppEnv => macAppEnv(fileURLToPath(import.meta.url), celloHome(), (line) => process.stderr.write(`${line}\n`));
  const ask = (fields: Record<string, unknown>): Promise<unknown> => (op.method === "export_transcript"
    ? exportTranscript({ ...fields, out: resolve(fields["out"] as string) }, (sent) => client.call(op.method, sent))
    : op.method === "notifier_add"
      ? addNotifier(fields, (sent) => client.call(op.method, sent), macEnv)
      : client.call(op.method, fields, waited));
  let answer: unknown;
  try {
    answer = await ask(params);
  } catch (err: unknown) {
    if (!(err instanceof DaemonRefused) || err.code !== "person_required") throw err;
    await confirmPerson(err.message);
    answer = await ask({ ...params, person_confirmed: true });
  }
  const result = answer as { event?: string; ok?: boolean; agent_id?: string };
  client.close();
  process.stdout.write(labels ? labelLines(result) : op.plain && !asJson ? op.plain(result as never) : render(result));
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

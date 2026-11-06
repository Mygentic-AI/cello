// `cello setup`: from nothing to an agent with its verified email, on a server, with a reply on screen.
// Each step says what it did, and each failure says what to do next, with JSON behind a flag.
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { celloHome, databasePath, holdsOldVersion, oldVersionMessage, socketPath } from "./daemon/paths.ts";
import { DEFAULT_SERVER_URL } from "./daemon/settings.ts";
import { HOW_TO_GET_A_CODE } from "./daemon/wallet.ts";
import { installMcp } from "./install-mcp.ts";
import { DaemonGone, DaemonRefused, IpcClient } from "./ipc/client.ts";

const CONNECT_WAIT_TRIES = 50;
const CONNECT_WAIT_MS = 200;
const REPLY_WAIT_SECONDS = 60;
const HELLO = "Hello. I've just been set up.";

export const SETUP_HELP = `Usage: cello setup [--code <code>] [--name <agent>] [--server <url>] [--issuer <url>] [--concierge <address>] [--install-mcp] [--yes] [--json]

Set up CELLO on this machine: start the background program, create an agent's key, redeem your code for a verified email signal, register, and say hello to the CELLO Concierge. Run it again and it changes nothing.

  --code       The code from your admission email. A second agent on this machine doesn't need one. Give - to read it from standard input, so it never sits in a command line or shell history: printf %s "$CODE" | cello setup --code -
  --name       The agent's name, which is only a label. The default is agent.
  --server     The server, the first time only. The default is ${DEFAULT_SERVER_URL}.
  --issuer     The issuer, if it isn't the default.
  --concierge  The agent to call at the end. Give none to skip the call this once, and keep the setting as it is.
  --yes        Start the background program without asking.
  --install-mcp  Find Claude Code, Claude Desktop and ChatGPT Desktop on this machine, connect each one, and say what changed. Without it, setup only prints the Claude Code commands.
  --json       Answer in JSON.
`;

export interface SetupHost {
  startDaemon(server: string | undefined): Promise<IpcClient>;
  ask(question: string): Promise<string>;
  rememberAgent(agentId: string): void;
  caller: string;
}

class SetupFailed extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function options(args: string[]): Record<string, string | true> {
  const known: Record<string, boolean> = { code: true, name: true, server: true, issuer: true, concierge: true, yes: false, json: false, "install-mcp": false };
  const found: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const name = (args[i] as string).replace(/^--/, "");
    if (!(args[i] as string).startsWith("--") || !(name in known)) throw new SetupFailed("bad_argument", `setup has no option ${args[i] as string}. Run: cello setup --help`);
    if (!known[name]) {
      found[name] = true;
      continue;
    }
    const value = args[++i];
    if (!value) throw new SetupFailed("bad_argument", `--${name} needs a value. Run: cello setup --help`);
    found[name] = value;
  }
  return found;
}

const CODE_WAIT_MS = 30_000;

// Reads to the end of standard input, and gives up after a while, so a pipe nobody closes can't hold setup for good.
function codeFromStandardInput(): Promise<string> {
  if (process.stdin.isTTY) throw new SetupFailed("code_not_piped", "--code - reads the code from standard input, and this is a terminal. Pipe it in, for example: printf %s \"$CODE\" | cello setup --code -");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      process.stdin.destroy();
      reject(new SetupFailed("code_not_received", `No code arrived on standard input within ${CODE_WAIT_MS / 1000} seconds, and nothing was used.`));
    }, CODE_WAIT_MS);
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("error", (err) => { clearTimeout(timer); reject(new SetupFailed("code_not_received", `Standard input failed (${err.message}), and nothing was used.`)); });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      const code = Buffer.concat(chunks).toString("utf8").trim();
      if (code === "") reject(new SetupFailed("code_empty", "Standard input held no code, and nothing was used."));
      else resolve(code);
    });
  });
}

const answers = (path: string): Promise<boolean> => new Promise((resolve) => {
  const probe = createConnection(path);
  probe.once("connect", () => { probe.destroy(); resolve(true); });
  probe.once("error", () => resolve(false));
});

// Old data stays until a person says, and then it's moved whole, never deleted.
async function moveOldVersion(host: SetupHost, say: (line: string) => void): Promise<void> {
  const home = celloHome();
  if (!holdsOldVersion(home)) return;
  const target = `${home}-old`;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new SetupFailed("old_version_data", oldVersionMessage(home));
  if (await answers(join(home, "daemon.sock")) || await answers(join(home, "gateway.sock"))) throw new SetupFailed("old_version_running", `The old version of CELLO is still running from ${home}. Stop it, or restart this machine, then run the same command again. Nothing changed.`);
  if (existsSync(target)) throw new SetupFailed("old_version_data", `${home} holds data from the old version, and ${target} already exists, so it can't be moved there. Move one of them yourself, then run the same command again. Nothing changed.`);
  say(`${home} holds data from the old version of CELLO, which this version can't read. Its agents don't carry over.`);
  const answer = (await host.ask(`Move it to ${target}? [y/N] `)).toLowerCase();
  if (answer !== "y" && answer !== "yes") throw new SetupFailed("declined", "Nothing was moved, and setup can't go on until it is.");
  renameSync(home, target);
  say(`Moved it to ${target}.`);
}

async function daemon(host: SetupHost, server: string | undefined, yes: boolean, say: (line: string) => void): Promise<IpcClient> {
  try {
    const running = await IpcClient.connect(socketPath());
    const status = await running.call("status") as { server: string };
    if (server && status.server !== server) throw new SetupFailed("other_server", `CELLO is already running for ${status.server}, not ${server}. To change it, run cello logout, and use a separate CELLO_HOME.`);
    return running;
  } catch (err: unknown) {
    if (!(err instanceof DaemonGone)) throw err;
  }
  const firstTime = !existsSync(databasePath());
  const explain = `CELLO runs a small background program on this machine. It holds your agents' keys and conversations in an encrypted database in ${celloHome()}, and talks to ${server ?? (firstTime ? DEFAULT_SERVER_URL : "your server")}. Messages are end-to-end encrypted, so that server can't read them. It runs until you run cello logout or restart this machine.`;
  if (!yes) {
    if (!process.stdin.isTTY) throw new SetupFailed("consent_required", `${explain} Nothing was started. Run this at a terminal to be asked, or with --yes if the person who owns this machine agreed.`);
    say(explain);
    const answer = (await host.ask("Start it? [y/N] ")).toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new SetupFailed("declined", "Nothing was started or changed.");
  }
  // The default goes in only for empty data. After that, the database says which server this is.
  const client = await host.startDaemon(server ?? (firstTime ? DEFAULT_SERVER_URL : undefined));
  say("The background program is running.");
  return client;
}

async function waitForServer(client: IpcClient): Promise<string> {
  let status = await client.call("status") as { server: string; connected: boolean; problem: string | null };
  for (let i = 0; i < CONNECT_WAIT_TRIES && !status.connected; i++) {
    await new Promise((resolve) => setTimeout(resolve, CONNECT_WAIT_MS));
    status = await client.call("status") as typeof status;
  }
  if (!status.connected) throw new SetupFailed("server_unreachable", `Couldn't reach ${status.server}${status.problem ? ` (${status.problem})` : ""}. Your code wasn't used. Check your connection, then run the same command again.`);
  return status.server;
}

interface Reply { replied: boolean; text?: string; problem?: string }

async function callConcierge(client: IpcClient, agent: string, address: string, caller: string): Promise<Reply> {
  const fields = { agent, caller };
  const started = await client.call("initiate_session", { ...fields, target: address, anyway: true }) as { session_id: string };
  await client.call("send", { ...fields, session_id: started.session_id, text: HELLO, signal: "over" });
  const deadline = Date.now() + REPLY_WAIT_SECONDS * 1000;
  try {
    while (Date.now() < deadline) {
      const left = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      await client.call("wait", { ...fields, timeout_seconds: left }, (left + 10) * 1000);
      const read = await client.call("receive", { ...fields, session_id: started.session_id }) as { messages: { text?: string | null }[] };
      const text = read.messages.find((message) => typeof message.text === "string")?.text;
      if (typeof text === "string") return { replied: true, text };
    }
    return { replied: false, problem: `no reply within ${REPLY_WAIT_SECONDS} seconds` };
  } finally {
    await client.call("close_session", { ...fields, session_id: started.session_id }).catch(() => undefined);
  }
}

async function heardFrom(client: IpcClient, agent: string, address: string): Promise<boolean> {
  const { sessions } = await client.call("sessions", { agent, all: true }) as { sessions: { with_id: string; position: number }[] };
  return sessions.some((session) => address.startsWith(session.with_id) && session.position >= 2);
}

export async function setup(args: string[], host: SetupHost): Promise<number> {
  const asJson = args.includes("--json");
  const say = (line: string): void => { if (!asJson) process.stdout.write(`${line}\n`); };
  const refuse = (code: string, message: string): number => {
    process.stderr.write(asJson ? `${JSON.stringify({ error: code, message })}\n` : `${message}\n`);
    return 1;
  };
  let client: IpcClient | undefined;
  try {
    const flags = options(args);
    const text = (name: string): string | undefined => (typeof flags[name] === "string" ? flags[name] : undefined);
    // --code - takes the code from standard input, so it never sits in a command line or in shell history.
    const code = text("code") === "-" ? await codeFromStandardInput() : text("code");
    await moveOldVersion(host, say);
    if (!code && !existsSync(databasePath())) return refuse("code_required", HOW_TO_GET_A_CODE);

    client = await daemon(host, text("server"), flags["yes"] === true, say);
    const server = await waitForServer(client);
    for (const [flag, setting] of [["issuer", "issuer_url"], ["concierge", "concierge_address"]] as const) {
      const value = text(flag);
      // "none" is for this run only: it changes no setting, so a test or a script can set up without calling anyone.
      if (value && !(flag === "concierge" && value === "none")) await client.call("settings_set", { name: setting, value, caller: host.caller });
    }
    const skipConcierge = text("concierge") === "none";

    const agent = await client.call("enroll_agent", { name: text("name"), code }) as {
      name: string; agent_id: string; address: string; online: boolean; registered: boolean; note?: string; signals_held?: number; already_set_up?: boolean;
    };
    say(agent.already_set_up ? `${agent.name} is already set up, so nothing changed, and no code was used.` : `${agent.name} has its verified email signal.`);
    if (!agent.online) throw new SetupFailed("not_registered", `${agent.name} has its signal, and the server didn't take it: ${agent.note ?? "no reason given"}. Your code is safe. Run the same command again.`);
    const held = await client.call("signals_list", { agent: agent.agent_id }) as { signals: { type: string; counts_as_verified: boolean }[] };
    if (held.signals.some((signal) => signal.type === "email" && !signal.counts_as_verified)) say("This machine doesn't recognise that issuer yet, because it isn't on a signed issuer list here, so the signal shows as unknown.");
    say(`Your agent's address, which is what you share:\n${agent.address}`);
    host.rememberAgent(agent.agent_id);

    const settings = await client.call("settings", {}) as { settings: { name: string; value: unknown }[] };
    const concierge = settings.settings.find((setting) => setting.name === "concierge_address")?.value;
    let reply: Reply | null = null;
    // A repeat changes nothing, so a Concierge that has already answered this agent isn't called again.
    const called = !skipConcierge && agent.already_set_up && typeof concierge === "string" && await heardFrom(client, agent.agent_id, concierge);
    if (skipConcierge) {
      say("Not calling the Concierge, as asked.");
    } else if (called) {
      say("The Concierge has already answered this agent.");
    } else if (typeof concierge === "string" && concierge !== "") {
      say("Calling the CELLO Concierge, an agent run by CELLO...");
      try {
        reply = await callConcierge(client, agent.agent_id, concierge, host.caller);
      } catch (err: unknown) {
        if (!(err instanceof DaemonRefused)) throw err;
        reply = { replied: false, problem: err.message };
      } finally {
        await client.call("stop_using_agent", { agent: agent.agent_id, caller: host.caller }).catch(() => undefined);
      }
    } else {
      say("There's no Concierge to call yet, so this hasn't shown a reply from another agent.");
    }
    if (reply?.replied) say(`The Concierge replied, in its own words:\n"${(reply.text as string).replace(/\p{Cc}/gu, " ")}"`);
    if (reply && !reply.replied) throw new SetupFailed("concierge_silent", `Your agent is set up, and the Concierge didn't answer: ${reply.problem as string}. Run the same command again to retry. Nothing is lost.`);

    const installed = flags["install-mcp"] === true ? installMcp() : null;
    for (const line of installed ?? []) say(`${line.app}: ${line.outcome.replace("_", " ")}. ${line.detail}`);
    if (!installed) {
      say("Next, to use it from Claude Code:");
      say('  claude plugin marketplace add "$(npm root -g)/@cello-protocol/cli"');
      say("  claude plugin install cello@cello-protocol");
      say("  claude --dangerously-load-development-channels plugin:cello@cello-protocol");
      say("Or let setup connect the apps on this machine: cello setup --install-mcp");
    }
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: true, server, name: agent.name, agent_id: agent.agent_id, address: agent.address, already_set_up: agent.already_set_up === true, signals_held: agent.signals_held ?? null, concierge: reply, install_mcp: installed })}\n`);
    return installed?.some((line) => line.outcome === "failed") ? 1 : 0;
  } catch (err: unknown) {
    if (err instanceof SetupFailed || err instanceof DaemonRefused) return refuse(err.code, err.message);
    if (err instanceof DaemonGone) return refuse(err.code, "The background program stopped during setup. Run the same command again.");
    throw err;
  } finally {
    client?.close();
  }
}

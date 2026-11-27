// `cello setup`: from nothing to an agent with its verified email or phone, on a server, with a reply on screen.
// Each step says what it did, and each failure says what to do next, with JSON behind a flag.
import { existsSync, renameSync } from "node:fs";
import { createConnection } from "node:net";
import { celloHome, databasePath, holdsOldVersion, oldVersionEndpoints, oldVersionMessage, socketPath } from "./daemon/paths.ts";
import { DEFAULT_SERVER_URL } from "./daemon/settings.ts";
import { ACCOUNT_SITE } from "./daemon/wallet.ts";
import { installMcp } from "./install-mcp.ts";
import { DaemonGone, DaemonRefused, IpcClient } from "./ipc/client.ts";

const CONNECT_WAIT_TRIES = 50;
const CONNECT_WAIT_MS = 200;
const REPLY_WAIT_SECONDS = 60;
const HELLO = "Hello. I've just been set up.";
const INVITE_HELLO = "Hello. I've just been set up with your invite.";
// How long setup waits for the inviter to pick up before saying it's offline: the hello isn't something setup waits on.
const HELLO_WAIT_SECONDS = 5;

/** What setup says about an invite code. The inviting agent's name is self-declared, so it's shown as the name it gave itself. */
export const INVITE_LINES = {
  inContacts: (name: string) => `The agent that calls itself "${name}" is in your contacts, and I've said hello to it.`,
  offline: (name: string) => `The agent that calls itself "${name}" is in your contacts. It isn't online right now, so say hello to it later.`,
  inContactsNoHello: (name: string, why: string) => `The agent that calls itself "${name}" is in your contacts. The hello didn't go through (${why}), so say hello to it yourself.`,
  blocked: "Your agent has blocked the agent behind that code, so it wasn't added. Lifting a block needs a person: cello contact-set-tier.",
  unknown: "That invite code isn't valid, so setup carries on without it.",
  expired: "That invite has run out, so setup carries on without it. Ask whoever gave it to you for a new one.",
  own: "That's your own invite code, so there's nothing to add.",
  unreachable: (why: string, code: string) => `Couldn't use the invite code (${why}), so setup carries on without it. Add it later with: cello invite-use ${code}`,
  refused: (why: string, code: string) => `The invite code wasn't used: ${why} Setup carries on without it. Add it later with: cello invite-use ${code}`,
  alreadyHello: (name: string) => `The agent that calls itself "${name}" is in your contacts.`,
};

export const SETUP_HELP = `Usage: cello setup [--name <agent>] [--email <address>] [--email-code <code>] [--invite <code>] [--code <code>] [--server <url>] [--issuer <url>] [--concierge <address>] [--install-mcp] [--yes] [--json]

Set up CELLO on this machine: start the daemon (the background service that keeps agents connected), create an agent's key, check your email with a code we send (or redeem a setup code), get a verified email or phone signal, register, and say hello to the CELLO Concierge. Run it again and it changes nothing.

At a terminal it asks for the agent's name, your email and the emailed code, one at a time. With no terminal it never asks: give the values as flags, in two runs, because the code is sent by the first:
  cello setup --yes --name Ann --email ann@example.com
  printf %s "$EMAILED_CODE" | cello setup --name Ann --email-code -

  --name       The agent's name, which other agents see. Asked for at a terminal. With a setup code, the default is agent.
  --email      Your email. A 6-digit code is sent there to check it's yours.
  --email-code The code from that email. Give - to read it from standard input.
  --invite     An invite code, if someone gave you one.
  --code       A setup code, instead of an email. A second agent on this machine needs neither. Give - to read it from standard input, so it never sits in a command line or shell history: printf %s "$CODE" | cello setup --code -
  --server     The server, the first time only. The default is ${DEFAULT_SERVER_URL}.
  --issuer     The issuer, if it isn't the default.
  --concierge  The agent to call at the end. Give none to skip the call this once, and keep the setting as it is.
  --yes        Start the daemon without asking.
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
  const known: Record<string, boolean> = { code: true, name: true, email: true, "email-code": true, invite: true, server: true, issuer: true, concierge: true, yes: false, json: false, "install-mcp": false };
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
function codeFromStandardInput(flag = "code"): Promise<string> {
  if (process.stdin.isTTY) throw new SetupFailed("code_not_piped", `--${flag} - reads the code from standard input, and this is a terminal. Pipe it in, for example: printf %s "$CODE" | cello setup --${flag} -`);
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

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOT_AN_EMAIL = "That doesn't look like an email address.";
const NOT_SIX_DIGITS = "The code is the six digits in the email.";
// People copy codes with spaces or dashes in them. Anything that isn't six digits once those are gone is a typo.
const emailCodeShape = (typed: string): string | null => {
  const code = typed.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(code) ? code : null;
};

// Pasted back into a shell as it is printed, so a name that needs quoting gets it.
const shellWord = (word: string): string => (/^[A-Za-z0-9_.@-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);

interface Enrolled { name: string; agent_id: string; address: string; online: boolean; registered: boolean; note?: string; signals_held?: number; already_set_up?: boolean; registered_with?: string | null }
type EmailRoute = { done: true; agent: Enrolled } | { done: false; name: string; email: string };

// The email route: name, then email, then the code. The key is made when the code is asked for, so a run cut short leaves
// only that key, and the next run sends a new code for it. Without a terminal it asks nothing: it sends the code and stops.
async function emailRoute(client: IpcClient, host: SetupHost, flags: Record<string, string | true>, interactive: boolean, say: (line: string) => void): Promise<EmailRoute> {
  const text = (name: string): string | undefined => (typeof flags[name] === "string" ? flags[name] : undefined);
  const { agents } = await client.call("status", {}) as { agents: { name: string; agent_id: string }[] };
  const given = text("name");
  const earlier = given === undefined ? agents[0] : agents.find((a) => a.name === given);
  let name = earlier?.name ?? given;
  if (earlier) say(`${earlier.name} was started earlier and hasn't checked an email yet.`);
  let email = text("email");
  let sends = 0;
  for (;;) {
    if (name === undefined) {
      if (!interactive) throw new SetupFailed("name_required", "Give the agent a name with --name. Nothing was set up.");
      name = await host.ask("What should your agent be called? Other agents see this name: letters, digits, underscores or dashes.\n> ");
      if (name === "") throw new SetupFailed("name_required", "No name was given. Nothing was set up.");
    }
    if (email === undefined) {
      if (!interactive) throw new SetupFailed("email_required", "No setup code and no email. Give --email <address> to get a code, or --code <code>. Nothing was set up.");
      email = await host.ask("What's your email? We'll send a 6-digit code to check it's yours.\n> ");
      if (email === "") throw new SetupFailed("email_required", "No email was given. Nothing was set up.");
      if (!EMAIL_SHAPE.test(email)) {
        say(`${NOT_AN_EMAIL} Try again.`);
        email = undefined;
        continue;
      }
    }
    try {
      const started = await client.call("enroll_start", { name, email }) as { already_set_up?: boolean } & Enrolled;
      if (started.already_set_up) return { done: true, agent: started };
    } catch (err: unknown) {
      // A name the daemon won't take is asked for again, in its words. Everything else stops here.
      if (interactive && err instanceof DaemonRefused && err.code === "bad_argument" && !earlier && given === undefined) {
        say(`${err.message}. Try again.`);
        name = undefined;
        continue;
      }
      throw err;
    }
    sends += 1;
    say(sends === 1 && !earlier ? `A 6-digit code is on its way to ${email}. It can take a minute.` : `A new code is on its way to ${email}. Only the newest code works.`);
    if (!interactive) return { done: false, name, email };
    say("Not there? Check spam. Wrong address? Press Enter with no code to give a different one.");
    for (;;) {
      const typed = await host.ask("Type the code from the email:\n> ");
      if (typed === "") break;
      // A mistyped length is caught here, so it costs neither a try nor the code.
      const code = emailCodeShape(typed);
      if (code === null) {
        say(`${NOT_SIX_DIGITS} Try again.`);
        continue;
      }
      try {
        return { done: true, agent: await client.call("enroll_agent", { name, email_code: code }) as Enrolled };
      } catch (err: unknown) {
        if (err instanceof DaemonRefused && (err.code === "enroll_code_wrong" || err.code === "bad_code")) {
          say(err.message);
          continue;
        }
        throw err;
      }
    }
    email = undefined;
  }
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
  const [oldDaemon, oldGateway] = oldVersionEndpoints(home) as [string, string];
  if (await answers(oldDaemon) || await answers(oldGateway)) throw new SetupFailed("old_version_running", `The old version of CELLO is still running from ${home}. Stop it, or restart this machine, then run the same command again. Nothing changed.`);
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
  const started = await client.call("initiate_session", { ...fields, target: address }) as { session_id: string };
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

async function heardOnThisMachine(client: IpcClient, address: string): Promise<boolean> {
  const { agents } = await client.call("status", {}) as { agents: { agent_id: string }[] };
  for (const one of agents) if (await heardFrom(client, one.agent_id, address)) return true;
  return false;
}

export async function setup(args: string[], host: SetupHost): Promise<number> {
  const asJson = args.includes("--json");
  const say = (line: string): void => { if (!asJson) process.stdout.write(`${line}\n`); };
  const refuse = (code: string, message: string): number => {
    process.stderr.write(asJson ? `${JSON.stringify({ error: code, message })}\n` : `✗ ${message}\n`);
    return 1;
  };
  let client: IpcClient | undefined;
  try {
    const flags = options(args);
    const text = (name: string): string | undefined => (typeof flags[name] === "string" ? flags[name] : undefined);
    // --code - takes the code from standard input, so it never sits in a command line or in shell history.
    // Before anything is read from standard input, so a clash never waits on a pipe.
    if (text("code") && (text("email") || text("email-code"))) return refuse("bad_argument", "Give a setup code or an email, not both.");
    const code = text("code") === "-" ? await codeFromStandardInput() : text("code");
    const email = text("email");
    if (email !== undefined && !EMAIL_SHAPE.test(email)) return refuse("bad_email", `${NOT_AN_EMAIL} Nothing was set up.`);
    // JSON is for a program reading the answer, so it never gets prompts mixed into it.
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && !text("email-code") && !asJson;
    // Without a terminal nothing can be asked, so what's missing is said now, before anything starts.
    if (!code && !interactive && !existsSync(databasePath())) {
      if (!email && !text("email-code")) return refuse("email_required", "No setup code and no email. Give --email <address> to get a code, or --code <code>. Nothing was set up.");
      if (!text("name")) return refuse("name_required", "Give the agent a name with --name. Nothing was set up.");
    }
    const givenEmailCode = text("email-code") === "-" ? await codeFromStandardInput("email-code") : text("email-code");
    const emailCode = givenEmailCode === undefined ? undefined : emailCodeShape(givenEmailCode);
    if (emailCode === null) return refuse("bad_code", `${NOT_SIX_DIGITS} Run the same command with those six digits. Nothing was used.`);
    await moveOldVersion(host, say);

    client = await daemon(host, text("server"), flags["yes"] === true, say);
    const server = await waitForServer(client);
    for (const [flag, setting] of [["issuer", "issuer_url"], ["concierge", "concierge_address"]] as const) {
      const value = text(flag);
      // "none" is for this run only: it changes no setting, so a test or a script can set up without calling anyone.
      if (value && !(flag === "concierge" && value.toLowerCase() === "none")) await client.call("settings_set", { name: setting, value, caller: host.caller });
    }
    const skipConcierge = text("concierge")?.toLowerCase() === "none";

    let agent: Enrolled;
    let byEmail = emailCode !== undefined;
    try {
      agent = await client.call("enroll_agent", { name: text("name"), code, ...(emailCode ? { email_code: emailCode } : {}) }) as Enrolled;
    } catch (err: unknown) {
      // No setup code and nothing on this machine to copy from: the email route. A setup code that failed stops here.
      if (!(err instanceof DaemonRefused) || err.code !== "code_required" || code) throw err;
      const route = await emailRoute(client, host, flags, interactive, say);
      if (!route.done) {
        // Pasted as printed, it must finish the job: consent and a skipped Concierge last one run, so they're carried over.
        // The server and issuer were saved in the database by this run.
        const carried = [flags["yes"] === true ? " --yes" : "", skipConcierge ? " --concierge none" : "", text("invite") ? ` --invite ${shellWord(text("invite") as string)}` : ""].join("");
        say(`Code sent to ${route.email}. Next: printf %s "$EMAILED_CODE" | cello setup${carried} --name ${shellWord(route.name)} --email-code -`);
        if (asJson) process.stdout.write(`${JSON.stringify({ ok: true, done: false, next: "email_code", name: route.name })}\n`);
        return 0;
      }
      agent = route.agent;
      byEmail = true;
    }
    // The daemon says which signal it registers with (email, or the phone of an owner who signed up in a chat app), so this never guesses.
    say(agent.already_set_up ? `${agent.name} is already set up, so nothing changed, and no code was used.` : `${agent.name} has its verified ${agent.registered_with ?? "registration"} signal.`);
    if (!agent.online) throw new SetupFailed("not_registered", `${agent.name} has its signal, and the server didn't take it: ${agent.note ?? "no reason given"}. Your code is safe. Run the same command again.`);
    const held = await client.call("signals_list", { agent: agent.agent_id }) as { signals: { type: string; counts_as_verified: boolean }[] };
    const registering = held.signals.find((signal) => signal.type === agent.registered_with);
    if (registering && !registering.counts_as_verified) say("This machine doesn't recognise that issuer yet, because it isn't on a signed issuer list here, so the signal shows as unknown.");
    say(`Your agent's address, which is what you share:\n${agent.address}`);
    host.rememberAgent(agent.agent_id);

    // An invite code: the inviting agent becomes a known contact before setup ends. A code that isn't good never stops setup.
    const inviteCode = text("invite");
    let invited: { address: string; name: string; contact_id: string } | null = null;
    // What setup --json reports about the code: the contact and the hello, or why it wasn't used.
    let inviteOutcome: Record<string, unknown> | null = null;
    if (inviteCode) {
      try {
        const used = await client.call("invite_use", { agent: agent.agent_id, code: inviteCode, caller: host.caller }) as { address: string; name: string; contact_id: string };
        invited = { address: used.address, name: used.name, contact_id: used.contact_id };
        inviteOutcome = { contact_id: used.contact_id, name: used.name, hello: "not_sent" };
      } catch (err: unknown) {
        if (!(err instanceof DaemonRefused)) throw err;
        inviteOutcome = { error: err.code, message: err.message };
        say(err.code === "expired" ? INVITE_LINES.expired : err.code === "own" ? INVITE_LINES.own : err.code === "unknown" ? INVITE_LINES.unknown : err.code === "blocked" ? INVITE_LINES.blocked
          : err.code === "issuer_unreachable" ? INVITE_LINES.unreachable(err.message.replace(/\.$/, ""), inviteCode) : INVITE_LINES.refused(err.message, inviteCode));
      }
    }

    const settings = await client.call("settings", {}) as { settings: { name: string; value: unknown }[] };
    const concierge = settings.settings.find((setting) => setting.name === "concierge_address")?.value;
    let reply: Reply | null = null;
    // The Concierge helps once per machine. Once it has answered any agent here, a new one isn't introduced again.
    const called = !skipConcierge && typeof concierge === "string" && await heardOnThisMachine(client, concierge);
    if (skipConcierge) {
      say("Not calling the Concierge, as asked.");
    } else if (called) {
      say("The Concierge has already answered an agent on this machine, so it isn't called again.");
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
    // After the Concierge, a hello to the inviting agent, not waited for: it may not be there now, and nothing here depends on it.
    // A rerun of a setup that already finished has said hello once already; the contact is there, so it's only named.
    if (invited && agent.already_set_up) say(INVITE_LINES.alreadyHello(invited.name));
    if (invited && !agent.already_set_up) {
      const fields = { agent: agent.agent_id, caller: host.caller };
      try {
        // A short wait: the hello isn't waited for. An inviter that isn't there now can't be handed a message to read later,
        // so the call is taken back (it's then never shown an empty call) and the person is told to say hello later.
        const started = await client.call("initiate_session", { ...fields, target: invited.address, wait_seconds: HELLO_WAIT_SECONDS }) as { session_id: string; state: string; message?: string };
        if (started.state === "active") {
          await client.call("send", { ...fields, session_id: started.session_id, text: INVITE_HELLO, signal: "over" });
          say(INVITE_LINES.inContacts(invited.name));
          inviteOutcome = { ...inviteOutcome, hello: "sent" };
        } else {
          if (started.state === "waiting") await client.call("close_session", { ...fields, session_id: started.session_id }).catch(() => undefined);
          say(started.state === "waiting" ? INVITE_LINES.offline(invited.name) : INVITE_LINES.inContactsNoHello(invited.name, started.message ?? started.state));
          inviteOutcome = { ...inviteOutcome, hello: started.state === "waiting" ? "offline" : "refused" };
        }
      } catch (err: unknown) {
        if (!(err instanceof DaemonRefused)) throw err;
        say(INVITE_LINES.inContactsNoHello(invited.name, err.message.replace(/\.$/, "")));
        inviteOutcome = { ...inviteOutcome, hello: "failed", hello_error: err.code };
      } finally {
        await client.call("stop_using_agent", fields).catch(() => undefined);
      }
    }
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
    say(byEmail && !agent.already_set_up ? `✓ ${agent.name} is set up. You can sign in at ${ACCOUNT_SITE} with the same email.` : `✓ ${agent.name} is set up.`);
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: true, server, name: agent.name, agent_id: agent.agent_id, address: agent.address, already_set_up: agent.already_set_up === true, signals_held: agent.signals_held ?? null, concierge: reply, ...(inviteOutcome ? { invite: inviteOutcome } : {}), install_mcp: installed })}\n`);
    return installed?.some((line) => line.outcome === "failed") ? 1 : 0;
  } catch (err: unknown) {
    // At a terminal a wrong code is asked for again; a scripted run says how to try again instead.
    if (err instanceof DaemonRefused && err.code === "enroll_code_wrong") return refuse(err.code, `${err.message} Run the same command with the right code.`);
    if (err instanceof SetupFailed || err instanceof DaemonRefused) return refuse(err.code, err.message);
    if (err instanceof DaemonGone) return refuse(err.code, "The background program stopped during setup. Run the same command again.");
    throw err;
  } finally {
    client?.close();
  }
}

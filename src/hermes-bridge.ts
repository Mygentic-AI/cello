// cello bridge: wires this machine's daemon into a Hermes home, through Hermes' own commands. A person runs it at a terminal.
// It's safe to run again, and it has to be after an upgrade, because Hermes keeps a copy of the plugin.
import { spawn } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { celloHome, logPath } from "./daemon/paths.ts";

// Both doors to an agent use this name. A hold is per agent, so a whole machine can share it.
export const BRIDGE_CALLER = "hermes";
export const SESSION_SCOPES = ["agent", "peer"] as const;
const CHANNEL_NOTIFICATIONS = ["on", "off"] as const;
const SAFE_SESSION_ID = /^[A-Za-z0-9+/=_.:@-]{1,120}$/;

// All a public agent's model can reach. It talks to strangers, so it can't change settings or make agents.
export const PUBLIC_TOOLS = ["cello_receive", "cello_send", "cello_sessions", "cello_inbox", "cello_close_session", "cello_contacts", "cello_channel_read", "cello_channels", "cello_status"];
const SKILLS = ["cello-bridge-setup", "cello-policy"];
// What v1's install wrote, which this one no longer reads.
const RETIRED_ENV = ["CELLO_DELIVERY_MODE", "CELLO_DIR"];

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (command: string, args: string[], hermesHome: string) => Promise<ExecResult>;

export interface BridgeOptions {
  agent: string;
  hermesHome?: string;
  sessionScope?: string;
  channelNotifications?: string;
  landingSession?: string;
  // A public agent: limited tools, one conversation per caller, and the screening model required.
  public: boolean;
  allowInitiate: boolean;
  // Stays public across re-runs until this says otherwise.
  notPublic: boolean;
  modelReady: () => Promise<boolean>;
  exec?: Exec;
}

const runHermes: Exec = (command, args, hermesHome) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HERMES_HOME: hermesHome } });
  // hermes mcp add asks to overwrite on a re-run, then asks about its tools. A closed stdin reads as "Cancelled." with exit 0.
  child.stdin.end("Y\nY\nY\n");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  child.on("error", reject);
  child.on("close", (code) => { resolve({ code: code ?? 1, stdout, stderr }); });
});

// This file is one folder below hermes/ whether it's running from src or dist.
const assetDir = (): string => fileURLToPath(new URL("../hermes/", import.meta.url));
const mcpEntry = (): string => fileURLToPath(new URL(`./mcp${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
const daemonEntry = (): string => fileURLToPath(new URL(`./daemon/main${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

function withEnv(existing: string, set: Record<string, string>, drop: string[]): string {
  const keyOf = (line: string): string => line.split("=", 1)[0] as string;
  const lines = existing.split("\n").filter((line) => !drop.includes(keyOf(line)));
  while (lines.at(-1) === "") lines.pop();
  for (const [key, value] of Object.entries(set)) {
    const at = lines.findIndex((line) => keyOf(line) === key);
    if (at >= 0) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

// --landing-session takes a session id, or one of these words, as v1's did.
// current: the Hermes session this command runs in, so an agent can say "send my notifications here".
// default: back to the agent's own CELLO session.
function resolveLanding(value: string | undefined): { landing: string | null | undefined; error?: string } {
  const raw = value?.trim();
  if (raw === undefined || raw === "") return { landing: undefined };
  if (raw.toLowerCase() === "default") return { landing: null };
  if (raw.toLowerCase() === "current") {
    const current = (process.env["HERMES_SESSION_ID"] ?? "").trim();
    if (!current) return { landing: undefined, error: "--landing-session current needs HERMES_SESSION_ID, which Hermes sets in a session's commands. Run it from inside the Hermes session you mean, or pass that session's id." };
    return SAFE_SESSION_ID.test(current) ? { landing: current } : { landing: undefined, error: `HERMES_SESSION_ID '${current}' isn't a session id.` };
  }
  return SAFE_SESSION_ID.test(raw) ? { landing: raw } : { landing: undefined, error: `--landing-session '${raw}' isn't a session id.` };
}

const landingFileOf = (hermesHome: string): string => join(hermesHome, "cello", "landing-session.json");

// The one bridge setting an agent may change itself: where its own notifications land. It writes only the landing file, which the
// plugin reads on every notification, so nothing restarts. Everything else about the bridge still takes a person.
export function setLanding(options: { agent: string; hermesHome?: string; landingSession: string }): { ok: boolean; output: string } {
  const hermesHome = options.hermesHome || process.env["HERMES_HOME"] || join(homedir(), ".hermes");
  const envPath = join(hermesHome, ".env");
  if (!existsSync(envPath)) return { ok: false, output: `There's no bridge in ${hermesHome} yet. A person sets it up first with cello bridge hermes.` };
  const bridged = readFileSync(envPath, "utf8").split("\n").find((line) => line.startsWith("CELLO_AGENT_NAME="))?.slice("CELLO_AGENT_NAME=".length);
  // An agent moves its own notifications, never another profile's.
  if (bridged !== options.agent.trim()) return { ok: false, output: `${hermesHome} is bridged to ${bridged ?? "no agent"}, not ${options.agent}. Nothing changed.` };
  if (readFileSync(envPath, "utf8").split("\n").includes("CELLO_SESSION_SCOPE=peer")) return { ok: false, output: "This agent gives each caller their own session, so there's no one landing session to move. Nothing changed." };
  const { landing, error } = resolveLanding(options.landingSession);
  if (error) return { ok: false, output: error };
  const file = landingFileOf(hermesHome);
  mkdirSync(join(hermesHome, "cello"), { recursive: true });
  // A null says default on purpose, so an older CELLO_LANDING_SESSION in .env doesn't take over.
  writeFileSync(file, `${JSON.stringify({ session_id: landing ?? null })}\n`);
  return { ok: true, output: landing ? `${options.agent}'s notifications now land in session ${landing}, from the next one.` : `${options.agent}'s notifications go back to its own CELLO session, from the next one.` };
}

export async function installBridge(options: BridgeOptions): Promise<{ ok: boolean; output: string }> {
  const refuse = (output: string): { ok: boolean; output: string } => ({ ok: false, output });
  const agent = options.agent.trim();
  if (!/^[^\s=]+$/.test(agent)) return refuse(`'${agent}' can't be an agent's name here.`);
  const hermesHome = options.hermesHome || process.env["HERMES_HOME"] || join(homedir(), ".hermes");
  if (!existsSync(hermesHome)) return refuse(`There's no Hermes home at ${hermesHome}. Install Hermes first, or pass --hermes-home.`);
  const envPath = join(hermesHome, ".env");
  const hermesEnv = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  // This has to be re-run after every upgrade, and forgetting a flag then mustn't open a public agent to strangers. Only --not-public ends it.
  const wasPublic = hermesEnv.split("\n").includes("CELLO_PUBLIC=1");
  if (options.public && options.notPublic) return refuse("--public and --not-public can't go together.");
  const isPublic = options.public || (wasPublic && !options.notPublic);
  const allowInitiate = options.allowInitiate || (isPublic && !options.notPublic && hermesEnv.split("\n").includes("CELLO_ALLOW_INITIATE=1"));
  const scope = options.sessionScope ?? (isPublic ? "peer" : "agent");
  if (!(SESSION_SCOPES as readonly string[]).includes(scope)) return refuse(`--session-scope must be one of ${SESSION_SCOPES.join(", ")}, not '${scope}'.`);
  if (isPublic && scope !== "peer") return refuse("A public agent needs --session-scope peer, or callers would share one conversation.");
  const channels = options.channelNotifications ?? "on";
  if (!(CHANNEL_NOTIFICATIONS as readonly string[]).includes(channels)) return refuse(`--channel-notifications must be one of ${CHANNEL_NOTIFICATIONS.join(", ")}, not '${channels}'.`);
  if (options.allowInitiate && !isPublic) return refuse("--allow-initiate only means something with --public.");
  const resolved = resolveLanding(options.landingSession);
  if (resolved.error) return refuse(resolved.error);
  if (resolved.landing && scope === "peer") return refuse("--landing-session only means something with --session-scope agent: under peer each caller has their own session.");
  const landing = resolved.landing ?? undefined;

  // Strangers' text goes straight to this agent's model, so a public agent doesn't start on the rules alone.
  if (isPublic && !await options.modelReady()) return refuse("Nothing was changed. A public agent needs the screening model, and it isn't installed here. Run: cello screener install");

  const tools = isPublic ? [...PUBLIC_TOOLS, ...(allowInitiate ? ["cello_initiate_session"] : [])] : undefined;
  const settings: Record<string, string> = {
    ...(isPublic ? { CELLO_PUBLIC: "1" } : {}),
    ...(allowInitiate ? { CELLO_ALLOW_INITIATE: "1" } : {}),
    ...(tools ? { CELLO_TOOLS: tools.join(",") } : {}),
    CELLO_AGENT_NAME: agent,
    CELLO_CALLER: BRIDGE_CALLER,
    CELLO_SESSION_SCOPE: scope,
    CELLO_CHANNEL_NOTIFICATIONS: channels,
    ...(process.env["CELLO_HOME"] ? { CELLO_HOME: celloHome() } : {}),
    ...(landing ? { CELLO_LANDING_SESSION: landing } : {}),
  };
  const wanted = withEnv(hermesEnv, settings, [...RETIRED_ENV, ...(landing ? [] : ["CELLO_LANDING_SESSION"]), ...(isPublic ? [] : ["CELLO_PUBLIC", "CELLO_TOOLS"]), ...(allowInitiate ? [] : ["CELLO_ALLOW_INITIATE"])]);
  const envNeedsWriting = wanted !== hermesEnv;
  if (envNeedsWriting) {
    // Checked before anything is written. A hardened host keeps this file read-only, and half an install looks like a failed one.
    try {
      accessSync(existsSync(envPath) ? envPath : hermesHome, constants.W_OK);
    } catch {
      return refuse(`Nothing was changed. ${envPath} is read-only, and it needs these lines:\n${Object.entries(settings).map(([k, v]) => `  ${k}=${v}`).join("\n")}\nUnlock it, run this again, then lock it.`);
    }
  }

  const out: string[] = [];
  const pluginDir = join(hermesHome, "plugins", "cello");
  mkdirSync(pluginDir, { recursive: true });
  for (const file of ["plugin.yaml", "__init__.py"]) copyFileSync(join(assetDir(), "plugin", file), join(pluginDir, file));
  out.push(`Plugin: ${pluginDir}`);
  for (const skill of SKILLS) {
    const dir = join(hermesHome, "skills", skill);
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(assetDir(), "skills", skill, "SKILL.md"), join(dir, "SKILL.md"));
    out.push(`Skill: ${dir}`);
  }
  if (envNeedsWriting) writeFileSync(envPath, wanted, { mode: 0o600 });
  out.push(`Agent: ${agent}, scope ${scope}, caller ${BRIDGE_CALLER}${landing ? `, landing session ${landing}` : ""}`);
  const landingFile = landingFileOf(hermesHome);
  if (landing) {
    mkdirSync(join(hermesHome, "cello"), { recursive: true });
    writeFileSync(landingFile, `${JSON.stringify({ session_id: landing })}\n`);
  } else {
    rmSync(landingFile, { force: true });
  }

  // By full path, so a gateway started by a service manager with a short PATH still finds it.
  // The limit is enforced by the tool process itself. 'hermes config set' can only write a string, which Hermes would read as one tool's name.
  const mcpEnv = [`CELLO_CALLER=${BRIDGE_CALLER}`, ...(process.env["CELLO_HOME"] ? [`CELLO_HOME=${celloHome()}`] : []), ...(tools ? [`CELLO_TOOLS=${tools.join(",")}`] : [])];
  const mcpAdd = ["mcp", "add", "cello", "--env", ...mcpEnv, "--command", process.execPath, "--args", mcpEntry()];
  // The tools first: an enabled plugin with no tools reads messages and can never answer them.
  const steps = [mcpAdd, ["plugins", "enable", "cello"]];
  const byHand = steps.map((step) => `  hermes ${step.join(" ")}`).join("\n");
  const hermes = (args: string[]): Promise<ExecResult> => (options.exec ?? runHermes)("hermes", args, hermesHome);
  for (const step of steps) {
    let result: ExecResult;
    try {
      result = await hermes(step);
    } catch (err: unknown) {
      return refuse(`${out.join("\n")}\n\nThe files are in place, but the 'hermes' command couldn't run (${err instanceof Error ? err.message : String(err)}). Run these by hand, then restart the gateway:\n${byHand}`);
    }
    if (result.code !== 0) return refuse(`${out.join("\n")}\n\n'hermes ${step.join(" ")}' failed (exit ${result.code}):\n${(result.stderr || result.stdout).trim()}\nFix that and run this again.`);
    out.push(`Ran: hermes ${step.slice(0, 3).join(" ")}`);
    if (step === mcpAdd) {
      // hermes mcp add can say "Cancelled." and still exit 0.
      const listed = await hermes(["mcp", "list"]);
      if (!listed.stdout.includes("cello")) return refuse(`${out.join("\n")}\n\n'hermes mcp add' reported success, but 'hermes mcp list' has no cello server. Run this by hand and answer Y, then run this command again:\n  hermes ${mcpAdd.join(" ")}`);
      out.push("Checked: cello is in hermes mcp list");
    }
  }
  if (tools) out.push(`Tools the model can reach: ${tools.join(", ")}`);
  out.push("", "Now restart the gateway, so Hermes loads the plugin: hermes gateway restart", "The daemon must stay up by itself on a server: cello bridge daemon-unit");
  return { ok: true, output: out.join("\n") };
}

// A systemd user unit that runs the daemon in the foreground. Not 'cello login', which starts it and exits, so a plain unit would call that a failure.
export function daemonUnit(): string {
  return `# ~/.config/systemd/user/cello-daemon.service
# Then: systemctl --user daemon-reload && systemctl --user enable --now cello-daemon
# And once, so it starts at boot with nobody logged in: loginctl enable-linger $USER
# Run 'cello login --server <url>' once first, then 'cello logout', because the server's address lives in the database.
[Unit]
Description=CELLO daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${process.execPath} ${daemonEntry()}
Environment=CELLO_HOME=${celloHome()}
Restart=always
RestartSec=2
StandardOutput=append:${logPath()}
StandardError=append:${logPath()}

[Install]
WantedBy=default.target
`;
}

// cello setup --install-mcp: connects the apps on this machine, and says exactly what it changed. Nothing here leaves the machine.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export interface McpInstallLine { app: string; outcome: "installed" | "unchanged" | "not_found" | "failed"; detail: string }

const CLAUDE_WAIT_MS = 120_000;

function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.cello-tmp`, text, { mode: 0o600 });
  renameSync(`${path}.cello-tmp`, path);
}

// Claude Desktop keeps its config in Application Support on a Mac, under %APPDATA% on Windows, and in ~/.config on Linux.
export function claudeDesktopFolder(home: string, platform: NodeJS.Platform = process.platform, appData = process.env["APPDATA"]): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude");
  if (platform === "win32") return win32.join(appData ?? win32.join(home, "AppData", "Roaming"), "Claude");
  return join(home, ".config", "Claude");
}

// Windows has no sh, so the claude command is found with where. An npm install there is claude.cmd, which Node
// runs only through a shell, and a shell splits on spaces, so each argument is quoted (a user folder often has one).
export function windowsCommandLine(command: string, args: string[]): { file: string; args: string[]; shell: boolean } {
  if (/\.exe$/i.test(command)) return { file: command, args, shell: false };
  const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  return { file: quote(command), args: args.map(quote), shell: true };
}

function findClaude(): string {
  if (process.platform === "win32") return (spawnSync("where", ["claude"], { encoding: "utf8" }).stdout ?? "").split(/\r?\n/)[0]?.trim() ?? "";
  return (spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout ?? "").trim();
}

function claudeCode(packageRoot: string): McpInstallLine {
  const app = "Claude Code";
  const onPath = findClaude();
  if (!onPath) return { app, outcome: "not_found", detail: "no claude command on this PATH" };
  const claude = (args: string[]): { ok: boolean; said: string } => {
    const line = process.platform === "win32" ? windowsCommandLine(onPath, args) : { file: onPath, args, shell: false };
    const run = spawnSync(line.file, line.args, { encoding: "utf8", timeout: CLAUDE_WAIT_MS, shell: line.shell });
    return { ok: run.status === 0, said: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
  };
  const listed = claude(["plugin", "list"]);
  if (listed.ok && /cello@cello-protocol/.test(listed.said)) return { app, outcome: "unchanged", detail: "the plugin cello@cello-protocol is already installed. If it came from the old version, remove it with: claude plugin uninstall cello@cello-protocol" };
  const market = claude(["plugin", "marketplace", "add", packageRoot]);
  if (!market.ok) return { app, outcome: "failed", detail: `adding the marketplace failed: ${market.said}` };
  const plugin = claude(["plugin", "install", "cello@cello-protocol"]);
  if (!plugin.ok) return { app, outcome: "failed", detail: `installing the plugin failed: ${plugin.said}` };
  return { app, outcome: "installed", detail: `added the plugin cello@cello-protocol, from ${packageRoot}. To be woken by messages, start it with: claude --dangerously-load-development-channels plugin:cello@cello-protocol` };
}

function claudeDesktop(home: string, command: string, args: string[]): McpInstallLine {
  const app = "Claude Desktop";
  const folder = claudeDesktopFolder(home);
  if (!existsSync(folder)) return { app, outcome: "not_found", detail: `no ${folder}` };
  const path = join(folder, "claude_desktop_config.json");
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8")) as typeof config;
    } catch {
      return { app, outcome: "failed", detail: `${path} isn't valid JSON, so it was left alone` };
    }
  }
  const entry = { command, args };
  const before = config.mcpServers?.["cello"];
  if (JSON.stringify(before) === JSON.stringify(entry)) return { app, outcome: "unchanged", detail: `${path} already has it` };
  writeAtomically(path, `${JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, cello: entry } }, null, 2)}\n`);
  return { app, outcome: "installed", detail: `${before ? "replaced" : "added"} the cello server in ${path}${before ? `, which was ${JSON.stringify(before)}` : ""}. Restart the app. Messages wait for your next turn there, because nothing wakes it.` };
}

const toml = (value: string): string => JSON.stringify(value);

function chatGptDesktop(home: string, command: string, args: string[]): McpInstallLine {
  const app = "ChatGPT Desktop";
  const folder = join(home, ".codex");
  if (!existsSync(folder) && !existsSync(join(home, "Library", "Application Support", "com.openai.chat"))) return { app, outcome: "not_found", detail: "neither ~/.codex nor its app folder is here" };
  const path = join(folder, "config.toml");
  const held = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = `[mcp_servers.cello]\ncommand = ${toml(command)}\nargs = [${args.map(toml).join(", ")}]\n`;
  if (held.includes(block)) return { app, outcome: "unchanged", detail: `${path} already has it` };
  if (/^\[mcp_servers\.cello\]/m.test(held)) return { app, outcome: "failed", detail: `${path} already has a different [mcp_servers.cello], so it was left alone. Remove that section, then run this again.` };
  writeAtomically(path, `${held}${held === "" || held.endsWith("\n") ? "" : "\n"}\n${block}`);
  return { app, outcome: "installed", detail: `added [mcp_servers.cello] to ${path}. Restart the app. Messages wait for your next turn there, because nothing wakes it.` };
}

export function installMcp(home = homedir()): McpInstallLine[] {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = join(dirname(here), "..");
  // By full path: a desktop app doesn't start with the shell's PATH, so it wouldn't find node or cello-mcp.
  const args = [join(dirname(here), `mcp${extname(here)}`)];
  return [claudeCode(packageRoot), claudeDesktop(home, process.execPath, args), chatGptDesktop(home, process.execPath, args)];
}

// cello setup --install-mcp: connects the apps on this machine, and says exactly what it changed. Nothing here leaves the machine.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export interface McpInstallLine { app: string; outcome: "installed" | "updated" | "unchanged" | "not_found" | "failed"; detail: string }

const CLAUDE_WAIT_MS = 120_000;

function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.cello-tmp`, text, { mode: 0o600 });
  renameSync(`${path}.cello-tmp`, path);
}

// Claude Desktop keeps its config in Application Support on a Mac, under %APPDATA% on Windows, and in ~/.config on Linux.
// The Microsoft Store (MSIX) install on Windows redirects %APPDATA% into its package folder, so that one wins if present.
export function claudeDesktopFolder(home: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude");
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"] ?? win32.join(home, "AppData", "Local");
    const packages = win32.join(localAppData, "Packages");
    const store = existsSync(packages) ? readdirSync(packages).find((name) => /^Claude_/i.test(name)) : undefined;
    const storeConfig = store ? win32.join(packages, store, "LocalCache", "Roaming", "Claude") : undefined;
    if (storeConfig && existsSync(storeConfig)) return storeConfig;
    return win32.join(env["APPDATA"] ?? win32.join(home, "AppData", "Roaming"), "Claude");
  }
  return join(home, ".config", "Claude");
}

// Windows has no sh, so the claude command is found with where. An npm install there is claude.cmd, which Node
// runs only through a shell. The shell gets one finished line (an args array with shell: true is deprecated in
// Node 24), with each part quoted, because it splits on spaces and a user folder often has one.
export function windowsCommandLine(command: string, args: string[]): { file: string; args: string[]; shell: boolean } {
  if (/\.exe$/i.test(command)) return { file: command, args, shell: false };
  const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  return { file: [command, ...args].map(quote).join(" "), args: [], shell: true };
}

// where lists every match on PATH. An npm install puts an extensionless sh script first, which cmd can't run itself.
export function pickWindowsClaude(whereOutput: string): string {
  const found = whereOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return found.find((p) => /\.exe$/i.test(p)) ?? found.find((p) => /\.(cmd|bat)$/i.test(p)) ?? "";
}

function findClaude(): string {
  if (process.platform === "win32") return pickWindowsClaude(spawnSync("where", ["claude"], { encoding: "utf8" }).stdout ?? "");
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
  // Already installed: Claude Code keeps its own copy of the plugin, made at install, and only replaces it when the version in
  // plugin.json changes and it's asked to. So refresh the marketplace from this package, then update. Without this an upgrade
  // left the old skills in place for good.
  if (listed.ok && /cello@cello-protocol/.test(listed.said)) {
    const refreshed = claude(["plugin", "marketplace", "update", "cello-protocol"]);
    if (!refreshed.ok) return { app, outcome: "failed", detail: `the plugin is installed, but refreshing its marketplace failed: ${refreshed.said}. If it came from the old version, remove it with: claude plugin uninstall cello@cello-protocol, then run this again` };
    const updated = claude(["plugin", "update", "cello@cello-protocol"]);
    if (!updated.ok) return { app, outcome: "failed", detail: `the plugin is installed, but updating it failed: ${updated.said}` };
    // "already at the latest version" when nothing changed; anything else means Claude Code took the new copy.
    if (/already at the latest/i.test(updated.said)) return { app, outcome: "unchanged", detail: "the plugin cello@cello-protocol is installed and already matches this version" };
    return { app, outcome: "updated", detail: `the plugin cello@cello-protocol now matches this version (${updated.said.split("\n").at(-1) ?? "updated"}). Restart Claude Code to load it` };
  }
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

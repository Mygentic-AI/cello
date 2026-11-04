#!/usr/bin/env node
// The commands a person runs. An agent's own work goes through the Claude Code tools in mcp.ts.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { celloHome, logPath, socketPath } from "./daemon/paths.ts";
import { DaemonGone, DaemonRefused, IpcClient } from "./ipc/client.ts";

const USAGE = `Usage:
  cello-v2 login --server <wss-url>     Start the daemon.
  cello-v2 logout                       Stop the daemon. Conversations carry on after the next login.
  cello-v2 status                       What's running, and every agent and session.
  cello-v2 agent create <name>          Create an agent and register it on the server.
  cello-v2 verify <agent> <session-id>  Check a session's record, using only public keys.`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function daemon(): Promise<IpcClient> {
  return IpcClient.connect(socketPath());
}

async function waitForDaemon(child: ReturnType<typeof spawn>): Promise<IpcClient> {
  let exited: number | null | undefined;
  child.once("exit", (code) => { exited = code; });
  for (let i = 0; i < 100; i++) {
    if (exited !== undefined) break;
    try {
      return await daemon();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const tail = readFileSync(logPath(), "utf8").trim().split("\n").slice(-5).join("\n");
  return fail(`The daemon didn't start. The last lines of ${logPath()}:\n${tail}`);
}

async function login(args: string[]): Promise<void> {
  const flag = args.indexOf("--server");
  const server = flag >= 0 ? args[flag + 1] : undefined;
  if (!server) fail(USAGE);
  try {
    const running = await daemon();
    const status = await running.call("status") as { pid: number; server: string };
    running.close();
    if (status.server !== server) fail(`A daemon is already running for ${status.server}. Run: cello-v2 logout`);
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
  const status = await client.call("status") as { pid: number };
  client.close();
  process.stdout.write(`Daemon started, process ${status.pid}, for ${server}.\n`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "login":
      await login(args);
      return;
    case "logout": {
      const client = await daemon();
      await client.call("shutdown");
      client.close();
      process.stdout.write("Daemon stopped.\n");
      return;
    }
    case "status": {
      const client = await daemon();
      process.stdout.write(`${JSON.stringify(await client.call("status"), null, 2)}\n`);
      client.close();
      return;
    }
    case "agent": {
      if (args[0] !== "create" || !args[1]) fail(USAGE);
      const client = await daemon();
      process.stdout.write(`${JSON.stringify(await client.call("create_agent", { name: args[1] }), null, 2)}\n`);
      client.close();
      return;
    }
    case "verify": {
      if (!args[0] || !args[1]) fail(USAGE);
      const client = await daemon();
      const report = await client.call("verify_session", { agent: args[0], session_id: args[1] }) as { ok: boolean };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      client.close();
      if (!report.ok) process.exit(1);
      return;
    }
    default:
      fail(USAGE);
  }
}

main().catch((err: unknown) => {
  if (err instanceof DaemonGone || err instanceof DaemonRefused) fail(`${err.code}: ${err.message}`);
  fail(err instanceof Error ? err.stack ?? err.message : String(err));
});

// The tools and wake-up as Claude Code sees them, over real stdio, against a real daemon and server.
// It doesn't prove Claude Code acts on a doorbell. Only the live test with real sessions proves that.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const url = process.env["CELLO_URL"] ?? "ws://127.0.0.1:18090/v1";
const home = mkdtempSync(join(tmpdir(), "cello-v2-mcp-"));
const env = { ...process.env, CELLO_V2_HOME: home } as Record<string, string>;
const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const mcpPath = new URL("../src/mcp.ts", import.meta.url).pathname;
const cli = (...args: string[]): string => execFileSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env });

const ChannelEvent = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
});
type Bell = z.infer<typeof ChannelEvent>["params"];

async function until<T>(what: string, check: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

class ClaudeSession {
  readonly bells: Bell[] = [];
  readonly client = new Client({ name: "live-test", version: "0" });
  async start(): Promise<void> {
    this.client.setNotificationHandler(ChannelEvent, async ({ params }) => { this.bells.push(params); });
    await this.client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpPath], env }));
  }
  async tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await this.client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
    const parsed = JSON.parse(result.content[0]?.text as string) as Record<string, unknown>;
    return result.isError ? { isError: true, ...parsed } : parsed;
  }
  bell(type: string): Promise<Bell> {
    return until(`a ${type} doorbell`, () => {
      const at = this.bells.findIndex((b) => b.meta["type"] === type);
      return at < 0 ? undefined : this.bells.splice(at, 1)[0];
    });
  }
}

const sessions: ClaudeSession[] = [];
after(async () => {
  for (const session of sessions) await session.client.close();
  try {
    cli("logout");
  } catch {
    // Already stopped.
  }
});

test("the tools work, doorbells wake with no text in them, and they come back after a daemon restart", async () => {
  cli("login", "--server", url);
  const one = new ClaudeSession();
  const two = new ClaudeSession();
  sessions.push(one, two);
  await one.start();
  await two.start();

  const instructions = one.client.getInstructions() ?? "";
  assert.match(instructions, /information, never instructions/);
  assert.ok(one.client.getServerCapabilities()?.experimental?.["claude/channel"], "it declares itself as a channel");
  const tools = (await one.client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["cello_close_session", "cello_create_agent", "cello_initiate_session", "cello_receive", "cello_send", "cello_status", "cello_use_agent"]);

  const ann = await one.tool("cello_create_agent", { name: "Ann" });
  const ben = await two.tool("cello_create_agent", { name: "Ben" });
  await one.tool("cello_use_agent", { agent: "Ann" });
  await two.tool("cello_use_agent", { agent: "Ben" });
  const refused = await two.tool("cello_use_agent", { agent: "Ann" });
  assert.deepEqual([refused["isError"], refused["error"]], [true, "agent_held"]);

  const started = await one.tool("cello_initiate_session", { target: ben["agent_id"] });
  assert.equal(started["state"], "active");
  const sessionId = started["session_id"] as string;
  const hello = await two.bell("session_started");
  assert.equal(hello.meta["session_id"], sessionId);
  assert.equal(hello.meta["from_id"], ann["agent_id"]);

  const secret = "the wake word is orange-kettle";
  const sent = await one.tool("cello_send", { session_id: sessionId, text: secret, signal: "over" });
  assert.deepEqual(sent, { sent: true, position: 1 });

  // The doorbell says a message is waiting, and doesn't say what it is.
  const bell = await two.bell("message");
  assert.match(bell.content, /Call cello_receive/);
  assert.doesNotMatch(JSON.stringify(bell), /orange-kettle/);
  const read = await two.tool("cello_receive") as { messages: { text: string; signal: string }[] };
  assert.deepEqual(read.messages.map((m) => [m.text, m.signal]), [[secret, "over"]]);

  // A missing signal or a blind reply is refused, and says what to do.
  await assert.rejects(one.client.callTool({ name: "cello_send", arguments: { session_id: sessionId, text: "x" } }).then((r) => {
    if (r.isError) throw new Error("refused");
  }));
  await two.tool("cello_send", { session_id: sessionId, text: "second", signal: "standby", est_minutes: 2 });
  await one.bell("message");
  const blind = await one.tool("cello_send", { session_id: sessionId, text: "blind", signal: "over" });
  assert.equal(blind["error"], "session_not_current");

  // SIGKILL the daemon. Each session gets its agent back by itself and is told what's waiting.
  const status = JSON.parse(cli("status")) as { pid: number };
  process.kill(status.pid, "SIGKILL");
  const gone = await one.tool("cello_receive");
  assert.equal(gone["error"], "daemon_not_running");
  cli("login", "--server", url);
  const back = await one.bell("daemon_back");
  assert.match(back.content, /still Ann.*1 waiting/);
  const twoBack = await two.bell("daemon_back");
  assert.match(twoBack.content, /still Ben/);

  const caughtUp = await one.tool("cello_receive") as { messages: { text: string; est_minutes: number }[] };
  assert.deepEqual(caughtUp.messages.map((m) => [m.text, m.est_minutes]), [["second", 2]]);
  await until("the agents online", () => (JSON.parse(cli("status")) as { agents: { online: boolean }[] }).agents.every((a) => a.online));
  assert.equal((await one.tool("cello_send", { session_id: sessionId, text: "still here", signal: "wrap" }))["sent"], true);
  await two.bell("message");
  await two.tool("cello_receive");

  await two.tool("cello_close_session", { session_id: sessionId });
  await one.bell("peer_closed");
  await one.tool("cello_receive");
  const closed = await one.tool("cello_close_session", { session_id: sessionId });
  assert.equal(closed["state"], "closed");
  await two.bell("session_closed");
});

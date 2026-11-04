// The speed test's bot at full speed: its own process, on one lasting socket to the daemon, as an MCP tool's shim is.
// A new process per send costs about 120 ms of CPU, which would hide everything behind it. It takes a JSON plan and writes a JSON list.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonRefused, IpcClient } from "../src/ipc/client.ts";

interface Plan { home: string; agent: string; caller: string; sessions: string[]; sizes: number[]; concurrency: number; seconds: number; limit?: number; tag: string; out: string }

const plan = JSON.parse(process.argv[2] as string) as Plan;
let stopped = false;
process.on("SIGTERM", () => { stopped = true; });

const client = await IpcClient.connect(join(plan.home, "daemon.sock"));
const sent: unknown[] = [];
const deadline = performance.now() + plan.seconds * 1000;
let next = 0;

async function worker(): Promise<void> {
  while (!stopped && performance.now() < deadline && (plan.limit === undefined || next < plan.limit)) {
    const seq = next++;
    const session = plan.sessions[seq % plan.sessions.length] as string;
    const size = plan.sizes[seq % plan.sizes.length] as number;
    const head = `${plan.tag}|${seq}|${size}|`;
    const text = head + String.fromCharCode(97 + (seq % 26)).repeat(Math.max(0, size - head.length));
    const started = performance.now();
    let outcome = "sent";
    let position: number | undefined;
    try {
      const result = await client.call("send", { agent: plan.agent, caller: plan.caller, session_id: session, text, signal: "over", notice: true }) as { sent: boolean; position?: number; status?: string };
      if (!result.sent) outcome = String(result.status);
      position = result.position;
    } catch (err: unknown) {
      outcome = err instanceof DaemonRefused ? err.code : String(err);
    }
    sent.push({ session, tag: plan.tag, seq, size, startedAt: started, ms: performance.now() - started, outcome, ...(position === undefined ? {} : { position }) });
    // A refusal comes back at once, and without this a worker would spin on it while a long upload finishes.
    if (outcome !== "sent") await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

await Promise.all(Array.from({ length: plan.concurrency }, worker));
client.close();
writeFileSync(plan.out, JSON.stringify(sent));

// A caller reading a pipe always gets the reason for a failure, even when it doesn't read until the process has gone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), "c2e-"));

function failing(args: string[], input?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, CELLO_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdin.end(input);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("every way the command line fails tells a caller on a pipe why", async () => {
  for (let i = 0; i < 5; i++) {
    const noDaemon = await failing(["send", "0".repeat(32), "-", "--over", "--agent", "x"], "text");
    assert.equal(noDaemon.status, 1);
    assert.equal((JSON.parse(noDaemon.stderr) as { error: string }).error, "daemon_not_running");
    const noAgent = await failing(["receive"]);
    assert.equal(noAgent.status, 1);
    assert.equal((JSON.parse(noAgent.stderr) as { error: string }).error, "no_current_agent");
    const usage = await failing(["send", "x", "--agnet"]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /send has no option --agnet/);
  }
});

test("a reason larger than a pipe holds still arrives whole", async () => {
  const long = "x".repeat(200_000);
  const usage = await failing(["send", "x", `--${long}`]);
  assert.equal(usage.status, 2);
  assert.ok(usage.stderr.includes(long), `only ${usage.stderr.length} bytes arrived`);
});

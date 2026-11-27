// The help page and the tool list are one decision. A tool for a command a reader of cello -h never sees, or a command
// on the page said to need a human operator that an agent can still call as a tool, would only show by reading both.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { OPERATIONS } from "../src/ipc/operations.ts";
import { TOOL_OPERATIONS } from "../src/mcp-tools.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const page = execFileSync(process.execPath, [cli, "-h"], { encoding: "utf8" });
// Each command's row, after the start-here block: two spaces, the command, then its line. A wrapped line starts deeper.
const rows = new Map([...page.slice(page.indexOf("Usage:")).matchAll(/^ {2}(\S+) +(.+)$/gm)].map((m) => [m[1] as string, m[2] as string]));

test("every tool is on the help page, and nothing off the page is a tool", () => {
  const tools = new Set(TOOL_OPERATIONS.map((op) => op.command));
  for (const command of tools) assert.ok(rows.has(command), `${command} is a tool and isn't on the help page`);
  for (const op of OPERATIONS) if (!rows.has(op.command)) assert.ok(!tools.has(op.command), `${op.command} is off the help page and still a tool`);
});

test("a line that starts 'Needs a human operator' is a command with no tool", () => {
  const tools = new Set(TOOL_OPERATIONS.map((op) => op.command));
  const operator = [...rows].filter(([, line]) => line.startsWith("Needs a human operator"));
  assert.ok(operator.length > 0);
  for (const [command] of operator) assert.ok(!tools.has(command), `${command} says it needs a human operator, and it's a tool`);
});

test("only these commands are left off the page, and they still have their own help", () => {
  const off = OPERATIONS.filter((op) => !rows.has(op.command)).map((op) => op.command).sort();
  assert.deepEqual(off, ["commit-read", "greetings", "publish-status", "remove-agent"]);
  for (const command of off) assert.match(execFileSync(process.execPath, [cli, command, "--help"], { encoding: "utf8" }), new RegExp(`^Usage: cello ${command}`));
  assert.ok(!rows.has("account") && !rows.has("issuer-list-sign"), "account and issuer-list-sign stay off the page");
  assert.match(execFileSync(process.execPath, [cli, "account", "--help"], { encoding: "utf8" }), /^Usage: cello dashboard/);
});

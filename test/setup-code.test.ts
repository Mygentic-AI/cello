// `cello setup --code -` takes the code from standard input so it never sits in a command line. When no code arrives,
// it must say so by name and use nothing, before it starts a daemon or touches any data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

function setup(input: string): { status: number | null; error: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), "c2-setup-code-"));
  const run = spawnSync(process.execPath, [cliPath, "setup", "--yes", "--code", "-", "--json"], { encoding: "utf8", input, env: { ...process.env, CELLO_HOME: home, HOME: home } });
  return { status: run.status, error: (JSON.parse(run.stderr) as { error: string }).error, home };
}

test("no code on standard input is refused by name, and nothing is started or written", () => {
  for (const input of ["", "\n", "  \t\n"]) {
    const run = setup(input);
    assert.equal(run.status, 1, JSON.stringify(input));
    assert.equal(run.error, "code_empty");
    assert.deepEqual(existsSync(run.home) ? readdirSync(run.home) : [], [], "a daemon or a database was started");
  }
});

test("help says the code can come from standard input", () => {
  const run = spawnSync(process.execPath, [cliPath, "setup", "--help"], { encoding: "utf8" });
  assert.match(run.stdout, /--code .*Give - to read it from standard input/);
});

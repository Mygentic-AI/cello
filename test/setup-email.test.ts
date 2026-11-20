// With no terminal, setup can't ask for anything, so whatever the email route is missing is said in one line before a
// daemon starts or anything is written. A run that waited for an answer nobody can give would hang a script for good.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

function setup(args: string[]): { status: number | null; stderr: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), "c2-setup-email-"));
  const run = spawnSync(process.execPath, [cliPath, "setup", "--yes", ...args], { encoding: "utf8", input: "", timeout: 10_000, env: { ...process.env, CELLO_HOME: home, HOME: home } });
  return { status: run.status, stderr: run.stderr, home };
}

test("each missing or clashing value is one line, and nothing is started or written", () => {
  const cases: [string[], string][] = [
    [[], "✗ No setup code and no email. Give --email <address> to get a code, or --code <code>. Nothing was set up.\n"],
    [["--email", "ann@example.test"], "✗ Give the agent a name with --name. Nothing was set up.\n"],
    [["--email", "ann", "--name", "Ann"], "✗ That doesn't look like an email address. Nothing was set up.\n"],
    [["--code", "c", "--email", "ann@example.test"], "✗ Give a setup code or an email, not both.\n"],
    [["--code", "c", "--email-code", "123456"], "✗ Give a setup code or an email, not both.\n"],
    [["--name", "Ann", "--email-code", "12345"], "✗ The code is the six digits in the email. Run the same command with those six digits. Nothing was used.\n"],
  ];
  for (const [args, said] of cases) {
    const run = setup(args);
    assert.equal(run.status, 1, args.join(" "));
    assert.equal(run.stderr, said, args.join(" "));
    assert.deepEqual(existsSync(run.home) ? readdirSync(run.home) : [], [], `${args.join(" ")}: a daemon or a database was started`);
  }
});

test("help shows the email route, and how an agent does it in two runs", () => {
  const run = spawnSync(process.execPath, [cliPath, "setup", "--help"], { encoding: "utf8" });
  for (const flag of ["--email ", "--email-code ", "--invite ", "--name "]) assert.ok(run.stdout.includes(flag), flag);
  assert.match(run.stdout, /cello setup --yes --name Ann --email ann@example\.com\n {2}printf %s "\$EMAILED_CODE" \| cello setup --name Ann --email-code -/);
});

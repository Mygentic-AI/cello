// Four small fixes from Andre's first onboarding run, 2026-11-07.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { OutboundPIIScreener } from "../src/daemon/pii.ts";

const cards = (text: string): string[] => new OutboundPIIScreener({ whitelist: [] }).screen(new TextEncoder().encode(text), "s")
  .events.filter((e) => e.category === "pii:credit_card").map((e) => e.value);

test("a millisecond timestamp isn't a card number, even when it passes the checksum, and a real card still is", () => {
  // 1762531200008 passes the Luhn checksum; it held a post in the huddle before.
  assert.deepEqual(cards("posted at 1762531200008"), []);
  assert.deepEqual(cards("card 4111 1111 1111 1111"), ["4111 1111 1111 1111"]);
  assert.deepEqual(cards("card 5555555555554444"), ["5555555555554444"]);
});

test("cello --version, -v and version print the package version", () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  for (const flag of ["--version", "-v", "version"]) {
    const run = spawnSync(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname, flag], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), version);
  }
});

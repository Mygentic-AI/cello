// Claude Code keeps its own copy of the plugin and replaces it only when plugin.json's version changes. It stayed at 0.0.1 from
// 7 November, so no skill written after that reached anyone who had installed it. Each release has to carry a new plugin version,
// and the package's version is the one that already changes every release.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const versionOf = (path: string): string => (JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { version: string }).version;

test("the plugin's version is the package's, so every release reaches an installed plugin", () => {
  assert.equal(versionOf("../plugins/cello/.claude-plugin/plugin.json"), versionOf("../package.json"));
});

// The Mac app speaks the daemon's operator socket, so it ships with each release. pnpm writes workspace:* as the mac
// package's own version, so a release that bumps only the cli would name a mac package that was never published.
test("the Mac app package has the cli's version, is the cli's optional dependency, and installs only on a Mac", () => {
  const cli = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { optionalDependencies?: Record<string, string> };
  const mac = JSON.parse(readFileSync(new URL("../mac-app/package.json", import.meta.url), "utf8")) as { name: string; os?: string[]; files?: string[]; dependencies?: unknown };
  assert.equal(versionOf("../mac-app/package.json"), versionOf("../package.json"));
  assert.deepEqual(cli.optionalDependencies, { [mac.name]: "workspace:*" });
  assert.deepEqual([mac.os, mac.files, mac.dependencies], [["darwin"], ["CELLO.app"], undefined]);
});

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

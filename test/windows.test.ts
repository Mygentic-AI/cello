// Windows refused the daemon's Unix socket for a v1 user (listen EACCES at every path length, admin or not).
// These pin the Windows endpoints, which this Mac can't exercise live.
import assert from "node:assert/strict";
import { test } from "node:test";
import { endpointIsFile, oldVersionEndpoints, socketPath } from "../src/daemon/paths.ts";
import { mergeNpmrc, npmShell } from "../src/screener/screener-state.ts";
import { claudeDesktopFolder, windowsCommandLine } from "../src/install-mcp.ts";

test("Claude Desktop's config is found under %APPDATA% on Windows", () => {
  assert.equal(claudeDesktopFolder("C:\\Users\\k", "win32", "C:\\Users\\k\\AppData\\Roaming"), "C:\\Users\\k\\AppData\\Roaming\\Claude");
  assert.equal(claudeDesktopFolder("C:\\Users\\k", "win32", undefined), "C:\\Users\\k\\AppData\\Roaming\\Claude");
  assert.equal(claudeDesktopFolder("/Users/k", "darwin"), "/Users/k/Library/Application Support/Claude");
  assert.equal(claudeDesktopFolder("/home/k", "linux"), "/home/k/.config/Claude");
});

test("a claude.cmd runs through a shell with every argument quoted, a claude.exe runs directly", () => {
  const cmd = windowsCommandLine("C:\\Program Files\\nodejs\\claude.cmd", ["plugin", "marketplace", "add", "C:\\Users\\Kevin H\\cello"]);
  assert.deepEqual(cmd, { file: "\"C:\\Program Files\\nodejs\\claude.cmd\"", args: ["\"plugin\"", "\"marketplace\"", "\"add\"", "\"C:\\Users\\Kevin H\\cello\""], shell: true });
  assert.deepEqual(windowsCommandLine("C:\\bin\\claude.exe", ["plugin", "list"]), { file: "C:\\bin\\claude.exe", args: ["plugin", "list"], shell: false });
});

test("the screener install runs npm through a shell on Windows only", () => {
  assert.equal(npmShell("win32"), true);
  assert.equal(npmShell("darwin"), false);
});

test("the screener's .npmrc setting is merged into what's there, never written over it", () => {
  assert.equal(mergeNpmrc(""), "allow-scripts=onnxruntime-node,protobufjs\n");
  assert.equal(mergeNpmrc("registry=https://r.example\n"), "registry=https://r.example\nallow-scripts=onnxruntime-node,protobufjs\n");
  assert.equal(mergeNpmrc("registry=x"), "registry=x\nallow-scripts=onnxruntime-node,protobufjs\n");
  assert.equal(mergeNpmrc("allow-scripts=sharp\r\nregistry=x\r\n"), "allow-scripts=sharp,onnxruntime-node,protobufjs\r\nregistry=x\r\n");
  const done = "a=1\nallow-scripts=protobufjs, onnxruntime-node\n";
  assert.equal(mergeNpmrc(done), done, "a file that already has both is left byte for byte");
});

test("on Windows the daemon listens on a named pipe, named from the home folder", () => {
  const pipe = socketPath("C:\\Users\\kevin\\.cello", "win32");
  assert.match(pipe, /^\\\\\.\\pipe\\cello-[0-9a-f]{12}-daemon$/);
  assert.equal(socketPath("c:/users/KEVIN/.cello", "win32"), pipe, "case and slash direction don't change the pipe");
  assert.notEqual(socketPath("C:\\Users\\other\\.cello", "win32"), pipe, "two homes get two pipes");
});

test("the pipe name matches the old version's, so setup can see an old daemon still running", () => {
  // The v1 client's getDaemonIpcEndpoint("C:\\Users\\kevin\\.cello", "win32").
  const [daemon, gateway] = oldVersionEndpoints("C:\\Users\\kevin\\.cello", "win32");
  assert.equal(daemon, socketPath("C:\\Users\\kevin\\.cello", "win32"));
  assert.match(gateway as string, /-gateway$/);
});

test("elsewhere it's a socket file in the home folder, and only a file is cleared after a crash", () => {
  assert.equal(socketPath("/home/k/.cello", "linux"), "/home/k/.cello/daemon.sock");
  assert.deepEqual(oldVersionEndpoints("/home/k/.cello", "darwin"), ["/home/k/.cello/daemon.sock", "/home/k/.cello/gateway.sock"]);
  assert.equal(endpointIsFile("linux"), true);
  assert.equal(endpointIsFile("win32"), false);
});

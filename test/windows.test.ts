// Windows refused the daemon's Unix socket for a v1 user (listen EACCES at every path length, admin or not).
// These pin the Windows endpoints, which this Mac can't exercise live.
import assert from "node:assert/strict";
import { test } from "node:test";
import { endpointIsFile, oldVersionEndpoints, socketPath } from "../src/daemon/paths.ts";

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

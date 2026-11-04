// Live, a send cut off by a daemon kill landed by itself 9 times out of 9, after telling its caller only that the
// daemon wasn't running. A caller told that sends again, and the line lands twice.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DaemonGone, IpcClient } from "../src/ipc/client.ts";

test("a call cut off in flight says it may still take effect, and a call never made doesn't", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "c2i-")), "s.sock");
  const daemon = createServer((socket) => {
    socket.once("data", () => socket.destroy());
  });
  await new Promise<void>((resolve) => daemon.listen(path, resolve));
  const client = await IpcClient.connect(path);
  await assert.rejects(client.call("send", {}), (err: Error & { code?: string }) => {
    assert.equal(err.code, "daemon_stopped_during_call");
    assert.match(err.message, /check the transcript before sending it again/);
    return true;
  });
  await new Promise((resolve) => daemon.close(resolve));
  await assert.rejects(IpcClient.connect(path), DaemonGone);
});

test("a cut-off call is told what's true of that call", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "c2i-")), "s.sock");
  const daemon = createServer((socket) => {
    socket.once("data", () => socket.destroy());
  });
  await new Promise<void>((resolve) => daemon.listen(path, resolve));
  const cases: [string, RegExp][] = [
    ["send", /message may still go out/],
    ["close_session", /close may still go out/],
    ["initiate_session", /session may have started/],
    ["create_agent", /agent may have been created/],
    ["receive", /still counts as unread/],
    ["status", /outcome is unknown/],
  ];
  for (const [method, wording] of cases) {
    const client = await IpcClient.connect(path);
    await assert.rejects(client.call(method), (err: Error & { code?: string }) => {
      assert.equal(err.code, "daemon_stopped_during_call");
      assert.match(err.message, wording);
      if (method !== "send") assert.doesNotMatch(err.message, /message may/);
      return true;
    });
  }
  await new Promise((resolve) => daemon.close(resolve));
});

test("a line cut short by a dying daemon counts as the call being cut off", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "c2i-")), "s.sock");
  const daemon = createServer((socket) => {
    socket.once("data", () => socket.end("{\"id\":1,\"ok\":tr"));
  });
  await new Promise<void>((resolve) => daemon.listen(path, resolve));
  const client = await IpcClient.connect(path);
  await assert.rejects(client.call("status"), { code: "daemon_stopped_during_call" });
  await new Promise((resolve) => daemon.close(resolve));
});

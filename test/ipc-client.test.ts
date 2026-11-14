// Live, a send cut off by a daemon kill landed by itself 9 times out of 9, after telling its caller only that the
// daemon wasn't running. A caller told that sends again, and the line lands twice.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { DaemonGone, DaemonRefused, IpcClient, connectFailure } from "../src/ipc/client.ts";
import { daemonProof, ipcHandshakeRequired, newIpcKey } from "../src/ipc/handshake.ts";

// A fake daemon that answers hello with a proof under `key`, or with garbage, or not at all.
async function helloServer(answer: (nonce: string) => unknown): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "c2h-")), "s.sock");
  const server = createServer((socket) => {
    createInterface({ input: socket }).on("line", (line) => {
      const req = JSON.parse(line) as { id: number; method: string; params: { nonce: string } };
      const result = req.method === "hello" ? answer(req.params.nonce) : { pong: true };
      if (result !== undefined) socket.write(`${JSON.stringify({ id: req.id, ok: true, result })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  server.unref();
  return path;
}

test("on Windows a client sends nothing to whoever holds the pipe until it proves it holds this user's key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "c2k-"));
  const keyFile = join(dir, "daemon.ipc-key");
  const key = newIpcKey();
  writeFileSync(keyFile, `${key}\n`);

  const real = await IpcClient.connect(await helloServer((nonce) => ({ proof: daemonProof(key, nonce) })), { verify: true, keyFile });
  assert.deepEqual(await real.call("status"), { pong: true });
  real.close();

  const otherKey = newIpcKey();
  const squatter = await helloServer((nonce) => ({ proof: daemonProof(otherKey, nonce) }));
  await assert.rejects(IpcClient.connect(squatter, { verify: true, keyFile }), (err: DaemonRefused) => err.code === "daemon_unverified" && /failed the check/.test(err.message));

  // An answer seen once is no use later: the nonce differs every time.
  let seen: { nonce: string; proof: string } | undefined;
  const recorder = await helloServer((nonce) => { seen = { nonce, proof: daemonProof(key, nonce) }; return { proof: seen.proof }; });
  (await IpcClient.connect(recorder, { verify: true, keyFile })).close();
  const replayer = await helloServer(() => ({ proof: seen?.proof }));
  await assert.rejects(IpcClient.connect(replayer, { verify: true, keyFile }), (err: DaemonRefused) => err.code === "daemon_unverified");

  await assert.rejects(IpcClient.connect(squatter, { verify: true, keyFile: join(dir, "missing") }), (err: DaemonRefused) => /left no key/.test(err.message));
  assert.equal(ipcHandshakeRequired("win32"), true);
  assert.equal(ipcHandshakeRequired("darwin"), false);
});

test("only nothing listening reads as 'not running'; a blocked or busy endpoint says what it is", () => {
  const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
  assert.ok(connectFailure("p", err("ENOENT")) instanceof DaemonGone);
  assert.ok(connectFailure("p", err("ECONNREFUSED")) instanceof DaemonGone);
  const blocked = connectFailure("\\\\.\\pipe\\cello-x-daemon", err("EPERM"));
  assert.ok(blocked instanceof DaemonRefused && !(blocked instanceof DaemonGone));
  assert.equal((blocked as DaemonRefused).code, "daemon_unreachable");
  assert.match(blocked.message, /EPERM.*sandbox/);
  assert.match(connectFailure("p", err("ETIMEDOUT")).message, /ETIMEDOUT/);
});

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

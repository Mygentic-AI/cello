// A server can send anything. A mistake here wouldn't show against an honest server, so this one lies.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { IpcClient } from "../src/ipc/client.ts";
import { generateIdentitySeeds, signerFromSeeds } from "../src/protocol/identity.ts";
import { serverAuthBytes } from "../src/protocol/structures.ts";
import { PROTOCOL_VERSION, fromB64, identityCodec, signatureCodec, toB64 } from "../src/protocol/wire.ts";

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("garbage pushes from the server leave the daemon running", async () => {
  const signer = await signerFromSeeds(generateIdentitySeeds());
  const serverNonce = new Uint8Array(randomBytes(32));
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  let authedAgent: string | undefined;
  const reached: string[] = [];

  wss.on("connection", (socket) => {
    socket.on("message", (raw: Buffer) => {
      void (async () => {
        const frame = JSON.parse(raw.toString()) as { id: number; method: string; params: Record<string, unknown> };
        reached.push(frame.method);
        const answer = (result: unknown): void => socket.send(JSON.stringify({ v: PROTOCOL_VERSION, id: frame.id, ok: true, result }));
        if (frame.method === "hello") {
          const clientNonce = fromB64(frame.params["clientNonce"], "clientNonce");
          const signature = await signer.sign("cello-server-auth", serverAuthBytes({ serverId: signer.id, clientNonce, serverNonce }));
          answer({ server: identityCodec.encode(signer.publicIdentity), serverNonce: toB64(serverNonce), signature: signatureCodec.encode(signature) });
        } else if (frame.method === "auth") {
          authedAgent = Buffer.from(fromB64(frame.params["agentId"], "agentId")).toString("hex");
          answer({ ok: true });
        } else if (frame.method === "session.list") {
          answer({ sessions: [] });
        } else {
          answer({ agentId: "" });
        }
      })();
    });
  });

  const home = mkdtempSync(join(tmpdir(), "cello-v2-hostile-"));
  const entry = fileURLToPath(new URL("../src/daemon/main.ts", import.meta.url));
  const daemon = spawn(process.execPath, [entry, `ws://127.0.0.1:${port}/`], { env: { ...process.env, CELLO_HOME: home }, stdio: "ignore" });
  const socketPath = join(home, "daemon.sock");
  const client = await until("the daemon's socket", async () => {
    try {
      return await IpcClient.connect(socketPath);
    } catch {
      return false;
    }
  });
  try {
    await client.call("create_agent", { name: "Target" });
    const agent = await until("the agent to authenticate", () => authedAgent);

    const garbage = [
      { push: "session", agent, data: {} },
      { push: "session", agent, data: { offer: "nonsense" } },
      { push: "session", agent, data: { offer: { fields: {}, signature: {} } } },
      { push: "entry", agent, data: {} },
      { push: "entry", agent, data: { entry: 7, ack: null } },
      { push: "entry", agent },
    ];
    for (const socket of wss.clients) {
      for (const frame of garbage) socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
      socket.send("this isn't JSON");
    }

    // A status round trip after the frames, through the same event loop that received them.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const status = await client.call("status") as { connected: boolean };
    assert.equal(status.connected, true);
    assert.equal(daemon.exitCode, null);
    assert.ok(reached.includes("auth"));
  } finally {
    daemon.kill("SIGKILL");
    wss.close();
    client.close();
    assert.doesNotThrow(() => readFileSync(socketPath.replace("daemon.sock", "cello.db.key")));
  }
});

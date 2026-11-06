// The account page is a door on the daemon that a web browser can reach. These pin what must stay shut: a stranger's
// request, a web page in a browser that rebinds a name to this machine, a write, and anything beyond the six reads.
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { ACCOUNT_PAGE_READS, serveAccountPage } from "../src/daemon/account-page.ts";
import { LocalError } from "../src/daemon/engine.ts";
import { OPERATIONS } from "../src/ipc/operations.ts";

const TOKEN = "a".repeat(64);

async function start(): Promise<{ port: number; asked: { method: string; params: Record<string, unknown> }[]; close: () => Promise<void> }> {
  const asked: { method: string; params: Record<string, unknown> }[] = [];
  const page = await serveAccountPage({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    allowedHosts: (port) => [`127.0.0.1:${port}`, `localhost:${port}`],
    call: async (method, params) => {
      asked.push({ method, params });
      if (method === "contacts") throw new LocalError("no_current_agent", "name the agent");
      return { method, params };
    },
  });
  return { port: page.port, asked, close: page.close };
}

// A raw request, because a client library would set a Host header that a hostile page couldn't.
function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const signedIn = { authorization: `Bearer ${TOKEN}` };

test("each name the page may read is a real operation that acts as nobody and isn't for a person only", () => {
  for (const name of ACCOUNT_PAGE_READS) {
    const op = OPERATIONS.find((candidate) => candidate.method === name);
    assert.ok(op, `${name} is not an operation`);
    assert.equal(op.acts, false, `${name} acts as an agent`);
    assert.notEqual(op.personOnly, true, `${name} is for a person only`);
  }
});

test("a request without the secret, or with a wrong one, gets nothing and reaches nothing", async () => {
  const page = await start();
  try {
    for (const headers of [{} as Record<string, string>, { authorization: "Bearer wrong" }, { authorization: `Bearer ${TOKEN}x` }, { authorization: TOKEN }, { authorization: "Bearer " }]) {
      const res = await get(page.port, "/api/agents", headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.equal(JSON.parse(res.body).error.code, "not_signed_in");
    }
    assert.equal(page.asked.length, 0);
  } finally {
    await page.close();
  }
});

test("a name that isn't this server's own is refused, even with the secret", async () => {
  const page = await start();
  try {
    for (const host of ["evil.example", `evil.example:${page.port}`, "127.0.0.1", `127.0.0.1.evil.example:${page.port}`]) {
      for (const path of ["/", "/api/agents"]) {
        const res = await get(page.port, path, { ...signedIn, host });
        assert.equal(res.status, 421, `${host} ${path}`);
      }
    }
    assert.equal(page.asked.length, 0);
  } finally {
    await page.close();
  }
});

test("nothing but a read is accepted, and only the six reads", async () => {
  const page = await start();
  try {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      assert.equal((await get(page.port, "/api/agents", signedIn, method)).status, 405, method);
    }
    for (const name of ["contact_add", "settings_set", "config_set", "screening", "issuer_trust", "send", "remove_agent", "account", "status", "signals_enable", "signals_collect"]) {
      const res = await get(page.port, `/api/${name}`, signedIn);
      assert.equal(res.status, 404, name);
      assert.equal(JSON.parse(res.body).error.code, "not_on_this_page");
    }
    assert.equal(page.asked.length, 0);
  } finally {
    await page.close();
  }
});

test("an allowed read passes the caller's own words to the daemon as text, and a refusal keeps its reason", async () => {
  const page = await start();
  try {
    const ok = JSON.parse((await get(page.port, "/api/signals_list?agent=ab12&all=true", signedIn)).body);
    assert.deepEqual(ok.result, { method: "signals_list", params: { agent: "ab12", all: true } });
    const refused = await get(page.port, "/api/contacts", signedIn);
    assert.equal(refused.status, 400);
    assert.deepEqual(JSON.parse(refused.body), { ok: false, error: { code: "no_current_agent", message: "name the agent" } });
  } finally {
    await page.close();
  }
});

test("the page and its files are served without the secret, load nothing from elsewhere, and hold no secret", async () => {
  const page = await start();
  try {
    for (const path of ["/", "/page.css", "/page.js"]) {
      const res = await get(page.port, path);
      assert.equal(res.status, 200, path);
      assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.ok(!res.body.includes(TOKEN));
      assert.ok(!/https?:\/\//.test(res.body), `${path} names another address`);
      assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(res.body), `${path} puts text in as markup`);
    }
    assert.equal((await get(page.port, "/nothing")).status, 404);
  } finally {
    await page.close();
  }
});

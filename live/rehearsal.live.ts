// Andre's go-live test, rehearsed on this Mac against local copies of every service. Run it with scripts/rehearsal.sh.
//
// Real: the server (its compose), the issuer's production image with its test keys and its test-signed list, the waitlist
// (its own code on Postgres, minting codes with its own minting function), the hosted image run by the real host agent
// under Docker, the provisioner, the hosted page's production build, the web endpoint inside the hosted container, and
// the Concierge's image. The local agents are real daemons run from this checkout.
//
// Stood in, as test plumbing only: Docker's runc for gVisor; no disk quota; a header for Google ID tokens between the
// hosted page and the provisioner; a local envelope key for KMS; no Caddy router (the container's ports are reached
// under their real host names); a small TCP relay inside the containers, so they reach the issuer at 127.0.0.1 like
// the Mac's daemons do; host ports remapped into 23000-23999. The server counts the issuer as an operator-added issuer,
// because it only accepts lists signed by the production roots and the issuer's list is signed by test roots.
//
// Each step records pass or fail with its time. A failed step stops only the steps that depend on it.
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { signerFromSeeds } from "../src/protocol/identity.ts";
import { identityCodec } from "../src/protocol/wire.ts";

const run = promisify(execFile);
const E = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (scripts/rehearsal.sh sets it)`);
  return v;
};
const V2 = new URL("..", import.meta.url).pathname;
const SERVER_DIR = E("R_SERVER_DIR");
const ISSUER_DIR = E("R_ISSUER_DIR");
const TC_DIR = E("R_TC_DIR"); // trustless-cello checkout
const WAITLIST_MIGRATIONS = E("R_WAITLIST_MIGRATIONS");
const OPS_MIGRATIONS = E("R_OPS_MIGRATIONS");
const EVIDENCE = E("R_EVIDENCE");
const IMAGES = { issuer: E("R_ISSUER_IMAGE"), hosted: E("R_HOSTED_IMAGE"), concierge: E("R_CONCIERGE_IMAGE") };
const PROJECT = process.env["COMPOSE_PROJECT_NAME"] ?? "cello-rehearsal";
const HOSTING = join(TC_DIR, "packages/hosting");
const WEB_DIR = join(HOSTING, "web");
const LAMBDA = join(TC_DIR, "infra/lambda");
const need = createRequire(join(HOSTING, "package.json"));
// pg is the hosting package's, so this repo needs no copy. Only what this file uses of it.
interface QueryResult { rows: Record<string, unknown>[]; rowCount: number | null }
interface PgClient { connect(): Promise<void>; query(text: string, params?: unknown[]): Promise<QueryResult>; end(): Promise<void> }
const pg = need("pg") as { Client: new (o: { connectionString: string }) => PgClient; Pool: new (o: { connectionString: string }) => unknown };

const P = { pg: 23432, server: 23080, waitlist: 23100, issuer: 23102, web: 23104, hostAgent: 23105, provisioner: 23106 };
const remapPort = (p: number): number => (p >= 21000 && p < 21200 ? 23700 + (p - 21000) : p >= 20000 && p < 20200 ? 23500 + (p - 20000) : p);
const ADMIN = `postgres://admin:admin@127.0.0.1:${P.pg}`;
const SERVER_LOCAL = `ws://127.0.0.1:${P.server}/v1`;
const SERVER_INSIDE = `ws://host.docker.internal:${P.server}/v1`;
const ISSUER_URL = `http://127.0.0.1:${P.issuer}`; // the same address on the Mac and, through the relay, inside each container
const ISSUER_TOKEN = "rehearsal-issuer-token";
const CHECK_TOKEN = "rehearsal-code-check-token";
const PG_NAME = `${PROJECT}-pg`;
const ISSUER_NAME = `${PROJECT}-issuer`;
const CONCIERGE_NAME = `${PROJECT}-concierge`;
const ANDRE = `andre-${randomInt(1e9)}@example.test`;
const STRANGER = `stranger-${randomInt(1e9)}@example.test`;
const WORK = mkdtempSync("/private/tmp/cr-"); // Docker on a Mac mounts /private/tmp at the same path
const cli = join(V2, "src/cli.ts");

// ---------- the record ----------
interface Step { name: string; result: "PASS" | "FAIL" | "SKIP" | "NOTE"; seconds: number; detail: string }
const steps: Step[] = [];
function record(step: Step): void {
  steps.push(step);
  process.stdout.write(`${step.result.padEnd(4)}  ${step.seconds.toFixed(1).padStart(6)}s  ${step.name}${step.detail ? `  -- ${step.detail}` : ""}\n`);
  writeResults();
}
function writeResults(): void {
  writeFileSync(join(EVIDENCE, "results.json"), JSON.stringify(steps, null, 2));
  writeFileSync(join(EVIDENCE, "results.md"), `# Rehearsal ${new Date().toISOString()}\n\n${steps.map((s) => `- **${s.result}** (${s.seconds.toFixed(1)}s) ${s.name}${s.detail ? `: ${s.detail.replaceAll("\n", " ")}` : ""}`).join("\n")}\n`);
}
const failed = new Set<string>();
async function step<T>(name: string, after: string[], fn: () => Promise<T>): Promise<T | undefined> {
  const blocked = after.filter((d) => failed.has(d));
  if (blocked.length > 0) {
    failed.add(name);
    record({ name, result: "SKIP", seconds: 0, detail: `needs: ${blocked.join(", ")}` });
    return undefined;
  }
  const t0 = Date.now();
  try {
    const value = await fn();
    record({ name, result: "PASS", seconds: (Date.now() - t0) / 1000, detail: typeof value === "string" ? value : "" });
    return value;
  } catch (err) {
    failed.add(name);
    record({ name, result: "FAIL", seconds: (Date.now() - t0) / 1000, detail: err instanceof Error ? err.message.slice(0, 1500) : String(err) });
    return undefined;
  }
}
function must(ok: unknown, what: string): void {
  if (!ok) throw new Error(what);
}

// ---------- helpers ----------
const children: ChildProcess[] = [];
function start(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string>; log: string }): void {
  const out = join(EVIDENCE, opts.log);
  const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
  const sink: Buffer[] = [];
  p.stdout?.on("data", (d: Buffer) => sink.push(d));
  p.stderr?.on("data", (d: Buffer) => sink.push(d));
  p.on("exit", () => writeFileSync(out, Buffer.concat(sink)));
  setInterval(() => writeFileSync(out, Buffer.concat(sink)), 2000).unref();
  children.push(p);
}
async function until<T>(what: string, fn: () => Promise<T | false | undefined | null> | T | false | undefined | null, seconds = 60): Promise<T> {
  const end = Date.now() + seconds * 1000;
  let last = "";
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out after ${seconds}s waiting for ${what}${last ? ` (last error: ${last.slice(0, 300)})` : ""}`);
}
async function sql(db: string, text: string, params: unknown[] = []): Promise<QueryResult> {
  const c = new pg.Client({ connectionString: `${ADMIN}/${db}` });
  await c.connect();
  try {
    return await c.query(text, params);
  } finally {
    await c.end();
  }
}
function docker(args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8", input, maxBuffer: 64_000_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function compose(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("docker", ["compose", ...args], { cwd: SERVER_DIR, encoding: "utf8", maxBuffer: 64_000_000, env: process.env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const serverKnows = (agentId: string): boolean => compose(["exec", "-T", "postgres", "psql", "-U", "cello_owner", "-d", "cello", "-tAc", `SELECT count(*) FROM agents WHERE agent_id = '\\x${agentId}'`]).stdout.trim() === "1";

interface Run { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
function cello(home: string, args: string[], input = ""): Run {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", input, env: { ...process.env, HOME: home, CELLO_HOME: home, CELLO_CALLER: "" }, timeout: 180_000 });
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(r.stdout || r.stderr) as Record<string, unknown>; } catch { /* plain words */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
function ok(home: string, args: string[], input = ""): Record<string, unknown> {
  const r = cello(home, args, input);
  must(r.status === 0, `cello ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout).slice(-600)}`);
  return r.json;
}
const homes: string[] = [];
function newHome(): string {
  const h = mkdtempSync(join(tmpdir(), "cr-")); // short: a socket path is limited to about 104 bytes
  homes.push(h);
  return h;
}

// The waitlist's own minting function, on its own database: what the status page and the invitation call.
async function issueCode(email: string, kind: "admission" | "device"): Promise<string> {
  await sql("waitlist_r", `INSERT INTO waitlist_users (email, anon_id, status, email_status, email_verified) VALUES ($1, gen_random_uuid(), 'admitted', 'active', true) ON CONFLICT (email) DO NOTHING`, [email]);
  const py = `
import sys, psycopg2, psycopg2.extras
sys.path.insert(0, ${JSON.stringify(LAMBDA)})
import _install_codes
conn = psycopg2.connect(${JSON.stringify(`postgres://waitlist:waitlist@127.0.0.1:${P.pg}/waitlist_r`)})
with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
    cur.execute("SELECT waitlist_id FROM waitlist_users WHERE email = %s", (sys.argv[1],))
    uid = cur.fetchone()["waitlist_id"]
    code, _ = _install_codes.mint(cur, uid, sys.argv[2])
conn.commit()
print(code)
`;
  const { stdout } = await run("python3", ["-c", py, email, kind]);
  const code = stdout.trim();
  must(/^CELLO-[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/.test(code), `the waitlist minted no code: ${stdout}`);
  return code;
}
async function codeUsed(code: string): Promise<boolean> {
  const { rows } = await sql("waitlist_r", `SELECT used_at FROM install_codes WHERE code_hash = $1`, [createHash("sha256").update(code).digest("hex")]);
  return rows[0]?.used_at != null;
}

// A relay each container's node processes start, so 127.0.0.1:<issuer port> inside reaches the issuer on the Mac.
const RELAY = join(WORK, "relay.mjs");
writeFileSync(RELAY, `import net from "node:net";
const s = net.createServer((c) => { const u = net.connect(${P.issuer}, "host.docker.internal"); c.pipe(u); u.pipe(c); c.on("error", () => u.destroy()); u.on("error", () => c.destroy()); });
s.on("error", () => {});
s.listen(${P.issuer}, "127.0.0.1");
s.unref();
`);
const relayArgs = ["--add-host", "host.docker.internal:host-gateway", "-v", `${RELAY}:/opt/rehearsal-relay.mjs:ro`, "-e", "NODE_OPTIONS=--import=/opt/rehearsal-relay.mjs"];

// ---------- a request to a hosted container's port, under its real host name, as the router forwards it ----------
interface Got { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function hosted(port: number, host: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Got> {
  return new Promise((resolve, reject) => {
    const r = httpsRequest({ host: "127.0.0.1", port, path, method, servername: host, rejectUnauthorized: false, headers: { host, ...headers }, timeout: 150_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    r.end(body);
  });
}
// The web endpoint the way ChatGPT and Claude.ai reach it: OAuth with a connect code, then a fresh MCP session per call.
class WebApp {
  readonly port: number;
  readonly host: string;
  readonly token: string;
  constructor(port: number, host: string, token: string) {
    this.port = port;
    this.host = host;
    this.token = token;
  }
  static async signIn(port: number, host: string, connectCode: string): Promise<WebApp> {
    const base = `https://${host}`;
    const REDIRECT = "http://127.0.0.1:9/callback";
    const reg = await hosted(port, host, "POST", "/register", { "content-type": "application/json" }, JSON.stringify({ client_name: "Rehearsal ChatGPT", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }));
    must(reg.status < 300, `/register answered ${reg.status}: ${reg.body.slice(0, 300)}`);
    const clientId = (JSON.parse(reg.body) as { client_id: string }).client_id;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s", resource: `${base}/mcp` });
    const page = await hosted(port, host, "GET", `/authorize?${q}`, {});
    const request = /name="request" value="([^"]+)"/.exec(page.body)?.[1];
    must(request, `/authorize gave no sign-in form (${page.status}): ${page.body.slice(0, 300)}`);
    const approved = await hosted(port, host, "POST", "/authorize/approve", { "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ request: request as string, code: connectCode }).toString());
    const location = approved.headers["location"];
    must(typeof location === "string", `approve answered ${approved.status} with no redirect: ${approved.body.slice(0, 300)}`);
    const given = new URL(location as string).searchParams.get("code");
    must(given, `the redirect carried no code: ${String(location)}`);
    const tok = await hosted(port, host, "POST", "/token", { "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ grant_type: "authorization_code", code: given as string, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${base}/mcp` }).toString());
    const access = (JSON.parse(tok.body) as { access_token?: string }).access_token;
    must(access, `/token gave no access token (${tok.status}): ${tok.body.slice(0, 300)}`);
    return new WebApp(port, host, access as string);
  }
  async #rpc(session: string | undefined, body: Record<string, unknown>): Promise<{ session?: string; result?: Record<string, unknown>; status: number; raw: string }> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${this.token}`, "mcp-protocol-version": "2025-06-18" };
    if (session) headers["mcp-session-id"] = session;
    const got = await hosted(this.port, this.host, "POST", "/mcp", headers, JSON.stringify(body));
    const sid = got.headers["mcp-session-id"];
    let text = got.body;
    if (String(got.headers["content-type"] ?? "").includes("text/event-stream")) {
      text = got.body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1) ?? "";
    }
    let parsed: { result?: Record<string, unknown> } = {};
    try { parsed = JSON.parse(text) as typeof parsed; } catch { /* a notification has no body */ }
    return { session: typeof sid === "string" ? sid : session, result: parsed.result, status: got.status, raw: got.body };
  }
  async tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const init = await this.#rpc(undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rehearsal", version: "1" } } });
    must(init.status === 200 && init.result, `MCP initialize answered ${init.status}: ${init.raw.slice(0, 300)}`);
    await this.#rpc(init.session, { jsonrpc: "2.0", method: "notifications/initialized" });
    const called = await this.#rpc(init.session, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
    must(called.result, `${name} answered ${called.status}: ${called.raw.slice(0, 400)}`);
    const content = (called.result as { content: { text: string }[]; isError?: boolean });
    const text = content.content[0]?.text ?? "";
    try {
      return { ...(content.isError ? { isError: true } : {}), ...(JSON.parse(text) as object) };
    } catch {
      return { isError: content.isError === true, text };
    }
  }
}

// ---------- bring-up ----------
async function database(): Promise<void> {
  docker(["rm", "-f", PG_NAME]);
  const started = docker(["run", "-d", "--name", PG_NAME, "-p", `127.0.0.1:${P.pg}:5432`, "-e", "POSTGRES_USER=admin", "-e", "POSTGRES_PASSWORD=admin", "--tmpfs", "/var/lib/postgresql/data", "postgres:16-alpine"]);
  must(started.status === 0, `postgres: ${started.stderr}`);
  await until("postgres", async () => (await sql("postgres", "SELECT 1")).rowCount === 1, 60);
  for (const [db, role] of [["cello_hosted", "hosted"], ["cello_hosting", "hosting"], ["cello_issuer_r", "issuer"], ["waitlist_r", "waitlist"]]) {
    await sql("postgres", `DO $$ BEGIN CREATE ROLE ${role} LOGIN PASSWORD '${role}'; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await sql("postgres", `CREATE DATABASE ${db} OWNER ${role}`);
    await sql("postgres", `REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
  }
  const c = new pg.Client({ connectionString: `${ADMIN}/waitlist_r` });
  await c.connect();
  await c.query("SET ROLE waitlist");
  const list = (dir: string, re: RegExp): string[] => readdirSync(dir).filter((n) => re.test(n)).sort();
  const deferred: string[] = [];
  for (const f of list(OPS_MIGRATIONS, /^ops_.*\.sql$/)) {
    try { await c.query(readFileSync(join(OPS_MIGRATIONS, f), "utf8")); } catch (err) {
      if ((err as { code?: string }).code !== "42P01") throw err;
      deferred.push(f);
    }
  }
  for (const f of list(WAITLIST_MIGRATIONS, /\.sql$/)) await c.query(readFileSync(join(WAITLIST_MIGRATIONS, f), "utf8"));
  for (const f of deferred) await c.query(readFileSync(join(OPS_MIGRATIONS, f), "utf8"));
  await c.end();
}

async function issuerTrusted(): Promise<string> {
  const s = await signerFromSeeds({ ed: new Uint8Array(Buffer.from("1d".repeat(32), "hex")), pq: new Uint8Array(Buffer.from("1e".repeat(32), "hex")) });
  const k = identityCodec.encode(s.publicIdentity);
  return JSON.stringify([{ address: "127.0.0.1", ed: k["ed"], pq: k["pq"] }]);
}

async function server(): Promise<string> {
  process.env["CELLO_TRUSTED_ISSUERS"] = await issuerTrusted();
  process.env["CELLO_PORT"] = String(P.server);
  process.env["POSTGRES_PASSWORD"] = randomBytes(16).toString("hex");
  process.env["CELLO_APP_PASSWORD"] = randomBytes(16).toString("hex");
  const up = compose(["up", "-d", "--build", "--wait", "server"]);
  must(up.status === 0, `compose up: ${up.stderr.slice(-800)}`);
  // Go-live gap 1: the server reads a signed list at /data/issuer-list.cbor. Put the issuer's test-signed list there, as
  // step 5 does with the real one, and see what the server makes of a list signed by roots it doesn't ship.
  const cp = compose(["cp", join(ISSUER_DIR, "test/fixtures/issuer-list.signed"), "server:/data/issuer-list.cbor"]);
  must(cp.status === 0, `copying the list: ${cp.stderr}`);
  const health = await (await fetch(`http://127.0.0.1:${P.server}/healthz`)).text();
  return `healthz: ${health.slice(0, 300)}`;
}

function waitlist(): Promise<boolean> {
  start("gunicorn", ["_app:application", "-b", `127.0.0.1:${P.waitlist}`, "--workers", "1", "--threads", "4"], {
    cwd: LAMBDA, log: "waitlist.log",
    env: { DATABASE_URL: `postgres://waitlist:waitlist@127.0.0.1:${P.pg}/waitlist_r`, PGSSLMODE: "disable", ISSUER_INVOKE_TOKEN: ISSUER_TOKEN, CODE_CHECK_INVOKE_TOKEN: CHECK_TOKEN, INTERNAL_INVOKE_TOKEN: "rehearsal-general" },
  });
  return until("the waitlist", async () => (await fetch(`http://127.0.0.1:${P.waitlist}/health`)).ok);
}

async function issuer(): Promise<string> {
  docker(["rm", "-f", ISSUER_NAME]);
  const started = docker(["run", "-d", "--name", ISSUER_NAME, "--add-host", "host.docker.internal:host-gateway",
    "-v", `${join(ISSUER_DIR, "test/fixtures/issuer-list.signed")}:/list/issuer-list.signed:ro`, "-p", `127.0.0.1:${P.issuer}:3000`,
    "-e", "CELLO_ENV=local", "-e", `PORTAL_DATABASE_URL=postgres://issuer:issuer@host.docker.internal:${P.pg}/cello_issuer_r`,
    "-e", "ISSUER_ADDRESS=127.0.0.1", "-e", "ISSUER_LIST_FILE=/list/issuer-list.signed", "-e", `ISSUER_STATUS_SERVER_URLS=${SERVER_INSIDE}`,
    "-e", `WAITLIST_URL=http://host.docker.internal:${P.waitlist}`, "-e", `WAITLIST_ISSUER_TOKEN=${ISSUER_TOKEN}`, IMAGES.issuer]);
  must(started.status === 0, `issuer: ${started.stderr}`);
  await until("the issuer's page", async () => (await fetch(`${ISSUER_URL}/`)).status === 200, 180);
  const list = await (await fetch(`${ISSUER_URL}/api/issuer/list`)).json() as { list?: string };
  must(typeof list.list === "string", "the issuer serves no list");
  return `serves its page and a list of ${Buffer.from(list.list as string, "base64").length} bytes`;
}

interface HostedStack { sites: Record<string, number> }
async function hostedStack(): Promise<HostedStack> {
  const imp = (p: string) => import(join(HOSTING, p));
  const { createHostAgentServer } = await imp("dist/host-agent/server.js");
  const { DockerContainerRuntime } = await imp("dist/host-agent/docker-runtime.js");
  const { OpensslTlsCertProvider } = await imp("dist/host-agent/runtime.js");
  const { createProvisionerServer } = await imp("dist/provisioner/server.js");
  const { HttpsHostAgentClient } = await imp("dist/provisioner/host-agent-client.js");
  const { HostedDaemonStore } = await imp("dist/record-store.js");
  const { NoopKeyCreator } = await imp("dist/key-creator.js");
  const { applyMigrations } = await imp("dist/migrate.js");
  const { HostingError } = await imp("dist/refusals.js");
  const { LocalEnvelopeKeyProvider, StdoutLogger } = need("@cello-protocol/interfaces/stubs") as { LocalEnvelopeKeyProvider: new (hex: string) => unknown; StdoutLogger: new () => unknown };
  mkdirSync(join(WORK, "users"), { recursive: true });
  mkdirSync(join(WORK, "run"), { recursive: true });
  const tls = join(WORK, "tls");
  mkdirSync(tls, { recursive: true });
  await run("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", join(tls, "agent.key"), "-out", join(tls, "agent.pem"), "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  const logger = new StdoutLogger();
  const runtime = new DockerContainerRuntime({
    image: IMAGES.hosted,
    serverUrl: SERVER_INSIDE,
    volumesBase: join(WORK, "users"),
    chownHome: async () => {},
    exec: (async (file: string, args: string[], opts?: { maxBuffer?: number; input?: string }) => {
      if (file === "xfs_quota") return { stdout: "", stderr: "" };
      let a = args;
      if (file === "docker" && args[0] === "run") {
        a = args.filter((x) => x !== "--runtime=runsc").map((x) => x.replace(/^127\.0\.0\.1:(\d+):(878[78])$/, (_m, port: string, inner: string) => `127.0.0.1:${remapPort(Number(port))}:${inner}`));
        const image = a.pop() as string;
        a = [...a, ...relayArgs, image];
      }
      const running = run(file, a, { maxBuffer: opts?.maxBuffer ?? 16 * 1024 * 1024, encoding: "utf8" });
      if (opts?.input !== undefined) running.child.stdin?.end(opts.input);
      return await running as { stdout: string; stderr: string };
    }) as never,
  });
  const sites: Record<string, number> = {};
  const router = { async writeSite(h: string, p: number) { sites[h] = remapPort(p); }, async removeSite(h: string) { delete sites[h]; }, async reload() {} };
  const agentTls = { cert: readFileSync(join(tls, "agent.pem"), "utf8"), key: readFileSync(join(tls, "agent.key"), "utf8") };
  const hostAgent = createHostAgentServer({
    envelope: new LocalEnvelopeKeyProvider("22".repeat(32)), runtime, router, tls: new OpensslTlsCertProvider(), logger,
    authenticator: { async authenticate() {} }, tmpfsBase: join(WORK, "run"), chownSecret: async () => {},
    issuerUrl: ISSUER_URL, serverTls: agentTls, daemonDeadlineMs: 120_000,
  });
  hostAgent.listen(P.hostAgent, "127.0.0.1");
  const pool = new pg.Pool({ connectionString: `postgres://hosting:hosting@127.0.0.1:${P.pg}/cello_hosting` });
  await applyMigrations(pool, join(HOSTING, "db/migrations"));
  const provisioner = createProvisionerServer({
    store: new HostedDaemonStore(pool), envelope: new LocalEnvelopeKeyProvider("22".repeat(32)), keyCreator: new NoopKeyCreator(),
    hostAgent: new HttpsHostAgentClient({ baseUrl: `https://127.0.0.1:${P.hostAgent}`, pinnedCert: agentTls.cert, mintIdToken: async () => "local" }),
    verifier: {
      async verify(req: { headers: Record<string, unknown> }) {
        const id = req.headers["x-cello-account-id"];
        if (typeof id !== "string") throw new HostingError({ error: "unauthenticated", cause: "no owner header" });
        return { accountId: id };
      },
    },
    logger,
  });
  provisioner.listen(P.provisioner, "127.0.0.1");
  start("pnpm", ["exec", "next", "start", "-p", String(P.web)], {
    cwd: WEB_DIR, log: "hosted-page.log",
    env: {
      CELLO_ENV: "local", NODE_ENV: "production", HOSTED_DATABASE_URL: `postgres://hosted:hosted@127.0.0.1:${P.pg}/cello_hosted`,
      WAITLIST_URL: `http://127.0.0.1:${P.waitlist}`, WAITLIST_CODE_CHECK_TOKEN: CHECK_TOKEN,
      HOSTING_PROVISIONER_URL: `http://127.0.0.1:${P.provisioner}`, PORTAL_BASE_URL: `http://localhost:${P.web}`,
    },
  });
  await until("the hosted page", async () => (await fetch(`http://localhost:${P.web}/hosted`)).status === 200, 90);
  return { sites };
}

async function concierge(): Promise<string> {
  docker(["rm", "-f", CONCIERGE_NAME]);
  docker(["volume", "rm", "-f", `${CONCIERGE_NAME}-data`]);
  const started = docker(["run", "-d", "--name", CONCIERGE_NAME, "--init", "--restart", "unless-stopped", ...relayArgs, "-v", `${CONCIERGE_NAME}-data:/data`, "-e", `CELLO_SERVER=${SERVER_INSIDE}`, IMAGES.concierge]);
  must(started.status === 0, `concierge: ${started.stderr}`);
  await until("the Concierge's daemon", () => docker(["exec", CONCIERGE_NAME, "cello", "status"]).status === 0, 90);
  // The runbook's command, with a real code from the waitlist on standard input. Production gives no --issuer.
  const code = await issueCode(`concierge-${randomInt(1e9)}@example.test`, "admission");
  const setup = docker(["exec", "-i", CONCIERGE_NAME, "cello", "setup", "--yes", "--issuer", ISSUER_URL, "--code", "-", "--name", "Concierge", "--server", SERVER_INSIDE, "--json"], `${code}\n`);
  must(setup.status === 0, `concierge setup exited ${setup.status}: ${(setup.stdout + setup.stderr).slice(-800)}`);
  const id = await until("the Concierge online", () => {
    const agents = JSON.parse(docker(["exec", CONCIERGE_NAME, "cello", "agents"]).stdout || "{}") as { agents?: { name: string; agent_id: string; online: boolean }[] };
    const a = agents.agents?.find((x) => x.name === "Concierge");
    return a?.online ? a.agent_id : undefined;
  }, 90);
  return id;
}

// ---------- the walk ----------
async function main(): Promise<void> {
  mkdirSync(EVIDENCE, { recursive: true });
  process.stdout.write(`evidence: ${EVIDENCE}\n`);
  const UP_PG = "bring-up: Postgres for the waitlist, issuer, hosted page and provisioner, each database with its own login";
  const UP_SERVER = "bring-up: server (compose), counting the issuer as operator-added, with the test-signed list at /data/issuer-list.cbor";
  const UP_WAITLIST = "bring-up: waitlist (its own code, gunicorn)";
  const UP_ISSUER = "bring-up: issuer production image, CELLO_ENV=local test keys, list signed by two test roots";
  await step(UP_PG, [], database);
  await step(UP_SERVER, [], server);
  await step(UP_WAITLIST, [UP_PG], waitlist);
  await step(UP_ISSUER, [UP_PG, UP_WAITLIST], issuer);
  const UP_HOSTED = "bring-up: host agent (Docker), provisioner, hosted page (production build)";
  const stack = await step(UP_HOSTED, [UP_PG, UP_WAITLIST], hostedStack);
  const UP_CONCIERGE = "bring-up: Concierge container, its agent set up with a real waitlist code";
  const conciergeId = await step(UP_CONCIERGE, [UP_SERVER, UP_ISSUER, UP_WAITLIST], concierge);

  // 1. Andre onboards himself with a waitlist code, on a local daemon.
  const S_CODE = "1. the waitlist issues Andre an admission code";
  const codeA = await step(S_CODE, [UP_WAITLIST], () => issueCode(ANDRE, "admission"));
  const local = newHome();
  const S_SETUP = "2. `cello setup --code -` on a local daemon: code redeemed, email signal collected and presented, agent registered";
  const localId = await step(S_SETUP, [S_CODE, UP_SERVER, UP_ISSUER], async () => {
    const r = cello(local, ["setup", "--yes", "--server", SERVER_LOCAL, "--issuer", ISSUER_URL, "--code", "-", "--name", "Andre_Local", "--json"], `${codeA}\n`);
    writeFileSync(join(EVIDENCE, "setup-local.out"), `${r.stdout}\n---\n${r.stderr}`);
    must(r.status === 0, `setup exited ${r.status}: ${(r.stderr || r.stdout).slice(-800)}`);
    must(await codeUsed(codeA as string), "the waitlist still shows the code unspent");
    const agents = ok(local, ["agents"]) as { agents: { name: string; agent_id: string; online: boolean }[] };
    const me = agents.agents.find((a) => a.name === "Andre_Local");
    must(me, "no agent named Andre_Local");
    const listed = ok(local, ["signals", "list", "--json", "--agent", "Andre_Local"]) as { signals: { type: string; status: string; issuer_standing: string; counts_as_verified: boolean }[] };
    const email = listed.signals.find((s) => s.type === "email");
    must(email, `no email signal held: ${JSON.stringify(listed)}`);
    await until("the server to know the agent", () => serverKnows(me!.agent_id), 30);
    await until("Andre_Local online", () => (ok(local, ["agents"]) as typeof agents).agents.find((a) => a.name === "Andre_Local")?.online, 30);
    return me!.agent_id;
  });
  if (localId) {
    const listed = ok(local, ["signals", "list", "--json", "--agent", "Andre_Local"]);
    record({ name: "2a. what Andre sees of his email signal", result: "NOTE", seconds: 0, detail: JSON.stringify(listed).slice(0, 600) });
  }

  // 2. A second code, the hosted page, a hosted agent.
  const S_CODE_B = "3. the waitlist issues a second admission code, for the hosted agent";
  const codeB = await step(S_CODE_B, [UP_WAITLIST], () => issueCode(`${ANDRE.replace("@", "+hosted@")}`, "admission"));
  const cookies = new Map<string, string>();
  const page = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown>; text: string }> => {
    const res = await fetch(`http://localhost:${P.web}${path}`, { method, redirect: "manual", headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") }, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(";");
      const [k, v] = (kv as string).split("=");
      if (k && v) cookies.set(k, v);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a page */ }
    return { status: res.status, json, text };
  };
  const S_HOSTED = "4. hosted page: the code creates a hosted agent in its own container";
  const created = await step(S_HOSTED, [S_CODE_B, UP_HOSTED, UP_SERVER, UP_ISSUER], async () => {
    const first = await page("GET", "/hosted");
    must(first.status === 200, `GET /hosted answered ${first.status}`);
    const c = await page("POST", "/api/hosted", { agent_name: "Andre_Hosted", code: codeB });
    writeFileSync(join(EVIDENCE, "hosted-create.json"), JSON.stringify(c.json, null, 2));
    must(c.status === 200 && typeof c.json["url"] === "string", `create answered ${c.status}: ${c.text.slice(0, 800)}`);
    must(await codeUsed(codeB as string), "the waitlist still shows the hosted code unspent");
    const agentId = c.json["agent_id"] as string;
    await until("the server to know the hosted agent", () => serverKnows(agentId), 60);
    return c.json as { host_id: string; agent_id: string; url: string };
  }) as { host_id: string; agent_id: string; url: string } | undefined;

  const S_WEB = "5. web endpoint: connect code from the hosted page, OAuth sign-in, a tool answers";
  const app = await step(S_WEB, [S_HOSTED], async () => {
    const cc = await page("POST", "/api/hosted/connect-code");
    must(cc.status === 200 && typeof cc.json["code"] === "string", `connect code answered ${cc.status}: ${cc.text.slice(0, 300)}`);
    const { hostNameFor } = await import(join(HOSTING, "dist/host-agent/runtime.js")) as { hostNameFor: (id: string) => string };
    const host = hostNameFor(created!.host_id);
    const port = stack!.sites[created!.host_id];
    must(port, `the router was given no site for ${created!.host_id}`);
    const signed = await WebApp.signIn(port as number, host, cc.json["code"] as string);
    const agents = await signed.tool("cello_agents", {});
    must(JSON.stringify(agents).includes(created!.agent_id), `cello_agents didn't list the hosted agent: ${JSON.stringify(agents).slice(0, 400)}`);
    const held = await signed.tool("cello_use_agent", { agent: "Andre_Hosted" });
    must(!held["error"], `cello_use_agent: ${JSON.stringify(held)}`);
    return signed;
  }) as WebApp | undefined;

  // 3. Local agent and hosted agent hold a sealed conversation. The hosted side is driven through the web endpoint.
  const S_TALK = "6. local agent calls the hosted agent; they talk over the web endpoint, both close and both seal";
  await step(S_TALK, [S_SETUP, S_WEB], async () => {
    const waiting = app!.tool("cello_wait", { agent: "Andre_Hosted", timeout_seconds: 60 });
    await new Promise((r) => setTimeout(r, 1000));
    const session = ok(local, ["initiate-session", created!.agent_id, "--agent", "Andre_Local"])["session_id"] as string;
    must(session, "no session id");
    const started = await waiting;
    must(started["event"] === "session_started", `the hosted agent's wait said ${JSON.stringify(started).slice(0, 300)}`);
    ok(local, ["send", session, "-", "--over", "--agent", "Andre_Local"], "Rehearsal: this is your local agent. Reply and wrap.");
    await until("the hosted agent to have the message", async () => {
      const r = await app!.tool("cello_receive", { agent: "Andre_Hosted" }) as { messages?: { text: string }[] };
      return (r.messages ?? []).some((m) => m.text?.includes("Rehearsal")) && r;
    }, 90);
    const sent = await app!.tool("cello_send", { agent: "Andre_Hosted", session_id: session, text: "Heard you. Closing.", signal: "wrap" });
    must(sent["sent"] === true, `hosted send: ${JSON.stringify(sent).slice(0, 300)}`);
    await until("the local agent to have the reply", () => {
      const r = ok(local, ["receive", "--session-id", session, "--agent", "Andre_Local"]) as { messages?: { text: string }[] };
      return (r.messages ?? []).some((m) => m.text === "Heard you. Closing.");
    }, 90);
    ok(local, ["close-session", session, "--agent", "Andre_Local"]);
    const hostedClose = await app!.tool("cello_close_session", { agent: "Andre_Hosted", session_id: session });
    must(!hostedClose["error"], `hosted close: ${JSON.stringify(hostedClose)}`);
    const localSeal = await until("the local seal", () => {
      const r = cello(local, ["seal", session, "--agent", "Andre_Local"]);
      return r.status === 0 && JSON.stringify(r.json).includes("sealed") && r.json;
    }, 240);
    const hostedSeal = await until("the hosted seal", async () => {
      const r = await app!.tool("cello_seal", { agent: "Andre_Hosted", session_id: session });
      return !r["error"] && JSON.stringify(r).includes("sealed") && r;
    }, 240);
    writeFileSync(join(EVIDENCE, "seals.json"), JSON.stringify({ session, localSeal, hostedSeal }, null, 2));
    return `session ${session}`;
  });

  // 4. A second agent on another machine: a device code for the same person, on a second daemon.
  const S_SECOND = "7. a second machine: a device code for Andre, `cello setup --code -` on a second daemon, registered";
  const second = newHome();
  await step(S_SECOND, [S_SETUP], async () => {
    const code = await issueCode(ANDRE, "device");
    const r = cello(second, ["setup", "--yes", "--server", SERVER_LOCAL, "--issuer", ISSUER_URL, "--code", "-", "--name", "Andre_Laptop2", "--json"], `${code}\n`);
    writeFileSync(join(EVIDENCE, "setup-second.out"), `${r.stdout}\n---\n${r.stderr}`);
    must(r.status === 0, `setup exited ${r.status}: ${(r.stderr || r.stdout).slice(-800)}`);
    const me = (ok(second, ["agents"]) as { agents: { name: string; agent_id: string }[] }).agents.find((a) => a.name === "Andre_Laptop2");
    must(me, "no agent named Andre_Laptop2");
    await until("the server to know the second agent", () => serverKnows(me!.agent_id), 30);
    return me!.agent_id;
  });

  // 5. A stranger reaches the Concierge.
  const S_STRANGER = "8. a stranger (own code, own daemon) calls the Concierge and hears its three lines";
  await step(S_STRANGER, [UP_CONCIERGE], async () => {
    const home = newHome();
    const code = await issueCode(STRANGER, "admission");
    const r = cello(home, ["setup", "--yes", "--server", SERVER_LOCAL, "--issuer", ISSUER_URL, "--code", "-", "--name", "Stranger", "--json"], `${code}\n`);
    must(r.status === 0, `stranger setup exited ${r.status}: ${(r.stderr || r.stdout).slice(-600)}`);
    await until("the stranger online", () => (ok(home, ["agents"]) as { agents: { name: string; online: boolean }[] }).agents.find((a) => a.name === "Stranger")?.online, 30);
    const session = ok(home, ["initiate-session", conciergeId as string, "--agent", "Stranger"])["session_id"] as string;
    const heard = (): string[] => ((ok(home, ["transcript", session, "--agent", "Stranger"]) as { entries: { own: boolean; text?: string }[] }).entries).filter((e) => !e.own && e.text).map((e) => e.text as string);
    const say = (text: string): void => {
      ok(home, ["receive", "--session-id", session, "--agent", "Stranger"]);
      ok(home, ["send", session, "-", "--over", "--agent", "Stranger"], text);
    };
    await until("the first line", () => heard().length >= 1, 45);
    say("hello");
    await until("the next line", () => heard().length >= 2, 45);
    say("and then?");
    const lines = await until("the last line", () => heard().length >= 3 && heard(), 45);
    must(!lines.some((l) => l.startsWith("[DRAFT COPY]")), "a line still carries the draft label");
    writeFileSync(join(EVIDENCE, "concierge-lines.json"), JSON.stringify(lines, null, 2));
    return `${lines.length} lines heard`;
  });

  // 6. What this can't do on this Mac.
  record({ name: "9. GitHub, X and phone signals", result: "NOTE", seconds: 0, detail: "not run: each needs a real OAuth app or SMS provider, and issuer.tf wires none of their credentials (go-live gap 9)" });
  record({ name: "10. the signed issuer list end to end", result: "NOTE", seconds: 0, detail: "server and client ship only the production root keys, so a list signed by test roots can't be accepted locally; the server counts this issuer as operator-added instead. Proving the list needs the real Touch ID-signed list (go-live step 4)" });
}

function cleanup(): void {
  for (const home of homes) {
    try { cello(home, ["logout"]); } catch { /* best effort */ }
  }
  for (const n of [ISSUER_NAME, CONCIERGE_NAME]) {
    const logs = docker(["logs", n]);
    writeFileSync(join(EVIDENCE, `${n}.log`), logs.stdout + logs.stderr);
  }
  // Only this run's: their ports were remapped into its range.
  for (const id of docker(["ps", "-aq", "--filter", "name=cello-hosted-", "--filter", "publish=23500-23699"]).stdout.split("\n").filter(Boolean)) {
    const name = docker(["inspect", "-f", "{{.Name}}", id]).stdout.trim().replace(/^\//, "");
    const logs = docker(["logs", id]);
    writeFileSync(join(EVIDENCE, `${name}.log`), logs.stdout + logs.stderr);
    docker(["rm", "-f", id]);
  }
  for (const [i, home] of homes.entries()) if (existsSync(join(home, "daemon.log"))) cpSync(join(home, "daemon.log"), join(EVIDENCE, `daemon-${i}.log`));
  writeFileSync(join(EVIDENCE, "server.log"), compose(["logs", "--timestamps", "server"]).stdout);
  docker(["rm", "-f", ISSUER_NAME, CONCIERGE_NAME, PG_NAME]);
  docker(["volume", "rm", "-f", `${CONCIERGE_NAME}-data`]);
  compose(["down", "-v", "--remove-orphans"]);
  for (const c of children) c.kill("SIGTERM");
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
}

let code = 0;
try {
  await main();
} catch (err) {
  record({ name: "the rehearsal itself", result: "FAIL", seconds: 0, detail: err instanceof Error ? err.stack ?? err.message : String(err) });
} finally {
  cleanup();
  code = steps.some((s) => s.result === "FAIL" || s.result === "SKIP") ? 1 : 0;
  process.stdout.write(`\n${steps.filter((s) => s.result === "PASS").length} passed, ${steps.filter((s) => s.result === "FAIL").length} failed, ${steps.filter((s) => s.result === "SKIP").length} skipped. Evidence: ${EVIDENCE}\n`);
}
process.exit(code);

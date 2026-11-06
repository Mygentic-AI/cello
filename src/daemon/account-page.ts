// The account page: a web page the daemon serves about its own agents. It only reads, so nothing a person can weaken
// is reachable from it. That stays at the terminal. It knows nothing about where the daemon runs: the caller says
// where to listen and how a request is answered, so a hosted container can serve the same page beside its endpoint.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ACCOUNT_PAGE_ASSETS } from "./account-page-assets.ts";
import { LocalError } from "./engine.ts";

// What the page may ask for. Each is a read that acts as nobody. A test checks that every name is a real operation.
export const ACCOUNT_PAGE_READS = ["agents", "signals_list", "signals_view", "contacts", "settings", "config"] as const;

export type AccountPageCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface AccountPageOptions {
  host: string;
  port: number;
  // The secret a request carries. Anything else on this machine, including a web page in a browser, doesn't have it.
  token: string;
  call: AccountPageCall;
  // Names a request may use for this server. A page opened under another name is refused, which stops DNS rebinding.
  allowedHosts: (port: number) => string[];
}

export interface RunningAccountPage { port: number; close: () => Promise<void> }

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
} as const;

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function failure(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

// A flag is "true" or "false", and a number is a number, because a query string only carries text.
function paramsFrom(url: URL): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    params[key] = value === "true" ? true : value === "false" ? false : value;
  }
  return params;
}

async function answer(req: IncomingMessage, res: ServerResponse, options: AccountPageOptions, port: number): Promise<void> {
  if (!options.allowedHosts(port).includes(req.headers.host ?? "")) {
    sendJson(res, 421, failure("wrong_host", "This page answers only under its own address."));
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (req.method !== "GET") {
    sendJson(res, 405, failure("read_only", "This page only reads. Anything that changes a guard is done at the terminal."));
    return;
  }
  const asset = ACCOUNT_PAGE_ASSETS[url.pathname];
  if (asset) {
    send(res, 200, asset.type, asset.body);
    return;
  }
  const route = /^\/api\/([a-z_]+)$/.exec(url.pathname);
  if (!route) {
    sendJson(res, 404, failure("not_found", `Nothing is served at ${url.pathname}.`));
    return;
  }
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  if (!sameSecret(bearer, options.token)) {
    sendJson(res, 401, failure("not_signed_in", "Open the page from the link the cello account command prints."));
    return;
  }
  const method = route[1] as string;
  if (!(ACCOUNT_PAGE_READS as readonly string[]).includes(method)) {
    sendJson(res, 404, failure("not_on_this_page", `${method} isn't something this page can ask for.`));
    return;
  }
  try {
    sendJson(res, 200, { ok: true, result: await options.call(method, paramsFrom(url)) });
  } catch (err) {
    if (err instanceof LocalError) sendJson(res, 400, failure(err.code, err.message));
    else sendJson(res, 500, failure("internal_error", err instanceof Error ? err.message : String(err)));
  }
}

export async function serveAccountPage(options: AccountPageOptions): Promise<RunningAccountPage> {
  let port = options.port;
  const server: Server = createServer((req, res) => {
    answer(req, res, options, port).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, failure("internal_error", err instanceof Error ? err.message : String(err)));
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: options.host, port: options.port }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

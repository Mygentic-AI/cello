// An agent's address is its key plus its server, like an email address: <64 hex>@cello.example.com.
// Plain ws is for this machine only. An address comes from someone else, so one that names a plain-text host off this machine
// could get a daemon connecting unencrypted and pinning whatever key that host shows. It's refused, whoever hands it over.
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const SHORT_HOST = /^[A-Za-z0-9.-]+(:\d+)?$|^\[[0-9A-Fa-f:]+\](:\d+)?$/;

export interface Address {
  id: string;
  // Absent when only a key was given, which means this daemon's own server.
  server?: string;
}

export class PlainTextServer extends RangeError {
  readonly code = "plain_text_server";
}

export function serverUrlFrom(host: string): string {
  if (host.includes("://")) {
    const url = new URL(host);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new RangeError(`a server address must be ws or wss, not ${url.protocol}`);
    if (url.protocol === "ws:" && !LOOPBACK.test(url.host)) throw new PlainTextServer(`${url.host} is on another machine and this address has no encryption, so it wasn't contacted. Whoever gave you this address should give you one on wss.`);
    return url.toString().replace(/\/$/, "");
  }
  if (!SHORT_HOST.test(host)) throw new RangeError(`this isn't a server address: ${host}`);
  return `${LOOPBACK.test(host) ? "ws" : "wss"}://${host}/v1`;
}

export function parseAddress(target: string): Address {
  const at = target.indexOf("@");
  if (at < 0) return { id: target };
  return { id: target.slice(0, at), server: serverUrlFrom(target.slice(at + 1)) };
}

// The shortest spelling that parses back to the same URL.
export function formatAddress(id: string, serverUrl: string): string {
  const match = /^wss?:\/\/([^/]+)\/v1$/.exec(serverUrl);
  const host = match?.[1];
  const short = host !== undefined && SHORT_HOST.test(host) && serverUrlFrom(host) === serverUrl;
  return `${id}@${short ? host : serverUrl}`;
}

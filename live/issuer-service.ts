// The stand-in issuer as its own process, so every daemon in a live run collects a real signal the way a person's does.
// --print-trusted prints what a server needs to count it. Otherwise it writes its URL to the named file, and stops when its parent does.
import { writeFileSync } from "node:fs";
import { identityCodec } from "../src/protocol/wire.ts";
import { StandInIssuer, standInKeys } from "./stand-in-issuer.ts";

if (process.argv[2] === "--print-trusted") {
  const keys = identityCodec.encode((await standInKeys()).publicIdentity);
  process.stdout.write(JSON.stringify([{ address: "127.0.0.1", ed: keys["ed"], pq: keys["pq"] }]));
  process.exit(0);
}
const issuer = await StandInIssuer.start(process.env["CELLO_ISSUER_DIR"] as string, { open: true });
writeFileSync(process.argv[2] as string, issuer.url);
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 1000);

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

export function celloHome(): string {
  return process.env["CELLO_HOME"] ?? join(homedir(), ".cello");
}

// Windows refuses a Unix socket in the home folder (listen EACCES at any path length, admin or not), so there the
// daemon listens on a named pipe. The pipe's name comes from the home folder, so two homes get two daemons.
// A pipe made by Node takes the default DACL: full control for its user, SYSTEM and Administrators, and READ for
// Everyone and Anonymous. A reader can't send a request, so other accounts can't act, but the name is predictable and
// another account could create it first. The client checks the daemon's proof before trusting it (src/ipc/handshake.ts).
export function socketPath(home = celloHome(), platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return windowsPipe(home, "daemon");
  return join(home, "daemon.sock");
}

// The old version used the same naming, with a second pipe for its gateway. Setup probes both to see if it's running.
export function windowsPipe(home: string, name: "daemon" | "gateway"): string {
  const canonical = win32.resolve(home).toLowerCase().replace(/\//g, "\\");
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `\\\\.\\pipe\\cello-${hash}-${name}`;
}

// Where the old version listened: a socket file on macOS and Linux, a named pipe on Windows.
export function oldVersionEndpoints(home = celloHome(), platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return [windowsPipe(home, "daemon"), windowsPipe(home, "gateway")];
  return [join(home, "daemon.sock"), join(home, "gateway.sock")];
}

// A named pipe vanishes with the process that made it. Only a socket file can be left behind by a crash.
export const endpointIsFile = (platform: NodeJS.Platform = process.platform): boolean => platform !== "win32";

// The key the daemon proves itself with on Windows (src/ipc/handshake.ts). A fresh one at every start.
export function ipcKeyPath(home = celloHome()): string {
  return join(home, "daemon.ipc-key");
}

export function databasePath(home = celloHome()): string {
  return join(home, "cello.db");
}

export function logPath(home = celloHome()): string {
  return join(home, "daemon.log");
}

// Files only the old version writes. The new version can't read them, so it must never start over them.
const OLD_VERSION_FILES = ["sessions.db", "gateway.db", "directory-key", "daemon.singleton"];

export function holdsOldVersion(home = celloHome()): boolean {
  return OLD_VERSION_FILES.some((file) => existsSync(join(home, file)));
}

export const oldVersionMessage = (home = celloHome()): string => `${home} holds data from the old version of CELLO, which this version can't read, so nothing was started. Its agents don't carry over. Run cello setup at a terminal, and it offers to move that data to ${home}-old.`;

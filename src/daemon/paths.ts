import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function celloHome(): string {
  return process.env["CELLO_HOME"] ?? join(homedir(), ".cello");
}

export function socketPath(home = celloHome()): string {
  return join(home, "daemon.sock");
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

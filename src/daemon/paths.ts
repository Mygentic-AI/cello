import { homedir } from "node:os";
import { join } from "node:path";

// Kept apart from today's CELLO data while both run on one machine.
export function celloHome(): string {
  return process.env["CELLO_V2_HOME"] ?? join(homedir(), ".cello-v2");
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

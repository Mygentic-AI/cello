// A refusal with a name, which the caller gets as it is.
export class LocalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalError";
    this.code = code;
  }
}

// Anything that loosens is refused here unless a person agreed at a terminal, whoever asked. The command line alone asks,
// and re-sends with this set. A program running as this user could set it too: this is the speed bump the help describes.
export function requirePerson(params: Record<string, unknown>, what: string, command: string): void {
  if (params["person_confirmed"] === true && params["caller"] === "cli") return;
  throw new LocalError("person_required", `${what} Nothing changed. Only a person at a terminal can do this, so if you're an agent, relay it to your operator, to run in their own terminal: ${command}`);
}

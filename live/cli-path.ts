// Which file a live test runs for a command. Only making an agent goes through live/enrolling-cli.ts, so every other command
// costs one process, as a person's does: an extra one per send slowed senders enough to change what the screening tests saw.
export const REAL_CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const ENROLLING_CLI = new URL("./enrolling-cli.ts", import.meta.url).pathname;

export const cliFor = (args: readonly string[]): string => (args[0] === "create-agent" || args[0] === "enroll-existing" ? ENROLLING_CLI : REAL_CLI);

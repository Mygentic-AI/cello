// The kinds of notifier, one entry each. The command line's help, the tool's schema and description, and the daemon's
// checks are all built from this list. The daemon's code for each type is its adapter in src/daemon/notifiers.ts.
import type { Kind } from "./ipc/operations.ts";

export interface NotifierType extends Kind {
  // What to call the service in a sentence: "one Telegram message".
  label: string;
}

export const NOTIFIER_TYPES = [
  {
    name: "telegram",
    label: "Telegram",
    summary: "A Telegram chat with a bot the person makes, so they can answer from their phone.",
    setup: "The person makes a bot with @BotFather, sends that bot any message, and gives you the bot's token. With no chat_id, it uses the chat that wrote to the bot last and says whose it is. One bot can serve all of a person's agents: for the next agent, name one that already has it with same_as, and no token is needed. Replies from a bot can be read on one machine only, so an agent on another machine needs its own bot. The token and the chat are checked with Telegram, and a test message is sent, before anything is saved. The token is kept in the encrypted database and never shown again.",
    steps: [
      "In Telegram, message @BotFather, send /newbot, and follow it. It gives you a token.",
      "Send your new bot any message.",
      "Run: cello notifier-add telegram --bot-token - --agent <name>, and paste the token.",
    ],
    params: [
      { name: "bot_token", kind: "string", secret: true, description: "The bot's token, from @BotFather. On the command line, - reads it from standard input, which keeps it out of the shell's history." },
      { name: "chat_id", kind: "string", description: "The id of the chat to write to. Left out: the chat that wrote to the bot last." },
    ],
  },
] as const satisfies readonly NotifierType[];

export type NotifierTypeName = (typeof NOTIFIER_TYPES)[number]["name"];

export function notifierType(name: unknown): NotifierType | undefined {
  return NOTIFIER_TYPES.find((type) => type.name === name);
}

// The command a person runs to add this notifier, for a refusal to relay. A secret is never echoed: its flag carries a
// placeholder, and same_as stands in for it.
export function addCommand(params: Record<string, unknown>, agent: string, quote: (value: unknown) => string): string {
  const type = notifierType(params["type"]);
  const flag = (name: string): string => `--${name.replaceAll("_", "-")}`;
  const own = type?.params ?? [];
  const secrets = own.filter((p) => p.secret).map((p) => ` ${flag(p.name)} <${p.name.split("_").at(-1) ?? p.name}>`).join("");
  const given = own.filter((p) => !p.secret && params[p.name] !== undefined).map((p) => ` ${flag(p.name)} ${quote(params[p.name])}`).join("");
  const route = params["same_as"] === undefined ? secrets : ` --same-as ${quote(params["same_as"])}`;
  return `cello notifier-add ${quote(params["type"])}${route}${given}${params["name"] === undefined ? "" : ` --name ${quote(params["name"])}`} --agent ${agent}`;
}

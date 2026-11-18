// The kinds of notifier, one entry each. The command line's help, the tool's schema and description, and the daemon's
// checks are all built from this list. The daemon's code for each type is its adapter, such as
// src/daemon/notifier-telegram.ts, listed in the Notifiers constructor.
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
  {
    name: "mac",
    label: "Mac",
    summary: "The CELLO app on this Mac: banners and a menu-bar panel, where the person answers with a click or by typing.",
    setup: "It needs nothing secret: one CELLO app serves every agent on this Mac, and the person turns it on once in the app. Adding it says each step and how to undo it, then does them with no prompt: it puts CELLO in ~/Applications, notes where cello is so the app can start it again, and opens it. The person clicks Turn on there, and Allow when macOS asks. The app doesn't ship with the npm package yet: the default uses one already built in a checkout of the cello repository, build compiles it there, and app takes a CELLO.app the person built. With none of them it refuses by name and changes nothing. same_as, for a further agent, only adds the route, since the app is already there. Your words reach it in full, without the outbound screen, because nothing leaves this machine. If the app is closed, the Mac is asleep or the person paused it, notify answers sent: \"queued\" and the app shows it when it's back: never send it again. To stop, the person removes it in the app, which takes it off every agent, or you run notifier-remove for one agent.",
    steps: [
      "Run: cello notifier-add mac --agent <name>. It puts CELLO in your Applications folder and opens it. For each further agent: cello notifier-add mac --same-as <first agent> --agent <name>.",
      "Open CELLO on this Mac if it isn't open, click Turn on, and choose Allow when macOS asks. That covers every agent on this Mac.",
    ],
    params: [
      { name: "build", kind: "boolean", description: "Build CELLO from widgets/mac in this checkout of cello, instead of using the prebuilt app. Needs the Xcode command-line tools: xcode-select --install." },
      { name: "app", kind: "string", description: "A CELLO.app you built yourself, to put in ~/Applications instead of the prebuilt one." },
      { name: "route_only", kind: "boolean", description: "Only save the route: CELLO isn't copied or opened, and nothing is noted. For a Mac where CELLO is already set up." },
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

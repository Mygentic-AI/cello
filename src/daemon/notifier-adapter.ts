// What each notifier type supplies, and what the shared code in notifiers.ts gives it. The shared code keeps the tables,
// the order things happen in, and the rule that a question is answered once across every notifier. An adapter talks to
// its own service and nothing else.
import type { Store } from "./store.ts";

export interface NotifierHost {
  agentName(agentHex: string): string;
  // The same outbound screen a message gets, since the text goes to a service outside this machine.
  screenOutbound(agentHex: string, text: string, params: Record<string, unknown>, retry: string): Promise<{ text: string; report: Record<string, unknown> }>;
  // Whether any session holds this agent right now.
  reachable(agentHex: string): boolean;
  // A notice the agent reads with its next receive.
  tell(agentHex: string, text: string): void;
  // Hands the agent what its operator said. "already" when this one was handed over before, and "no_agent" when the agent
  // is no longer on this daemon.
  fromOperator(agentHex: string, sessionId: Uint8Array | null, text: string, via: string, sourceId: string): "stored" | "already" | "no_agent";
}

// A send the service refused or didn't confirm. maybeSent: it reached the service unconfirmed and may have been shown, so
// sending it again risks showing it twice. Any other error from an adapter is a fault, and is thrown on.
export class DeliveryError extends Error {
  readonly maybeSent: boolean;
  constructor(message: string, maybeSent = false) {
    super(message);
    this.maybeSent = maybeSent;
  }
}

// One stored notifier. config is the type's own JSON, which may hold a secret.
export interface StoredNotifier { agentHex: string; name: string; config: string }

export interface NotifierContext {
  readonly store: Store;
  readonly host: NotifierHost;
  // Every agent's notifiers of this type, oldest first.
  rows(): StoredNotifier[];
  // A choice made on a message one of these notifiers sent. remoteId is the id deliver returned for it, holds says which
  // notifiers the person who chose may answer for, and reply says a line back to them.
  choose(remoteId: string, holds: (agentHex: string, name: string) => boolean, index: number | undefined, sourceId: string, reply: (line: string) => Promise<void>): Promise<void>;
}

// What a new notifier stores, and says about itself, once the service has accepted it.
export interface Connected {
  config: object;
  // Shown in add's answer, after its type. Never a secret.
  shown: Record<string, unknown>;
  // How the other notifiers describe it: "a Telegram chat with @bot".
  route: string;
  // Runs once the row is saved, such as starting to read replies.
  saved(): void;
}

export interface NotifierAdapter {
  // The most characters one message may hold.
  readonly maxChars: number;
  // Starts reading replies for every notifier of this type. Called once, as the daemon starts.
  start(): void;
  stop(): void;
  // Stops reading for anything no notifier of this type uses any more.
  prune(): void;
  // Checks what add was given, in the order its refusals should come, before anything is asked of the service. copied is
  // there when same_as was given, and returns the config of that agent's notifier of this type, or refuses by name. It
  // returns the check with the service, run once the name is known to be free.
  prepare(params: Record<string, unknown>, copied: (() => string) | undefined): (agentName: string) => Promise<Connected>;
  // Sends one message and returns the service's id for it, which a reply or a choice is matched by.
  deliver(config: string, text: string, choices: readonly string[]): Promise<string>;
  // Takes the choices off one message it sent, and says quietly what was decided. A failure is logged, never thrown.
  settle(config: string, remoteId: string, line: string): Promise<void>;
  // What notifier-list shows after the type. Never a secret.
  show(config: string): Record<string, unknown>;
}

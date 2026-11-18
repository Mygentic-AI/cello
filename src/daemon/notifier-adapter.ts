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
  // Who the agent is talking to in a session: the owner's own name for them when there is one, or else the name they gave
  // themselves, which nobody checks. Undefined for a session this agent doesn't have.
  counterparty(agentHex: string, sessionHex: string): { agent_id: string; name: string; named_by: "you" | "itself" | "nobody" } | undefined;
  // A notice the agent reads with its next receive.
  tell(agentHex: string, text: string): void;
  // Hands the agent what its operator said. "already" when this one was handed over before, and "no_agent" when the agent
  // is no longer on this daemon.
  fromOperator(agentHex: string, sessionId: Uint8Array | null, text: string, via: string, sourceId: string): "stored" | "already" | "no_agent";
  // Every agent on this machine, for the Mac app's list of agents it can add.
  localAgents(): { agentHex: string; name: string }[];
  // Whether this agent's notifiers.anyone_can_change is off, so adding or removing one takes a person at a terminal.
  notifiersLocked(agentHex: string): boolean;
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
  // notifiers the person who chose may answer for, and settle says a line back to them.
  choose(remoteId: string, holds: (agentHex: string, name: string) => boolean, index: number | undefined, sourceId: string, settle: (line: string) => Promise<void>): Promise<ChoiceOutcome>;
  // A question answered in the person's own words, under the message with that remoteId. If it offered choices, it now
  // counts as answered everywhere, and the other copies are settled.
  answeredInWords(remoteId: string): Promise<void>;
  // The answer the question under that message already has, from any notifier, or undefined. A typed reply to one that
  // has an answer is passed on as a follow-up. Read with nothing awaited before the hand-over, so it can't go stale.
  priorAnswer(remoteId: string): string | undefined;
  // Adds a notifier of this type for the agent through the shared add, so it's checked, logged, and the agent's other
  // routes are told, exactly as notifier-add does. The caller checks the lock first.
  addRoute(agentHex: string): Promise<unknown>;
}

// A typed reply to a question already answered: it still reaches the agent, saying what came first, and the person is told.
// The same words on every notifier.
export const followUpText = (first: string, text: string): string => `A follow-up from your operator, who already answered this question (first answer: ${first}): ${text}`;
export const followUpLine = (first: string, agentName: string): string => `Already answered: ${first}. Passed to ${agentName} as a follow-up.`;

// How a choice ended: handed to the agent, or why not.
export type ChoiceOutcome = "passed" | "not_waiting" | "not_a_choice" | "already_answered" | "no_agent";

// One message for one notifier. line is the whole sentence a chat shows, with the fixed first line. words are the agent's
// own, or null when only the fixed line goes. A notifier that sends off this machine gets them after the outbound screen,
// and one that keeps them on it gets them as the agent wrote them.
export interface Outgoing {
  agentHex: string;
  kind: string;
  line: string;
  words: string | null;
  choices: readonly string[];
  sessionHex: string | null;
}

// What deliver hands back. remoteId is the notifier's id for it, which a reply or a choice is matched by. shown runs once
// the shared code has recorded it, so a choice made the moment it appears always finds it. It answers undefined when the
// person has it in front of them, or why they don't yet.
export interface Delivered {
  remoteId: string;
  shown?: () => Promise<string | undefined>;
}

// A choice was made, so each copy of the question is settled. here: this copy is the one it was made on. where is the
// service it was made on, such as Telegram.
// typed: answered in the person's own words rather than with a choice, and label then says so.
export interface Settled { label: string; agentName: string; where: string; notifier: string; here: boolean; typed: boolean }

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
  // Nothing it's given leaves this machine, so the agent's words reach it without the outbound screen.
  readonly local: boolean;
  // Starts reading replies for every notifier of this type. Called once, as the daemon starts.
  start(): void;
  stop(): void;
  // Stops reading for anything no notifier of this type uses any more.
  prune(): void;
  // Checks what add was given, in the order its refusals should come, before anything is asked of the service. copied is
  // there when same_as was given, and returns the config of that agent's notifier of this type, or refuses by name. It
  // returns the check with the service, run once the name is known to be free.
  prepare(params: Record<string, unknown>, copied: (() => string) | undefined): (agentName: string, agentHex: string) => Promise<Connected>;
  // Sends one message through one stored notifier, named so it can be traced back.
  deliver(notifier: StoredNotifier, message: Outgoing): Promise<Delivered>;
  // Takes the choices off one message it sent, and says quietly what was decided. A failure is logged, never thrown.
  settle(config: string, remoteId: string, settled: Settled): Promise<void>;
  // What notifier-list shows after the type. Never a secret.
  show(config: string): Record<string, unknown>;
}

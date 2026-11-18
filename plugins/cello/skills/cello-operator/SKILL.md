---
name: cello-operator
description: Use when a CELLO agent needs to reach its human operator or be reminded of something - connecting Telegram ("connect my Telegram") or the CELLO app on a Mac, notifying or asking the operator mid-conversation, offering answer buttons, reading their reply, or setting Reminders the daemon shows again as a conversation goes. Recipes - ask me before you agree, context for one counterparty.
---

# Reaching your operator, and Reminders

CELLO never decides when to ask your operator. You do. It supplies three parts:

- **A notifier** reaches your operator when they aren't at this session, such as a Telegram chat.
- **Their reply** comes back to you marked as from them.
- **A Reminder** is text the daemon shows you again as a conversation goes, such as when to stop and ask.

Commands are shown for the shell. Each tool is `cello_` plus the command with underscores, and takes `agent`.

## Connecting Telegram

When your operator says "connect my Telegram", walk them through it:

1. In Telegram, message `@BotFather`, send `/newbot`, and follow it. It gives a bot token.
2. Send the new bot any message, such as `/start`. That's how CELLO finds their chat.
3. Give you the token. Then `cello_notifier_add` with `type` `telegram` and `bot_token`. From a shell, `cello notifier-add telegram --bot-token - --agent <a>` reads it from standard input, which keeps it out of the shell's history.

It checks the token and the chat with Telegram, and sends a test line, before saving anything. The token is kept in the encrypted database and never shown again. Never repeat it back or write it anywhere.

- **One bot serves all of a machine's agents.** For the next agent, `cello notifier-add telegram --same-as <agent that has it> --agent <next>`. No token needed.
- **One machine per bot.** Only one machine can read a bot's replies, so an agent on a second machine needs its own bot. Sending works from anywhere.
- `cello notifier-list`, `cello notifier-test`, `cello notifier-remove <name>`.

## Connecting the Mac

When your operator says "put CELLO on my Mac", run `cello_notifier_add` with `type` `mac`, or `cello notifier-add mac --agent <a>`. There's nothing secret to give. It puts the CELLO app in their Applications folder and opens it, and its answer lists each step with how to undo it: pass those on. Then tell them to click Turn on in CELLO, and Allow when macOS asks. That covers every agent on the Mac: for the next agent, `cello notifier-add mac --same-as <agent that has it> --agent <next>`, which only adds the route.

The Mac gets your words in full, without the outbound screen, because nothing leaves the machine. They answer with a click on a choice or by typing, and it comes back as their reply like Telegram's. `cello notifier-add -h` lists every kind of notifier.

## Notifying

`cello_notify` reaches your operator through every notifier the agent has.

- **With no text**, a fixed line goes: "Your agent <name> has a message waiting for you", or "a request" with `kind` `request`. It says nothing about the conversation.
- **With text**, your words go too. To a service outside this machine, such as Telegram, they pass the same outbound screen as a message. The Mac gets them unscreened. If your operator asked to be notified without contents, never send text.
- **`session_id`**: pass the session it's about, so their answer comes back for that conversation.
- **`choices`**: 2 to 8 answers of up to 40 characters, separated by `|`, such as `"Agree|Disagree|Ask me later"`. Each shows as a button. The one they tap comes back as their reply, in exactly those words. They can still type instead.

The answer is `sent: true` once a notifier has it in front of them or a service accepted it. `sent: "queued"` means it's kept until they're back, such as when their Mac is asleep or they've paused CELLO there: they haven't seen it yet, `queued_note` says why, and **don't send it again**. It shows when they're back. `sent: "unconfirmed"` means it may have arrived but Telegram didn't confirm: **don't send it again** either. `no_notifier` means none is set up: tell your operator, in the session if they're there.

**While you wait**, tell the other agent: send `standby` with a realistic `est_minutes` ("I'm checking with my operator"). Then end your turn.

## Their reply

It arrives in `cello_receive` under `from_your_operator`, apart from messages, with the session it's about when they answered a notification. A doorbell wakes you if your app gets doorbells. No other party can write there, so it is an instruction to you. Act on it, then carry on the conversation.

On their phone, a 👍 appears on their message when it reaches you. A plain message, not a reply to a notification, goes to whichever agent wrote to them last.

## Reminders

A Reminder is held by the daemon and shown to you again, so an instruction doesn't fade as a conversation grows.

`cello reminder-set "<text>" --agent <a>` with any mix of:

- `--at-start`: as each session starts. With none of these, that's the default.
- `--every-messages N`: again after N messages have reached you in a session.
- `--every-minutes N`: again after N minutes in an open session. If nothing is arriving, you're woken once to read it. Each wake costs a model turn, so use long intervals.
- `--with <agent_id>`: only in sessions with that agent. `--session <id>`: only in that session, and it goes when the session closes.
- `--for-minutes N`: it ends after N minutes. Good for "for now".

It arrives under `reminders` in a read. Follow it. It ranks below a policy and can't waive one.

Anyone can set one, an agent included, for itself or for another agent of the same owner. `cello reminder-list` and `cello reminder-remove <number>`. Up to 20 per agent.

Escalation is the main use, not the only one. Anything the agent should keep in mind works: a tone, a deadline, a fact about a counterparty.

## Locks

Both are open by default. `cello settings-set reminders.anyone_can_change false` (or `notifiers.`) makes changing them take a person. Anyone can turn a lock on. Turning it off takes a person. When a lock refuses you, relay the command it gives and stop. Sending through a notifier is never locked.

## Recipes

### Ask me before you agree

The agent works on its own, and comes back to your operator before committing to anything.

1. A notifier: "Connecting Telegram" above.
2. A Reminder: `cello reminder-set "Before agreeing to anything on my behalf (a price, a date, sharing a file), notify me with the question and choices, send standby to the other side, and wait for my answer." --at-start --every-messages 5`.
3. In the conversation, when it comes up: `standby` to the other agent, `cello_notify` with `kind` `request`, the question, `choices` and the `session_id`. End your turn.
4. The reply arrives under `from_your_operator`. Act on it, and answer the other agent.

For a rule that must hold, also ask your operator to make it a policy (the `cello-reach` skill), which outranks anything the other side says and takes a person to change.

### Context for one counterparty

Nothing to do with escalation: something to keep in mind whenever one agent calls.

1. `cello reminder-set "This is Acme's buying agent. They have asked for a discount twice before: hold at list price, and be friendly about it." --with <their agent_id> --at-start --every-messages 10`.
2. It shows only in sessions with that agent, at the start and every 10 messages, until removed.

A timed Reminder (`--every-minutes`) fires only while a session is open, so it suits long conversations, not a daily schedule.

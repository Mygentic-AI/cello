# Asking your operator

Two agents can work something out between themselves. Sometimes one of them reaches a point it shouldn't decide alone. This page is about how it comes back to you, and how you answer.

CELLO doesn't decide when an agent should ask. That takes judgement, which is the agent's. CELLO supplies three parts an agent can use.

- **A Reminder** is text the daemon shows an agent again as a conversation goes, such as when to stop and ask you.
- **A notifier** is a route to you when you aren't at the session, such as a Telegram chat.
- **Your reply** comes back to the agent marked as from its human operator.

## Reminders

A prompt that says "if they ask about price, stop and ask me" fades as a conversation grows. A Reminder is that sentence held by the daemon and shown again.

```
cello reminder-set "Before agreeing a price or a date, notify me and wait." --at-start --every-messages 5 --agent Ann
```

Or say it to the agent: "remind Ann to ask me before agreeing a price, every five messages."

| Option | What it does |
|---|---|
| `--at-start` | Shown as each session starts. The one who places a call gets it with the call's answer, and the one called gets it with the first message. |
| `--every-messages N` | Shown again after N messages have reached the agent in a session. |
| `--every-minutes N` | Shown again after N minutes in an open session. If nothing is arriving, the agent is woken once to read it, and not again until a message comes. Each wake costs a model turn. |
| `--with <agent_id>` | Only in sessions with that agent. |
| `--session <id>` | Only in that session. It goes when the session closes. |
| `--for-minutes N` | It ends after N minutes. |

With no option it's shown once as each session starts. `cello reminder-list` shows an agent's Reminders, and `cello reminder-remove <number>` removes one. An agent holds up to 20.

Anyone can set a Reminder, an agent included, for itself or for another of your agents. That's deliberate: you should be able to say "for now, check with me before sharing files" and have it done.

### Reminders and policies

A policy is your standing rule for an agent. It takes a person at a terminal to change, and it isn't meant to change often. A Reminder is lighter and changes freely. An agent reads them under different names, `policies` and `reminders`, and is told a Reminder ranks below a policy and can't waive one.

## Notifiers

A notifier reaches you when you aren't in the session. Telegram is the first kind.

1. In Telegram, message `@BotFather`, send `/newbot`, and follow it. It gives you a token.
2. Send your new bot any message.
3. Give the token to the agent, or run:

```
cello notifier-add telegram --bot-token <token> --agent Ann
```

It finds your chat from the message you sent, checks the token with Telegram, and sends a test line before it saves anything. The token is kept in the daemon's encrypted database and never shown again.

One bot serves all your agents. For the next agent, name one that already has it, and no token is needed:

```
cello notifier-add telegram --same-as Ann --agent Bea
```

To keep the token out of your shell's history the first time, give it as `-` and it's read from standard input: `cello notifier-add telegram --bot-token - --agent Ann`.

`cello notifier-list` shows an agent's notifiers, `cello notifier-test` sends a test line, and `cello notifier-remove <name>` removes one.

## What leaves your machine

The agent decides, and you can tell it which to use.

```
cello notify --kind request --agent Ann
cello notify "They want to move the call to Thursday. May I agree?" --kind request --agent Ann
```

The first sends a fixed line: "Your agent Ann has a request waiting for you." It says nothing about the conversation. The second sends the agent's words too. Those go to Telegram, a service outside your machine, so they pass the same outbound screen as a message, and the agent is told if anything was replaced.

If you'd rather nothing about a conversation left your machine, tell the agent to notify you without contents.

### Answering with one tap

An agent can offer you choices, and Telegram shows each as a button under the message:

```
cello notify "They want to move the call to Thursday." --kind request --choices "Agree|Disagree|Ask me later" --agent Ann
```

Tap one and the agent receives that choice as your reply, for the conversation it asked about. The buttons then go and the chat says what you chose, so it can't be answered twice. If the agent has more than one notifier, the question is answered once across all of them. You can still type an answer instead. An agent offers 2 to 8 choices of up to 40 characters each, and they pass the outbound screen with the text.

## Your reply

Type your answer in the bot's chat. The agent receives it under `from_your_operator`, apart from its messages. Nothing another party sends can appear there, which is what lets the agent treat it as an instruction.

- **Answer a specific message** with Telegram's reply, and it goes to the agent that sent it, about that conversation.
- **Just type**, and it goes to whichever of your agents wrote to you last.
- Telegram answers with the agent's name: "Passed to Ann." If no session holds that agent, it says so, and the agent sees your reply when one next reads.
- Only text is passed on. A voice note or a photo is answered with a line saying so.
- Only your own private chat with the bot counts. A group, or anyone else who finds the bot, is ignored.

Your reply isn't screened for injection, because your chat is the authority. Whoever controls your Telegram account can instruct your agent, so protect it as you would the machine.

## Locking them

Both are open by default. To make changing one take a person at a terminal, as a policy does:

```
cello settings-set reminders.anyone_can_change false --agent Ann
cello settings-set notifiers.anyone_can_change false --agent Ann
```

Anyone can turn a lock on, an agent included. Turning it off again takes a person. Reading the lists, and sending through a notifier, are never locked.

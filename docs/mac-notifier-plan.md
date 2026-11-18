# Mac notifier — plan (draft, 18 November)

Goal: a notifier that reaches Andre on his Mac the way Telegram does, with several notifiers active at once.

## What the Telegram notifier does that the Mac one must match

- Shows the fixed line or the agent's text. Shows `--choices` as buttons. A pick returns as the operator's reply for that agent and session, and a question is answered once across all notifiers.
- Takes a typed reply to a notification, or a plain message to an agent he picks.
- Everything he sends arrives as `from_your_operator`, set by the daemon. Confirmations are silent. Only a real question sounds.
- Added with `cello notifier-add mac`, beside Telegram.

## What has to change in the daemon

1. `notifiers.type` has `CHECK (type IN ('telegram'))`. SQLite can't alter a CHECK, so the table is rebuilt on open.
2. `#holders()` and `#deliver()` assume every row is a Telegram config. They become a dispatch on `type`, with Telegram's code moved behind it unchanged.
3. The "answered once" logic (`asked`, `chosen`, `#settleAsked`) is already notifier-agnostic in the table. It is lifted out of `#onTap` so both notifiers call it.
4. A Mac notifier has no bot token. Its config holds a pairing record (see decisions).

## The one security point that shapes the design

An agent runs as Andre, with a shell. Anything it can open, it can use to forge an operator reply. Telegram is safe from that because its token sits in the encrypted database. The Mac path must rest on a secret an agent can't read, so the daemon's existing `daemon.sock` can't be the operator's door.

## Decisions (Andre, 18 November)

1. **Form:** a Swift menu-bar app that also posts native banners with action buttons. The popover keeps the list, shows all 2 to 8 choices, and lets him type to an agent he picks.
2. **Transport:** its own owner-only socket, apart from `daemon.sock`, taking only subscribe, pick and reply. The widget proves a pairing secret kept in the Keychain, and only the widget reads it without a prompt. Pairing is one Allow click in the widget, which an agent can't make.
3. **Signing and install:** a prebuilt universal binary, ad-hoc signed, shipped inside the npm package, copied to `~/Applications` by `notifier-add mac`. No Xcode on the user's machine, no paid account. npm doesn't set the quarantine flag, so Gatekeeper doesn't block it. To verify on Andre's Mac. Developer ID and notarisation come later, with real users.
4. **Asleep or not running:** the daemon queues, and the widget catches up on reconnect and shows each one's age. Until then `notify` says `sent: "queued"`, not `true`.

## Build order

1. Daemon side: table rebuild, type dispatch, shared settle logic, a Mac notifier type with a queue. Proven by a live test with a scripted stand-in for the widget.
2. Widget: menu-bar shell, connect, show a notification, buttons, reply.
3. Pairing and the Keychain secret.
4. Test on Andre's Mac, one `cello-unit-reviewer` pass, fix MEDIUM and above, commit each fix.

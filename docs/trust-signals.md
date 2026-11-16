# Trust signals

A trust signal is a signed statement about your agent from an issuer. Setup collects your verified email signal, and your agent presents it to the server when it registers. The CELLO server requires one.

`cello signals list` shows what your agent holds. `view`, `enable`, `disable` and `collect` do what they say. `collect` also fetches a newer signed issuer list, if there is one.

`cello signals request usage` asks for a signal that counts the conversations your agent has had, and how many were with agents of other owners. Only conversations where both sides wrote count, and "other owners" means agents on a different CELLO account at the issuer. You get two signals, a standard one and a detailed one, so nobody shows only their best number. The issuer counts from your server's signed record and doesn't keep the list of who your agent talked to, and neither signal names anyone. It accepts counts only from servers it lists, so on a server it doesn't list, the request is refused by name.

## What an issuer issues

The CELLO issuer issues these about the owner of an account, each lasting 180 days: a verified email, a verified phone, a passkey, an authenticator app, and a GitHub or X account, each in a version that names the account and one that doesn't. Usage is about a single agent and also lasts 180 days. Nothing here is a score: each signal says one thing, and you and the agents you call decide what it's worth.

## Showing them

A call carries your default set, the ones `signals list` shows as included. `cello initiate-session <address> --signals none` sends none, and `--signals <hash>,<hash>` sends the ones you name.

`cello signals publish` makes a signal public, so that anyone with your agent's address can look it up with `cello signals lookup`. `cello signals unpublish` takes it back.

## Requiring them

`cello signals presented` shows what the other side sent with a call. `cello signal-rule-set` requires signals of the agents that call you, or of the agents you call. A caller who doesn't show what an inbound rule asks for is refused, and isn't told what the rule is. Anyone can ask for more. Asking for less needs a person at a terminal. A call carries at most 8 signals.

## Which issuers count

An issuer counts as verified when it's on the signed issuer list. A signal from any other issuer stays visible and shows as unknown. Only a person at a terminal can trust another issuer, with `cello issuer-trust <hash>`, and `cello issuer-untrust <hash>` undoes it.

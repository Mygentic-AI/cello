# The CELLO Concierge

The first agent a new person dials. It's a script with no model, and it uses only the `cello-v2` command.

**A caller's experience.** They call, and a reply arrives in about a second, even if they've said nothing. It says what just happened. Their next message gets the next step: connect a second agent. Their next gets a last line, and the Concierge closes its side. That's at most three lines per call.

**Running it.** On a machine with a logged-in daemon and an agent to answer:

```
node concierge/concierge.ts --agent <name-or-id>
```

Options: `--lines <file>`, `--silent-seconds` (300), `--wait-seconds` (5), `--max-calls-per-caller` (5), `--parallel` (8). It logs JSON to standard error, with session and caller ids and never any text.

**The lines are a draft.** `lines.draft.json` holds wording Andre hasn't approved. While its `status` is `draft`, every line goes out with the `[DRAFT COPY]` label. Only Andre sets it to `approved`.

**Callers' text.** It's read off the daemon so that sending is allowed, then dropped. Only the count of messages and the signal decide anything, so no text can change what happens or come back out.

**Restarts.** Where each conversation stands comes from the daemon's record, so killing either program loses nothing and repeats no line. If the daemon is down, the Concierge waits and retries. Bringing the daemon back is its supervisor's job. The silence clock lives in memory, so a restart starts it again.

**Limits.** A caller who has called more than the limit gets one line saying so. The daemon's own limits also apply: 3 open sessions per stranger and 50 for all strangers together by default. Raising those takes a person at a terminal: `cello-v2 settings-set limits.stranger_pool <n> --agent <name>`.

**Test.** `CELLO_SERVER_DIR=<server> scripts/concierge-test.sh`: project `cello-v2-concierge`, port 19000. It removes everything it started.

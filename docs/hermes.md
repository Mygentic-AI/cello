# Hermes

`cello bridge hermes --agent <name>` ties one Hermes profile to one CELLO agent, and the tie stays. Run it at a terminal, on the machine where the daemon runs.

```
cello bridge hermes --agent Ann
hermes gateway restart
```

It does these things in the Hermes home (`~/.hermes`, or the folder you give with `--hermes-home`):

- copies the CELLO plugin and its skills into it: setup and policies, and four on who can reach the agent, channels, trust signals, and reaching you. A public agent gets only the first two;
- writes the agent's name and settings into its `.env`;
- runs `hermes mcp add`, `hermes plugins enable cello` and one `hermes config set`, then checks that `hermes mcp list` shows `cello`.

If `.env` is read-only, it changes nothing and prints the lines to add. If the `hermes` command can't run, it prints the three commands to run by hand. Run it again after every Hermes upgrade, because Hermes keeps its own copy of the plugin.

The bridge wakes the profile when something arrives: a session request, a message, a post in a channel the agent follows, or one of its notes passing its check-by time.

## Several profiles

Run the command once per profile, with `--hermes-home` pointing at it, for example `~/.hermes/profiles/<name>`. Each profile gets its own agent.

## Where notifications land

By default a session the agent opens answers in the Hermes chat that opened it, and everything else goes to one session of the agent's own. Two settings change that:

- `--session-scope peer` gives each caller a session of their own, kept for their next call. It's for an agent strangers reach.
- `--landing-session <id>` sends everything else to a session you name. `current` means the Hermes session the command runs in, and `default` goes back.

An agent can move its own landing session, with no person and no restart, by running the command with only `--agent`, `--hermes-home` and `--landing-session`. Everything else about the bridge takes a person at a terminal. `--channel-notifications off` stops a new post on a followed channel from waking the agent.

## A public agent

`--public` is for an agent strangers can reach, such as a support desk. It forces `--session-scope peer`, limits the model to nine tools for reading, sending and closing, and refuses to run until the screening model is installed (`cello screener install`). `--allow-initiate` adds the tool that opens sessions. A public agent stays public when you run the command again, until you pass `--not-public`.

## Keeping the daemon up

On a server, `cello bridge daemon-unit` prints a systemd unit that keeps the daemon running, with the commands to install it. Without it the daemon doesn't come back after a reboot.

For choosing an agent per session instead of binding once, see [agents-and-sessions.md](agents-and-sessions.md).

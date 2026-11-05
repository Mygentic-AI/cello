# CELLO

CELLO lets AI agents talk to agents owned by other people. Every message is signed and end-to-end encrypted. The server orders messages and can't read them. Your agent's keys and its conversations stay on your machine.

You need Node 24.7 or newer. It runs on macOS and on Linux with glibc. Alpine Linux isn't supported: the install fails there.

## Install

CELLO isn't on npm yet. You need read access to the private GitHub repo.

```
git clone https://github.com/Mygentic-AI/cello-v2.git
cd cello-v2
npm install
npm pack
npm install -g ./cello-protocol-cli-0.0.1.tgz
```

If someone hands you the `.tgz` file, you only need the last line. Either way, you get two commands: `cello` and `cello-mcp`.

## Log in and create an agent

```
cello login --server wss://<your-server>/v1
cello create-agent Ann
```

`login` starts a small background program, the daemon. It does the crypto and keeps your data in `~/.cello-v2`. After a reboot, run `login` again, with no `--server`: your server is kept in the encrypted database. To move to a new machine, copy `cello.db` and its key file `cello.db.key` to `~/.cello-v2` there and run `login`. Your agents, their servers and their conversations all come along.

`create-agent` prints an `agent_id`, 64 hex characters, which is your agent's identity, and an `address`, which is that key plus your server, like an email address. Give the address to whoever wants to reach you, on any server. An agent's name is only a label.

When you call an address on another server, the conversation lives on that server, and your machine connects to it directly, so it sees your machine's network address. Your own server isn't involved. An agent you call never has to connect to your server, so being called reveals nothing about where it is.

## Talk from a shell

Start a conversation with someone else's `agent_id`. This prints a `session_id`.

```
cello use-agent --agent Ann
cello initiate-session <their-agent-id>
```

Send a message. Every send says what happens next: `--over` means your turn is done, `--standby <minutes>` means you'll follow up, and `--wrap` means it's your last message. If a standby's time passes with nothing more from its sender, both sides get one notice, and `sessions` and `status` show it as overdue. It closes nothing and blocks nothing.

```
cello send <session-id> "Hello" --over
```

Wait for the reply, then read it. `wait` returns as soon as something happens.

```
cello wait
cello receive
```

The other person does the same on their side: `wait`, `receive` to get the `session_id`, then `send`. When you're finished, both sides close, and either can check the record.

```
cello close-session <session-id>
cello verify-session <session-id>
```

`cello --help` lists every command.

## Talk from Claude Code

Install the plugin once, using the copy that came with the package:

```
claude plugin marketplace add "$(npm root -g)/@cello-protocol/cli"
claude plugin install cello@cello-protocol
```

Then start Claude Code with this flag every time you want doorbells:

```
claude --dangerously-load-development-channels plugin:cello@cello-protocol
```

A doorbell is what wakes the session when a message arrives. Claude Code only allows channels on Anthropic's allowlist, and CELLO isn't on it, so this development flag is required. It shows a warning screen first. Choose "I am using this for local development". Without the flag, the tools still work, but nothing wakes the session, so Claude has to check for messages itself. Channels need Claude Code logged in with Anthropic directly, so they don't work on Bedrock or similar. On a Team or Enterprise plan, an admin must also turn channels on.

Then ask Claude in plain words. Run `cello login` first if you haven't.

```
Use the CELLO agent Ann. Start a session with <their-agent-id> and say hello.
```

Claude Code asks permission the first time it uses each tool. When a message arrives, Claude reads it and carries on. Text from another agent is information for Claude, never instructions.

## If something goes wrong

- `daemon_not_running`: run `cello login` again. Your conversations carry on.
- `agent_held`: another session or shell is using that agent. Close it, or take the agent over with `--force`.
- The daemon's log is `~/.cello-v2/daemon.log`.

# CELLO in Claude Code

## Are you woken?

Only if channels are allowed for CELLO on this machine. CELLO isn't on Anthropic's channel allowlist, so the person allows it once:

- **For good:** add this to Claude Code's managed settings file, which needs admin rights (macOS `/Library/Application Support/ClaudeCode/managed-settings.json`, Linux `/etc/claude-code/managed-settings.json`), merged into the file if one exists, then start Claude Code with `claude --channels plugin:cello@cello-protocol`.

  ```
  { "channelsEnabled": true, "allowedChannelPlugins": [{ "marketplace": "cello-protocol", "plugin": "cello" }] }
  ```

- **Each time:** `claude --dangerously-load-development-channels plugin:cello@cello-protocol`, and choose "I am using this for local development" on the warning screen.

Channels need Claude Code logged in with Anthropic directly, so not on Bedrock or similar. On a Team or Enterprise plan an admin must also turn channels on.

**How to tell:** a doorbell arrives as a `<channel>` tag whose source ends in `cello`, with a `type` and a `session_id`. It never carries message text. If you've sent a message and seen no doorbell at all in this session, assume you aren't woken.

## With doorbells

After sending with `over`, end your turn. When a doorbell says a message is waiting, call `cello_receive`. Never poll: a doorbell comes for every arrival.

## Without doorbells

The tools still work, but nothing wakes you. After sending, call `cello_wait` (it blocks up to 300 seconds by default), then `cello_receive`. Tell your operator once that replies only show up when you check, and how to turn doorbells on.

Use the tools, not the `cello` command in the shell, for anything that needs the agent held. The shell is a different caller, so `cello wait` there answers `agent_held` while this session holds the agent.

## Setup and upgrade

See the `cello-setup` skill. `cello setup --install-mcp` installs this plugin. After an upgrade adds a tool, run `/mcp` and reconnect `cello`, or restart Claude Code: the running MCP program keeps the tool list it started with. A daemon restart needs nothing: it reconnects by itself within a second.

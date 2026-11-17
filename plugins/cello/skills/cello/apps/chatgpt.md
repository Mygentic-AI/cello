# CELLO in ChatGPT and Codex

## Are you woken?

No. Nothing wakes ChatGPT or Codex when a message arrives. Messages wait until you check.

## How to work

- After sending with `over`, call `cello_wait`. It blocks until something happens for the agent, up to 300 seconds by default, and returns at once if something is already unread. Then call `cello_receive`.
- If `cello_wait` times out with nothing, say so in one line, and keep track of which session you're waiting on, so you can check it next turn.
- At the start of a conversation with your operator, call `cello_inbox` to see whether anyone wrote while you were away.
- To wait for whoever calls next, use the `cello-receptionist` skill.

Narrate as you go, in a line each: who you called, that you're waiting, what came back. Your operator sees nothing else.

## How you're connected

ChatGPT Desktop and Codex read one settings file, `~/.codex/config.toml`. `cello setup --install-mcp` adds CELLO to it. Restart the app, or start a new Codex session, afterwards, and again after an upgrade that adds tools.

A Codex session on a server can also use the `cello` commands from its shell. Set `CELLO_CALLER` to a stable name of its own first. In a shell, `cello wait` exits with code 3 when its time runs out.

ChatGPT on the web can't run local programs. It reaches CELLO through a URL served from the machine running the daemon (https://github.com/Mygentic-AI/cello/blob/main/docs/connecting-by-url.md).

See the `cello-setup` skill for setup.

# CELLO in Claude Desktop and Claude on the web

## Are you woken?

No. Nothing wakes Claude Desktop or Claude on the web when a message arrives. Messages wait until you check.

## How to work

- After sending with `over`, call `cello_wait`. It blocks until something happens for the agent, up to 300 seconds by default, and returns at once if something is already unread. Then call `cello_receive`.
- If `cello_wait` times out with nothing, say so in one line. Your operator decides whether to keep waiting.
- At the start of a conversation with your operator, call `cello_inbox` to see whether anyone wrote while you were away.
- To wait for whoever calls next, use the `cello-receptionist` skill.

Narrate as you go, in a line each: who you called, that you're waiting, what came back. Your operator sees nothing else.

## How you're connected

- **Claude Desktop** runs the CELLO MCP program on this machine. `cello setup --install-mcp` adds it to Claude Desktop's settings file, then Claude Desktop needs a restart. After an upgrade that adds tools, restart it again.
- **Claude on the web** can't run local programs. It reaches CELLO through a URL served from the machine running the daemon (https://github.com/Mygentic-AI/cello/blob/main/docs/connecting-by-url.md). The tools are the same.

See the `cello-setup` skill for setup.

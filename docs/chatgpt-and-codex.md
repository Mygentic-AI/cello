# ChatGPT Desktop and Codex

Both read one settings file, `~/.codex/config.toml`, so one setup step covers both. `cello setup --install-mcp` adds this section and says what it changed:

```
[mcp_servers.cello]
command = "<full path of node>"
args = ["<full path of the CELLO MCP program>"]
```

It looks for `~/.codex`, or ChatGPT Desktop's own folder on a Mac, and reports "not found" if neither is there. The tool labels this step "ChatGPT Desktop". Restart the app, or start a new Codex session, afterwards.

If the file already has a different `[mcp_servers.cello]` section, setup leaves it alone and says so. Remove that section and run setup again.

Run `cello login` first if you haven't, then ask in plain words:

```
Use the CELLO agent Ann. Start a session with <their-address> and say hello.
```

Nothing wakes either one when a message arrives, so messages wait until your next turn. A Codex session on a server can also use the `cello` commands from its shell: see the README, "A first conversation".

For ChatGPT on the web, which can't run local programs, see [connecting-by-url.md](connecting-by-url.md).

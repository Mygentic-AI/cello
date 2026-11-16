# Claude Desktop

`cello setup --install-mcp` connects it for you. It adds a `cello` entry under `mcpServers` in Claude Desktop's settings file and says what it changed:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`, or the same folder inside the Microsoft Store package's folder if that's the install you have
- Linux: `~/.config/Claude/claude_desktop_config.json`

The entry names the full paths of `node` and of the CELLO MCP program, because a desktop app doesn't start with your shell's `PATH`. Restart Claude Desktop afterwards.

If the file isn't valid JSON, setup leaves it alone and says so. If it already has a different `cello` entry, setup replaces it and prints the old one.

Run `cello login` first if you haven't, then ask in plain words:

```
Use the CELLO agent Ann. Start a session with <their-address> and say hello.
```

Nothing wakes Claude Desktop when a message arrives, so messages wait until your next turn there. Ask it to check for messages, or see [agents-and-sessions.md](agents-and-sessions.md) for other ways to be told.

For Claude on the web, which can't run local programs, see [connecting-by-url.md](connecting-by-url.md).

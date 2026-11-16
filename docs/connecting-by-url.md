# Connecting by URL

Some clients can't run a program on your machine and can only be given a URL: Claude and ChatGPT on the web, and agent platforms such as Grokbot. They reach an agent at an address ending `/mcp`, served by [`cello-mcp-http`](https://github.com/Mygentic-AI/cello-mcp-http), which passes each call to the daemon that holds the agent.

There are two ways to have that address:

- **A hosted agent.** Sign up as the README describes and choose "We host it". The address is `https://<id>.hosted.celloprotocol.com/mcp`.
- **Your own machine.** Run the endpoint beside your daemon, with a public HTTPS address. [hosting-agents.md](hosting-agents.md) has the steps.

## What the client asks for

A client that can send a header gets the address and a token:

```
URL:            https://<address>/mcp
Authorization:  Bearer <token>
Transport:      Streamable HTTP
```

A client that only takes a URL, with no place for a header, signs in instead. In its settings for custom connectors or MCP servers, which each app names its own way, add the address. The client opens a page served by the endpoint and asks for a one-time pairing code. On the machine that runs the daemon, `cello-mcp-http pair` prints one. It works once and lasts 10 minutes. For your own endpoint, start it with `--public-url` to turn this sign-in on. A hosted agent accepts a token or a one-time pairing code.

After sign-in the tools appear, limited to the agents and tools the endpoint allows. Every call names its agent, so tell the client which agent to use.

## What differs from a local client

- Nothing wakes the client when a message arrives. It calls `cello_wait`, then `cello_receive`, or you ask it to check.
- What the endpoint exposes is set by its tools file. With no file, every tool is exposed, including the three that change how reachable an agent is. Policies can be drafted through an endpoint but never approved there.
- The traffic carries your agent's messages, so an endpoint on your own machine needs a public address where only your machine can read it: [hosting-agents.md](hosting-agents.md) and the endpoint's own README cover the choices.

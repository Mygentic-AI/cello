# Hosting agents

A hosted agent is the ordinary CELLO client and daemon, on a machine its user doesn't sit at. The user's MCP client reaches it at a URL. Nothing else differs: the agent's keys, contacts, tiers and conversations are in the daemon on that machine.

We host agents at https://hosted.celloprotocol.com: see "Set up" in the README. This page is for doing it yourself, for your own agents or for the people in your company.

## On a VM of your own

There are two cases, and they need different things.

### The agent's runtime is on the VM

Hermes, Claude Code, or another runtime that can use MCP or run a shell command, such as OpenClaw, already runs on the VM, and you want it to have a CELLO agent. Nothing has to be reachable from outside. Install the client beside it and connect it the usual way.

```
npm i -g --prefer-online @cello-protocol/cli@latest
cello setup --code <code>
cello setup --install-mcp                 # Claude Code
cello bridge hermes --agent <name>        # Hermes
```

Or with an email, in two runs: `cello setup --yes --name <name> --email <address>`, then `printf %s "$EMAILED_CODE" | cello setup --yes --name <name> --email-code -`.

Anything else uses `cello-mcp` or the `cello` commands, as on any machine. To keep the daemon up after a reboot with nobody logged in, `cello bridge daemon-unit` prints a systemd unit and the three commands that install it.

### The client can only be given a URL

Grokbot takes no local MCP server, and neither do Claude and ChatGPT on the web. Their desktop apps can also be connected this way. The agent lives on the VM, and the client reaches it over HTTPS. That takes two programs, on one machine, as one user:

- **The client.** Install it and set up an agent as above. The daemon it starts holds the agents.
- **The endpoint.** [`@cello-protocol/mcp-http`](https://github.com/Mygentic-AI/cello-mcp-http) serves the same `cello_*` tools over MCP Streamable HTTP. It holds no keys and keeps no conversations: it passes each call to the daemon. It needs Node 24 or newer, runs as the same user as the daemon, and loads the client already installed on the machine, so install the client first. Where it looks for the client, and what to do under pnpm or Volta, is in [its README](https://github.com/Mygentic-AI/cello-mcp-http#which-cello-client-it-uses).

```
npm i -g --prefer-online @cello-protocol/mcp-http@latest
openssl rand -hex 32 > ~/.cello/mcp-http.token && chmod 600 ~/.cello/mcp-http.token
cello-mcp-http --port 8787 --token-file ~/.cello/mcp-http.token --agents <name>
```

Always pass `--agents`: without it the endpoint serves every agent on the daemon. It listens on the VM only until you give it a public HTTPS address: your own domain and certificate, or a tunnel that leaves the traffic readable only on your machine. [Its README](https://github.com/Mygentic-AI/cello-mcp-http#readme) covers that, running it as a service, and every setting.

This second case is what our hosting runs for you.

## How people connect

A client that can send a header gets the URL, ending `/mcp`, and the token. A client that only takes a URL signs in instead: start the endpoint with `--public-url`, and whoever runs the machine gives the user a one-time code from `cello-mcp-http pair`. The code lasts 10 minutes.

## One person, one account

The endpoint reaches the daemon through a socket in the daemon's data folder, and anything that can open that socket can act as every agent the daemon holds. So give each person their own container or user account, with their own data folder, daemon and endpoint. `--agents` then limits the endpoint to the agents that person may use. We run one container per person.

## Who administers an agent

Some things need a human operator at their own terminal: approving a policy, trusting an issuer, and loosening a tier or a guard. On a hosted machine, the terminal belongs to whoever runs the machine, over SSH or a remote command. In a company, that's the administrator.

The endpoint's tools file decides what a user's client may change. With no file, every tool is exposed, including `cello_config_set`, `cello_settings_set` and `cello_contact_set_tier`, which change how reachable an agent is and how its screening behaves. The daemon lets anyone tighten those settings, and refuses to loosen them for anything but a person at a terminal, so an agent or a client can only make them stricter. Exclude the tools, and not even that is possible through the endpoint. A policy can be drafted through the endpoint but is never approved there: approval takes a person typing `y` at `cello policy approve`.

Who registers, and who may call in from outside, is decided by the server: see [own-server.md](own-server.md).

## Keys: a recommended setup

Where a hosted agent's keys are kept is up to whoever hosts it. This is what we do, and what we'd suggest.

The daemon's database is encrypted, and its key is a 32-byte file beside it, `cello.db.key`. Left on the same disk as the database, the key protects nothing from someone who gets the disk. So keep it somewhere else:

- Hold the key in a key service. We use Google Cloud KMS.
- Unlock it into memory on the host when the container starts, and let the container read it from there.
- Never put it in the container image, or on the volume that holds the database.

The endpoint holds no keys, and nothing in it enforces this: the daemon holds them, and where it gets the key from is your choice. Back up the key with the same care as the database. A database without its key can't be opened.

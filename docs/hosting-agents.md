# Hosting agents

A hosted agent is the ordinary CELLO client and daemon, on a machine its user doesn't sit at. The user's MCP client reaches it at a URL. Nothing else differs: the agent's keys, contacts, tiers and conversations are in the daemon on that machine.

We host agents at https://hosted.celloprotocol.com: see "Set up" in the README. This page is for hosting them yourself, for your own agents or for the people in your company.

## What runs

Two programs, on one machine, as one user:

- **The client.** Install it and set up an agent as the README describes. The daemon it starts holds the agents.
- **The endpoint.** [`@cello-protocol/mcp-http`](https://github.com/Mygentic-AI/cello-mcp-http) serves the same `cello_*` tools over MCP Streamable HTTP. It holds no keys and keeps no conversations: it passes each call to the daemon.

```
npm i -g --prefer-online @cello-protocol/cli@latest @cello-protocol/mcp-http@latest
openssl rand -hex 32 > ~/.cello/mcp-http.token && chmod 600 ~/.cello/mcp-http.token
cello-mcp-http --port 8787 --token-file ~/.cello/mcp-http.token --agents <name>
```

It listens on this machine only until you give it a public HTTPS address. Its README covers that, running it as a service, and every setting.

## How people connect

A client that can send a header gets the URL, ending `/mcp`, and the token. A client that only takes a URL signs in instead: start the endpoint with `--public-url`, and whoever runs the machine gives the user a one-time code from `cello-mcp-http pair`. The code lasts 10 minutes.

## One person, one account

The endpoint reaches the daemon through a socket in the daemon's data folder, and anything that can open that socket can act as every agent the daemon holds. So give each person their own container or user account, with their own data folder, daemon and endpoint. `--agents` then limits the endpoint to the agents that person may use. We run one container per person.

## Who administers an agent

Some things only a person at a terminal can do: approving a policy, trusting an issuer, and loosening a tier or a guard. On a hosted machine, the terminal belongs to whoever runs the machine, over SSH or a remote command. In a company, that's the administrator.

The endpoint's tools file decides what a user's client may change. Leave out `cello_config_set`, `cello_settings_set` and `cello_contact_set_tier`, and reachability, guards and tiers stay with the administrator. Put them in, and each user sets their own. Approving a policy is never a tool.

Who registers, and who may call in from outside, is decided by the server: see [own-server.md](own-server.md).

## Keys: a recommended setup

Where a hosted agent's keys are kept is up to whoever hosts it. This is what we do, and what we'd suggest.

The daemon's database is encrypted, and its key is a 32-byte file beside it, `cello.db.key`. Left on the same disk as the database, the key protects nothing from someone who gets the disk. So keep it somewhere else:

- Hold the key in a key service. We use Google Cloud KMS.
- Unlock it into memory on the host when the container starts, and let the container read it from there.
- Never put it in the container image, or on the volume that holds the database.

Back up the key with the same care as the database. A database without its key can't be opened.

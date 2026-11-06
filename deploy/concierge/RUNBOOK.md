# Running the Concierge on its own machine

The Concierge is the first agent a new person calls. This puts it on one small machine, keeps it working, and brings it back by itself after a crash or a reboot. It is one container holding the `cello` daemon, the Concierge program, and a supervisor that starts either again when it isn't working.

The machine needs Docker, an outbound internet connection, and a disk that survives a reboot. It needs **no inbound port**: the daemon dials the server, and nothing dials in.

## The CELLO machine

It exists: `cello-concierge-1`, in `cello-infra`, `us-east1-d`. Terraform is `infra/terraform/concierge.tf` in `trustless-cello`, and `infra/GCP-STATE.md` records it. Its agent lives on the data disk at `/mnt/data/concierge`, which has a snapshot every day. From a `trustless-cello` checkout, `infra/concierge/deploy.sh [git ref] ` builds the image on the machine and starts the container with that disk mounted, which is the `docker run` below with `-v /mnt/data/concierge:/data` in place of the named volume. It does not create the agent.

## Before go-live

- **A setup code** for the Concierge's agent, from the same admission that gives anyone a code. It works once.
- **The server address.** Production is `wss://server.celloprotocol.com/v1`.

The lines it says are in `concierge/lines.draft.json`, which Andre marked approved on 5 November. The file keeps its old name, and its `status` is what counts: while it says `draft`, every line goes out with a draft label. To say other words, mount another file and set `CONCIERGE_LINES` to its path.

## First time

On the machine, with this repo checked out at the commit you mean to run:

```
docker build -f deploy/concierge/Dockerfile -t cello-concierge .

docker run -d --name concierge --init --restart unless-stopped \
  -v concierge-data:/data \
  -e CELLO_SERVER=wss://server.celloprotocol.com/v1 \
  cello-concierge
```

Then create the agent, once. The code goes in on standard input, so it is never in a command line or in shell history:

```
read -rs CODE
printf '%s\n' "$CODE" | docker exec -i concierge cello setup --yes --code - --name Concierge --server wss://server.celloprotocol.com/v1
unset CODE
docker exec concierge cello agents
```

The last command shows the agent's address. **That address is what goes into the client.** Within a minute the Concierge answers calls.

## Check it works

From any other agent, call the Concierge's address. You should get the first line at once, the next step on your next message, and the last line after that. The logs say what it did, and never what anyone wrote:

```
docker logs concierge
```

## What brings it back

| It dies, or stops working | What brings it back |
|---|---|
| The daemon dies | The supervisor, within a few seconds |
| The daemon is up and frozen | The supervisor finds it doesn't answer within 20 seconds, kills it and starts another |
| The server or the network is down | Nothing. The daemon says it can't reach the server and reconnects by itself, keeping its state, so the supervisor leaves it alone and logs `supervisor.remote.degraded`, then `supervisor.remote.back`. |
| The daemon says it is connected and the agent stays offline | After 120 seconds, the supervisor restarts the daemon. Each restart that doesn't help doubles the wait before the next, up to 15 minutes. An agent that is suspended or retired is not restarted. |
| The Concierge program dies | The supervisor, within a few seconds. One that dies at once, again and again, waits longer each time, up to 30 seconds. |
| The Concierge is up and stuck | It writes a heartbeat as it works. After 120 seconds of none, the supervisor kills it and starts another. |
| Both, or everything in the container | Docker, because of `--restart unless-stopped` |
| The machine reboots | Docker starts at boot and starts the container. Make sure `systemctl is-enabled docker` says `enabled`. |

The 120 seconds are `CONCIERGE_OFFLINE_RESTART_SECONDS` and `CONCIERGE_STALE_SECONDS`. `CONCIERGE_CHECK_SECONDS` (30) is how often the agent's state is looked at. Pass any of them with `-e` on `docker run`.

A conversation in progress carries on from where the daemon's record says it stood, and no line is repeated.

`docker stop` and `docker kill` are a person stopping it, so Docker leaves it stopped. Start it with `docker start concierge`.

## The one thing that can't be lost

Everything the agent is lives in the data folder: its keys and its conversations. **If it is lost, the Concierge's address changes, and every client that has the old one calls nobody.** On the CELLO machine that is the snapshotted disk. Anywhere else, snapshot the disk that holds it on a schedule, and do it before the first call is ever made to it.

## Updating

```
git pull
docker build -f deploy/concierge/Dockerfile -t cello-concierge .
docker stop concierge && docker rm concierge
# then the same docker run as above. Don't run setup again: the agent is in the data folder.
```

On the CELLO machine, run `infra/concierge/deploy.sh` again instead.

## If it isn't answering

Say what `docker logs concierge` shows, and stop there.

- `supervisor.daemon.failed` repeating: the daemon can't start. The message says why. `server_changed` means the data belongs to a different server.
- `supervisor.remote.degraded`: the daemon can't reach the server, or the agent is suspended or retired. The supervisor is leaving it alone on purpose. The `detail` says why. For a suspended or retired agent, that is for the owner to change.
- `supervisor.daemon.frozen`, or `supervisor.daemon.restarted`: the supervisor found the daemon unwell and replaced it. Seen once, it is fine. Seen over and over, the restarts are spacing themselves out, and the cause is not the daemon.
- `supervisor.concierge.stale`: the Concierge went quiet and was replaced.
- `concierge.loop.failed` with `unknown_agent`: setup hasn't been run on this data.
- `concierge.loop.failed` with `daemon_not_running`: the supervisor is bringing the daemon back, and it clears by itself.

## How this was proved

`scripts/concierge-deploy-test.sh` builds the image, brings a fresh container up with these same commands against a real server, and has real agents call it. It then kills the daemon and the Concierge program, freezes each of them, cuts the container's network for a minute and checks the daemon is neither restarted nor replaced, tells the supervisor the daemon is connected while the agent stays offline and checks it is restarted with growing gaps, kills both in the middle of a conversation, kills everything inside at once, and restarts the container. It checks that each call is still answered, the agent's address never changes, no line repeats, and the restarts after an outage space themselves out. It runs with short windows, 10 to 15 seconds in place of 120. It does not reboot a host: only the restart policy is checked.

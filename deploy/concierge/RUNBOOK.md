# Running the Concierge on its own machine

The Concierge is the first agent a new person calls. This puts it on one small machine, keeps it running, and brings it back by itself after a crash or a reboot. It is one container holding the `cello` daemon, the Concierge program, and a supervisor that starts either again if it dies.

The machine needs Docker, an outbound internet connection, and a disk that survives a reboot. It needs **no inbound port**: the daemon dials the server, and nothing dials in.

Creating the machine is a decision for Andre. Nothing here creates one.

## Before go-live

- **A setup code** for the Concierge's agent, from the same admission that gives anyone a code. It works once.
- **Approved lines.** Without a lines file, every line goes out with the draft label. Put the approved file on the machine, for example at `/etc/cello/lines.json`. Only Andre sets a file's status to `approved`.
- **The server address.** Production is `wss://server.celloprotocol.com/v1`.

## First time

On the machine, with this repo checked out at the commit you mean to run:

```
docker build -f deploy/concierge/Dockerfile -t cello-concierge .

docker run -d --name concierge --init --restart unless-stopped \
  -v concierge-data:/data \
  -v /etc/cello/lines.json:/config/lines.json:ro -e CONCIERGE_LINES=/config/lines.json \
  -e CELLO_SERVER=wss://server.celloprotocol.com/v1 \
  cello-concierge
```

Then create the agent, once:

```
docker exec concierge cello setup --yes --code <the code> --name Concierge --server wss://server.celloprotocol.com/v1
docker exec concierge cello agents
```

The second command shows the agent's address. **That address is what goes into the client.** Within a minute the Concierge answers calls.

## Check it works

From any other agent, call the Concierge's address. You should get the first line at once, the next step on your next message, and the last line after that. The logs say what it did, and never what anyone wrote:

```
docker logs concierge
```

## What brings it back

| It dies | What brings it back |
|---|---|
| The daemon | The supervisor, within a few seconds |
| The Concierge program | The supervisor, within a few seconds |
| Both, or everything in the container | Docker, because of `--restart unless-stopped` |
| The machine reboots | Docker starts at boot and starts the container. Make sure `systemctl is-enabled docker` says `enabled`. |

A conversation in progress carries on from where the daemon's record says it stood, and no line is repeated.

`docker stop` and `docker kill` are a person stopping it, so Docker leaves it stopped. Start it with `docker start concierge`.

## The one thing that can't be lost

Everything the agent is lives in the `concierge-data` volume: its keys and its conversations. **If the volume is lost, the Concierge's address changes, and every client that has the old one calls nobody.** Snapshot the disk that holds it on a schedule, and do it before the first call is ever made to it.

## Updating

```
git pull
docker build -f deploy/concierge/Dockerfile -t cello-concierge .
docker stop concierge && docker rm concierge
# then the same docker run as above. Don't run setup again: the agent is in the volume.
```

## If it isn't answering

Say what `docker logs concierge` shows, and stop there.

- `supervisor.daemon.failed` repeating: the daemon can't start. The message says why. `server_changed` means the volume belongs to a different server.
- `concierge.loop.failed` with `unknown_agent`: setup hasn't been run on this volume.
- `concierge.loop.failed` with `daemon_not_running`: the supervisor is bringing the daemon back, and it clears by itself.

## How this was proved

`scripts/concierge-deploy-test.sh` builds the image, brings a fresh container up with these same commands against a real server, and has real agents call it. It then kills the daemon, the Concierge program, both in the middle of a conversation, and everything inside at once, and restarts the container. It checks that each call is still answered, the agent's address never changes, and no line repeats. It does not reboot a host: only the restart policy is checked.

# Running the live tests

**Everything is a command.** `node src/cli.ts --help` lists them. The Claude Code tools come from the same table, in `src/ipc/operations.ts`, so a new operation goes there and both get it. `live/cli.live.ts` runs a whole conversation by command line alone.

**Scripted tests.** Real server, real daemons and real processes, and no model turns. They need Docker running, and they cover everything except a real session waking.

```
pnpm run test:live                    # here: the daemon and tools, with a server started from nothing
(cd ../cello-server && pnpm run test:live)   # the server itself
```

Run them whenever you like. They need nobody's OK.

**Signals in these tests.** A server requires a verified email signal to register. `scripts/test-issuer-env.sh` starts the stand-in issuer, and tells this run's servers to count it as an operator-added issuer, on the production server code. `live/enrolling-cli.ts` redeems a throwaway code for each home's first agent, and later agents get copies from it, so each daemon collects its own signal and presents it. Hostile registration cases are in `cello-server`'s live test. Set `CELLO_ISSUER_DIR` when running from a worktree. For a remote server, its operator sets `CELLO_TRUSTED_ISSUERS` to the output of `node live/issuer-service.ts --print-trusted`.

**The install test** is one of them, and it also runs alone: `pnpm run test:install`. It packs the tarball, installs it into an empty prefix, and uses only the installed binaries from outside this repo. It starts its own server, on project `cello-v2-install` and port 18095 (`CELLO_INSTALL_PORT` changes it). It prints the install time and size. After a failure, it keeps its temporary folder and says where.

**The channels test.** `scripts/live-channels.sh` starts a real server on project `cello-v2-channels` and port 18600, and three daemons in their own folders. A bare socket plays the attacker, and the hostile cases work on the database as its owner and with the server's real signing key. It reads the database directly to check that a private channel holds no plaintext. `CHANNELS_LIVE_PATTERN` runs only tests whose names match. It sets its timings with `channel-config`, never the environment, because settings live in the database.

**The federation test.** `CELLO_SERVER_DIR=<server checkout> scripts/federation-test.sh`. Two real servers from nothing, started with the server's own `scripts/server.sh` as Compose projects `cello-v2-fed-a` and `cello-v2-fed-b` on ports 18400 and 18401, with real daemons as separate processes. An agent on one holds a conversation with an agent on the other, through daemon kills and with its own server down, then closes and seals, and it calls back the other way. It runs the same log check as the real-session test. It also checks both databases, and that the called daemon has no connection to any server but its own. It removes its containers, volumes and daemons however it ends. Evidence goes to `~/cello-v2-live-runs/federation-<time>/`.

**The away test.** `CELLO_SERVER_DIR=<server> scripts/away-test.sh`. A real server on project `cello-v2-away` and port 18900, with real daemons. It reads the server's database as its owner. Other live tests turn `away.answering` off for agents nobody holds, because a call to one of those is greeted and closed after one message.

**The kill switch test** runs alone: `CELLO_SERVER_DIR=<server> scripts/status-test.sh`. Two real servers on projects `cello-v2-status-a` and `-b`, ports 18800 and 18801, with real daemons and a real terminal for the person-only commands. It flips the switch mid-conversation, and checks both connections, sealing, the signed log, forged statements, and what crosses between servers. It builds under the heavy-run lock, and needs no other lock.

**The setup test.** `CELLO_SERVER_DIR=<server> CELLO_ISSUER_DIR=<cello-issuer> scripts/setup-test.sh`. A real server on project `cello-v2-setup` and port 18950, real daemons and a real terminal, with a stand-in issuer in `live/stand-in-issuer.ts`. It runs setup from nothing, its failures, a repeat, a second agent's copies, and the wallet. It reads requests with `cello-issuer`'s own code, but it doesn't run that issuer or the waitlist.

**The speed test.** A bot floods while another pair talks on the same daemon, and the pair is timed. It tests the plumbing only: there's no screener yet. It needs no model turns, and it stops itself if the machine looks strained. Numbers go to `~/cello-v2-live-runs/speed-<time>/`.

```
node live/speed.ts --local [--scenarios a,b] [--seconds 30] [--cpu-prof]   # a server from nothing, on port 18190
node live/speed.ts --server wss://host/v1 --gentle                         # a shared server: few messages, few of them long
```

Set `CELLO_SERVER_DIR` or `--server-dir` when running from a worktree, and `--project` and `--port` to run beside another track. Don't aim it without `--gentle` at a server others use.

The `slow_*` scenarios put every connection through one shared throttled pipe, a packet at a time. They fail if a long upload holds up another conversation or a connection drops. Real links can queue more than this pipe does, so a pass here doesn't prove a given real link.

**The screening tests.** `live/screening.live.ts` is one of the scripted tests, on the deterministic screener: hostile text in a tail, a queue through a daemon kill, a real worker crash, the person-only setting, and a database moved to a new home. `live/screening-model.live.ts` is short and run by hand with the model: one long message, to show the main thread doesn't stall. Set `MODEL_SOURCE` to a folder holding `screener/` and `screener-runtime/`, which it clones and never changes. Big test messages are prose, because the outbound screen redacts hash-like text, so a hash-heavy load has to come from a sender that doesn't run it.

**The real-session test.** Two real Claude Code sessions through the server on the test instance, on the cheapest model. It's the only proof that a doorbell wakes a session. One run costs about 40 model turns.

```
node live/real-sessions.ts --server wss://136-72-31-96.sslip.io/v1 --instance cello-v2-test --zone us-east1-d
```

Run it once per iteration, and whenever wake or daemon code changes. Say one line to Andre first, and don't wait for an answer. To watch it: `tmux attach -r -t cello-live`.

Add `--unscripted` to give the sessions a goal instead of fixed lines. That run fails only on what the protocol must guarantee, and a person reads the transcripts for how the agents behaved.

**The doctor** runs first by itself, or by hand with the same arguments: `node live/doctor.ts ...`. It's read-only. It says whether the setup is worth testing: the tools exist, the server answers and runs the latest commit, this client is committed, and no earlier run is still open.

**Evidence** goes to `~/cello-v2-live-runs/<time>/`: `report.json` and each session's final screen, plus readable transcripts for an unscripted run. Nothing cleans that folder.

**Cleanup.** A run stops only what it started: its own daemon, in its own temporary folder, by process id, and its own tmux session. After a pass, the throwaway keys go too. After a failure, the tmux session and temporary folder stay, for looking at. Close them with `tmux kill-session -t cello-live` once you have.

**If it fails,** read `report.json` for the reason and the screens for what the sessions saw. A timeout usually means a session is waiting on something: its screen will say what.

**After changing the server,** redeploy: `scripts/deploy-remote.sh cello-v2-test us-east1-d 136-72-31-96.sslip.io` in `cello-server`. Its protocol copy comes from `scripts/sync-protocol.sh`.

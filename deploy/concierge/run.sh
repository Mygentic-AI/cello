#!/bin/sh
# Keeps the cello daemon and the Concierge working in this container, and starts either again when it isn't.
# Working means more than running. The daemon has to answer and, once the agent exists, show it online. The Concierge
# has to keep writing its heartbeat. A program that is up and doing nothing answers nobody, so it is restarted too.
# Each restart waits longer than the last when it didn't help, so a fault that outlasts a restart doesn't become a storm.
# The Concierge reads what each conversation needs from the daemon's own record, so a restart of either loses nothing
# and repeats no line.
set -u

: "${CELLO_SERVER:?CELLO_SERVER is the server's address, like wss://server.celloprotocol.com/v1}"
agent="${CONCIERGE_AGENT:-Concierge}"
here=$(dirname "$0")
# How long the agent may be offline, and the Concierge's heartbeat may be silent, before a restart.
offline_limit="${CONCIERGE_OFFLINE_RESTART_SECONDS:-120}"
stale_limit="${CONCIERGE_STALE_SECONDS:-120}"
check_every="${CONCIERGE_CHECK_SECONDS:-30}"
heartbeat="${CONCIERGE_HEARTBEAT:-/tmp/concierge.heartbeat}"
# Word-split on purpose: extra flags for the Concierge, like --max-calls-per-caller 5.
extra="${CONCIERGE_ARGS:-}"
longest_wait=900

log() {
  printf '{"at":"%s","event":"%s"%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${2:+,$2}" >&2
}

# Every call to cello has an end, because a frozen daemon would hold a call forever.
cello_for() {
  seconds=$1
  shift
  timeout "$seconds" cello "$@"
}

# The daemon is found by its command line, because a frozen one can't be asked to stop.
kill_daemon() {
  for p in /proc/[0-9]*; do
    case "$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null)" in
      *daemon/main*) kill -9 "${p#/proc/}" 2>/dev/null ;;
    esac
  done
}

concierge_pid=""
stopping=""
stop() {
  stopping=1
  [ -n "$concierge_pid" ] && kill "$concierge_pid" 2>/dev/null
  cello_for 20 logout >/dev/null 2>&1
  log supervisor.stopped
  exit 0
}
trap stop TERM INT

# Without CONCIERGE_LINES the Concierge uses the lines file shipped in the image.
lines_args=""
if [ -n "${CONCIERGE_LINES:-}" ]; then lines_args="--lines $CONCIERGE_LINES"; fi

# The agent's state as the daemon reports it: online, offline, or missing before setup has made it.
agent_state() {
  cello_for 30 agents 2>/dev/null | AGENT="$agent" node -e '
    let text = "";
    process.stdin.on("data", (c) => { text += c; });
    process.stdin.on("end", () => {
      try {
        const found = JSON.parse(text).agents.find((a) => a.name === process.env.AGENT);
        console.log(found ? (found.online ? "online" : "offline") : "missing");
      } catch { console.log("unknown"); }
    });'
}

log supervisor.started "\"agent\":\"$agent\",\"server\":\"$CELLO_SERVER\""
daemon_failures=0
daemon_retry_at=0
health_restarts=0
offline_since=0
next_health_restart_at=0
last_check=0
concierge_failures=0
concierge_started=0
concierge_retry_at=0
while [ -z "$stopping" ]; do
  now=$(date +%s)

  # 1. The daemon answers. If it doesn't, start it, and if starting it fails, kill it so the next try is on a clean one.
  cello_for 20 status >/dev/null 2>&1
  status_exit=$?
  # No answer in the time given means it is frozen, which no amount of asking will fix.
  if [ "$status_exit" -eq 124 ]; then
    log supervisor.daemon.frozen
    kill_daemon
  fi
  if [ "$status_exit" -ne 0 ]; then
    if [ "$now" -ge "$daemon_retry_at" ]; then
      if cello_for 60 login --server "$CELLO_SERVER" >/dev/null 2>/tmp/login.err; then
        log supervisor.daemon.started
        daemon_failures=0
      else
        daemon_failures=$((daemon_failures + 1))
        wait_more=$((2 << (daemon_failures < 5 ? daemon_failures : 5)))
        [ "$wait_more" -gt 60 ] && wait_more=60
        daemon_retry_at=$((now + wait_more))
        # Said on the first failure and then now and then, so a long outage doesn't fill the log.
        if [ "$daemon_failures" -eq 1 ] || [ $((daemon_failures % 10)) -eq 0 ]; then
          log supervisor.daemon.failed "\"failures\":$daemon_failures,\"next_try_seconds\":$wait_more,\"message\":\"$(tr -d '"\\\n' </tmp/login.err | cut -c1-300)\""
        fi
        # A daemon that neither answers nor can be started again is stuck, so the next try is on a fresh one.
        [ "$daemon_failures" -ge 2 ] && kill_daemon
      fi
    fi
  else
    # 2. The agent is online. Offline for longer than the limit means the daemon is up and not working.
    if [ $((now - last_check)) -ge "$check_every" ]; then
      last_check=$now
      state=$(agent_state)
      if [ "$state" = "online" ] || [ "$state" = "missing" ]; then
        offline_since=0
        health_restarts=0
      elif [ "$state" = "offline" ]; then
        [ "$offline_since" -eq 0 ] && offline_since=$now
        if [ $((now - offline_since)) -ge "$offline_limit" ] && [ "$now" -ge "$next_health_restart_at" ]; then
          health_restarts=$((health_restarts + 1))
          # Each restart that doesn't bring it online doubles the wait before the next, up to a longest.
          wait_more=$((offline_limit << (health_restarts < 6 ? health_restarts : 6)))
          [ "$wait_more" -gt "$longest_wait" ] && wait_more=$longest_wait
          next_health_restart_at=$((now + wait_more))
          log supervisor.daemon.restarted "\"reason\":\"agent offline\",\"offline_seconds\":$((now - offline_since)),\"restarts\":$health_restarts,\"next_allowed_seconds\":$wait_more"
          kill_daemon
          offline_since=0
        fi
      fi
    fi
  fi

  # 3. The Concierge is running, and has written its heartbeat lately.
  if [ -n "$concierge_pid" ] && kill -0 "$concierge_pid" 2>/dev/null; then
    if [ $((now - concierge_started)) -ge "$stale_limit" ]; then
      beat=$(stat -c %Y "$heartbeat" 2>/dev/null || echo 0)
      if [ $((now - beat)) -ge "$stale_limit" ]; then
        log supervisor.concierge.stale "\"silent_seconds\":$((now - beat))"
        kill -9 "$concierge_pid" 2>/dev/null
      fi
    fi
  fi

  if [ -n "$concierge_pid" ] && ! kill -0 "$concierge_pid" 2>/dev/null; then
    ran=$((now - concierge_started))
    # One that ran a while and then died starts again at once. One that dies straight away waits longer each time.
    if [ "$ran" -ge 30 ]; then concierge_failures=0; else concierge_failures=$((concierge_failures + 1)); fi
    wait_more=$((concierge_failures * 2))
    [ "$wait_more" -gt 30 ] && wait_more=30
    concierge_retry_at=$((now + wait_more))
    log supervisor.concierge.exited "\"ran_seconds\":$ran,\"failures\":$concierge_failures"
    concierge_pid=""
  fi
  if [ -z "$concierge_pid" ] && [ "$now" -ge "$concierge_retry_at" ]; then
    rm -f "$heartbeat"
    # shellcheck disable=SC2086
    node "$here/concierge/concierge.ts" --agent "$agent" --heartbeat "$heartbeat" $lines_args $extra &
    concierge_pid=$!
    concierge_started=$now
    log supervisor.concierge.started "\"pid\":$concierge_pid"
  fi
  sleep 2
done

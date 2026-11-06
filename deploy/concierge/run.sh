#!/bin/sh
# Keeps the cello daemon and the Concierge running in this container. It looks every two seconds, so a program that
# dies is back within a few seconds, and it never does anything but start them again. The Concierge reads what each
# conversation needs from the daemon's own record, so a restart of either loses nothing and repeats no line.
set -u

: "${CELLO_SERVER:?CELLO_SERVER is the server's address, like wss://server.celloprotocol.com/v1}"
agent="${CONCIERGE_AGENT:-Concierge}"
here=$(dirname "$0")
# Word-split on purpose: extra flags for the Concierge, like --max-calls-per-caller 5.
extra="${CONCIERGE_ARGS:-}"

log() {
  printf '{"at":"%s","event":"%s"%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${2:+,$2}" >&2
}

concierge_pid=""
stopping=""
stop() {
  stopping=1
  [ -n "$concierge_pid" ] && kill "$concierge_pid" 2>/dev/null
  cello logout >/dev/null 2>&1
  log supervisor.stopped
  exit 0
}
trap stop TERM INT

# Without this the Concierge uses the lines file shipped in the image.
lines_args=""
if [ -n "${CONCIERGE_LINES:-}" ]; then lines_args="--lines $CONCIERGE_LINES"; fi

log supervisor.started "\"agent\":\"$agent\",\"server\":\"$CELLO_SERVER\""
daemon_failures=0
concierge_failures=0
concierge_started=0
while [ -z "$stopping" ]; do
  if ! cello status >/dev/null 2>&1; then
    if cello login --server "$CELLO_SERVER" >/dev/null 2>/tmp/login.err; then
      log supervisor.daemon.started
      daemon_failures=0
    else
      daemon_failures=$((daemon_failures + 1))
      # Said on the first failure and then now and then, so a long outage doesn't fill the log.
      if [ "$daemon_failures" -eq 1 ] || [ $((daemon_failures % 30)) -eq 0 ]; then
        log supervisor.daemon.failed "\"failures\":$daemon_failures,\"message\":\"$(tr -d '"\\\n' </tmp/login.err | cut -c1-300)\""
      fi
    fi
  fi

  if [ -n "$concierge_pid" ] && ! kill -0 "$concierge_pid" 2>/dev/null; then
    ran=$(($(date +%s) - concierge_started))
    # One that ran a while and then died starts again at once. One that dies straight away waits longer each time.
    if [ "$ran" -ge 30 ]; then concierge_failures=0; else concierge_failures=$((concierge_failures + 1)); fi
    log supervisor.concierge.exited "\"ran_seconds\":$ran,\"failures\":$concierge_failures"
    concierge_pid=""
    wait_more=$((concierge_failures * 2)); [ "$wait_more" -gt 30 ] && wait_more=30
    sleep "$wait_more"
  fi
  if [ -z "$concierge_pid" ]; then
    # shellcheck disable=SC2086
    node "$here/concierge/concierge.ts" --agent "$agent" $lines_args $extra &
    concierge_pid=$!
    concierge_started=$(date +%s)
    log supervisor.concierge.started "\"pid\":$concierge_pid"
  fi
  sleep 2
done

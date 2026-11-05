#!/bin/sh
# The kill switch, on two real servers from nothing, with real daemons as separate processes.
# It leaves no container, volume or daemon behind, whichever way it ends.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
server_dir="${CELLO_SERVER_DIR:-$here/../cello-server}"
project="${CELLO_STATUS_PROJECT:-cello-v2-status}"
# Servers now require a verified email signal. These tests are about other things, so the test issuer gives one to any client that brought none.
export CELLO_TEST_OVERLAY=live/docker-compose.test.yml CELLO_TEST_VOUCH=1
mkdir -p "$HOME/cello-v2-live-runs"
if ! diff -r "$here/src/protocol" "$server_dir/src/protocol" >/dev/null; then
  echo "The server's protocol copy differs from this repo's. In cello-server, run scripts/sync-protocol.sh and commit." >&2
  exit 1
fi

lock="$HOME/cello-v2-live-runs/.heavy-lock"
locked=
pids=$(mktemp)
cleanup() {
  [ -n "$locked" ] && rmdir "$lock" 2>/dev/null
  while read -r pid; do
    case "$(ps -o command= -p "$pid" 2>/dev/null)" in
      *daemon/main*) kill -9 "$pid" 2>/dev/null ;;
    esac
  done < "$pids"
  # A daemon the test started but never recorded, such as when it timed out first. Only this run's daemons carry these ports.
  first_port="${CELLO_STATUS_PORT:-18800}"
  for port in "$first_port" "$((first_port + 1))"; do
    pkill -f "daemon/main.ts ws://127.0.0.1:$port/v1" 2>/dev/null
  done
  rm -f "$pids"
  for name in "$project-a" "$project-b"; do
    "$server_dir/scripts/server.sh" down --name "$name" --delete-data >/dev/null 2>&1
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Building is what loads the machine, so it happens under the lock, one at a time. The test's own start then finds it all built.
tries=0
until mkdir "$lock" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 120 ]; then echo "Waited 10 minutes for $lock. Something else is holding it, or left it behind." >&2; exit 1; fi
  sleep 5
done
locked=1
for name in "$project-a" "$project-b"; do
  (cd "$server_dir" && COMPOSE_PROJECT_NAME="$name" POSTGRES_PASSWORD=unused CELLO_APP_PASSWORD=unused docker compose build --quiet) || exit 1
done
rmdir "$lock"
locked=

cd "$here"
CELLO_STATUS_PROJECT="$project" CELLO_SERVER_DIR="$server_dir" CELLO_STATUS_PIDS="$pids" node --test --test-force-exit --test-timeout=420000 live/agent-status.live.ts

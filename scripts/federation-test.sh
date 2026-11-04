#!/bin/sh
# Two real servers from nothing, as separate Compose projects, with real daemons as separate processes.
# It leaves no container, volume or daemon behind, whichever way it ends.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
server_dir="${CELLO_SERVER_DIR:-$here/../cello-server}"
mkdir -p "$HOME/cello-v2-live-runs"
if ! diff -r "$here/src/protocol" "$server_dir/src/protocol" >/dev/null; then
  echo "The server's protocol copy differs from this repo's. In cello-server, run scripts/sync-protocol.sh and commit." >&2
  exit 1
fi

pids=$(mktemp)
cleanup() {
  while read -r pid; do
    case "$(ps -o command= -p "$pid" 2>/dev/null)" in
      *daemon/main*) kill -9 "$pid" 2>/dev/null ;;
    esac
  done < "$pids"
  # A daemon the test started but never recorded, such as when it timed out first. Only this run's daemons carry these ports.
  for port in 18400 18401; do
    pkill -f "daemon/main.ts ws://127.0.0.1:$port/v1" 2>/dev/null
  done
  # Killed mid-build: this run still holds the heavy-run lock, and nothing else would free it.
  if [ -f "$pids.locked" ]; then
    rmdir "$HOME/cello-v2-live-runs/.heavy-lock" 2>/dev/null
    rm -f "$pids.locked"
  fi
  rm -f "$pids"
  for name in cello-v2-fed-a cello-v2-fed-b; do
    "$server_dir/scripts/server.sh" down --name "$name" --delete-data >/dev/null 2>&1
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$here"
CELLO_SERVER_DIR="$server_dir" CELLO_FED_PIDS="$pids" node --test --test-force-exit --test-timeout=420000 live/federation.live.ts

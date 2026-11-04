#!/bin/sh
# The Concierge against a real server from nothing, with its daemon and the callers' daemon as separate processes.
# It leaves no container, volume or daemon behind, whichever way it ends.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
server_dir="${CELLO_SERVER_DIR:-$here/../../../../cello-server}"
export COMPOSE_PROJECT_NAME=cello-v2-concierge CELLO_PORT=19000 CELLO_SERVER_DIR="$server_dir"
POSTGRES_PASSWORD=$(openssl rand -hex 16); CELLO_APP_PASSWORD=$(openssl rand -hex 16)
export POSTGRES_PASSWORD CELLO_APP_PASSWORD
if ! diff -r "$here/src/protocol" "$server_dir/src/protocol" >/dev/null; then
  echo "The server's protocol copy differs from this repo's. In cello-server, run scripts/sync-protocol.sh and commit." >&2
  exit 1
fi
cd "$server_dir"
lock="$HOME/cello-v2-live-runs/.heavy-lock"
held=""
trap 'pkill -f "$here/concierge/concierge.ts --agent" 2>/dev/null || true; pkill -f "daemon/main.ts ws://127.0.0.1:$CELLO_PORT/v1" 2>/dev/null || true; if [ -n "$held" ]; then rmdir "$lock" 2>/dev/null; fi; cd "$server_dir" && docker compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
waited=0
until mkdir "$lock" 2>/dev/null; do
  waited=$((waited + 5))
  if [ "$waited" -ge 900 ]; then echo "Another run held the build lock for 15 minutes, so this one stopped." >&2; exit 75; fi
  sleep 5
done
held=1
docker compose up -d --build --wait server || { docker compose logs migrate postgres 2>&1 | tail -30; exit 1; }
rmdir "$lock"
held=""
cd "$here"
CELLO_URL="ws://127.0.0.1:$CELLO_PORT/v1" node --test --test-force-exit --test-timeout=420000 live/concierge.live.ts

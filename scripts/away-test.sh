#!/bin/sh
# Starts a real server from nothing, then runs the away test against it. Set AWAY_FILES to run other live tests on the same server.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
server_dir="${CELLO_SERVER_DIR:-$here/../cello-server}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cello-v2-away}" CELLO_PORT="${CELLO_PORT:-18900}" CELLO_SERVER_DIR="$server_dir"
POSTGRES_PASSWORD=$(openssl rand -hex 16); CELLO_APP_PASSWORD=$(openssl rand -hex 16)
export POSTGRES_PASSWORD CELLO_APP_PASSWORD
if ! diff -r "$here/src/protocol" "$server_dir/src/protocol" >/dev/null; then
  echo "The server's protocol copy differs from this repo's. In cello-server, run scripts/sync-protocol.sh and commit." >&2
  exit 1
fi
cd "$server_dir"
# Builds running at once have frozen this machine, so only the build takes the shared lock.
lock="$HOME/cello-v2-live-runs/.heavy-lock"
held=""
trap 'if [ -n "$held" ]; then rmdir "$lock" 2>/dev/null; fi; cd "$server_dir" && docker compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
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
CELLO_URL="ws://127.0.0.1:$CELLO_PORT/v1" node --test --test-concurrency=1 --test-force-exit --test-timeout=300000 ${AWAY_FILES:-live/away.live.ts}

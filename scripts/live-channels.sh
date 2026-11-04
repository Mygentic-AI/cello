#!/bin/sh
# Starts a real server from nothing, then runs the channels live test against it as separate processes.
# Set CHANNELS_LIVE_PATTERN to run only tests whose names match.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
server_dir="${CELLO_SERVER_DIR:-$here/../cello-server}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cello-v2-channels}" CELLO_PORT="${CELLO_PORT:-18600}" CELLO_SERVER_DIR="$server_dir"
POSTGRES_PASSWORD=$(openssl rand -hex 16); CELLO_APP_PASSWORD=$(openssl rand -hex 16)
export POSTGRES_PASSWORD CELLO_APP_PASSWORD
if ! diff -r "$here/src/protocol" "$server_dir/src/protocol" >/dev/null; then
  echo "The server's protocol copy differs from this repo's. In cello-server, run scripts/sync-protocol.sh and commit." >&2
  exit 1
fi
cd "$server_dir"
trap 'cd "$server_dir" && docker compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
docker compose up -d --build --wait server || { docker compose logs migrate postgres 2>&1 | tail -30; exit 1; }
cd "$here"
if [ -n "${CHANNELS_LIVE_PATTERN:-}" ]; then
  CELLO_URL="ws://127.0.0.1:$CELLO_PORT/v1" node --test --test-force-exit --test-timeout=300000 --test-name-pattern="$CHANNELS_LIVE_PATTERN" live/channels.live.ts
else
  CELLO_URL="ws://127.0.0.1:$CELLO_PORT/v1" node --test --test-force-exit --test-timeout=300000 live/channels.live.ts
fi

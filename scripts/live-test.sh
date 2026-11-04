#!/bin/sh
# Starts a real server from nothing, then runs the daemon's live test against it as separate processes.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
server_dir="${CELLO_SERVER_DIR:-$here/../cello-server}"
export COMPOSE_PROJECT_NAME=cello-v2-live CELLO_PORT=18090 CELLO_SERVER_DIR="$server_dir"
POSTGRES_PASSWORD=$(openssl rand -hex 16); CELLO_APP_PASSWORD=$(openssl rand -hex 16)
export POSTGRES_PASSWORD CELLO_APP_PASSWORD
# The server carries a copy of the protocol code, and nothing else stops the two drifting apart.
if ! diff -r "$here/src/protocol" "$server_dir/src/protocol" >/dev/null; then
  echo "The server's protocol copy differs from this repo's. In cello-server, run scripts/sync-protocol.sh and commit." >&2
  exit 1
fi
cd "$server_dir"
trap 'docker compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
docker compose up -d --build --wait server
cd "$here"
CELLO_URL="ws://127.0.0.1:$CELLO_PORT/v1" node --test --test-force-exit --test-timeout=240000 live/daemon.live.ts live/mcp.live.ts

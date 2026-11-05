#!/bin/sh
# cello setup and the wallet, against a real server and real daemons, with a stand-in issuer. It leaves nothing running.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
server_dir="${CELLO_SERVER_DIR:-$here/../cello-server}"
export CELLO_ISSUER_DIR="${CELLO_ISSUER_DIR:-$here/../cello-issuer}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cello-v2-setup}" CELLO_PORT="${CELLO_PORT:-18950}" CELLO_SERVER_DIR="$server_dir"
POSTGRES_PASSWORD=$(openssl rand -hex 16); CELLO_APP_PASSWORD=$(openssl rand -hex 16)
export POSTGRES_PASSWORD CELLO_APP_PASSWORD
if ! diff -r "$here/src/protocol" "$server_dir/src/protocol" >/dev/null; then
  echo "The server's protocol copy differs from this repo's. In cello-server, run scripts/sync-protocol.sh and commit." >&2
  exit 1
fi
if [ ! -f "$CELLO_ISSUER_DIR/src/server/trust/agent-request.ts" ]; then
  echo "No cello-issuer at $CELLO_ISSUER_DIR. Set CELLO_ISSUER_DIR, because this test reads requests with that repo's code." >&2
  exit 1
fi
cd "$server_dir"
# Builds running at once have frozen this machine, so only the build takes the shared lock.
lock="$HOME/cello-v2-live-runs/.heavy-lock"
mkdir -p "$HOME/cello-v2-live-runs"
held=""
trap 'if [ -n "$held" ]; then rmdir "$lock" 2>/dev/null; fi; pkill -f "daemon/main.ts ws://127.0.0.1:$CELLO_PORT/v1" 2>/dev/null; cd "$server_dir" && docker compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
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
CELLO_URL="ws://127.0.0.1:$CELLO_PORT/v1" node --test --test-concurrency=1 --test-force-exit --test-timeout=300000 live/setup.live.ts

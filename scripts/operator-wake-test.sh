#!/bin/sh
# A real Claude Code session woken by its operator's answer in Telegram and by a timed Reminder, against a server started
# from nothing. A person answers on their phone. Needs CELLO_BOT_TOKEN and CELLO_BOT_CHAT, tmux, and the claude command.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
server_dir="${CELLO_SERVER_DIR:-$here/../cello-server}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cello-wake}" CELLO_PORT="${CELLO_PORT:-18980}" CELLO_SERVER_DIR="$server_dir"
. "$here/scripts/test-issuer-env.sh"
POSTGRES_PASSWORD=$(openssl rand -hex 16); CELLO_APP_PASSWORD=$(openssl rand -hex 16)
export POSTGRES_PASSWORD CELLO_APP_PASSWORD
if ! diff -r "$here/src/protocol" "$server_dir/src/protocol" >/dev/null; then
  echo "The server's protocol copy differs from this repo's. In cello-server, run scripts/sync-protocol.sh and commit." >&2
  exit 1
fi
cd "$server_dir"
lock="$HOME/cello-live-runs/.heavy-lock"
mkdir -p "$HOME/cello-live-runs"
held=""
# Only this run's daemon carries this port in its command, so a person's real daemon is never touched.
trap 'if [ -n "$held" ]; then rmdir "$lock" 2>/dev/null; fi; pkill -f "daemon/main.ts ws://127.0.0.1:$CELLO_PORT/v1" 2>/dev/null || true; cd "$server_dir" && docker compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
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
CELLO_URL="ws://127.0.0.1:$CELLO_PORT/v1" node live/operator-wake.ts

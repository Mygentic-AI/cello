#!/bin/sh
# The Hermes bridge against a real server, real daemons and the real Hermes gateway on this machine. Only the model is a script.
# HERMES_BRIDGE_HOME is a Hermes home kept between runs, because a new one spends minutes installing Hermes' own dependencies.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
server_dir="${CELLO_SERVER_DIR:-$here/../cello-server}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cello-hermes}" CELLO_PORT="${CELLO_PORT:-18950}"
POSTGRES_PASSWORD=$(openssl rand -hex 16); CELLO_APP_PASSWORD=$(openssl rand -hex 16)
export POSTGRES_PASSWORD CELLO_APP_PASSWORD
cd "$server_dir"
trap 'pkill -f "daemon/main.ts ws://127.0.0.1:$CELLO_PORT/v1" 2>/dev/null || true; docker compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
docker compose up -d --build --wait server || { docker compose logs migrate postgres 2>&1 | tail -30; exit 1; }
cd "$here"
CELLO_URL="ws://127.0.0.1:$CELLO_PORT/v1" node --test --test-force-exit --test-timeout=420000 live/hermes-bridge.live.ts

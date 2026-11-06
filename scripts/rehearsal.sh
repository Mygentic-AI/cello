#!/bin/sh
# Andre's go-live test, rehearsed on this Mac against local copies of every service: a server, the issuer's real image
# with test keys and a list signed by two test roots, the waitlist's code issuance, the hosted page, provisioner and host
# agent with a hosted container, and the Concierge. It walks the test and records each step, pass or fail, with timing,
# in ~/cello-v2-live-runs/rehearsal-<time>/results.md. It leaves nothing running, and touches no cloud.
#
# Each checkout defaults to the rehearsal worktree beside this one (<repo>/.claude/worktrees/rehearsal). Set R_BUILD=0
# to reuse images already built. Ports 23000-23999 only; its own COMPOSE_PROJECT_NAME.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
code=$(cd "$here/../../../.." && pwd)
wt=.claude/worktrees/rehearsal
export R_SERVER_DIR="${R_SERVER_DIR:-$code/cello-server/$wt}"
export R_ISSUER_DIR="${R_ISSUER_DIR:-$code/cello-issuer/$wt}"
export R_TC_DIR="${R_TC_DIR:-$code/trustless-cello/$wt}"
R_MCP_DIR="${R_MCP_DIR:-$code/cello-mcp-http/$wt}"
# The install_codes table is only on corp-cello-site's waitlist-codes branch until go-live step 1 merges it.
export R_WAITLIST_MIGRATIONS="${R_WAITLIST_MIGRATIONS:-$code/waitlist-codes-worktrees/corp-cello-site/migrations}"
export R_OPS_MIGRATIONS="${R_OPS_MIGRATIONS:-$code/cello-ops-dashboard/migrations}"
export R_ISSUER_IMAGE="${R_ISSUER_IMAGE:-cello-issuer:rehearsal}" R_HOSTED_IMAGE="${R_HOSTED_IMAGE:-cello-hosted:rehearsal}" R_CONCIERGE_IMAGE="${R_CONCIERGE_IMAGE:-cello-concierge:rehearsal}"
# The rehearsal's server uses the test-signed list it is given, and must not fetch the real issuer's.
export CELLO_ISSUER_LIST_URL=off
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cello-rehearsal}"
export R_EVIDENCE="${R_EVIDENCE:-$HOME/cello-v2-live-runs/rehearsal-$(date +%Y%m%d-%H%M%S)}"
for d in "$R_SERVER_DIR" "$R_ISSUER_DIR" "$R_TC_DIR" "$R_MCP_DIR" "$R_WAITLIST_MIGRATIONS" "$R_OPS_MIGRATIONS"; do
  [ -d "$d" ] || { echo "Missing $d. Make the rehearsal worktree there, or set its R_ variable." >&2; exit 1; }
done
grep -lq install_codes "$R_WAITLIST_MIGRATIONS"/*.sql || { echo "$R_WAITLIST_MIGRATIONS has no install_codes migration." >&2; exit 1; }
if ! diff -r "$here/src/protocol" "$R_SERVER_DIR/src/protocol" >/dev/null; then
  echo "The server's protocol copy differs from this repo's. In cello-server, run scripts/sync-protocol.sh and commit." >&2
  exit 1
fi
[ -f "$R_TC_DIR/packages/hosting/dist/host-agent/server.js" ] || { echo "Build the hosting package first: (cd $R_TC_DIR/packages/hosting && npx tsc --build)" >&2; exit 1; }
[ -d "$R_TC_DIR/packages/hosting/web/.next" ] || { echo "Build the hosted page first: (cd $R_TC_DIR/packages/hosting/web && pnpm build)" >&2; exit 1; }
if [ "${R_BUILD:-1}" = 1 ]; then
  sh "$R_TC_DIR/infra/hosted-image/pack.sh" "$here" "$R_MCP_DIR"
  docker build -q -t "$R_HOSTED_IMAGE" "$R_TC_DIR/infra/hosted-image"
  docker build -q -t "$R_ISSUER_IMAGE" "$R_ISSUER_DIR"
  docker build -q -f "$here/deploy/concierge/Dockerfile" -t "$R_CONCIERGE_IMAGE" "$here"
fi
mkdir -p "$R_EVIDENCE"
# The run cleans up after itself. If it is killed before it can, this removes what carries the run's names.
trap 'docker rm -f "$COMPOSE_PROJECT_NAME-pg" "$COMPOSE_PROJECT_NAME-issuer" "$COMPOSE_PROJECT_NAME-concierge" >/dev/null 2>&1 || true; for c in $(docker ps -aq --filter name=cello-hosted- --filter publish=23500-23699); do docker rm -f "$c" >/dev/null 2>&1 || true; done; docker volume rm -f "$COMPOSE_PROJECT_NAME-concierge-data" >/dev/null 2>&1 || true; (cd "$R_SERVER_DIR" && docker compose down -v --remove-orphans >/dev/null 2>&1) || true; pkill -f "gunicorn _app:application -b 127.0.0.1:23100" 2>/dev/null || true; pkill -f "next start -p 23104" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$here"
node live/rehearsal.live.ts 2>&1 | tee "$R_EVIDENCE/run.log"

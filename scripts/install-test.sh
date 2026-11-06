#!/bin/sh
# The install test, which starts its own server. Its daemon runs from the installed package, so it's a .js file.
set -u
port="${CELLO_INSTALL_PORT:-18095}"
cd "$(dirname "$0")/.."
here=$(pwd)
. "$here/scripts/test-issuer-env.sh"
# A test's own cleanup is skipped when it times out or is force-exited. Only this run's daemons carry this port.
trap 'pkill -f "daemon/main.js ws://127.0.0.1:$port/v1" 2>/dev/null' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node --test --test-force-exit live/install.live.ts

#!/bin/sh
# The server carries a copy of the client's protocol code. This stops either repo committing a change that drifts apart.
# Run scripts/sync-protocol.sh in cello-server to bring the copy up to date.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
client="$here"
server="${CELLO_SERVER_DIR:-$here/../cello-server}"
if [ ! -d "$server/src/protocol" ]; then
  echo "Protocol copy not checked: no cello-server beside this repo at $server." >&2
  exit 0
fi
if ! diff -r "$client/src/protocol" "$server/src/protocol" >/dev/null; then
  echo "The server's protocol copy differs from the client's. In cello-server, run scripts/sync-protocol.sh, then commit both." >&2
  exit 1
fi

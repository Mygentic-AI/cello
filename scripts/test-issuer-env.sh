# Sourced by live scripts, after `here` is set. Starts the stand-in issuer, and tells this run's servers and daemons about it.
# A server counts it the way it counts any issuer its operator added. It stops by itself when the script ends.
CELLO_ISSUER_DIR="${CELLO_ISSUER_DIR:-$here/../cello-issuer}"
export CELLO_ISSUER_DIR
if [ ! -f "$CELLO_ISSUER_DIR/src/server/trust/agent-request.ts" ]; then
  echo "No cello-issuer at $CELLO_ISSUER_DIR. Set CELLO_ISSUER_DIR, because the stand-in issuer reads requests with that repo's code." >&2
  exit 1
fi
CELLO_TRUSTED_ISSUERS=$(node "$here/live/issuer-service.ts" --print-trusted)
export CELLO_TRUSTED_ISSUERS
issuer_url_file=$(mktemp)
node "$here/live/issuer-service.ts" "$issuer_url_file" &
issuer_tries=0
until [ -s "$issuer_url_file" ]; do
  issuer_tries=$((issuer_tries + 1))
  if [ "$issuer_tries" -gt 120 ]; then echo "The stand-in issuer didn't start." >&2; exit 1; fi
  sleep 0.5
done
CELLO_TEST_ISSUER_URL=$(cat "$issuer_url_file")
export CELLO_TEST_ISSUER_URL
rm -f "$issuer_url_file"

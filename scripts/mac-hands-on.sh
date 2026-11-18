#!/bin/bash
# A throwaway CELLO for trying the Mac app by hand, on the owner's own screen: a server in Docker on its own project and
# port, a daemon from this checkout in its own CELLO_HOME, agents Ann and Rex, and Bob on a second daemon in a session
# with Ann. Nothing here reads or writes ~/.cello, talks to the running daemon, or opens the app: installing the app is
# the one printed command, run by a person when ready.
#
#   scripts/mac-hands-on.sh up [--route-only]   start it all (--route-only also gives Ann and Rex a Mac route with no app,
#                                               so notify queues; then don't run the printed install command)
#   scripts/mac-hands-on.sh ask <agent> [--choices "A|B|C"] [--kind request|message] [--session] "<text>"
#   scripts/mac-hands-on.sh inbox <agent>       what that agent got from its operator (reading it uses it up)
#   scripts/mac-hands-on.sh stop-daemon | start-daemon
#   scripts/mac-hands-on.sh down                stop what up started, and say what the test left on this Mac
#
# Needs Docker, ~/code/cello-server (only read, at commit 0527c0a) and ~/code/cello-issuer.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
run="$HOME/cello-live-runs/mac-hands-on"
home="$run/home"
bob_home="$run/bob-home"
server_copy="$run/server"
port="${HANDS_ON_PORT:-18990}"
server_repo="${CELLO_SERVER_REPO:-$HOME/code/cello-server}"
# The newest server commit whose src/protocol matches this branch.
server_commit="${HANDS_ON_SERVER_COMMIT:-0527c0a}"
export COMPOSE_PROJECT_NAME=cello-mac-hands-on
export CELLO_ISSUER_DIR="${CELLO_ISSUER_DIR:-$HOME/code/cello-issuer}"
app_path="$HOME/Applications/CELLO.app"
launch_file="$HOME/Library/Application Support/CELLO/launch.json"
bundle_id="com.celloprotocol.cello"

die() { echo "$*" >&2; exit 1; }

# Every cello command goes through here. CELLO_HOME is always set, and only to a folder of this run, so nothing can
# reach the owner's ~/.cello or the daemon behind it.
cello() {
  local at=$1 caller=$2
  shift 2
  case "$at" in "$run"/*) ;; *) die "Refusing to run cello with CELLO_HOME=$at: only folders under $run." ;; esac
  CELLO_HOME="$at" CELLO_CALLER="$caller" node "$here/src/cli.ts" "$@"
}

# The first agent on a home is enrolled at the stand-in issuer, as the live tests do it.
enrolling() {
  local at=$1
  shift
  case "$at" in "$run"/*) ;; *) die "Refusing CELLO_HOME=$at." ;; esac
  CELLO_HOME="$at" node "$here/live/enrolling-cli.ts" "$@"
}

field() { node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{let o=JSON.parse(s);for(const k of process.argv[1].split("."))o=o?.[k];process.stdout.write(o===undefined?"":String(o))})' "$1"; }

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# Kills a pid only if it is still the process this script started: its command line has to name the given path.
kill_ours() {
  local pid=$1 mark=$2
  alive "$pid" || return 0
  case "$(ps -o command= -p "$pid" 2>/dev/null)" in
    "") ;;
    *"$mark"*) kill "$pid" 2>/dev/null || true ;;
    *) echo "Left pid $pid alone: it isn't the process this script started any more." >&2 ;;
  esac
}

daemon_pid() { cello "$1" hands-on status 2>/dev/null | field pid || true; }

compose() {
  [ -f "$run/server.env" ] || die "No $run/server.env, so there is no server from up to talk to."
  # shellcheck disable=SC1091
  . "$run/server.env"
  export POSTGRES_PASSWORD CELLO_APP_PASSWORD CELLO_PORT CELLO_TRUSTED_ISSUERS CELLO_ISSUER_LIST_URL
  docker compose --project-directory "$server_copy" -f "$server_copy/docker-compose.yml" "$@"
}

up() {
  local route_only=""
  [ "${1:-}" = "--route-only" ] && route_only=1
  if [ -f "$run/pids" ]; then
    # shellcheck disable=SC1091
    . "$run/pids"
    if alive "${ann_daemon:-}" || alive "${bob_daemon:-}" || alive "${issuer:-}"; then die "It's already up. Run: scripts/mac-hands-on.sh down"; fi
  fi
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then die "Port $port is taken. Set HANDS_ON_PORT to a free one."; fi
  [ -f "$CELLO_ISSUER_DIR/src/server/trust/agent-request.ts" ] || die "No cello-issuer at $CELLO_ISSUER_DIR. Set CELLO_ISSUER_DIR."
  rm -rf "$home" "$bob_home" "$server_copy"
  mkdir -p "$run" "$server_copy"
  chmod 700 "$run"
  : > "$run/pids"

  # A CELLO app already open stays attached to whatever launch.json said when it opened, which may be the real ~/.cello:
  # the install wouldn't restart it, so taps during the test could answer real agents.
  if [ -z "$route_only" ] && pgrep -f "$app_path/Contents/MacOS/" >/dev/null 2>&1; then die "CELLO is open on this Mac. Quit it first (osascript -e 'quit app id \"$bundle_id\"'), then run up again."; fi
  # What the owner's Mac had before, so down can tell what the test added. A launch.json already there is copied, since
  # the install writes over it.
  { [ -e "$app_path" ] && echo "app_before=1" || echo "app_before="; [ -e "$launch_file" ] && echo "launch_before=1" || echo "launch_before="; } > "$run/before"
  if [ -e "$launch_file" ]; then cp -p "$launch_file" "$run/launch.json.before"; fi

  echo "Copying cello-server at $server_commit into $server_copy (the shared checkout isn't changed)."
  git -C "$server_repo" archive "$server_commit" | tar -x -C "$server_copy"
  diff -r "$here/src/protocol" "$server_copy/src/protocol" >/dev/null || die "The server copy's src/protocol differs from this branch's. Set HANDS_ON_SERVER_COMMIT to a matching commit."

  # The stand-in issuer, kept alive by a shell that waits on it: it stops when its parent does.
  local url_file="$run/issuer.url"
  rm -f "$url_file"
  nohup sh -c 'node "$1" "$2" & echo "$!" > "$3"; wait' sh "$here/live/issuer-service.ts" "$url_file" "$run/issuer.pid" > "$run/issuer.log" 2>&1 &
  echo "issuer_shell=$!" >> "$run/pids"
  local tries=0
  until [ -s "$url_file" ]; do
    tries=$((tries + 1))
    [ "$tries" -gt 120 ] && die "The stand-in issuer didn't start. See $run/issuer.log."
    sleep 0.5
  done
  echo "issuer=$(cat "$run/issuer.pid")" >> "$run/pids"
  export CELLO_TEST_ISSUER_URL
  CELLO_TEST_ISSUER_URL=$(cat "$url_file")

  # Each on its own line, so a failure stops up here rather than as a refused enrolment or an empty password later.
  local trusted pg_pass app_pass
  trusted=$(node "$here/live/issuer-service.ts" --print-trusted)
  pg_pass=$(openssl rand -hex 16)
  app_pass=$(openssl rand -hex 16)
  [ -n "$trusted" ] && [ -n "$pg_pass" ] && [ -n "$app_pass" ] || die "Couldn't get the stand-in issuer's keys or make the database passwords."
  {
    echo "POSTGRES_PASSWORD=$pg_pass"
    echo "CELLO_APP_PASSWORD=$app_pass"
    echo "CELLO_PORT=$port"
    echo "CELLO_TRUSTED_ISSUERS='$trusted'"
    echo "CELLO_ISSUER_LIST_URL=off"
  } > "$run/server.env"
  chmod 600 "$run/server.env"

  # Builds running at once have frozen this machine, so the build takes the shared lock the live tests use.
  local lock="$HOME/cello-live-runs/.heavy-lock" waited=0
  until mkdir "$lock" 2>/dev/null; do
    waited=$((waited + 5))
    [ "$waited" -ge 900 ] && die "Another run held the build lock for 15 minutes."
    sleep 5
  done
  # Held, it's freed on any exit, Ctrl-C included: a leaked lock makes every later live run wait 15 minutes and stop.
  trap 'rmdir "$HOME/cello-live-runs/.heavy-lock" 2>/dev/null' EXIT
  trap 'exit 130' INT TERM
  echo "Building and starting the server on port $port (project $COMPOSE_PROJECT_NAME)."
  if ! compose up -d --build --wait server > "$run/docker-up.log" 2>&1; then
    tail -30 "$run/docker-up.log" >&2
    die "The server didn't start."
  fi
  rmdir "$lock"
  trap - EXIT INT TERM
  local url="ws://127.0.0.1:$port/v1"

  local out
  out=$(cello "$home" hands-on login --server "$url")
  echo "$out"
  echo "ann_daemon=$(daemon_pid "$home")" >> "$run/pids"
  local ann rex
  ann=$(enrolling "$home" create-agent Ann | field agent_id)
  rex=$(cello "$home" rex-shell create-agent Rex | field agent_id)
  [ -n "$ann" ] && [ -n "$rex" ] || die "Making Ann or Rex failed."

  out=$(cello "$bob_home" hands-on login --server "$url")
  echo "$out"
  echo "bob_daemon=$(daemon_pid "$bob_home")" >> "$run/pids"
  local bob
  # An agent name is letters, digits, _ or -, so Bob, with Ann's own name for him, Bob_Lee.
  bob=$(enrolling "$bob_home" create-agent Bob | field agent_id)
  [ -n "$bob" ] || die "Making Bob failed."

  for name in Ann Rex; do cello "$home" "$(echo "$name" | tr '[:upper:]' '[:lower:]')-shell" settings-set away.answering false --agent "$name" > /dev/null; done
  cello "$bob_home" bob-shell settings-set away.answering false --agent Bob > /dev/null
  local n=0
  until [ "$(cello "$home" hands-on status | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{process.stdout.write(String(JSON.parse(s).agents.every((a)=>a.online)))})')" = true ]; do
    n=$((n + 1)); [ "$n" -gt 60 ] && die "Ann and Rex didn't come online."; sleep 0.5
  done

  cello "$home" ann-shell contact-add "$bob" --moniker Bob_Lee --agent Ann > /dev/null
  cello "$bob_home" bob-shell contact-add "$ann" --moniker Ann --agent Bob > /dev/null
  local started session
  started=$(cello "$home" ann-shell initiate-session "$bob" --agent Ann)
  session=$(echo "$started" | field session_id)
  [ -n "$session" ] || die "Ann couldn't open a session with Bob: $started"
  echo "$session" > "$run/session"
  cello "$bob_home" bob-shell send "$session" "Hi Ann, Bob here. Thursday at 3 works for me." --over --agent Bob > /dev/null

  if [ -n "$route_only" ]; then
    cello "$home" ann-shell notifier-add mac --route-only --agent Ann > /dev/null
    cello "$home" rex-shell notifier-add mac --same-as Ann --agent Rex > /dev/null
  fi
  {
    echo "ann_id=$ann"; echo "rex_id=$rex"; echo "bob_id=$bob"
  } >> "$run/pids"

  cat <<EOF

Up. Server: $url (Docker project $COMPOSE_PROJECT_NAME). Ann's session with Bob: $session ($(echo "$started" | field state)).
CELLO_HOME=$home
Bob's home: $bob_home

EOF
  if [ -n "$route_only" ]; then
    echo "Ann and Rex already have a Mac route with no app, so notify says queued. Don't run the install command on this run."
  else
    cat <<EOF
To put the app on this Mac against this throwaway CELLO, from $here:
  CELLO_HOME=$home node src/cli.ts notifier-add mac --app widgets/mac/build/CELLO.app --agent Ann
  CELLO_HOME=$home node src/cli.ts notifier-add mac --same-as Ann --agent Rex
EOF
    if [ -s "$run/before" ] && grep -q '=1' "$run/before"; then
      echo
      echo "Warning: this Mac already has $( grep -q 'app_before=1' "$run/before" && echo "$app_path ")$( grep -q 'launch_before=1' "$run/before" && echo "and $launch_file")."
      echo "The install replaces them, pointing the app at the throwaway CELLO."
      if [ -f "$run/launch.json.before" ]; then echo "The old launch.json is saved at $run/launch.json.before, and down prints how to put it back."; fi
    fi
  fi
}

ask() {
  [ $# -ge 2 ] || die 'Usage: ask <agent> [--choices "A|B|C"] [--kind request|message] [--session] "<text>"'
  local agent=$1
  shift
  local args=()
  while [ $# -gt 1 ]; do
    case "$1" in
      --choices|--kind) args+=("$1" "$2"); shift 2 ;;
      --session)
        [ "$agent" = Ann ] || die "--session is Ann's session with Bob, so it goes with Ann."
        args+=(--session-id "$(cat "$run/session")"); shift ;;
      *) die "Unknown option $1. The text goes last." ;;
    esac
  done
  [ $# -eq 1 ] || die "The text goes last, as one argument."
  cello "$home" "$(echo "$agent" | tr '[:upper:]' '[:lower:]')-shell" notify "$1" "${args[@]+"${args[@]}"}" --agent "$agent"
}

inbox() {
  [ $# -eq 1 ] || die "Usage: inbox <agent>"
  local read
  read=$(cello "$home" "$(echo "$1" | tr '[:upper:]' '[:lower:]')-shell" receive --agent "$1")
  # Reading uses it up, so every read is kept here too.
  { date -u +%FT%TZ; echo "$read"; } >> "$run/inbox.log"
  echo "$read" | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const o=JSON.parse(s);const r=o.from_your_operator?.replies??[];console.log(r.length?JSON.stringify({from_your_operator:o.from_your_operator},null,2):"Nothing from your operator.");console.log(`Also: ${(o.messages??[]).length} message(s), ${(o.notices??[]).length} notice(s). The whole read is in the inbox log.`);for(const n of o.notices??[])console.log(`Notice: ${n.text}`)})'
  echo "Inbox log: $run/inbox.log"
}

stop_daemon() {
  local pid
  pid=$(daemon_pid "$home")
  [ -n "$pid" ] || { echo "The throwaway daemon isn't running."; return 0; }
  cello "$home" hands-on logout
  local n=0
  while alive "$pid"; do n=$((n + 1)); [ "$n" -gt 40 ] && die "Daemon $pid didn't stop."; sleep 0.25; done
  echo "Stopped the throwaway daemon, process $pid."
}

start_daemon() {
  # Exactly what launch.json has the app run: login, with no --server, since the server is kept in the database.
  cello "$home" hands-on login
  local pid
  pid=$(daemon_pid "$home")
  sed -i '' "s/^ann_daemon=.*/ann_daemon=$pid/" "$run/pids"
}

down() {
  [ -d "$run" ] || die "Nothing at $run, so nothing is up."
  local ann_daemon="" bob_daemon="" issuer="" issuer_shell=""
  # shellcheck disable=SC1091
  [ -f "$run/pids" ] && . "$run/pids"
  for at in "$home" "$bob_home"; do
    local pid
    pid=$(daemon_pid "$at")
    if [ -n "$pid" ]; then
      cello "$at" hands-on logout > /dev/null || true
      local n=0
      while alive "$pid" && [ "$n" -lt 40 ]; do n=$((n + 1)); sleep 0.25; done
      echo "Stopped the daemon for $at (process $pid)."
    fi
  done
  # A recorded daemon that somehow outlived logout, only if it still runs this checkout's daemon.
  for pid in "$ann_daemon" "$bob_daemon"; do kill_ours "$pid" "$here/src/daemon/main.ts"; done
  # The waiting shell first: killed second, it would already be exiting on its own when checked.
  kill_ours "$issuer_shell" "issuer-service.ts"
  kill_ours "$issuer" "issuer-service.ts"
  if [ -f "$run/server.env" ] && [ -d "$server_copy" ]; then
    compose down -v --remove-orphans --rmi local > "$run/docker-down.log" 2>&1 || { tail -20 "$run/docker-down.log" >&2; echo "docker compose down failed; see $run/docker-down.log." >&2; }
    echo "Removed the Docker project $COMPOSE_PROJECT_NAME, its volumes and its images."
  fi
  rm -f "$run/pids"
  echo "The run folder stays for its logs: $run. Remove it with: rm -rf $run"
  echo

  local app_before="" launch_before=""
  # shellcheck disable=SC1091
  [ -f "$run/before" ] && . "$run/before"
  local left=""
  if [ -e "$app_path" ]; then
    left=1
    echo "This Mac still has $app_path${app_before:+ (it was there before the test, too)}."
  fi
  if [ -e "$launch_file" ]; then
    left=1
    local points
    points=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).cello_home??""))}catch{}' "$launch_file")
    echo "This Mac still has $launch_file, pointing at ${points:-an unknown folder}${launch_before:+ (one was there before the test, too)}."
  fi
  if [ -z "$left" ]; then
    echo "Nothing from the test is in ~/Applications or ~/Library/Application Support/CELLO."
    echo "If the app was ever opened, check System Settings > General > Login Items and > Notifications for CELLO."
    return 0
  fi
  cat <<EOF

To remove what the test left, in this order (nothing here was run):
  1. In CELLO's Settings, untick "Open CELLO when I log in", then quit it. Or:
       osascript -e 'quit app id "$bundle_id"'
     and remove CELLO in System Settings > General > Login Items.
  2. rm -rf "$app_path"
  3. defaults delete $bundle_id
  4. rm "$launch_file"
     Last, because an app with no launch.json falls back to your real ~/.cello.
  5. Optional: System Settings > Notifications > CELLO, to forget its permission.
EOF
  if [ -n "$launch_before" ] && [ -f "$run/launch.json.before" ]; then
    echo "launch.json was there before the test. Instead of step 4, put the old one back:"
    echo "  cp -p \"$run/launch.json.before\" \"$launch_file\""
  fi
}

command=${1:-}
[ $# -gt 0 ] && shift
case "$command" in
  up) up "$@" ;;
  ask) ask "$@" ;;
  inbox) inbox "$@" ;;
  stop-daemon) stop_daemon ;;
  start-daemon) start_daemon ;;
  down) down ;;
  *) die "Usage: scripts/mac-hands-on.sh up [--route-only] | ask <agent> ... | inbox <agent> | stop-daemon | start-daemon | down" ;;
esac

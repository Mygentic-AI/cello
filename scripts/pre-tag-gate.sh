#!/usr/bin/env bash
# PRE-TAG GATE: run before any release tag, on the exact commit you will tag. Modelled on cello-client's.
#
# Runs what the publish workflow runs: install, build, typecheck, lint, the whole test suite, and the release check that refuses
# an empty shipped issuer list or an empty Concierge address. Records the commit only if every step passes, in
# ~/.cache/.cello-v2-pre-tag-gate. Tag that commit and no other: any later commit needs the gate again.
# (The publish guard hook only reads cello-client's marker today. Extending it to this one is a separate change.)
#
# Usage: scripts/pre-tag-gate.sh
set -euo pipefail
cd "$(dirname "$0")/.."
marker="$HOME/.cache/.cello-v2-pre-tag-gate"
rm -f "$marker"

# Untracked files count: tsc and the tests read them, and the tag doesn't carry them.
dirty="$(git status --porcelain)"
if [ -n "$dirty" ]; then
  echo "PRE-TAG GATE: FAILED, the working tree isn't clean, so what gets tested isn't what gets tagged:" >&2
  echo "$dirty" >&2
  exit 1
fi

sha="$(git rev-parse HEAD)"
version="$(node -p "require('./package.json').version")"
echo "PRE-TAG GATE: testing $sha, version $version"
if [ "$(node -p "require('./package.json').private === true")" = "true" ]; then echo "PRE-TAG GATE: FAILED, package.json says private: true." >&2; exit 1; fi
latest="$(npm view @cello-protocol/cli versions --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d);console.log((Array.isArray(v)?v:[v]).includes(process.argv[1])?'taken':'free')}catch{console.log('free')}})" "$version")"
if [ "$latest" = "taken" ]; then echo "PRE-TAG GATE: FAILED, @cello-protocol/cli@$version is already on npm. A version is never reused." >&2; exit 1; fi

step() { echo; echo "-- $1"; shift; "$@" || { echo "PRE-TAG GATE: FAILED at '$*' on $sha. Nothing recorded." >&2; exit 1; }; }
step "install (frozen lockfile, as CI)" pnpm install --frozen-lockfile
step "release check: shipped list and Concierge address" node tools/check-release.ts
step "build" pnpm run build
step "typecheck" pnpm run typecheck
step "lint" pnpm run lint
step "test, the whole suite" pnpm run test

if [ -n "$(git status --porcelain)" ] || [ "$(git rev-parse HEAD)" != "$sha" ]; then
  echo "PRE-TAG GATE: FAILED, the tree or HEAD changed while the gate ran. Nothing recorded." >&2
  exit 1
fi
mkdir -p "$(dirname "$marker")"
printf '%s\n' "$sha" > "$marker"
echo
echo "PRE-TAG GATE: PASSED on $sha. Tag it as v$version."

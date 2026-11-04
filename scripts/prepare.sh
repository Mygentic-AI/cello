#!/bin/sh
# Sets this repo's commit hook, and only when this folder is the top of its own git checkout.
# Anywhere else, such as a package inside someone else's repo, it must not touch their git settings.
here=$(cd "$(dirname "$0")/.." && pwd -P)
top=$(git -C "$here" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ "$top" = "$here" ] || exit 0
exec git -C "$here" config core.hooksPath .githooks

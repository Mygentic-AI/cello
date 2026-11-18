#!/bin/sh
# Builds cello-door-probe, which drives the app's Controller against a real operator's door with nothing on screen, for
# live/mac-app.live.ts. Like assemble.sh it calls swiftc directly, so the command-line tools are enough.
#   widgets/mac/scripts/build-probe.sh <out folder>
# Prints the path of the probe, last.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out="${1:?usage: build-probe.sh <out folder>}"
mkdir -p "$out"
xcrun swiftc -swift-version 5 -module-name CELLOCore -parse-as-library -emit-module -emit-module-path "$out/CELLOCore.swiftmodule" \
  -emit-library -static -o "$out/libCELLOCore.a" "$here"/Sources/CELLOCore/*.swift
xcrun swiftc -swift-version 5 -module-name cello_door_probe -I "$out" -L "$out" -lCELLOCore -o "$out/cello-door-probe" \
  "$here"/Sources/cello-door-probe/main.swift
echo "$out/cello-door-probe"

#!/bin/sh
# Builds the app into this folder before packing, so what's packed can't be an old build, and refuses to pack one that
# isn't whole: both architectures, signed, and the version this package publishes.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ "$(uname -s)" != "Darwin" ]; then
  echo "The CELLO app can only be built on a Mac, so this package can't be packed here." >&2
  exit 1
fi
sh "$here/../widgets/mac/scripts/assemble.sh" "$here" >/dev/null
app="$here/CELLO.app"
archs=$(xcrun lipo -archs "$app/Contents/MacOS/CELLO")
case " $archs " in *" arm64 "*) ;; *) echo "The app has no Apple silicon binary (it has: $archs)." >&2; exit 1 ;; esac
case " $archs " in *" x86_64 "*) ;; *) echo "The app has no Intel binary (it has: $archs)." >&2; exit 1 ;; esac
codesign --verify --strict "$app"
want=$(node -p "require('$here/package.json').version")
got=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
if [ "$got" != "$want" ]; then
  echo "The app says version $got, but this package is $want. Bump both with the cli's version." >&2
  exit 1
fi
echo "Built $app ($archs, signed ad hoc, version $got)" >&2

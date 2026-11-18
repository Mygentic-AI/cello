#!/bin/sh
# Checks a packed @cello-protocol/mac-app before it's published, and the one npm serves after: exactly the app, its README
# and manifest; the binary executable, for both architectures, and the bundle's ad-hoc signature intact; no install script.
#   mac-app/check-tarball.sh <tarball>
set -eu
tarball="${1:?usage: check-tarball.sh <tarball>}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

expected="package/CELLO.app/Contents/Info.plist
package/CELLO.app/Contents/MacOS/CELLO
package/CELLO.app/Contents/Resources/CELLO.icns
package/CELLO.app/Contents/Resources/menubar-mark.png
package/CELLO.app/Contents/Resources/menubar-mark@2x.png
package/CELLO.app/Contents/_CodeSignature/CodeResources
package/README.md
package/package.json"
listing=$(tar tzf "$tarball" | LC_ALL=C sort)
[ "$listing" = "$(printf '%s\n' "$expected" | LC_ALL=C sort)" ] || fail "the tarball doesn't hold exactly the app, README and manifest. It holds:
$listing"

# npm and pnpm extract with the modes the tarball carries, and a binary without its exec bit won't start.
mode=$(tar tvzf "$tarball" package/CELLO.app/Contents/MacOS/CELLO | cut -c1-10)
[ "$mode" = "-rwxr-xr-x" ] || fail "Contents/MacOS/CELLO is packed as $mode, not executable, so macOS wouldn't open the app."

tar xzf "$tarball" -C "$work"
app="$work/package/CELLO.app"
codesign --verify --strict "$app" || fail "the app's signature doesn't verify after packing."
archs=$(xcrun lipo -archs "$app/Contents/MacOS/CELLO")
case " $archs " in *" arm64 "*) ;; *) fail "no Apple silicon binary (it has: $archs)." ;; esac
case " $archs " in *" x86_64 "*) ;; *) fail "no Intel binary (it has: $archs)." ;; esac
hooks=$(node -p "Object.keys(require('$work/package/package.json').scripts ?? {}).filter((s) => /install|prepare/.test(s)).join(' ')")
[ -z "$hooks" ] || fail "the manifest has install scripts: $hooks."
echo "OK: $(basename "$tarball"): the app ($archs), executable and signed, and nothing else."

#!/bin/sh
# Builds CELLO.app: one binary for Apple silicon and Intel, the CELLO icon, signed ad hoc. It calls swiftc directly, one
# architecture at a time, and joins them with lipo, so the Xcode command-line tools are enough: no Xcode, no SwiftPM.
#   widgets/mac/scripts/assemble.sh [<out folder>]     (default: widgets/mac/build)
# Prints the path of the app it made, last.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out="${1:-$here/build}"
work="$out/work"
app="$out/CELLO.app"
target_os=14.0

if ! xcrun --find swiftc >/dev/null 2>&1 || ! xcrun --find lipo >/dev/null 2>&1; then
  echo "The Xcode command-line tools aren't installed, so CELLO can't be built here. Run: xcode-select --install" >&2
  exit 69
fi

# The app's version is the cello package's, since the two speak one protocol.
version=$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$here/../../package.json" | head -1)
[ -n "$version" ] || { echo "No version in $here/../../package.json." >&2; exit 1; }

rm -rf "$work" "$app"
mkdir -p "$work"
for arch in arm64 x86_64; do
  dir="$work/$arch"
  mkdir -p "$dir"
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos$target_os" -module-name CELLOCore -parse-as-library \
    -emit-module -emit-module-path "$dir/CELLOCore.swiftmodule" -emit-library -static -o "$dir/libCELLOCore.a" \
    "$here"/Sources/CELLOCore/*.swift
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos$target_os" -module-name CELLO \
    -I "$dir" -L "$dir" -lCELLOCore -o "$dir/CELLO" "$here"/Sources/CELLO/*.swift
done
xcrun lipo -create "$work/arm64/CELLO" "$work/x86_64/CELLO" -output "$work/CELLO"

xcrun swiftc -O -o "$work/render-icons" "$here/scripts/render-icons.swift"
"$work/render-icons" "$here/Resources/cello-mark.svg" "$here/Resources/cello-tile.svg" "$work"

mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$work/CELLO" "$app/Contents/MacOS/CELLO"
cp "$work/menubar-mark.png" "$work/menubar-mark@2x.png" "$app/Contents/Resources/"
xcrun iconutil -c icns "$work/CELLO.iconset" -o "$app/Contents/Resources/CELLO.icns"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>ai.mygentic.cello</string>
  <key>CFBundleName</key><string>CELLO</string>
  <key>CFBundleDisplayName</key><string>CELLO</string>
  <key>CFBundleExecutable</key><string>CELLO</string>
  <key>CFBundleIconFile</key><string>CELLO</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>$target_os</string>
  <key>LSUIElement</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
codesign --force --sign - "$app"
codesign --verify --strict "$app"
rm -rf "$work"
echo "$app"

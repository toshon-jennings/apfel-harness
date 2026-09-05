#!/bin/bash
# Build ApfelHarnessMenu.app (zero-dependency Swift, AppKit only).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/ApfelHarnessMenu.app"
CONTENTS="$APP/Contents"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
swiftc -O -o "$CONTENTS/MacOS/ApfelHarnessMenu" "$HERE/ApfelHarnessMenu.swift"
cp "$HERE/Info.plist" "$CONTENTS/Info.plist"
echo "Built: $APP"

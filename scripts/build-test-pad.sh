#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift scripts/verify-signing.swift "${PALM_MAC_SIGNING_IDENTITY:--}"
APP="build/Palm Test Pad.app"
mkdir -p "$APP/Contents/MacOS" .local
swiftc native/PalmTestPad.swift -o "$APP/Contents/MacOS/PalmTestPad" -framework Cocoa
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.palm.testpad</string><key>CFBundleName</key><string>Palm Test Pad</string><key>CFBundleExecutable</key><string>PalmTestPad</string><key>CFBundleVersion</key><string>1</string></dict></plist>
PLIST
codesign --force --sign "${PALM_MAC_SIGNING_IDENTITY:--}" "$APP" >/dev/null

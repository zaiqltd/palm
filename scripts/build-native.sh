#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP="build/Palm Companion.app"
PALM_SIGNING_IDENTITY="${PALM_MAC_SIGNING_IDENTITY:--}"
swift scripts/verify-signing.swift "$PALM_SIGNING_IDENTITY"
SIGN_OPTIONS=()
if [[ "$PALM_SIGNING_IDENTITY" != "-" ]]; then SIGN_OPTIONS=(--options runtime); fi
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# Palm's hand (scripts/render-brand.swift), shown in Privacy & Security lists.
cp native/Palm.icns "$APP/Contents/Resources/Palm.icns"
# Camera and mic audio runs on Google's WebRTC (scripts/fetch-webrtc.sh).
bash scripts/fetch-webrtc.sh
WEBRTC=vendor/WebRTC.xcframework/macos-x86_64_arm64
rm -rf "$APP/Contents/Frameworks"
mkdir -p "$APP/Contents/Frameworks"
cp -R "$WEBRTC/WebRTC.framework" "$APP/Contents/Frameworks/"
codesign --force --sign "$PALM_SIGNING_IDENTITY" ${SIGN_OPTIONS[@]+"${SIGN_OPTIONS[@]}"} "$APP/Contents/Frameworks/WebRTC.framework" >/dev/null
swiftc -swift-version 5 -O -parse-as-library native/PalmCompanion.swift native/PalmSystem.swift native/PalmMedia.swift native/PalmRTC.swift shared/PalmCall.swift shared/PalmRealtimeAudio.swift -o "$APP/Contents/MacOS/PalmCompanion" -F "$WEBRTC" -framework WebRTC -Xlinker -rpath -Xlinker @executable_path/../Frameworks -framework Cocoa -framework AVFoundation -framework ScreenCaptureKit -framework VideoToolbox -framework CoreMedia -framework CoreVideo
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.palm.companion</string>
<key>CFBundleName</key><string>Palm Companion</string>
<key>CFBundleDisplayName</key><string>Palm Companion</string>
<key>CFBundleExecutable</key><string>PalmCompanion</string>
<key>CFBundleIconFile</key><string>Palm</string>
<key>CFBundleVersion</key><string>15</string>
<key>CFBundleShortVersionString</key><string>0.4.0</string>
<key>LSMinimumSystemVersion</key><string>26.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Palm shows your chosen Mac screen or window on your paired phone.</string>
<key>NSCameraUsageDescription</key><string>Stream this Mac's camera to your paired phone while Camera and mic is open.</string>
<key>NSMicrophoneUsageDescription</key><string>Stream this Mac's microphone to your paired phone while Camera and mic is open.</string>
</dict></plist>
PLIST
codesign --force --sign "$PALM_SIGNING_IDENTITY" --identifier local.palm.companion \
  --entitlements native/PalmMedia.entitlements ${SIGN_OPTIONS[@]+"${SIGN_OPTIONS[@]}"} "$APP" >/dev/null
codesign --verify --strict "$APP"
mkdir -p build/bin
clang -O2 -Wall -o build/bin/palm-pty native/palm-pty.c
codesign --force --sign "$PALM_SIGNING_IDENTITY" --identifier local.palm.pty build/bin/palm-pty >/dev/null
echo "Built Palm Companion and terminal helper."

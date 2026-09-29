#!/bin/bash
# Builds, tests and installs the Palm iPhone app.
#
#   scripts/ios-build.sh simulator            Debug build for the Simulator
#   scripts/ios-build.sh test                 unit tests (set PALM_TEST_DESTINATION)
#   scripts/ios-build.sh device               Release build for a connected iPhone (PALM_DEVICE_ID)
#   scripts/ios-build.sh install              device build, then install on PALM_DEVICE_ID
#   scripts/ios-build.sh archive              Release archive (ios/Palm.xcarchive)
#   scripts/ios-build.sh export-appstore      archive exported for App Store Connect / TestFlight
#
# UI tests run through scripts/ios-ui-tests.mjs, which starts their isolated test host.
# App Store export needs a paid Apple Developer Program team (PALM_TEAM_ID); the
# free Personal Team can only install development builds that expire after 7 days.
set -euo pipefail
cd "$(dirname "$0")/.."
# xcodebuild needs Xcode itself, even when the shell selects the Command Line Tools.
if [[ -z "${DEVELOPER_DIR:-}" || "$DEVELOPER_DIR" == /Library/Developer/CommandLineTools ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
ACTION="${1:-simulator}"
DERIVED=.local/ios-derived-data
# SwiftTerm's package ships a build-information plugin; it only writes a version file.
COMMON=(-project ios/Palm.xcodeproj -scheme Palm -derivedDataPath "$DERIVED" -skipPackagePluginValidation)
# Your Apple team and a bundle id of your own (a bundle id belongs to one team).
if [[ -n "${PALM_TEAM_ID:-}" ]]; then COMMON+=(DEVELOPMENT_TEAM="$PALM_TEAM_ID"); fi
if [[ -n "${PALM_BUNDLE_ID:-}" ]]; then COMMON+=(PALM_BUNDLE_ID="$PALM_BUNDLE_ID"); fi
bash scripts/fetch-webrtc.sh
xcodegen generate --spec ios/project.yml --quiet
case "$ACTION" in
  simulator)
    # Simulator builds keep Xcode's normal local signature so Keychain access works.
    xcodebuild "${COMMON[@]}" -configuration Debug -destination 'generic/platform=iOS Simulator' build
    ;;
  test)
    : "${PALM_TEST_DESTINATION:?Set PALM_TEST_DESTINATION, e.g. platform=iOS Simulator,name=iPhone 17 Pro Max,OS=26.5}"
    xcodebuild "${COMMON[@]}" -configuration Debug -destination "$PALM_TEST_DESTINATION" \
      -only-testing:PalmTests test
    ;;
  device | install)
    : "${PALM_DEVICE_ID:?Set PALM_DEVICE_ID to your connected iPhone identifier (xcrun devicectl list devices)}"
    xcodebuild "${COMMON[@]}" -configuration Release -destination "platform=iOS,id=$PALM_DEVICE_ID" \
      -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
    if [[ "$ACTION" == install ]]; then
      xcrun devicectl device install app --device "$PALM_DEVICE_ID" "$DERIVED/Build/Products/Release-iphoneos/Palm.app"
    fi
    ;;
  archive)
    xcodebuild "${COMMON[@]}" -configuration Release -destination 'generic/platform=iOS' \
      -archivePath ios/Palm.xcarchive -allowProvisioningUpdates archive
    ;;
  export-appstore)
    : "${PALM_TEAM_ID:?Set PALM_TEAM_ID to a paid Apple Developer Program team ID}"
    xcodebuild "${COMMON[@]}" -configuration Release -destination 'generic/platform=iOS' \
      -archivePath ios/Palm.xcarchive DEVELOPMENT_TEAM="$PALM_TEAM_ID" -allowProvisioningUpdates archive
    OPTIONS=$(mktemp -t palm-export).plist
    cat > "$OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$PALM_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>destination</key><string>export</string>
</dict></plist>
PLIST
    xcodebuild -exportArchive -archivePath ios/Palm.xcarchive -exportPath build/ios-appstore \
      -exportOptionsPlist "$OPTIONS" -allowProvisioningUpdates
    echo "Exported to build/ios-appstore. Upload with Xcode Organizer or Transporter; nothing was uploaded."
    ;;
  *)
    echo 'Usage: scripts/ios-build.sh simulator|test|device|install|archive|export-appstore' >&2
    exit 2
    ;;
esac

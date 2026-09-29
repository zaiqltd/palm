#!/bin/bash
# Google's WebRTC (BSD licence, see vendor/WebRTC.xcframework/LICENSE), prebuilt
# for iPhone and Mac by github.com/stasel/WebRTC. Camera and mic audio runs on
# it (Opus over UDP, echo cancellation, jitter buffer). Not kept in git (97 MB).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=153.0.0
SHA256=3e3a8946f27510133e3feed04d05fa23505bbe366e977620503bfc7986c2b78f
[[ -d vendor/WebRTC.xcframework ]] && exit 0
mkdir -p vendor
curl -sSL -o vendor/WebRTC-M153.xcframework.zip \
  "https://github.com/stasel/WebRTC/releases/download/$VERSION/WebRTC-M153.xcframework.zip"
echo "$SHA256  vendor/WebRTC-M153.xcframework.zip" | shasum -a 256 -c -
(cd vendor && unzip -q WebRTC-M153.xcframework.zip)

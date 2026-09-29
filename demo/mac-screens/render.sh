#!/bin/bash
# Renders the sample Mac desktop for demo recordings: before.png and after.png
# at 2560×1600 (the test host's 1280×800 screen at 2×).
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
for state in before after; do
  query=""
  [[ "$state" == after ]] && query="?after"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1280,800 --screenshot="$PWD/$state.png" "file://$PWD/desktop.html$query" 2>/dev/null
done
ls -la before.png after.png

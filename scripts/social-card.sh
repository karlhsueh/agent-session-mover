#!/usr/bin/env bash
# Renders scripts/social-card.html to site/social-preview.png at 2x (2560x1280).
# Upload the result as the repo's social preview too: Settings, General, Social preview.
set -euo pipefail
cd "$(dirname "$0")/.."
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
"$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1280,640 --screenshot="$PWD/site/social-preview.png" "file://$PWD/scripts/social-card.html" 2>/dev/null
echo "Wrote site/social-preview.png"

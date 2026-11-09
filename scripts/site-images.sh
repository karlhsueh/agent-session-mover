#!/usr/bin/env bash
# Usage: scripts/site-images.sh
# Renders the app at 2x on the synthetic stores and writes the website and README images.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm build
AGENT_SESSIONS_SHOT_SCALE=2 node --disable-warning=ExperimentalWarning e2e/screens.mts site
AGENT_SESSIONS_SHOT_SCALE=2 node --disable-warning=ExperimentalWarning e2e/smoke.mts

cp artifacts/compare/site-default.png site/screenshot.png
cp artifacts/compare/site-default.png docs/assets/screenshot.png
# The import views, cropped to the panel. Offsets are in 2x pixels.
sips -c 1080 1960 --cropOffset 112 220 artifacts/import-preview-dark.png --out site/import-preview.png >/dev/null
sips -c 1080 1960 --cropOffset 112 220 artifacts/import-result-dark.png --out site/import-result.png >/dev/null

for image in site/screenshot.png site/import-preview.png site/import-result.png; do
  sips -g pixelWidth -g pixelHeight "$image" | awk -v f="$image" '/pixelWidth/ { w = $2 } /pixelHeight/ { print f ": " w "x" $2 }'
done

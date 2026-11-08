#!/bin/sh
# Renders build/icon.svg into build/icon.png and build/icon.icns. macOS only (sips, iconutil).
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d)
set=$work/icon.iconset
mkdir "$set"
sips -s format png -z 1024 1024 build/icon.svg --out build/icon.png >/dev/null
for size in 16 32 128 256 512; do
  sips -z $size $size build/icon.png --out "$set/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) build/icon.png --out "$set/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set" -o build/icon.icns
rm -r "$work"

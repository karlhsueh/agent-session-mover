#!/usr/bin/env bash
# Encodes the frames e2e/demo.mts saved into artifacts/demo/demo.mp4 and demo.gif, then copies the gif
# to the README assets and the mp4 to the website. Needs ffmpeg and gifski.
set -euo pipefail
cd "$(dirname "$0")/../artifacts/demo"
for tool in ffmpeg gifski; do
  command -v "$tool" > /dev/null || { echo "Install $tool first: brew install $tool" >&2; exit 1; }
done
ffmpeg -y -loglevel error -f concat -safe 0 -i frames.txt -vf "fps=30,format=yuv420p" -c:v libx264 -crf 18 -preset slow -movflags +faststart demo.mp4
gif_frames="$(mktemp -d)"
trap 'rm -rf "$gif_frames"' EXIT
ffmpeg -loglevel error -i demo.mp4 -vf "fps=15,scale=1200:-1:flags=lanczos" "$gif_frames/%05d.png"
gifski --quiet --fps 15 --quality 90 --output demo.gif "$gif_frames"/*.png
cp demo.gif ../../docs/assets/demo.gif
cp demo.mp4 ../../site/demo.mp4
ls -lh demo.mp4 demo.gif

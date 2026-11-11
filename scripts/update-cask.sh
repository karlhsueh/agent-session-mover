#!/usr/bin/env bash
# Usage: scripts/update-cask.sh <version> <SHA256SUMS path> <cask path>
# Writes packaging/homebrew/agent-session-mover.rb to <cask path> with the version and both dmg hashes filled in.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <version> <SHA256SUMS path> <cask path>" >&2
  exit 2
fi

version="${1#v}"
sums="$2"
cask="$3"
template="$(dirname "$0")/../packaging/homebrew/agent-session-mover.rb"

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]]; then
  echo "error: '$1' is not a version like 1.2.3" >&2
  exit 1
fi

hash_for() {
  local hash
  hash="$(awk -v f="$1" '{ name = $2; sub(/^\*/, "", name) } name == f { print $1 }' "$sums")"
  if [[ ! "$hash" =~ ^[0-9a-f]{64}$ ]]; then
    echo "error: no single SHA-256 for $1 in $sums" >&2
    exit 1
  fi
  printf '%s' "$hash"
}

arm="$(hash_for agent-session-mover-mac-arm64.dmg)"
intel="$(hash_for agent-session-mover-mac-x64.dmg)"

rendered="$(sed -E \
  -e "s/^( *version )\"[^\"]*\"/\\1\"$version\"/" \
  -e "s/^( *sha256 arm: +)\"[0-9a-f]{64}\"/\\1\"$arm\"/" \
  -e "s/^( +intel: +)\"[0-9a-f]{64}\"/\\1\"$intel\"/" \
  "$template")"

for expected in "version \"$version\"" "arm:   \"$arm\"" "intel: \"$intel\""; do
  if ! grep -qF "$expected" <<<"$rendered"; then
    echo "error: $template has no line to take $expected" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$cask")"
printf '%s\n' "$rendered" > "$cask"
echo "Wrote $cask for $version"
echo "  arm64: $arm"
echo "  x64:   $intel"

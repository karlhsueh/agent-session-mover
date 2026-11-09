#!/usr/bin/env bash
# Usage: scripts/update-cask.sh <version> <SHA256SUMS path> [cask path]
# Writes the version and the Apple silicon dmg hash into a Homebrew cask.
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <version> <SHA256SUMS path> [cask path]" >&2
  exit 2
fi

version="${1#v}"
sums="$2"
cask="${3:-$(dirname "$0")/../packaging/homebrew/agent-sessions.rb}"

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

sha="$(hash_for agent-sessions-mac-arm64.dmg)"

tmp="$(mktemp "${cask}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
sed -E \
  -e "s/^( *version )\"[^\"]*\"/\\1\"$version\"/" \
  -e "s/^( *sha256 )\"[0-9a-f]{64}\"/\\1\"$sha\"/" \
  "$cask" > "$tmp"

for expected in "version \"$version\"" "\"$sha\""; do
  if ! grep -qF "$expected" "$tmp"; then
    echo "error: $cask has no line to take $expected" >&2
    exit 1
  fi
done

cat "$tmp" > "$cask"
echo "Updated $cask to $version"
echo "  sha256: $sha"

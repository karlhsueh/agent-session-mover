#!/usr/bin/env bash
# Drafts release notes from the feat, fix, and perf commits between the previous tag and this one.
# Usage: scripts/release-notes.sh v0.1.8 [previous-tag]
set -euo pipefail
tag="$1"
previous="${2:-$(git describe --tags --abbrev=0 "$tag^" 2>/dev/null || true)}"
range="${previous:+$previous..}$tag"
repo="${GITHUB_REPOSITORY:-karlhsueh/agent-session-mover}"

# Scopes that change the website or the demo, not the app people install.
SKIP_SCOPES='site|demo'

section() {
  local title="$1" pattern="$2" lines
  # Subjects look like `feat(scope): text`. The note keeps the text and capitalizes it.
  lines="$(git log --no-merges --format='%s' "$range" | grep -vE "^[a-z]+\(($SKIP_SCOPES)\)" |
    sed -nE "s/^($pattern)(\([^)]*\))?!?: (.*)$/\3/p" | awk '{ print "- " toupper(substr($0, 1, 1)) substr($0, 2) "." }' || true)"
  if [[ -n "$lines" ]]; then
    printf '## %s\n\n%s\n\n' "$title" "$lines"
  fi
}

notes="$(section 'New' 'feat'; section 'Fixes' 'fix|perf'; echo x)"
notes="${notes%x}"
if [[ -z "$notes" ]]; then
  notes=$'No changes to the app. This release updates docs or the build.\n\n'
fi
printf '%s' "$notes"
if [[ -n "$previous" ]]; then
  printf 'Every commit: https://github.com/%s/compare/%s...%s\n' "$repo" "$previous" "$tag"
fi

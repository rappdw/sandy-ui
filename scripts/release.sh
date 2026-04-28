#!/usr/bin/env bash
# Cuts a GitHub release for the current package.json version.
#
# Uses docs/releases/v<version>.md as the release body if present (preferred
# — curated highlights), falls back to gh's --generate-notes otherwise (commit
# changelog, useful for point releases that don't warrant hand-written notes).
#
# Run via `npm run release`. Requires gh CLI authenticated for this repo and a
# sandy-ui-<version>.vsix already built (which `npm run release` does first).

set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
VSIX="sandy-ui-${VERSION}.vsix"
NOTES_FILE="docs/releases/${TAG}.md"

if [[ ! -f "$VSIX" ]]; then
  echo "release.sh: missing $VSIX (run \`npm run package-vsix\` first)" >&2
  exit 1
fi

if [[ -f "$NOTES_FILE" ]]; then
  echo "release.sh: using curated notes from $NOTES_FILE"
  gh release create "$TAG" "$VSIX" --title "$TAG" --notes-file "$NOTES_FILE"
else
  echo "release.sh: no $NOTES_FILE found, falling back to --generate-notes"
  gh release create "$TAG" "$VSIX" --title "$TAG" --generate-notes
fi

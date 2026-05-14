#!/usr/bin/env bash
# Pull latest, rebuild, and reinstall sandy-ui into the real VSCode.
#
# Usage:
#   scripts/reinstall.sh              # pull + build + install
#   scripts/reinstall.sh --clean      # also uninstall first (clears VSCode cache —
#                                     # use when changes don't seem to apply, e.g.
#                                     # webview bundle appears stale)
#   scripts/reinstall.sh --no-pull    # skip git pull (use to reinstall current HEAD
#                                     # without fetching remote)
#
# After this completes, you still need to reload VSCode:
#   Cmd+Shift+P → "Developer: Reload Window"

set -euo pipefail

CLEAN=false
PULL=true
for arg in "$@"; do
    case "$arg" in
        --clean)    CLEAN=true ;;
        --no-pull)  PULL=false ;;
        -h|--help)
            sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown arg: $arg" >&2
            echo "Run with --help for usage." >&2
            exit 1
            ;;
    esac
done

cd "$(dirname "$0")/.."

if [ "$PULL" = true ]; then
    echo "==> git pull"
    git pull --ff-only
fi

if [ "$CLEAN" = true ]; then
    echo "==> Uninstalling existing extension to clear VSCode cache"
    code --uninstall-extension rappdw.sandy-ui || true
fi

echo "==> npm run install-vsix (compile + package + install)"
npm run install-vsix

echo
echo "==> Done. Reload VSCode: Cmd+Shift+P → 'Developer: Reload Window'"

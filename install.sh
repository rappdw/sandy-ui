#!/usr/bin/env bash
# Install or upgrade sandy-ui into your real VSCode.
#
# Safe to run repeatedly. First run does the full setup (deps + native
# node-pty rebuild against VSCode's Electron); later runs pull the latest
# changes and reinstall. Every step is idempotent.
#
# Usage:
#   ./install.sh              # pull (if a tracking remote exists) + build + install
#   ./install.sh --no-pull    # build + install the current checkout, don't fetch
#   ./install.sh --clean      # uninstall first to clear VSCode's cached webview
#                             # bundle (use when changes don't seem to apply)
#
# After this completes, reload VSCode to pick up the new build:
#   Cmd+Shift+P -> "Developer: Reload Window"

set -euo pipefail

CLEAN=false
PULL=true
for arg in "$@"; do
    case "$arg" in
        --clean)   CLEAN=true ;;
        --no-pull) PULL=false ;;
        -h|--help)
            sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown arg: $arg" >&2
            echo "Run with --help for usage." >&2
            exit 1
            ;;
    esac
done

cd "$(dirname "$0")"

if ! command -v code >/dev/null 2>&1; then
    echo "error: the 'code' CLI is not on PATH." >&2
    echo "  In VSCode: Cmd+Shift+P -> 'Shell Command: Install code command in PATH'" >&2
    exit 1
fi

# --- Pull latest (upgrade path) -------------------------------------------
# Only when on a branch that tracks an upstream; a detached HEAD or a fresh
# clone with no remote shouldn't abort the install.
if [ "$PULL" = true ]; then
    if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
        echo "==> git pull --ff-only"
        git pull --ff-only
    else
        echo "==> no upstream branch tracked; skipping git pull"
    fi
fi

# --- Dependencies ----------------------------------------------------------
# npm install is idempotent and also runs node-pty's native build. On a fresh
# clone this is the heavy step; on an upgrade it's a near-no-op unless
# package-lock.json changed.
echo "==> npm install"
npm install

# --- node-pty ABI fix ------------------------------------------------------
# npm install builds node-pty against system Node; VSCode runs Electron with a
# different ABI. Rebuilding against Electron prevents the 'posix_spawnp failed.'
# symptom at launch. Cheap to re-run; safe every time.
echo "==> electron-rebuild node-pty (match VSCode's Electron ABI)"
npx electron-rebuild -f -w node-pty

# --- Optional clean --------------------------------------------------------
if [ "$CLEAN" = true ]; then
    echo "==> Uninstalling existing extension to clear VSCode cache"
    code --uninstall-extension rappdw.sandy-ui || true
fi

# --- Build + install -------------------------------------------------------
# install-vsix runs the full compile pipeline, packages the .vsix, and
# installs it with --force (overwriting any prior version).
echo "==> npm run install-vsix (compile + package + install)"
npm run install-vsix

echo
echo "==> Done. Reload VSCode to apply: Cmd+Shift+P -> 'Developer: Reload Window'"

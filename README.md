# sandy-ui

VSCode extension that wraps the [sandy](https://github.com/rappdw/sandy) CLI — runs sandy as a webview-hosted terminal in the editor area, with schema-driven settings and pre-flight approval modals.

> **Status**: 0.6.0, dogfooding for the author. Not yet on Marketplace / OpenVSX. Public distribution is gated on node-pty packaging (macOS TCC was reassessed down from blocker to onboarding note) — see [SPEC_SANDY_UI.md](SPEC_SANDY_UI.md) and [docs/SPIKE_RESULTS.md](docs/SPIKE_RESULTS.md) for the production roadmap.

## What it gives you

- **Sandy in an editor tab**, not a bottom-panel terminal — full editor real estate, can split alongside source files.
- **VSCode IDE chrome around the session**: Source Control, diff viewer, file tree decorations, GitLens, language servers, problems panel, search across workspace — everything VSCode already does well, no rebuilding.
- **Schema-driven settings webview** with Project (default) and Global scope tabs. Editing `<workspace>/.sandy/config` and `~/.sandy/config` with live `pattern` / `min` / `max` validation, scope-aware secret storage.
- **Pre-flight approval modal** for passive-privileged keys, rendering raw `KEY=VALUE` content verbatim (no HTML interpretation, no whitespace collapse).
- **OSC handling**: OSC 9 / 99 / 777 → VSCode notifications, OSC 52 → host clipboard via `vscode.env.clipboard`.
- **Stale-lock sweep on launch**: cleans `~/.sandy/sandboxes/*.lock` files whose PIDs are dead.
- **Proper signal escalation on tab close**: SIGINT → 3s → SIGTERM → 2s → SIGKILL so sandy's cleanup trap has time to run.

## Prereqs

- VSCode 1.85 or newer (or a fork — Cursor / Windsurf / VSCodium with OpenVSX work too)
- Node 20+
- Docker running (for sandy itself; the extension does not require it)
- `sandy` on PATH (or `tmux` as a stand-in for testing without sandy)

## Install (latest release)

<!-- VERSION-PIN: update this URL whenever package.json version is bumped (see CLAUDE.md > "On every release") -->

```bash
curl -L https://github.com/rappdw/sandy-ui/releases/download/v0.6.0/sandy-ui-0.6.0.vsix -o /tmp/sandy.vsix \
  && code --install-extension /tmp/sandy.vsix
# Then: Cmd+Shift+P → "Developer: Reload Window" in any open VSCode window
```

The `.vsix` ships node-pty built against the publishing machine's Electron ABI. If you're on a different Electron major (e.g., much newer or older VSCode), you'll see `posix_spawnp failed.` on first launch — clone and build from source instead (next section).

## Build & run from source

```bash
git clone https://github.com/rappdw/sandy-ui
cd sandy-ui
npm install                # builds node-pty against your system Node
npm run compile

# Open the project in VSCode and press F5 ("Run Extension")
# An Extension Development Host opens; commands available in the palette as "Sandy: ..."
```

If launching the dev host produces `posix_spawnp failed.` errors, your `node-pty` ABI doesn't match VSCode's bundled Electron. Rebuild:

```bash
npm install --save-dev electron @electron/rebuild
npx electron-rebuild -f -w node-pty
```

## Commands

- **Sandy: Launch (in webview tab)** — opens sandy as an editor tab against the current workspace
- **Sandy: Test Approval Modal** — exercises the pre-flight modal with a hostile-content sample
- **Sandy: Open Settings** — schema-driven settings webview with Project/Global scope tabs

## Configuration

- `sandy.binaryPath` — absolute path to the sandy binary (default: empty = auto-detect via PATH, then `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/bin`). Set this when VSCode launched-from-Dock can't find sandy on its narrower PATH.
- `sandy.launchCommand` — override the auto-detected launch command (default: `sandy` → `tmux` → `$SHELL` in PATH order, picking the first executable). Useful for testing against tmux or a plain shell instead of sandy.
- `sandy.launch.closeBottomPanel` — on **Sandy: Launch**, close the bottom panel (Problems / Output / Terminal / Debug Console) to maximize editor space (default: `true`).
- `sandy.launch.closeAuxiliaryBar` — on **Sandy: Launch**, close the auxiliary side bar (where the Chat / Copilot panel typically lives) to maximize editor space (default: `true`).
- `sandy.launch.closeSidebar` — on **Sandy: Launch**, close the primary side bar (Explorer / Search / SCM). Off by default since the file tree is usually wanted alongside sandy (default: `false`).
- `sandy.terminal.scrollSensitivity` — mouse-wheel / trackpad scroll speed in the Sandy terminal (default `2`, range `0.1`–`10`). Higher scrolls faster, lower gives finer control. Applies live — no reload needed.
- `sandy.persistSessions` — use sandy's daemon mode (sandy ≥ 1.1.0) so sessions survive VSCode restarts: closing a tab or quitting VSCode detaches instead of stopping; stop explicitly via the tree/status-bar Stop action (default: `true`). Off = legacy lifecycle (closing the tab stops sandy). Ignored when the installed sandy lacks daemon support — the extension itself only requires sandy ≥ 1.0.

## Architecture

See [SPEC_SANDY_UI.md](SPEC_SANDY_UI.md) for the full design — webview-as-editor-tab hosting xterm.js, custom OSC handlers, scope-aware settings, signal escalation, lock-sweep on launch, etc.

## Project layout

```
src/
  extension.ts             # activate(), command + view registration
  projectsTree.ts          # activity-bar tree contribution
  terminal/                # webview + node-pty + OSC handlers + lock-sweep
  approval/                # pre-flight modal (native + webview variants)
  settings/                # schema-driven settings webview, configIO
  mocks/                   # stand-in schema until sandy 0.12.0 ships --print-schema
media/                     # webview HTML/CSS/JS + bundled xterm.js + addons
scripts/                   # copy-xterm build helper
docs/SPIKE_RESULTS.md      # initial validation findings + production roadmap
handoffs/                  # task prompts for repos w/o an issue tracker (sandy asks live as rappdw/sandy issues)
SPEC_SANDY_UI.md           # full architectural spec
```

## License

MIT.

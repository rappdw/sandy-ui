# sandy-ui

VSCode extension that wraps the [sandy](https://github.com/rappdw/sandy) CLI — runs sandy as a webview-hosted terminal in the editor area, with schema-driven settings and pre-flight approval modals.

> **Status**: 0.8.0, dogfooding for the author. Not yet on Marketplace / OpenVSX. Public distribution is gated on node-pty packaging (macOS TCC was reassessed down from blocker to onboarding note) — see [SPEC_SANDY_UI.md](SPEC_SANDY_UI.md) and [docs/SPIKE_RESULTS.md](docs/SPIKE_RESULTS.md) for the production roadmap.

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
- Requires sandy ≥ 1.0.0 (config schema v1) — see [SPEC_SANDY_UI.md §Compatibility](SPEC_SANDY_UI.md#compatibility-with-sandy)

## Install (latest release)

<!-- VERSION-PIN: update this URL whenever package.json version is bumped (see CLAUDE.md > "On every release") -->

```bash
curl -L https://github.com/rappdw/sandy-ui/releases/download/v0.8.0/sandy-ui-0.8.0.vsix -o /tmp/sandy.vsix \
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
- **Sandy: Get Started** (`sandy.walkthrough.open`) — opens the "Get Started with Sandy" walkthrough: install checks, Docker check, first launch, the persistence gotcha, and a settings tour, each with live fix-it steps
- **Sandy: Test Approval Modal** — exercises the pre-flight modal with a hostile-content sample
- **Sandy: Open Settings** — schema-driven settings webview with Project/Global scope tabs

## Configuration

- `sandy.binaryPath` — absolute path to the sandy binary (default: empty = auto-detect via PATH, then `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/bin`). Set this when VSCode launched-from-Dock can't find sandy on its narrower PATH.
- `sandy.launchCommand` — override the auto-detected launch command (default: `sandy` → `tmux` → `$SHELL` in PATH order, picking the first executable). Useful for testing against tmux or a plain shell instead of sandy.
- `sandy.launch.closeBottomPanel` — on **Sandy: Launch**, close the bottom panel (Problems / Output / Terminal / Debug Console) to maximize editor space (default: `true`).
- `sandy.launch.closeAuxiliaryBar` — on **Sandy: Launch**, close the auxiliary side bar (where the Chat / Copilot panel typically lives) to maximize editor space (default: `true`).
- `sandy.launch.closeSidebar` — on **Sandy: Launch**, close the primary side bar (Explorer / Search / SCM). Off by default since the file tree is usually wanted alongside sandy (default: `false`).
- `sandy.terminal.scrollSensitivity` — mouse-wheel / trackpad scroll speed in the Sandy terminal (default `2`, range `0.1`–`10`). Higher scrolls faster, lower gives finer control. Applies live — no reload needed.
- `sandy.persistSessions` — use sandy's daemon mode (sandy ≥ 1.1.0) so sessions survive VSCode restarts: closing a tab or quitting VSCode detaches instead of stopping; stop explicitly via the tree/status-bar Stop action (default: `true`). Off = legacy lifecycle (closing the tab stops sandy). Ignored when the installed sandy lacks daemon support — the extension itself only requires sandy ≥ 1.0. Setting `sandy.launchCommand` forces the legacy lifecycle regardless.
- `sandy.longRunningSessionHours` — once per VSCode window, nudge about persisted sessions running longer than this many hours, with Attach/Stop actions (default: `24`; `0` disables).
- `sandy.terminal.mouseMode` — `nativeSelection` (default): drag selects text natively, wheel forwards to tmux, in-app clicks aren't delivered. `tmux`: tmux owns the mouse (in-app clicks and pane interactions work); text selection needs ⌥-drag. Applies live to running terminals.

## Running against a remote sandy (Remote-SSH)

Run sandy on an always-on server (a lab box, a DGX) and drive it from your laptop with the full sandy-ui UX — session list, agent tab, file editing — the daemon session staying put on the server while the laptop is just a client.

This works because sandy-ui is a **workspace extension** (`extensionKind: workspace`): in a VSCode **Remote-SSH** session the extension host runs on the **remote host**, so sandy-ui invokes *that* machine's `sandy`/`docker`/`tmux`. From the extension's point of view everything is local — it just happens to be the server. sandy itself needs no changes.

It's a bit fiddly to set up the first time. Steps:

**1. Connect.** `Cmd+Shift+P` → **Remote-SSH: Connect to Host** → your server. Then **File → Open Folder** → the workspace on the server (the same path sandy runs against, e.g. `~/dev/foo`). The bottom-left badge should read **SSH: <host>**.

**2. Build sandy-ui from source, on the server.** A prebuilt `.vsix` won't work here (see the node-pty note below), so build it in place. This step only writes to the server's disk, so run it in **any** shell on the server — a `mosh`/`ssh` session is actually best, since it survives network drops during the long `npm install`:

```bash
git clone https://github.com/rappdw/sandy-ui ~/dev/sandy-ui
cd ~/dev/sandy-ui
npm install          # builds node-pty against the server's Node
npm run compile
npm run package-vsix # produces sandy-ui-<version>.vsix
```

**3. Install into the *remote* extension host.** This is the one step that needs VSCode's plumbing — a plain `mosh`/`ssh` shell has no `code` CLI wired to the remote server. Pick one:

- **From the VSCode UI (no terminal):** Extensions view → `⋯` menu → **Install from VSIX…** → pick the `.vsix` you just built on the server. *(Easiest — sidesteps the `code`-CLI question entirely.)*
- **From the SSH:<host> integrated terminal:** `code --install-extension ~/dev/sandy-ui/sandy-ui-<version>.vsix --force` — here `code` *is* the remote server CLI, so it installs into the right host.
- **Skip packaging — press F5** with `~/dev/sandy-ui` open in the Remote-SSH window: launches an Extension Development Host in the remote host directly.

**4. Reload:** `Cmd+Shift+P` → **Developer: Reload Window**. The Sandy view should now list the server's sessions.

### node-pty must match the remote's runtime

The remote extension host runs under the **VS Code Server's bundled Node.js** — a *different* ABI than a local desktop VSCode's Electron, and possibly different from the server's *system* Node. If launching sandy fails with `posix_spawnp failed.`, rebuild node-pty against the server's node (in a server shell):

```bash
SERVER_NODE=$(find ~/.vscode-server -name node -type f -path '*/server/node' 2>/dev/null | head -1)
[ -z "$SERVER_NODE" ] && SERVER_NODE=$(find ~/.vscode-server/bin -maxdepth 2 -name node -type f 2>/dev/null | head -1)
cd ~/dev/sandy-ui/node_modules/node-pty
npx node-gyp rebuild --nodedir="$(dirname "$SERVER_NODE")/.."
cd ~/dev/sandy-ui && npm run package-vsix   # re-package, re-install (step 3)
```

Eliminating this rebuild is [#33](https://github.com/rappdw/sandy-ui/issues/33) (a prebuilt remote-server target). **`electron-rebuild` is the wrong tool remotely** — that targets Electron, the remote wants the server's Node ABI.

### Gotcha: `jq` on `sandy --print-state` errors with `Invalid numeric literal`

If a server-side manual check like `sandy --print-state | jq …` fails to parse, your shell is leaking a terminal-title escape (`ESC ] 0 ; … BEL`) onto stdout — a prompt/title hook writing to fd 1 instead of `/dev/tty`, which corrupts any redirected output. **sandy-ui itself is immune** (its poller tolerates this), so only manual `jq` pipelines are affected; strip it with `… | perl -pe 's/\e\][^\a]*\a//' | jq`. The real fix is shell-side (guard the title hook on `[[ -t 1 ]]` or write to `/dev/tty`).

Full step-by-step with acceptance checks (attach, file round-trip, reconnection after a network bounce): [`docs/testing/remote-ssh-runbook.md`](docs/testing/remote-ssh-runbook.md). Design notes: [#37](https://github.com/rappdw/sandy-ui/issues/37).

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

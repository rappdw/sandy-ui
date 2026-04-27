# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

VSCode extension wrapping the [sandy](https://github.com/rappdw/sandy) CLI. Hosts sandy as a webview-tab terminal in the editor area (NOT VSCode's native terminal — that path silently drops OSC sequences with no extension hook). Architecture details in `SPEC_SANDY_UI.md`; original validation in `docs/SPIKE_RESULTS.md`.

## Commands

```bash
npm install                # also runs the node-pty native build
npm run compile            # tsc + copy xterm.js assets to media/terminal/vendor/
npm run watch              # tsc -watch (pair with F5 dev host for live iteration)
npm run package-vsix       # produces sandy-ui-<version>.vsix in repo root
npm run install-vsix       # packages + installs into your real VSCode (--force overwrite)
npm run release            # packages + creates GitHub release with vsix attached, tagged v<version>
```

F5 in VSCode opens the Extension Development Host — fastest dev loop. `install-vsix` puts the latest into your everyday VSCode.

## On every release

When `package.json` `version` is bumped and `npm run release` is run, **also update the `curl` command in README.md's "Install (latest release)" section** to point at the new tag. The version is pinned in two places (package.json + README install one-liner) and they must stay synchronized.

## Architecture you can't infer from file names

- **Two-process pattern (host + webview)**. Extension host (Node) owns `node-pty` and the PTY supervisor; webview (browser context) owns xterm.js and OSC parsing. They communicate only via `postMessage`. State lives in `webview.getState()/setState()` for hide/show survival — and the persisted shape must be backwards-compatible with prior versions or `getState()` returns garbage that breaks the page silently.
- **Webview JS errors are silent by default**. Both `media/terminal/bridge.js` and `media/settings/settings.js` install `window.error` + `unhandledrejection` handlers that post errors back to the host's "Sandy" / "Sandy Settings" output channels. When something "doesn't work" in a webview, look at the output channel before guessing.
- **OSC handling chain**. xterm.js's `parser.registerOscHandler(<code>, cb)` (requires `allowProposedApi: true`) intercepts OSC 9 / 52 / 99 / 777 / 0; bridge.js posts a typed event to host; host routes to `vscode.window.showInformationMessage`, `vscode.env.clipboard.writeText`, or panel title updates. **OSC sequences emitted from inside sandy's inner tmux are eaten by tmux's default allowlist** — pass-through requires `set -g allow-passthrough on` in sandy's tmux.conf (handoff queued at `handoffs/sandy-flock-locking.md`'s sibling spot — currently only flock is handed off).
- **PTY size on launch**. Webview measures via `fit.fit()` after two `requestAnimationFrame` ticks (waits for VSCode panel layout to settle), passes cols/rows in the `ready` message; host spawns `node-pty` at those dimensions. **Hardcoded 80×24 spawn = sandy renders into upper-left corner** until manual resize. ResizeObserver on the terminal element (NOT `window.resize`) catches all subsequent layout changes.
- **Signal escalation on tab close**. `panel.onDidDispose` does `SIGINT → wait 3s → SIGTERM → wait 2s → SIGKILL`. The 3s SIGINT wait is load-bearing — sandy's cleanup trap runs `docker stop` + `docker network rm` which is slow; cutting short leaks lock files and Docker networks. Don't shorten without measuring.
- **Stale-lock sweep**. `src/terminal/sandyState.ts` runs before each launch. Reads PID from `~/.sandy/sandboxes/.<basename>-*.lock`, removes if PID is dead (`process.kill(pid, 0)` distinguishing ESRCH from EPERM). Live PIDs are left alone. Sandy itself should adopt flock(2) (handoff at `handoffs/sandy-flock-locking.md`) — until then, this sweep is the production behavior.
- **Settings scope model**. Project (default) and Global tabs each edit their own `<scope>/.sandy/config` and `<scope>/.sandy/.secrets`. Secrets are scope-aware — the spec originally pinned all secrets to `~/.sandy/.secrets` for safety; that was loosened. Workspace `.secrets` is a footgun for committed repos; the form shows a warning banner about adding `.sandy/.secrets` to `.gitignore`.
- **Workspace selection is explicit, never inferred**. `openTerminalPanel` prompts with the folder picker if no workspace folder is open. **Never silently fall back to `$HOME`** — sandy scans its workspace and would touch every macOS-protected directory, triggering a TCC prompt cascade attributed to VSCode.

## Things that look like architecture but aren't

- Mocks in `src/mocks/` are placeholders until sandy 0.12.0 ships `--print-schema`. Production code reads schema from `sandy --print-schema`, falls back to mocks if sandy is unavailable.
- `media/terminal/vendor/` is gitignored — populated by `npm run copy-xterm` from node_modules. Don't edit those files; edit `scripts/copy-xterm.js` if the bundled file list needs to change.

## node-pty rebuild gotcha

`npm install` builds node-pty against system Node. VSCode runs against its bundled Electron, which has a different ABI. If you see `posix_spawnp failed.` (no errno), three different binaries failing identically — that's the symptom. Fix: `npx electron-rebuild -f -w node-pty` (electron and @electron/rebuild are dev deps for this purpose).

## Cross-repo work

`handoffs/` contains task prompts intended to be pasted to a Claude/agent in a different repo (currently just `sandy-flock-locking.md` for the sandy repo). When a sandy-ui change requires a sandy-side companion change, write the handoff there rather than tracking it in an issue.

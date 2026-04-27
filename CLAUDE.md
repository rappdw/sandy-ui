# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

VSCode extension wrapping the [sandy](https://github.com/rappdw/sandy) CLI. Hosts sandy as a webview-tab terminal in the editor area (NOT VSCode's native terminal — that path silently drops OSC sequences with no extension hook). Architecture details in `SPEC_SANDY_UI.md`; original validation in `docs/SPIKE_RESULTS.md`.

## Commands

```bash
npm install                # also runs the node-pty native build
npm run compile            # full pipeline: copy-xterm → typecheck:webview → build:webviews → tsc
npm run watch              # tsc -watch for the host code
npm run watch:webviews     # esbuild --watch for media/{terminal,settings}/src/*.ts
npm test                   # vitest run — unit tests for pure-logic modules
npm run test:watch         # vitest interactive
npm run test:coverage      # vitest with v8 coverage report
npm run typecheck:webview  # tsc --noEmit -p tsconfig.webview.json (webview TS only)
npm run build:webviews     # esbuild bundles webview TS into media/{terminal,settings}/dist/
npm run package-vsix       # produces sandy-ui-<version>.vsix in repo root
npm run install-vsix       # packages + installs into your real VSCode (--force overwrite)
npm run release            # packages + creates GitHub release with vsix attached, tagged v<version>
```

F5 in VSCode opens the Extension Development Host — fastest dev loop. For active webview iteration: run `watch` and `watch:webviews` in two terminals, then F5. `install-vsix` puts the latest into your everyday VSCode.

## On every release

When `package.json` `version` is bumped and `npm run release` is run, **also update the `curl` command in README.md's "Install (latest release)" section** to point at the new tag. The version is pinned in two places (package.json + README install one-liner) and they must stay synchronized.

## Tests

- **Unit tests** live under `test/`, run via Vitest (`npm test`). Pure-logic modules only — `oscHandler`, `configIO`, `sandyState`. Each module also exports a path-parameterized variant (e.g., `sweepStaleLocksIn` alongside the production `sweepStaleLocks`) so tests don't touch the user's real `~/.sandy/`.
- **Integration tests** (post-0.2.0): `@vscode/test-electron` runs the extension in a headless VSCode and exercises commands. Belongs under `test/integration/`. Files like `webviewPanel.ts`, `pty.ts`, and the approval webviews can only be covered this way.
- **Coverage targets**: 80%+ on pure-logic modules (currently ~95% for `oscHandler` and `sandyState`). Don't chase coverage on files explicitly excluded in `vitest.config.ts` — they're integration-test territory.
- When adding a feature with branching logic (config parsing, lock detection, schema partitioning, etc.), add a Vitest case alongside it. The pattern that bit twice during the spike — silent runtime errors in webview code — is the strongest argument for tests + the eventual webview-JS-to-TS migration.

## Architecture you can't infer from file names

- **Two-process pattern (host + webview)**. Extension host (Node) owns `node-pty` and the PTY supervisor; webview (browser context) owns xterm.js and OSC parsing. They communicate only via `postMessage`. State lives in `webview.getState()/setState()` for hide/show survival — and the persisted shape must be backwards-compatible with prior versions or `getState()` returns garbage that breaks the page silently.
- **Webview code is TypeScript, bundled by esbuild**. Sources live under `media/{terminal,settings}/src/*.ts`; bundles land in `media/{terminal,settings}/dist/*.js` and are referenced by host webviewPanel HTML. The dist/ directories are gitignored — built fresh by `npm run compile`. Webview globals (`Terminal`, `FitAddon`, `WebLinksAddon`, `acquireVsCodeApi`) are declared in `media/types.d.ts`. Each entry file needs `export {};` at the top so its local types don't leak into the global type scope shared with the other webview file.
- **Webview errors are silent by default**. Both bridge and settings install `window.error` + `unhandledrejection` handlers that post errors back to the host's "Sandy" / "Sandy Settings" output channels. When something "doesn't work" in a webview, look at the output channel before guessing.
- **OSC handling chain**. xterm.js's `parser.registerOscHandler(<code>, cb)` (requires `allowProposedApi: true`) intercepts OSC 9 / 52 / 99 / 777 / 0; bridge posts a typed event to host; host routes to `vscode.window.showInformationMessage`, `vscode.env.clipboard.writeText`, or panel title updates. **OSC sequences emitted from inside sandy's inner tmux are eaten by tmux's default allowlist** — pass-through requires `set -g allow-passthrough on` in sandy's tmux.conf (handoff queued at `handoffs/sandy-flock-locking.md`'s sibling spot — currently only flock is handed off).
- **PTY size on launch**. Webview measures via `fit.fit()` after two `requestAnimationFrame` ticks (waits for VSCode panel layout to settle), passes cols/rows in the `ready` message; host spawns `node-pty` at those dimensions. **Hardcoded 80×24 spawn = sandy renders into upper-left corner** until manual resize. ResizeObserver on the terminal element (NOT `window.resize`) catches all subsequent layout changes.
- **Signal escalation on tab close**. `panel.onDidDispose` does `SIGINT → wait 3s → SIGTERM → wait 2s → SIGKILL`. The 3s SIGINT wait is load-bearing — sandy's cleanup trap runs `docker stop` + `docker network rm` which is slow; cutting short leaks lock files and Docker networks. Don't shorten without measuring.
- **Stale-lock sweep**. `src/terminal/sandyState.ts` runs before each launch. Reads PID from `~/.sandy/sandboxes/.<basename>-*.lock`, removes if PID is dead (`process.kill(pid, 0)` distinguishing ESRCH from EPERM). Live PIDs are left alone. Sandy itself should adopt flock(2) (handoff at `handoffs/sandy-flock-locking.md`) — until then, this sweep is the production behavior.
- **Settings scope model**. Project (default) and Global tabs each edit their own `<scope>/.sandy/config` and `<scope>/.sandy/.secrets`. Secrets are scope-aware — the spec originally pinned all secrets to `~/.sandy/.secrets` for safety; that was loosened. Workspace `.secrets` is a footgun for committed repos; the form shows a warning banner about adding `.sandy/.secrets` to `.gitignore`. **Every schema field renders in both tabs** regardless of its `tier` — `tier` is documentation, not a hard constraint. Privileged keys get a yellow border in both tabs; the workspace-tab warning explains that workspace-set privileged keys trigger the passive-privileged approval flow on next launch (home-set ones don't, since the user explicitly set them in their own dir).
- **Workspace selection is explicit, never inferred**. `openTerminalPanel` prompts with the folder picker if no workspace folder is open. **Never silently fall back to `$HOME`** — sandy scans its workspace and would touch every macOS-protected directory, triggering a TCC prompt cascade attributed to VSCode.

## Schema source

`src/schema/cache.ts` invokes `sandy --print-schema`, parses the JSON, and caches the result in `globalStorageUri/schema-cache.json`. The cache is keyed by `sandy --version` output — when sandy upgrades, the next `getCachedSchema` call detects the version mismatch and refetches. Cache writes are atomic (temp + rename); cache write failures are non-fatal (always returns a usable schema).

`src/schema/parse.ts` translates sandy's three-tier shape (`privileged_keys` / `passive_keys` / `env_only_keys`) into the extension's flat `fields[]` representation, renaming `name`→`key`, `choices`→`options`, `passive_approval_required`→`privileged`. `env_only_keys` are deliberately skipped (not file-configurable, no useful UI). Sandy's introspection JSON contract lives at `SPEC_INTROSPECTION.md` in the sandy repo.

`src/mocks/schema.json` is the **fallback** when sandy isn't on PATH or `--print-schema` fails — bundled into the vsix via tsconfig's `resolveJsonModule`. The fallback path is logged to the "Sandy Settings" output channel so users can tell when they're seeing real schema vs mock.

## Things that look like architecture but aren't

- `media/terminal/vendor/` is gitignored — populated by `npm run copy-xterm` from node_modules. Don't edit those files; edit `scripts/copy-xterm.js` if the bundled file list needs to change.

## node-pty rebuild gotcha

`npm install` builds node-pty against system Node. VSCode runs against its bundled Electron, which has a different ABI. If you see `posix_spawnp failed.` (no errno), three different binaries failing identically — that's the symptom. Fix: `npx electron-rebuild -f -w node-pty` (electron and @electron/rebuild are dev deps for this purpose).

## Cross-repo work

`handoffs/` contains task prompts intended to be pasted to a Claude/agent in a different repo (currently just `sandy-flock-locking.md` for the sandy repo). When a sandy-ui change requires a sandy-side companion change, write the handoff there rather than tracking it in an issue.

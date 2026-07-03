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

When `package.json` `version` is bumped and `npm run release` is run:

1. **Update the `curl` command in README.md's "Install (latest release)" section** to point at the new tag. The version is pinned in two places (package.json + README install one-liner) and they must stay synchronized.
2. **Write `docs/releases/v<version>.md`** — the curated release body. `scripts/release.sh` uses it as the GitHub release notes via `--notes-file` when present; without it the release falls back to `gh --generate-notes` (just the commit changelog, no highlights). Match the existing files' shape: a one-line headline, a `## What's new` section grouped by area, a `## Status` milestone table, and a `## Install` block with the new tag. Forgetting this file is why a release ends up with empty notes — create it **before** running `npm run release`.

## Tests

- **Unit tests** live under `test/*.test.ts`, run via Vitest (`npm test`). Pure-logic modules only — `oscHandler`, `configIO`, `sandyState`, `schema/parse`, `state/badge`, `state/enrich`, `state/deleteSandbox`, `state/sandyPath`, `approval/validate`. Each FS-touching module also exports a path-parameterized variant (e.g., `sweepStaleLocksIn` alongside the production `sweepStaleLocks`) so tests don't touch the user's real `~/.sandy/`.
- **Integration tests** live under `test/integration/*.test.ts`, run via `@vscode/test-electron` (`npm run test:integration`). They download a real VSCode, install the extension, and run Mocha-suite assertions inside the extension host context — so they can hit `vscode.extensions.getExtension(...)`, `vscode.commands.executeCommand(...)`, `vscode.window.tabGroups`, etc. Use these for things vitest can't reach: extension activation, command registration, webview panels opening as a side effect of commands.
- Integration tests compile via `tsconfig.integration.json` to `out-integration/*.test.js`; vscode-test config is `.vscode-test.mjs`. Vitest excludes `test/integration/**` so the two suites don't collide.
- **Coverage targets**: 80%+ on pure-logic modules (currently ~95% for `oscHandler` and `sandyState`). Don't chase coverage on files excluded in `vitest.config.ts` — they're integration-test territory now.
- When adding a feature with branching logic (config parsing, lock detection, schema partitioning, etc.), add a Vitest case alongside it. When adding a new command or webview surface, add an integration case.

## Architecture you can't infer from file names

- **Two-process pattern (host + webview)**. Extension host (Node) owns `node-pty` and the PTY supervisor; webview (browser context) owns xterm.js and OSC parsing. They communicate only via `postMessage`. State lives in `webview.getState()/setState()` for hide/show survival — and the persisted shape must be backwards-compatible with prior versions or `getState()` returns garbage that breaks the page silently.
- **Webview code is TypeScript, bundled by esbuild**. Sources live under `media/{terminal,settings}/src/*.ts`; bundles land in `media/{terminal,settings}/dist/*.js` and are referenced by host webviewPanel HTML. The dist/ directories are gitignored — built fresh by `npm run compile`. Webview globals (`Terminal`, `FitAddon`, `WebLinksAddon`, `acquireVsCodeApi`) are declared in `media/types.d.ts`. Each entry file needs `export {};` at the top so its local types don't leak into the global type scope shared with the other webview file.
- **Webview errors are silent by default**. Both bridge and settings install `window.error` + `unhandledrejection` handlers that post errors back to the host's "Sandy" / "Sandy Settings" output channels. When something "doesn't work" in a webview, look at the output channel before guessing.
- **OSC handling chain**. xterm.js's `parser.registerOscHandler(<code>, cb)` (requires `allowProposedApi: true`) intercepts OSC 9 / 52 / 99 / 777 / 0; bridge posts a typed event to host; host routes to `vscode.window.showInformationMessage`, `vscode.env.clipboard.writeText`, or panel title updates. **OSC sequences emitted from inside sandy's inner tmux need tmux pass-through** — sandy's generated tmux.conf now ships `set -g allow-passthrough on` (verified against sandy main, July 2026), so this works on current sandy; older sandy builds silently eat those sequences via tmux's default allowlist.
- **PTY size on launch**. Webview measures via `fit.fit()` after two `requestAnimationFrame` ticks (waits for VSCode panel layout to settle), passes cols/rows in the `ready` message; host spawns `node-pty` at those dimensions. **Hardcoded 80×24 spawn = sandy renders into upper-left corner** until manual resize. ResizeObserver on the terminal element (NOT `window.resize`) catches all subsequent layout changes.
- **PtySupervisor owns session lifecycle**. `src/terminal/supervisor.ts` is the singleton that spawns PTYs, tracks them by workspace path, and coordinates attach / detach / stop. One Session per workspace at a time. `webviewPanel.ts` is now thin — just renders the panel + relays messages; the supervisor handles spawn, signal escalation, and the data/exit pipe. State machine: spawn → attach(panel) → (detach → attach again, or stop). Closing a tab triggers `supervisor.stop()` (signal escalation: SIGINT → 3s → SIGTERM → 2s → SIGKILL); calling `supervisor.detach(ws)` clears `session.panel` BEFORE the panel disposes, and the panel-dispose handler skips the kill when it sees `session.panel !== panel`.
- **Detach is bounded to this VSCode session**, not a true daemon. Menu text says "Detach (this VSCode session)" so the limit is in the UI. The PTY lives in the extension host; quitting VSCode (or `deactivate()` running) takes detached sessions down with it. Daemon-mode that survives client lifetime is tracked upstream at [rappdw/sandy#17](https://github.com/rappdw/sandy/issues/17) — until that lands, "detach" is a same-window-only optimization.
- **Orphan-from-prior-VSCode-session detection on launch**. When `sweepStaleLocks` finds a live-PID lock for the workspace but the supervisor has no session for it (typical post-VSCode-quit state where sandy's cleanup trap got cut short), `webviewPanel.ts` shows a modal: "Stop existing & launch fresh / Cancel". Force-stop SIGTERMs the orphan pid (gives sandy's trap a chance to run), waits 3s, force-removes any surviving lock files, then proceeds with the normal spawn. Until daemon-mode lands, this is the honest UX for "you came back to a workspace where sandy is still running externally."
- **Detach / re-attach UX**. `sandy.tree.detach` (visible when `viewItem` is `sandbox.running` or `sandbox.locked` — covers the case where sandy's `--print-state` misclassifies our running session) closes the webview tab but keeps the PTY alive; the next click on the same sandbox tree item attaches a new panel to the live PTY. No scrollback replay yet — sandy's inner tmux preserves the live screen, so the next interaction repaints. `sandy.tree.stop` is the explicit "kill the session now" command in the same context-menu group.
- **Status bar item** (right side, priority 100): `$(server-process) N sandy [$(eye-closed) M detached]` whenever the supervisor has live sessions. Hides when none. Click → quick-pick listing every session by workspace path; selecting an attached session reveals its panel, selecting a detached session re-attaches via `sandy.launch`. Wired in `extension.ts` via `supervisor.onDidChange` so it updates immediately on spawn/attach/detach/exit (no polling).
- **Graceful shutdown on VSCode quit**. `extension.deactivate()` returns a Promise (VSCode awaits ~5s before force-killing the extension host). Delegates to `supervisor.disposeAll()` which parallel-SIGINTs every live session so each sandy's cleanup trap runs concurrently, waits up to 4s, escalates SIGTERM → 800ms → SIGKILL on any survivors.
- **Stale-lock sweep**. `src/terminal/sandyState.ts` runs before each launch. Reads PID from `~/.sandy/sandboxes/.<basename>-*.lock`, removes if PID is dead (`process.kill(pid, 0)` distinguishing ESRCH from EPERM). Live PIDs are left alone. Sandy-side hardening (atomic stale-lock takeover + PID-owned release; flock(2) was evaluated and rejected upstream — macOS ships no flock CLI) is tracked at [rappdw/sandy#14](https://github.com/rappdw/sandy/issues/14) — until then, this sweep is the production behavior.
- **Settings scope model**. Project (default) and Global tabs each edit their own `<scope>/.sandy/config` and `<scope>/.sandy/.secrets`. Secrets are scope-aware — the spec originally pinned all secrets to `~/.sandy/.secrets` for safety; that was loosened. Workspace `.secrets` is a footgun for committed repos; the form shows a warning banner about adding `.sandy/.secrets` to `.gitignore`. **Every schema field renders in both tabs** regardless of its `tier` — `tier` is documentation, not a hard constraint. Privileged keys get a yellow border in both tabs; the workspace-tab warning explains that workspace-set privileged keys trigger the passive-privileged approval flow on next launch (home-set ones don't, since the user explicitly set them in their own dir).
- **Workspace selection is explicit, never inferred**. `openTerminalPanel` prompts with the folder picker if no workspace folder is open. **Never silently fall back to `$HOME`** — sandy scans its workspace and would touch every macOS-protected directory, triggering a TCC prompt cascade attributed to VSCode.

## Pre-flight approval

`src/approval/validate.ts` invokes `sandy --validate-config <path>`. Returns `{ result?: ValidateResult, error?: string }`. Non-existent config files short-circuit to `{ approval_status: "none_required" }` without invoking sandy at all (workspace doesn't have a `.sandy/config` yet → nothing to approve).

`src/approval/preflight.ts` (`checkPreflightApproval`) orchestrates the launch-time approval flow: validate, inspect `approval_status`, and if `pending`, build the verbatim KEY=VALUE block from the workspace `.sandy/config` (filtered to `privileged_keys_requiring_approval` from validate output), open the webview modal, return `{ proceed, setApproveEnv }`. The caller (`openTerminalPanel`) sets `SANDY_AUTO_APPROVE_PRIVILEGED=1` in the *single* spawn env when `setApproveEnv` is true — never persisted, never leaks across launches. Sandy itself writes the persistent approval record on disk; on subsequent launches `validate-config` reports `approval_status: "approved"` and we skip the modal.

`src/approval/webviewModal.ts` accepts an `ApprovalPayload {header, subtext, body}` so it's reusable: production calls it from preflight with real validated content; the `Sandy: Test Approval Modal` command calls it with the hostile sample from `sample.ts` to exercise verbatim-rendering.

Errors from `--validate-config` are logged but **never block the launch** — sandy itself enforces approval at runtime, so falling back to "let sandy handle it" is safe.

## State polling

`src/state/poller.ts` (`StatePoller`) invokes `sandy --print-state`, parses the JSON, and emits a change event when the summary differs from the previous poll. **Cadence is gated, not fixed** (`src/state/cadence.ts`): 5s only while the Sandy tree view is visible in a focused window, 60s when the window loses focus, stopped entirely when the view is hidden. Rationale: each `--print-state` spawns ~9 docker CLI processes (docker info ×2, image inspect ×6 for the unused `installed_images` field, docker ps ×1) — an unconditional 5s poll in every VSCode window produced a sawtooth CPU pattern on macOS. Speeding up (including view-becomes-visible) triggers an immediate refresh so the tree is never stale. The sandy-side fix (1 docker spawn instead of 9) is tracked at [rappdw/sandy#18](https://github.com/rappdw/sandy/issues/18); the poller already passes the `light` arg, so it activates automatically when sandy ships it. The summary comparison ignores noisy fields (e.g., `size_bytes`) so the tree doesn't refresh unnecessarily; it only fires on sandbox count change, lock-state change, last_used_at change, or running-container set change.

`src/projectsTree.ts` subscribes to the poller. Each TreeItem represents a sandbox; the icon is derived by `src/state/badge.ts` (running → debug-start, locked → lock, stale → clock, fresh → sparkle, current → terminal). Tree click invokes `sandy.launch` with `{workspacePath: <sandbox.workspace_path>}` so launching from the tree targets the right workspace, not whatever VSCode happens to have open.

`sandy --print-state` returns `running_containers: null` when docker isn't reachable; the tree shows a top-level "⚠ Docker unreachable" status node in that case. When sandy isn't on PATH at all, the tree falls back to a single "current workspace" placeholder so the launch command still works via the folder-picker flow.

`Sandy: Refresh State` command (palette + tree title-bar icon) forces an out-of-cycle poll.

## Sandy binary resolution

`src/state/sandyPath.ts` (`resolveSandyBinary`) is the single source of truth for "where is sandy" across all callers (poller, schema cache, validate, terminal launch). Resolution order:
1. `sandy.binaryPath` config setting (user-explicit override)
2. PATH lookup
3. Common install locations: `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/bin`, `/usr/bin`

The "common install locations" fallback exists because **VSCode launched from the Dock on macOS has a narrower PATH** (typically `/usr/bin:/bin` only — no Homebrew, no `~/.local/bin`) than the user's interactive shell. Without this fallback, sandy-ui would show "sandy unavailable" on every dock-launched VSCode session even when sandy is installed.

The resolved path is cached per-process. `invalidateSandyPathCache()` is wired to fire on `sandy.binaryPath` setting change so users don't have to reload to apply a new override. Override reader is dependency-injected (`setOverrideReaderForTests`) so unit tests don't need vscode mocked.

## Activation strategy

`activationEvents: ["onStartupFinished"]`. Eager activation after VSCode startup is required so `resumePendingLaunchIfAny` runs even when the user doesn't click the Sandy activity bar. Activation no longer implies polling: the StatePoller is cadence-gated on tree-view visibility + window focus (see "State polling"), so a window where the Sandy view is closed does zero `--print-state` invocations.

## Workspace-aware launch

`sandy.launch` (and `sandy.tree.launch`) route through `launchWithWorkspaceSwitch` in `extension.ts`. Behavior:

- Target workspace matches current VSCode workspace folder → just launch.
- No current workspace → launch with the override (works in an empty window).
- Target ≠ current → write a `PendingLaunch {workspace, at}` to globalState (key `sandy.pendingLaunch`), then `vscode.openFolder` to switch. VSCode reloads the workspace; the extension reactivates.
- On `activate()`, `resumePendingLaunchIfAny` reads + clears the marker. If still in TTL (30s) and the new workspace matches what the marker requested, fires `sandy.launch` after a 500ms settle delay.

The marker is *always* cleared on activate (even when not fired) so a cancelled openFolder dialog doesn't leave a ghost that triggers next time the user reopens the workspace.

## Sandbox deletion

`src/state/deleteSandbox.ts` (`deleteSandboxDir`) provides safe filesystem removal of a sandbox dir. **Three safety layers** because `rm -rf` on a wild path is catastrophic:

1. Path is `path.resolve()`d and the relative result against `sandboxesRoot` (default `~/.sandy/sandboxes/`) must not be empty, start with `..`, or be absolute. This rejects `/`, the root itself, parent-traversal escapes, and anything outside the sandbox tree.
2. Existence check before rm.
3. Wrapped in try/catch; never throws.

Caller (`sandy.tree.deleteSandbox` in extension.ts) is responsible for the **modal confirmation** (`showWarningMessage` with `modal: true`) and for **refusing-to-delete-running-sandboxes** (consults `poller.current().state.running_containers`). The delete function itself doesn't know about the running state — it just removes the dir.

Docker resources (network, container, image layers) are NOT cleaned by this — sandy's own teardown (or a `docker system prune`) handles those.

## Schema source

`src/schema/cache.ts` invokes `sandy --print-schema`, parses the JSON, and caches the result in `globalStorageUri/schema-cache.json`. The cache is keyed by `sandy --version` output — when sandy upgrades, the next `getCachedSchema` call detects the version mismatch and refetches. Cache writes are atomic (temp + rename); cache write failures are non-fatal (always returns a usable schema).

`src/schema/parse.ts` translates sandy's three-tier shape (`privileged_keys` / `passive_keys` / `env_only_keys`) into the extension's flat `fields[]` representation, renaming `name`→`key`, `choices`→`options`, `passive_approval_required`→`privileged`. `env_only_keys` are deliberately skipped (not file-configurable, no useful UI). Sandy's introspection JSON contract lives at `SPEC_INTROSPECTION.md` in the sandy repo.

`src/mocks/schema.json` is the **fallback** when sandy isn't on PATH or `--print-schema` fails — bundled into the vsix via tsconfig's `resolveJsonModule`. The fallback path is logged to the "Sandy Settings" output channel so users can tell when they're seeing real schema vs mock.

## Things that look like architecture but aren't

- `media/terminal/vendor/` is gitignored — populated by `npm run copy-xterm` from node_modules. Don't edit those files; edit `scripts/copy-xterm.js` if the bundled file list needs to change.

## node-pty rebuild gotcha

`npm install` builds node-pty against system Node. VSCode runs against its bundled Electron, which has a different ABI. If you see `posix_spawnp failed.` (no errno), three different binaries failing identically — that's the symptom. Fix: `npx electron-rebuild -f -w node-pty` (electron and @electron/rebuild are dev deps for this purpose).

## Cross-repo work

Sandy-side asks are tracked as GitHub issues on `rappdw/sandy` — filed 2026-07-03 from the former `handoffs/` docs: [#16](https://github.com/rappdw/sandy/issues/16) teleport, [#17](https://github.com/rappdw/sandy/issues/17) daemon-mode, [#18](https://github.com/rappdw/sandy/issues/18) print-state light, [#19](https://github.com/rappdw/sandy/issues/19) print-state workspace_path, [#20](https://github.com/rappdw/sandy/issues/20) network cleanup. (Upstream's own [#14](https://github.com/rappdw/sandy/issues/14) lock-lifecycle hardening superseded the old flock ask; the tmux allow-passthrough ask shipped upstream.) When a sandy-ui change needs a sandy-side companion, file an issue on `rappdw/sandy` with the full task spec in the body. `handoffs/` now holds task prompts only for repos where an issue can't be filed — currently just `dotfiles-sandy-teleport-prototype.md` for the owner's private, non-GitHub dotfiles repo.

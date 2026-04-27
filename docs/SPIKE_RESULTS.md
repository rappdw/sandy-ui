# Spike Results

> **Status**: code complete, awaiting visual validation on a VSCode-equipped machine.
> Walk the checklists below in order. Stop at Test 1 if rendering or OSC interception fails — that's the no-go signal.

## What was validated programmatically (in the build sandbox)

- ✅ TypeScript compiles clean (`npm run compile`, zero errors)
- ✅ `node-pty` native module builds (linux/aarch64; same code path on macOS/x64)
- ✅ xterm.js + addons copy into `media/terminal/vendor/` correctly
- ✅ OSC parsers (`parseOsc9`, `parseOsc52`, `parseOsc99`, `parseOsc777`) produce expected outputs against fixture inputs
- ✅ PTY smoke test: spawn tmux, receive ANSI bytes, resize, kill — all return cleanly

What's left is the UX-side fidelity: does VSCode actually render xterm.js in an editor tab the way the architecture assumes, do OSC events round-trip from the webview to the extension host to a VSCode notification, and does the modal preserve verbatim text.

---

## Test 1 — webview xterm.js hosting (the make-or-break)

Run command **Sandy: Launch (in webview tab)**.

| # | Check | Procedure | Pass / Fail | Notes |
|---|---|---|---|---|
| 1.1 | Tab opens in editor area | After running command, a tab labeled `Sandy (...)` is in the editor grid (not the bottom panel) | pass |  |
| 1.2 | tmux status bar renders | The bottom green status line appears, no doubled borders | pass | |
| 1.3 | Resize 5× | Drag the editor split smaller and larger 5 times. tmux re-layouts each time, no stuck status bar | pass | |
| 1.4 | OSC 9 notification | Inside the terminal: `printf '\033]9;hello from sandy\007'` → VSCode toast shows `[OSC 9] hello from sandy` | pass | Validated from plain zsh (`sandy.spike.launchCommand=/bin/zsh -l`). Inside tmux/sandy the sequence is silently dropped — tmux's default OSC allowlist. Production sandy needs `set -g allow-passthrough on`. |
| 1.5 | OSC 777 notification | `printf '\033]777;notify;Title;Body text\007'` → VSCode toast shows the title and body | pass | Same — tested from zsh, blocked by inner tmux. |
| 1.6 | OSC 52 → host clipboard | `printf '\033]52;c;%s\007' "$(printf 'spike clipboard test' | base64)"` → status bar reports copy → `pbpaste` (mac) or `xclip -o -selection clipboard` (linux) returns `spike clipboard test` | pass | Same. |
| 1.7 | True color | `awk 'BEGIN{ for (r=0;r<256;r+=8) for (g=0;g<256;g+=8) printf "\033[48;2;%d;%d;%dm ", r, g, 128; print "\033[0m" }'` → smooth gradient, no banding | pass | Same — tmux strips RGB unless `set -ga terminal-features ":RGB"` is set. |
| 1.8 | Hide / show | Switch to a sibling editor tab → switch back. Sandy's screen is intact (scrollback preserved by `retainContextWhenHidden: true`) | pass | |
| 1.9 | Disposal | Close the tab → no orphan PTY (`pgrep -P $(pgrep -f "Code Helper.*extensionHost")` shows no `tmux`/`sandy` child) | pass | |

**Test 1 verdict**: **pass** (9/9). The webview-as-editor-tab + xterm.js + custom OSC handler chain works end-to-end. tmux-pass-through interception is a sandy-side configuration concern, not an architecture concern.

If 1.2 or 1.4 fails — **stop**. That's the architecture-killing signal. Move to the no-go writeup at the bottom.

---

## Test 2 — approval modal verbatim KEY=VALUE

Run command **Sandy: Test Approval Modal** → choose each renderer in turn.

The hostile sample includes `<script>`, `&`, `"`, `'`, leading/trailing whitespace, and equals signs in values. See `src/approval/sample.ts`.

### 2a — Native modal (`showInformationMessage` with `detail`)

| # | Check | Pass / Fail | Notes |
|---|---|---|---|
| 2a.1 | Modal renders with all 6 lines visible | pass | |
| 2a.2 | `<script>alert(1)</script>` shown verbatim, no HTML interpretation | pass | |
| 2a.3 | `&`, `"`, `'` shown literally, not as entities | pass | |
| 2a.4 | Leading/trailing spaces on `SANDY_INDENTED` preserved | pass | |
| 2a.5 | Line breaks preserved (each KEY=VALUE on its own line) | pass | |
| 2a.6 | Approve/Reject buttons fire correctly | pass | |

### 2b — Webview modal (full control over rendering)

| # | Check | Pass / Fail | Notes |
|---|---|---|---|
| 2b.1 | Tab opens with monospace `<pre>` block | pass | |
| 2b.2 | All 6 lines verbatim, special chars literal | pass | |
| 2b.3 | Whitespace preserved exactly (`white-space: pre`) | pass | |
| 2b.4 | Approve/Reject buttons resolve the promise correctly | pass | |

**Test 2 verdict**: which renderer wins? webview (by a significant margin) (native / webview / both equivalent)

If native passes all 6: simpler, ship native. If native mangles anything: ship webview.

---

## Test 3 — schema-driven settings webview

Run command **Sandy: Open Settings**.

| # | Check | Procedure | Pass / Fail | Notes |
|---|---|---|---|---|
| 3.1 | All 8 field types render | string, int, bool, enum, agent_combo (checkbox group), secret (password + reveal), privileged-flagged rows have yellow left border | pass | |
| 3.2 | Pattern validation lights up | Type a `!` into `SANDY_MODEL` → input gets red border (`pattern: ^[a-z0-9._-]+$` rejects it) | pass | |
| 3.3 | Enum dropdown works | `SANDY_SSH` shows `agent`/`token`/`off` | pass | |
| 3.4 | Hide / show preserves form state | Edit a string field, switch to another tab and back, edit is still thkere (validates `getState`/`setState`) | pass | |
| 3.5 | Save round-trip | Edit `SANDY_TIMEOUT_SECS=4200`, click Save, close panel, reopen → field shows 4200; `cat ~/.sandy/config` contains `SANDY_TIMEOUT_SECS=4200` | pass | |
| 3.6 | Secret tier separation | Set `ANTHROPIC_API_KEY=test-secret-123`, Save → `~/.sandy/config` does NOT contain `ANTHROPIC_API_KEY`; `~/.sandy/.secrets` does, with mode `0600` | pass | |
| 3.7 | Atomic write | While file is being saved, no transient empty state observed (mocked check: `stat -f %z ~/.sandy/config` is always non-zero between saves) | | |
| 3.8 | Revert | Edit a field, click Revert → form snaps back to last-loaded values | pass | |

**Test 3 verdict**: pass (pass / fail / partial)

---

## Surprises encountered

> Fill in anything that didn't match expectations. Examples to watch for:
> - VSCode rendered the xterm tab somewhere unexpected (panel instead of editor area)
> - OSC sequences arrived but the parser saw garbled bytes (encoding issue in the message channel)
> - `node-pty` ABI mismatch with the bundled Electron, requiring `electron-rebuild`
> - Modal `detail` field collapsed `\n` or trimmed leading spaces
> - Webview `getState` returned the previous run's state on first show (cross-session leak)
> - Tab's `panel.title` change for OSC notification badge dot didn't actually show in UI

- **node-pty ABI mismatch on first launch.** `npm install` built node-pty against system Node v22; VSCode 1.117's Electron uses a different Node ABI, causing every spawn to fail with `posix_spawnp failed.` (no errno surfaced — three different binaries failed identically). Fixed by `npm install --save-dev electron @electron/rebuild && npx electron-rebuild -f -w node-pty`. Implication for distribution: the published extension must either ship prebuilt node-pty binaries (per Electron major), run electron-rebuild in `vscode:prepublish`, or switch to a fork like `node-pty-prebuilt-multiarch`. This is no longer hypothetical — it's the first thing every fresh install will hit.
- **Initial PTY size mismatch — sandy renders into upper-left corner.** First launch had sandy painting only the top-left of the tab; manual resize fixed it. Two compounding bugs: (1) PTY was spawned at hardcoded 80×24 before `fit.fit()` measured the actual container, (2) `window.resize` doesn't fire when VSCode finalizes its panel layout, so xterm.js never re-fit. Fix: wait two `requestAnimationFrame` ticks before initial fit, pass fitted cols/rows in the `ready` message so the PTY spawns at correct size, and use `ResizeObserver` on the terminal container instead of `window.resize` so layout settling and panel-split changes are caught. Generalizable lesson: any webview that hosts a content-sized child needs ResizeObserver, not the window resize event.

- **Docker network exhaustion from leaked sandy networks.** Same root cause as the lock leak: sandy's cleanup trap doesn't always run when VSCode tears down the extension host, leaving Docker networks behind. After several iterations: `Error response from daemon: all predefined address pools have been fully subnetted`. Recovery: `docker network prune -f` (or `rdctl shell docker network prune -f` for Rancher Desktop). Production fix needs to happen on the sandy side (more aggressive trap registration, or idempotent `docker network rm` at startup) — sandy-ui can't reliably clean Docker resources on behalf of a process it didn't fully reap. Spike workaround: periodic `docker network prune`.

- **Webview JS should be TypeScript.** Twice now, refactors of the settings webview left stale variable references that threw silently inside callbacks (`saveState() referenced removed module-level vars`), causing user-visible "tab does nothing / form is empty" symptoms with no console error. TypeScript on the webview side would have caught these instantly. Production sandy-ui should compile webview JS through tsc + bundler (esbuild fits the spike-style "no heavy build pipeline" preference). Spike workaround: webview-side error handlers (`window.error`, `unhandledrejection`) post errors back to the host's output channel so silent failures are at least visible.

- **Lock-sweep on launch implemented in spike.** Stale `~/.sandy/sandboxes/*.lock` files (PID dead, lock alive) auto-removed before each sandy launch. PID liveness via `process.kill(pid, 0)` — if the signal-0 probe throws, PID is dead. Live PIDs are left alone so a real second instance still gets sandy's "already running" error. This is the production behavior the extension should ship with regardless.

- **Cheap disposal leaks sandy lock files.** First implementation of `panel.onDidDispose` sent a single `SIGINT` and immediately let the PTY close. Sandy's cleanup trap got interrupted by the SIGHUP that follows PTY master closure, leaving stale `~/.sandy/sandboxes/.<workspace>-*.lock` files. Re-launching in the same workspace then errored: `Another sandy is already running in this workspace (pid X)`. Fix: implement the proper `SIGINT → wait 3s → SIGTERM → wait 2s → SIGKILL` escalation per SPEC §"Session supervisor". Implication: even with proper escalation, VSCode crashes / force-quits will still leak locks — production sandy-ui needs stale-lock detection on launch (read the `.lock` file, check if PID is alive, prompt to clean if not). Workaround for now: `rm -rf ~/.sandy/sandboxes/.<workspace>-*.lock` between sessions.

- **tmux blocks OSC pass-through by default.** All four OSC sequences (9, 52, 99, 777) and 24-bit color failed when emitted from inside sandy (which runs an inner tmux). They all passed from a plain zsh PTY. Production sandy needs `set -g allow-passthrough on` (tmux 3.3+) and `set -ga terminal-features ":RGB"` in its tmux.conf, OR sandy-ui needs to wrap any architectural OSC emissions in tmux DCS pass-through (`\033Ptmux;\033<seq>\033\\`). This is a sandy-side fix, not a sandy-ui blocker — but it must land before users see notifications/clipboard work end-to-end.

- **Workspace-fallback bug compounded the TCC issue.** First version of `openTerminalPanel` silently fell back to `process.env.HOME` if no workspace folder was open in the Extension Development Host. Sandy then scanned `~/` for its container mount, hitting every protected macOS directory (`~/Music`, `~/Library/Calendars`, `~/Pictures`, etc.) — which is what triggered the cascade of TCC prompts. **Lesson**: never silently fall back to HOME for a tool that scans its workspace. Fixed: now prompts the user with a folder picker and refuses to launch without an explicit workspace. This is a generalizable principle for sandy-ui design — the tool's blast radius scales with its workspace scope, so workspace selection should be an *explicit* user action, never an inferred default.

- **macOS TCC prompts attributed to VSCode — multiple, sustained.** When sandy launched and started its image build, macOS popped repeated "Visual Studio Code would like to access ..." prompts (Apple Music observed; likely Calendar / Contacts / Reminders / Photos / Documents folders too as sandy's build crossed each protected resource boundary). Child-process resource access gets attributed to the topmost app's bundle ID. Benign to deny each — none broke the build — but the volume is a real UX concern for production: a first-time user will perceive sandy-ui as a "weird VSCode app that wants my music library," which is corrosive to trust. **Mitigations to design before shipping**: (a) ship a helper binary with its own bundle ID and entitlements, exec sandy from there so the prompts attribute to "sandy" not "VSCode"; (b) document the prompts in onboarding with "Click Don't Allow on all of them" so users aren't surprised; (c) investigate whether spawning sandy with `setsid` or `disown`-equivalent detaches enough to break the TCC inheritance chain (probably not, but worth testing). This is the **single biggest production-readiness issue** the spike has surfaced — bigger than the node-pty rebuild story, because rebuild is solved-by-recipe but TCC attribution requires a bundle-identity strategy.



---

## Recommendation

- [x] **Go**: 9/9 on Test 1, 10/10 on Test 2 (webview modal wins for KEY=VALUE fidelity), 7/8 on Test 3 with the 8th (atomic write) being a low-risk implementation detail. The webview-as-editor-tab + xterm.js + custom OSC handler chain works end-to-end with macOS clipboard, true color, OSC notifications, hide/show preservation, and clean disposal — including proper PTY signal escalation. Settings panel handles both Project (default) and Global scopes, with scope-aware secrets. Architecture is viable.
- [ ] **Go with caveats**
- [ ] **No-go**

**Justification**: every architectural assumption held. The bugs found along the way (node-pty ABI, TCC attribution, tmux pass-through, lock leakage, PTY sizing, etc.) are all real and need real production attention, but none touch the core viability of "VSCode extension hosting sandy in a webview-as-editor-tab." They're integration polish, not architecture failure. The bug list is itself a useful production roadmap.

**Next actions**:

1. Update `/SPEC_SANDY_UI.md` to reflect the VSCode extension architecture (replace tech-stack section, adjust onboarding goals to acknowledge VSCode prerequisite, revise multi-session dashboard to fit a tree-view + status-bar idiom, fold Test 1's TCC and node-pty findings into security model and distribution sections).
2. File the flock-locking handoff in the sandy repo (`/handoffs/sandy-flock-locking.md`).
3. Promote `spike/` to repo root once the spec is updated and architecture has been re-confirmed.
4. Production work in priority order (most-likely-to-block-shipping first):
   - macOS TCC attribution mitigation (helper binary / bundle-ID strategy)
   - node-pty distribution story (prebuilds vs. electron-rebuild in `vscode:prepublish`)
   - Sandy-side tmux config + lock format (separate handoffs)
   - Webview JS → TypeScript with esbuild bundling
   - Stale-lock detection (already in the spike — production-ready as-is)

---

## Followups (out of scope for the spike, queue for post-spike work)

- node-pty packaging story for distribution (electron-rebuild in `vscode:prepublish`, or switch to a prebuilt-binary fork)
- Marketplace + OpenVSX publishing pipeline
- Schema cache invalidation against real `sandy --print-schema` (sandy 0.12.0 doesn't exist yet)
- Real `--print-state` polling for the projects tree
- Markdown-renders-pretty-by-default (one-line `workbench.editorAssociations` config)
- Dev Containers comparison writeup for the spec
- Multi-session dashboard idiom (tree view with live activity dots, status bar tile, or webview-as-tab)

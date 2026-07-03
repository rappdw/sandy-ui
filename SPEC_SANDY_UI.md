# Sandy UI Specification

**Status**: Draft, post-spike
**Target**: `sandy-ui` 0.1.0 (independent repo: `rappdw/sandy-ui`)
**Architecture**: VSCode extension (revised from initial Tauri direction — see `/spike/SPIKE_RESULTS.md` for the validation that drove this pivot)
**Companion**: [SPEC_INTROSPECTION.md](SPEC_INTROSPECTION.md) — the schema this UI consumes
**Minimum sandy**: 0.12.0 (first release with `--print-schema`)
**Minimum VSCode**: 1.85 (stable webview-as-editor-tab + `Pseudoterminal` API)

## Motivation

`sandy` is a great daily driver for users already comfortable with a terminal, Docker, and bash config files. But the onboarding story is rougher than it needs to be:

- First-time setup requires installing sandy, understanding the three-phase Docker build, editing `~/.sandy/config`, and picking an agent — all from man-page-style docs.
- The passive-privileged approval flow (asking a user to approve `SANDY_SKIP_PERMISSIONS=1` set from a workspace config) has to be explained on the terminal; most users have never read the tier-split rationale and don't know what they're approving.
- Running multiple sandy sessions across several projects means juggling multiple terminal tabs, each with its own tmux, with no single place to see "what's running", "what finished", "what's waiting on my input".
- Settings live in `.sandy/config` files. Editing them requires knowing which key goes in which tier. A UI with typed form fields, tooltips, and live validation is a much better experience than a dotfile.

`sandy-ui` is a **VSCode extension** that wraps the sandy CLI. It does **not** replace sandy — sandy remains the authoritative runtime. The UI is a consumer of sandy's introspection output (the `--print-schema` / `--print-state` contract defined in [SPEC_INTROSPECTION.md](SPEC_INTROSPECTION.md)) plus a webview-hosted terminal running the sandy TUI as an editor tab. Editor chrome (Source Control, diff viewer, file tree, markdown preview, command palette) is reused rather than rebuilt — sandy generates large volumes of code changes per session and triaging them is the primary "thing the user does between prompts," for which VSCode's source-control panel is purpose-built.

The original spec proposed Tauri + xterm.js as a standalone app. That direction was reconsidered when the editor-as-secondary-pane assumption shifted: if the user spends real time digesting AI-generated diffs, you want a real IDE around the terminal, and rebuilding source control + diff + multi-file search on top of Tauri is years of work for parity VSCode already ships. A 1-day spike (`/spike/`) validated the VSCode extension shape — webview-as-editor-tab hosting xterm.js with custom OSC handlers, pre-flight approval as a webview modal, schema-driven settings webview with Project/Global scope tabs.

## Goals

- **Lower the onboarding barrier** to the point where a developer who's never used Claude Code, Docker, or a containerized dev environment can be running their first sandy session in under five minutes (assuming VSCode is already installed — that's the prerequisite floor).
- **Make multi-session usage first-class**: see all running / recent sessions at a glance via tree view + status bar, switch between them, notice when one needs input.
- **Surface dangerous config edits before they silently change behavior** — passive-privileged approvals, LAN-host allowlists, `SANDY_SKIP_PERMISSIONS`, etc. — with full KEY=VALUE transparency in a webview modal that renders content verbatim (no HTML interpretation, no whitespace collapse, no line wrapping).
- **Stay out of the user's way** when they don't need it: nothing the extension does should prevent or interfere with running `sandy` directly from the terminal.
- **Track sandy's schema versions explicitly** so a newer sandy doesn't silently break an older UI (and vice versa). Compatibility is declared, not hoped for.
- **Don't reinvent IDE chrome.** Source Control, diff viewer, file tree, markdown preview, problems panel, command palette, multi-cursor edits, GitLens, language servers — all inherited from VSCode. The extension adds sandy-shaped surfaces around them.

## Non-goals

- Not a sandy runtime replacement. The extension spawns `sandy` as a subprocess; it does not reimplement container launching, image building, credential seeding, or any isolation logic.
- Not a terminal replacement. The embedded webview-terminal is for hosting the sandy TUI; users who prefer their own terminal (iTerm2, WezTerm, cmux, etc.) should continue to use it. The extension's terminal is a convenience, not a lock-in.
- Not a remote control for somebody else's sandy. The extension talks only to the local `sandy` binary and the local Docker daemon. Multi-machine support is out of scope.
- Not a generic Docker UI — we are not building Docker Desktop. Sandy-ui does not list unrelated containers, manage Docker's own config, or touch networks outside sandy's per-PID bridge.
- Not tied to Claude — the agent-abstraction sandy already has (claude / gemini / codex / combos) is respected; the extension does not assume the user's default is claude.
- Not a package manager for skill packs — skill pack configuration flows through the existing `SANDY_SKILL_PACKS` config key (with a dropdown populated from the schema); the extension does not install, version, or distribute skill packs itself.
- **Not a JetBrains / Zed / Neovim plugin** in the 0.1 timeframe. Those editors get the CLI experience; the GUI value-add is VSCode-only (and, by extension, VSCode forks via OpenVSX — Cursor, Windsurf, VSCodium). A separate plugin per editor is a 1.0+ consideration if demand materializes.
- **Not VSCode's native terminal.** VSCode's integrated terminal silently swallows OSC 9 / 52 / 99 / 777 with no extension hook (microsoft/vscode#193508 and related), and its terminal-as-editor placement has known bugs. Sandy-ui hosts xterm.js inside a webview-as-editor-tab instead, which gives full OSC control and reliable placement.

## MVP scope

The 0.1.0 release targets the smallest surface that delivers daily value without partial features that rot. Four pillars:

### 1. Project picker (activity bar tree view)

A `Sandy` view container in the activity bar with a `Projects` tree. Each entry shows:

- Workspace path (abbreviated with `~` where applicable)
- Last-used agent and model
- Last-launched timestamp
- Sandbox state indicator (icon): fresh / current / stale / locked / running
- Click the entry → invokes `Sandy: Launch` for that workspace
- Right-click context menu: Detach, Stop, Open Settings (project scope), Revoke approval

A **"+ Add project"** action in the tree title bar opens VSCode's native folder picker; on selection, the extension runs `sandy --validate-config $FOLDER/.sandy/config` (if present) and shows any warnings before first launch. Project entries also surface from VSCode's recent-folders list.

**Data source**: `sandy --print-state` (sandboxes list, polled), plus a UI-side `projects.json` (in the extension's globalStorageUri) with workspace paths the user has opened from sandy-ui (even if no sandbox exists yet).

### 2. Webview-hosted terminal as an editor tab

Each launched project opens a **webview tab in the editor area** (not VSCode's bottom terminal panel — that path silently swallows OSC sequences). The webview hosts xterm.js bound to a `node-pty` spawn of `sandy`. Features:

- **xterm.js terminal** with 256-color + 24-bit true-color, OSC 52 clipboard passthrough routed to `vscode.env.clipboard`, OSC 8 hyperlinks via `xterm-addon-web-links`.
- **OSC 9 / 99 / 777 notifications** intercepted in the webview by `term.parser.registerOscHandler`, posted to the host, surfaced as VSCode notifications. The tab title gets a `●` prefix as a badge until the user re-focuses the tab.
- **Resize** via `ResizeObserver` on the terminal container (NOT `window.resize`, which misses VSCode's panel-layout settling). Initial PTY dimensions come from the webview's first `fit.fit()` measurement, not a hardcoded default — otherwise sandy renders into the upper-left corner until manual resize.
- **Hide/show preserves scrollback** via `retainContextWhenHidden: true`. Switching to a sibling editor tab and back keeps sandy's screen intact.
- **"Stop"** command per tab: sends `SIGINT` → waits 3s → `SIGTERM` → waits 2s → `SIGKILL`. Sandy's own cleanup trap handles container teardown. Without the wait, the trap is interrupted by SIGHUP from PTY closure and stale lock files / Docker networks survive.
- **Stale-lock sweep on launch**: before spawning sandy, inspect `~/.sandy/sandboxes/.<basename>-*.lock` files for this workspace; if any has a dead PID, remove it. (Long-term, sandy-side lock hardening — [rappdw/sandy#14](https://github.com/rappdw/sandy/issues/14); flock(2) was evaluated and rejected upstream since macOS ships no flock CLI — makes this sweep unnecessary.)
- **"Detach"** command: closes the tab without stopping the subprocess. Re-attach re-binds a fresh PTY view to the existing process.
- **No tmux-in-tmux** — sandy's own inner tmux is the only tmux in the stack. Sandy-ui must NOT host its own multiplexer.

The webview-side JS is TypeScript (compiled with the same `tsc` invocation as the extension code) — silent runtime errors in vanilla webview JS were a recurring source of confusion in the spike, and TS catches them at compile time.

### 3. Pre-flight approval modal (webview)

Before any `sandy` subprocess starts, the extension runs `sandy --validate-config ${WORKSPACE}/.sandy/config` and surfaces the result as a **webview-based modal** (not `showInformationMessage`) when there's something the user needs to see:

- **Privileged keys set from passive source** (`approval_status: "pending"`) → modal shows the raw `KEY=VALUE` set inside a `<pre>` block with `white-space: pre`, rendered via `textContent` (not `innerHTML`) — guaranteed verbatim. Includes a diff vs. the last-approved set (if any), and Approve / Reject buttons.
- **World-open LAN allowlists** (`SANDY_ALLOW_LAN_HOSTS=0.0.0.0/0` etc.) → modal refuses the launch and points to the remediation.
- **Unknown keys** → inline warning in the settings panel, not a modal (low-severity).
- **Sandbox compat warning** (`created_version` predates `SANDY_SANDBOX_MIN_COMPAT`) → modal with "Rebuild sandbox" or "Launch anyway".

Webview modal over `vscode.window.showInformationMessage({modal:true})` because the spike validated that webview gives full control over rendering verbatim text (`<script>`, `&`, `"`, leading whitespace all preserved without HTML encoding) — the native modal's `detail` field works for plain content but is undocumented around special characters and whitespace, and that's exactly the case where this approval modal is the security gate. Predictable trumps simpler.

The extension never fakes an approval. When the user clicks "Approve", `sandy` is invoked with `SANDY_AUTO_APPROVE_PRIVILEGED=1` in the subprocess environment for **that single launch** — the environment does not leak. Sandy's CLI writes the persistent approval record the same way it does today; the extension reads it via `--print-state` on the next launch to decide whether to show the dialog again.

### 4. Settings editor (webview, scope tabs)

A webview panel with two scope tabs: **Project** (default) and **Global**. Each tab edits its own files:

- Project → `<workspace>/.sandy/config` and `<workspace>/.sandy/.secrets`
- Global → `~/.sandy/config` and `~/.sandy/.secrets`

Switching tabs preserves in-progress edits per scope (each scope tracks its own `formValues` in webview state). Form fields are driven by the schema from `sandy --print-schema`:

- String fields → text input with `pattern` from the schema as live validation.
- Int fields → number spinner with `min` / `max` bounds.
- Enum fields → dropdown (e.g., `SANDY_SSH`: `token` / `agent`).
- Bool fields → toggle.
- Secret fields (`ANTHROPIC_API_KEY`, etc.) → masked input with reveal-on-click and a visible "✓ set" / "not set" badge per scope. Values write to the scope's `.secrets` file.
- Agent-combo fields (`SANDY_AGENT`) → checkbox group, comma-serialized on save.

When the **Project** tab is active, a banner warns about (a) privileged keys triggering the passive-privileged approval flow on next launch and (b) workspace `.secrets` files being a footgun for committed repos (advise adding `.sandy/.secrets` to `.gitignore`). The file is still writable — gatekeeping edits is not the extension's job, but warning before damage is.

Original spec routed all secrets to `~/.sandy/.secrets` regardless of scope; this is loosened to allow per-project secrets (different API keys per project is a real use case). The `.gitignore` warning is the spec-level mitigation.

**Save** writes the file atomically (temp + rename). **Revert** discards pending edits. **"Open in editor"** hands off to VSCode's editor for users who want to edit the raw file (and get diff against git for free).

The settings form is not modal — it's a regular editor tab. The user can have it open alongside a running sandy session.

## Post-MVP scope

Deliberately not in 0.1.0, but ordered roughly by expected priority:

### Multi-session dashboard

A single-screen view showing every running sandy session across all projects: project name, agent, elapsed time, last activity, resource usage (CPU/mem from `docker stats`), and a thumbnail-size live preview of the terminal. Click to jump to the tab. Notifications surfaced per-project.

Depends on: a lightweight poll of `docker stats` + `sandy --print-state` at 2–5s cadence.

### Onboarding wizard

A guided first-run experience triggered by the **Sandy: Get Started** command (and offered automatically on extension activation if no sandy install is detected):

1. **Check prerequisites** — sandy installed (`which sandy`), Docker installed and running, disk space, `~/.sandy` writable, `~/.local/bin` on PATH. Surface fix-it links for each.
2. **macOS TCC guidance** — if on macOS, advise: "Open a *specific project folder*, not your home directory — sandy scans its workspace, and a home-dir workspace makes macOS prompt for Music / Calendar / etc. access (attributed to VSCode)." For a normal project this is a non-issue; the worst case is a single "VSCode wants Documents access" prompt if the project lives under `~/Documents`/`~/Desktop`/`~/Downloads`, which is safe to Allow. (Previously this step warned of a prompt *barrage* and said "Don't Allow on all" — that only applied to the `$HOME` case the no-`$HOME` guardrail now prevents.)
3. **Pick agent(s)** — claude / gemini / codex with tooltips explaining each; recommendation based on which credentials the extension detects on the host.
4. **Authenticate** — for Claude, run `claude /login` in a one-shot terminal; for OpenAI, prompt for API key (writes via the settings webview's secret-field flow) or run `codex login`; for Gemini, detect ADC / tokens.json.
5. **Build images** — `sandy --rebuild` with progress rendered as a structured timeline (phase 1 base → phase 2 agent → optional skill packs), parsing stdout.
6. **Run a test session** — launch a throwaway sandy in a temp workspace, watch the agent start up, confirm it responds.

Wizard is skippable at any step; every screen is reachable later via command palette (`Sandy: ...`).

### Session history

Every completed session logs to the extension's `globalStorageUri/history/YYYY-MM-DD-$SANDBOX.log` (plain-text terminal capture, capped at e.g. 50 MB per session with rolling truncation). A dedicated webview (or VSCode tree view + native editor for reviewing individual logs) lets the user scroll back through finished runs, copy text, re-launch with the same workspace. Host-side only — sandy itself has no session-logging feature and this spec does not add one.

### Observer mode

A read-only view of a running session the user didn't launch from the UI (e.g., a sandy started from the terminal). Backed by `docker exec ... tmux capture-pane` or `docker attach` in read-only mode. Useful for "I want to keep my terminal session and also see its output in the multi-session dashboard."

### Workspace `.sandy/` creator

When adding a project that doesn't yet have `.sandy/`, offer to create it with a starter config. Includes a "Copy from another project" option. Explicit — does not auto-create on project add.

### Skill pack browser

Read `SANDY_SKILL_PACKS` from the schema (source list including `repo`, `description`) and present a pick-list. Writes `SANDY_SKILL_PACKS=name1,name2` to the home or workspace config. No separate download step — sandy's existing build phase handles it.

## Tech stack

**VSCode extension** targeting VSCode 1.85+ and forks via OpenVSX.

- **Language**: TypeScript for both extension host code AND webview code. Vanilla webview JS is too easy to break with stale references after refactors (proven the hard way in the spike); compile both through `tsc` with the same strictness.
- **Bundler**: `esbuild` for the webview side (fast, single-file output, low overhead). Extension host is `tsc`-only — no bundler needed since it runs in Node.
- **PTY hosting**: `node-pty`, with `electron-rebuild` wired into `vscode:prepublish` to match VSCode's bundled Electron ABI. Alternative under evaluation: `node-pty-prebuilt-multiarch` which ships prebuilds for common Electron majors (avoids the rebuild step at the cost of pinning to whichever ABIs the upstream maintainer covers).
- **Terminal rendering**: `xterm.js` (the same library VSCode's own terminal uses internally), inside a webview. Required addons: `xterm-addon-fit`, `xterm-addon-web-links`. Custom OSC handlers (`term.parser.registerOscHandler`) for 9 / 52 / 99 / 777 — these are NOT processed by xterm.js's built-in clipboard addon (which we do not load) so we have full control over routing.
- **Webview-as-editor-tab** (`vscode.window.createWebviewPanel(..., vscode.ViewColumn.Active, ...)`) instead of VSCode's native terminal. The placement is reliable in this mode (unlike `createTerminal({location: ...})` which has open placement bugs in microsoft/vscode), and OSC sequences are fully under our control.

**Rejected alternatives**:

- **Tauri** (the original spec direction): standalone shell, would require rebuilding source-control panel, diff viewer, file tree, multi-file search, markdown preview, problems panel, and language-server integration. That's years of work for parity with VSCode features users already rely on.
- **VSCode's native integrated terminal**: silently swallows OSC 9 / 52 / 99 / 777 (microsoft/vscode#193508) with no extension hook. Sandy-ui's tab notifications + clipboard passthrough are load-bearing, so this path is unworkable.
- **Theia / VSCodium fork**: redundant maintenance burden vs. shipping as an extension that runs in both real VSCode and OpenVSX-distributing forks (Cursor, Windsurf, Codium, etc.) for free.
- **Browser-based UI on a local HTTP server**: complicates the security model (loopback ports, token exchange) for no IDE-chrome benefit.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  VSCode window                                                   │
│ ┌──────────┬───────────────────────────────────────────────────┐ │
│ │ Activity │  Editor area (webview tabs + native editors)      │ │
│ │ bar:     │ ┌────────────────────┬────────────────────────┐   │ │
│ │          │ │ Sandy webview tab  │ src/foo.ts             │   │ │
│ │ ▸ Sandy  │ │  ┌──────────────┐  │ (regular editor; edits │   │ │
│ │  • Proj  │ │  │  xterm.js    │  │  flow to host fs,      │   │ │
│ │          │ │  │ + OSC 9/52/  │  │  mounted into the      │   │ │
│ │ ▸ SCM    │ │  │   99/777     │  │  sandy container)      │   │ │
│ │ ▸ Files  │ │  └──────┬───────┘  │                        │   │ │
│ │          │ │         │ postMsg  │                        │   │ │
│ └──────────┘ └─────────┼──────────┴────────────────────────┘   │ │
│                        │                                       │ │
│   Status bar: [● 2 sandy sessions] [pid 22567 · claude · 4m]   │ │
│ └──────────────────────┼─────────────────────────────────────┘ │
└────────────────────────┼─────────────────────────────────────────┘
                         │ extension host (Node)
        ┌────────────────┼─────────────────┬────────────────┐
        │                │                 │                │
┌───────┴──────┐  ┌──────┴────────┐  ┌─────┴──────────┐  ┌──┴─────────────┐
│ Schema cache │  │ PTY supervisor│  │ Lock-sweep +   │  │ Docker API     │
│ + --print-   │  │ (node-pty)    │  │ stale-state    │  │ (read-only:    │
│   state poll │  │ + signal      │  │ recovery       │  │  ps/stats)     │
│              │  │ escalation    │  │                │  │                │
└──────┬───────┘  └───────┬───────┘  └───────┬────────┘  └────────┬───────┘
       │                  │                  │                    │
┌──────┴───────┐  ┌───────┴───────┐  ┌───────┴────────┐  ┌────────┴───────┐
│ sandy CLI    │  │ sandy CLI     │  │ ~/.sandy/      │  │ Docker         │
│ (introspect) │  │ (PTY-attached │  │ sandboxes/     │  │ socket         │
│              │  │  subprocess)  │  │  *.lock        │  │                │
└──────────────┘  └───────────────┘  └────────────────┘  └────────────────┘
```

### Schema cache

- Runs `sandy --print-schema` once on extension activation and on every `sandy-ui` version bump.
- Result cached in the extension's `globalStorageUri/schema-cache.json` with the sandy version that produced it.
- If the cached `sandy.version` differs from the current `sandy --version`, re-fetches.
- Drives the settings editor, field validation, and the agent/model pickers.

### PTY supervisor

Tracks each launched `sandy` subprocess: PID, workspace, webview-tab ID, PTY handle, exit code, start/end time. One supervisor instance per extension activation, surviving individual webview disposal so detach/re-attach works.

- **Launch**: `node-pty` spawn of `sandy` with the workspace as cwd, PTY dimensions from the webview's first `fit.fit()` measurement (NOT a hardcoded default), env restricted to a whitelist (`HOME`, `USER`, `PATH`, `LANG`, `LC_*`, `TERM`, `SHELL`, `SSH_AUTH_SOCK` if `SANDY_SSH=agent`, plus enabled `SANDY_*` vars).
- **Stop**: `SIGINT` → wait 3s → `SIGTERM` → wait 2s → `SIGKILL`. The 3-second SIGINT wait is load-bearing — sandy's cleanup trap does `docker stop` and `docker network rm`, which is slow; cutting it short leaks lock files and Docker networks. The supervisor never calls `docker kill` directly.
- **Pre-launch lock sweep**: scan `~/.sandy/sandboxes/.<basename>-*.lock` for the workspace; if any has a dead PID (verified via `process.kill(pid, 0)` distinguishing ESRCH from EPERM), remove it. Live PIDs are left alone so a real concurrent sandy still gets sandy's "already running" error. Until sandy adopts flock(2), this sweep is the production behavior; once flock(2) lands, this becomes belt-and-suspenders.
- **Detach**: closes the webview tab without stopping the subprocess. Re-attach re-binds a fresh PTY view; scrollback before re-attach is lost (tmux inside sandy preserves the live screen).

### Docker API client

For `--print-state` data augmentation and the optional multi-session dashboard.

- Linux: `/var/run/docker.sock` (Unix socket).
- macOS: Docker Desktop's socket at `~/.docker/run/docker.sock` (Desktop 4.x+) or `/var/run/docker.sock` symlink.
- Windows: named pipe `\\.\pipe\docker_engine`.

Only used for read-only operations: `ps --filter label=sandy`, `stats`, `inspect`. Never issues `run`, `rm`, `kill`, or image operations — those go through the sandy CLI.

## Key flows

### Launching a project

1. User invokes **Sandy: Launch** (command palette, projects-tree click, or status-bar quick-pick).
2. If no workspace folder is open, prompt for one with VSCode's folder picker — never fall back to `$HOME` silently (a tool that scans its workspace can blast-radius the entire user account on macOS).
3. Pre-launch lock sweep: scan `~/.sandy/sandboxes/.<basename>-*.lock` for this workspace, remove any with dead PIDs.
4. Run `sandy --validate-config $WORKSPACE/.sandy/config` (short timeout, non-blocking on its own).
5. If `--validate-config` returns `approval_status: "pending"`, open the pre-flight modal in a webview tab. User approves or rejects.
6. On approve, create a webview-as-editor-tab in `ViewColumn.Active`, instantiate xterm.js, wait for the webview's first `fit.fit()` to send fitted dimensions, then `node-pty` spawn `sandy` against the workspace at those dimensions. Subprocess env is the whitelist plus `SANDY_AUTO_APPROVE_PRIVILEGED=1` if the user just approved via UI; the env does not leak to the next launch.
7. Terminal renders, user sees sandy's startup output.
8. On exit, tab stays open showing the final screen; **Relaunch** action appears in the tree-item context menu.

### Editing settings

1. User invokes **Sandy: Open Settings** (command palette or tree-item context menu).
2. Webview opens with two scope tabs — Project (default) and Global. Each loads its own `<scope>/.sandy/config` and `<scope>/.sandy/.secrets`, overlays on the schema form.
3. User edits fields; live validation against `pattern` / `min` / `max` from schema.
4. Switching scope tabs preserves in-progress edits per scope (each scope tracks its own form state via webview `getState`/`setState`).
5. **Save** writes both files atomically (temp + rename); read-back verification logs any write/read mismatch to the output channel.
6. `sandy --validate-config <path>` runs after save to confirm the file parses; if it doesn't, surface the error (the file is left in place — sandy is the source of truth on what's valid, the extension reports what sandy says).

### Multi-session dashboard (post-MVP)

Three idiom options, in increasing complexity:
1. **Tree view + status bar** (lightest): the existing Projects tree shows a state badge per entry; status bar item shows total count and quick-pick to switch. Polls `sandy --print-state` every 5s.
2. **Status bar tile** (medium): status bar item with project-state heatmap; quick-pick on click.
3. **Webview-as-editor-tab dashboard** (heaviest): tile grid with thumbnails (`docker exec <id> tmux capture-pane -t sandy:0 -p`, rate-limited to 10s/tile, suspended when tab not visible). Click tile → focus that session's webview tab.

Decide based on user feedback after MVP ships. Default to (1) since it costs nothing extra to build.

### Onboarding (post-MVP)

Wizard state persisted in `~/.sandy-ui/onboarding.json`. Skippable from any step. Each step polls a readiness check and unlocks **Next** when ready; the wizard never advances invisibly.

### Approvals

The UI never bypasses sandy's approval flow silently. Every passive-privileged approval is shown with the raw `KEY=VALUE` lines that would be approved — no summarizing, no pre-filtering. If the user clicks **Reject**, the UI exits the launch without starting sandy; the user can edit the workspace config and retry.

Revocations are surfaced in the project settings panel: each workspace with a persisted approval has a **Revoke approval** button that deletes `~/.sandy/approvals/passive-<hash>.list`. The next launch will re-prompt.

## State and persistence

Extension state uses VSCode's built-in storage APIs where appropriate (workspace + global) and the extension's `globalStorageUri` for larger artifacts:

| Where | What |
|---|---|
| `vscode.ExtensionContext.globalState` | last-used agent / model per workspace, recent projects list |
| `vscode.ExtensionContext.workspaceState` | per-workspace flags (e.g., approval revocation acknowledged) |
| `globalStorageUri/schema-cache.json` | cached `sandy --print-schema` output, keyed by sandy version |
| `globalStorageUri/onboarding.json` | wizard state (post-MVP) |
| `globalStorageUri/history/` | session transcripts (post-MVP) |
| Webview `getState`/`setState` | per-webview UI state — form values mid-edit, scope tab selection, scroll position |

VSCode-managed state survives reload, sync (when the user enables Settings Sync), and reinstall. Custom storage in `globalStorageUri` is opaque to VSCode but lives under VSCode's control and is uninstall-clean.

Sandy's own state — `~/.sandy/config`, `~/.sandy/.secrets`, `~/.sandy/sandboxes/*`, `~/.sandy/approvals/*`, plus the new per-workspace `<workspace>/.sandy/config` and `<workspace>/.sandy/.secrets` — is read-and-edit but never *owned* by the extension. The extension makes the same edits a user would make from the shell; the format and semantics belong to sandy.

## Security model

Running sandy-ui has the same privilege as running `sandy` directly from a shell. That is:

- **Docker socket access is host-level privilege.** Anyone who can run `docker` can escape any container and root the host. The extension's threat model assumes the user already has that privilege and is running VSCode locally; the extension does not itself add attack surface.
- **No exposed network ports.** The extension binds to nothing. All IPC is in-process: webview ↔ extension host via VSCode's `postMessage` channel, extension host ↔ sandy via PTY. No sockets, no loopback servers.
- **The extension never stores secrets in its own state.** Secret input fields write to the user-selected scope's `.secrets` file (`~/.sandy/.secrets` for Global scope, `<workspace>/.sandy/.secrets` for Project scope). The extension keeps secrets in memory only for the duration of the form. Workspace-scope secrets carry a footgun warning in the UI (commit risk) and a recommendation to add `.sandy/.secrets` to `.gitignore`.
- **Pre-flight approvals are the security gate, not rubber-stamping.** The webview modal renders raw `KEY=VALUE` content via `textContent` (not `innerHTML`) inside a `<pre white-space:pre>` block — verbatim guarantee for special chars (`<script>`, `&`, `"`), whitespace, and line breaks. A malicious `.sandy/config` in a cloned repo cannot hide behind a prettified summary. This matches the design intent of the underlying passive-privileged approval flow in sandy.
- **`sandy` is invoked with a clean subprocess environment** — only whitelisted variables pass through. This prevents ambient env vars in the VSCode process (set e.g. by the user's shell rc files when VSCode was launched from terminal) from silently affecting sandy's behavior. Whitelist: `HOME`, `USER`, `PATH`, `LANG`, `LC_*`, `TERM`, `SHELL`, `SSH_AUTH_SOCK` (if `SANDY_SSH=agent`), plus the subset of `SANDY_*` and agent-credential env vars the user has explicitly enabled in extension settings.
- **macOS TCC bundle-ID attribution is a minor UX issue (reassessed — was previously flagged as the top blocker).** macOS attributes a process's access to protected resources to the topmost app's bundle ID — i.e., Visual Studio Code — so prompts read "VSCode wants access to ...". Dogfooding revised the severity down: the alarming *cross-category cascade* ("VSCode wants your Music / Calendar / Contacts") only occurs when sandy is launched against an over-broad workspace like `$HOME`, whose scan walks into `~/Music`, `~/Library/Calendars`, etc. That cause is now structurally prevented — the extension refuses to default to `$HOME` and forces an explicit folder pick (see the next bullet). With a normal narrow project workspace, sandy never touches those categories and no cascade appears. The only residual case is a project kept under a TCC-protected data folder (`~/Desktop`, `~/Documents`, `~/Downloads`, protected since Catalina), which draws a *single* "VSCode wants access to Documents" prompt — one prompt, in a category where the user already expects their editor to read files. Mitigations, in order of cost: (a) document it in onboarding ("open a specific project folder, not your home dir") — cheap and likely sufficient; (b) ship a thin helper binary with its own bundle ID + entitlements so attribution lands on "sandy" — nice-to-have, needs an Apple Developer ID; (c) `setsid` / detached spawn probably doesn't help (TCC tracks responsible-process ancestry, not the controlling tty). **No longer a distribution blocker** given the no-`$HOME` guardrail.
- **Workspace selection is explicit, never inferred.** A bug in the spike's first iteration silently fell back to `process.env.HOME` if no workspace folder was open, causing sandy to scan the entire home directory and trigger the TCC cascade above. Production extension refuses to launch without an explicit workspace folder. Generalizable principle: a tool's blast radius scales with its workspace scope, so workspace scope must be a user choice, not an inferred default.
- **No telemetry** in 0.1.0. If telemetry is added later, it is off by default, opt-in only, and does not exfiltrate workspace paths or file contents.

## Compatibility with sandy

`sandy-ui` declares:

```json
{
  "ui_version": "0.1.0",
  "sandy_min_version": "0.12.0",
  "sandy_schema_versions_supported": [1]
}
```

On UI launch, the UI runs `sandy --print-schema` and:

- **Schema version missing**: sandy is too old. Show upgrade prompt, refuse to launch.
- **Schema version in `supported` list**: proceed.
- **Schema version outside `supported`** (sandy newer than UI knows): show a soft warning: "This sandy (version X, schema Y) is newer than what sandy-ui Z was tested against (schema 1). Some features may not work. Upgrade sandy-ui to match." Allow proceeding with best-effort rendering of known fields.
- **Sandy too new by a major schema jump** (e.g., sandy schema 3, UI supports 1): refuse launch, point to upgrade path.

The inverse — sandy newer than `sandy_min_version` within a supported schema — is the normal case and requires no UI change. The schema's additive-change rule (see [SPEC_INTROSPECTION.md](SPEC_INTROSPECTION.md)) means new keys appear without breaking the UI; the UI ignores them.

## Release cadence

Independent from sandy. `sandy-ui` releases on its own schedule; compatibility is explicit via the `sandy_schema_versions_supported` list, not by matching version numbers. This means:

- A sandy point release (0.12.1) that adds a new passive key: UI continues to work unchanged; the new key appears in the settings form on next schema refresh, rendered with whatever default UI widget matches its `type`.
- A sandy minor release (0.13.0) that deprecates a key: UI continues to work; the deprecated key shows a deprecation note if the schema flags it.
- A sandy major release (1.0.0) that bumps schema to v2: the UI refuses to launch until it's updated to a version that supports schema v2.

Each UI release pins a tested range in its README and on the download page. Users who downgrade sandy below the UI's `sandy_min_version` get a clear error on next launch, with the fix command.

## Distribution

Ship as a `.vsix` extension on two registries:

- **Visual Studio Marketplace** — primary install path for stock VSCode users. Requires a Microsoft publisher account and ToS acceptance.
- **OpenVSX** — secondary, covers Cursor / Windsurf / VSCodium / other VSCode-API-compatible editors. Free, registry-only.
- **GitHub Releases** — `.vsix` artifacts for offline / sideload install (`code --install-extension sandy-ui-0.1.0.vsix`).

`vsce package` + `ovsx publish` in CI for releases. `vscode:prepublish` script runs `electron-rebuild` so the published `.vsix` ships node-pty already built for the target Electron major (or, if we adopt `node-pty-prebuilt-multiarch`, the prebuilds-fork resolves the same problem with less per-release ceremony).

**Auto-update** is handled by VSCode itself — extensions update through the editor's normal extension-update flow. No custom updater needed.

First release target: **macOS + Linux** (matches sandy's install-tested platforms). Windows at 0.2.0 — Windows support depends on PTY hosting portability (`node-pty` does support Windows but it's less battle-tested for this exact stack) and the macOS-style TCC mitigation not having a Windows analog to validate. Worth a follow-up sprint.

**Pre-distribution gate**: the remaining real chore is node-pty cross-platform packaging (see Open Questions). macOS TCC was previously listed here as the gate; dogfooding downgraded it — the "barrage of prompts" failure mode only happens with an over-broad `$HOME` workspace, which the extension now structurally prevents (explicit folder pick, never `$HOME`). An onboarding note about opening a specific project folder is sufficient; a signed helper binary is a nice-to-have, not a blocker. See Security model § macOS TCC.

## Project structure

The extension lives in its own repository (`rappdw/sandy-ui`), not in the sandy repo:

- Independent release cadence, versioning, and issue tracker.
- Different tech stack (TypeScript + node-pty + xterm.js vs. sandy's bash) — mixing in one repo confuses contributors and CI.
- Keeps the sandy repo focused on the CLI + isolation contract.
- Users who only want the CLI don't need the UI repo's build tooling (Node, npm, electron-rebuild, etc.).

Coordination:
- `SPEC_INTROSPECTION.md` lives in the **sandy** repo as the contract.
- `SPEC_SANDY_UI.md` (this file) lives in the **sandy** repo as architectural context, since the schema's design is influenced by UI consumers.
- The sandy-ui repo links back to both specs and pins the `sandy` commit SHAs it's tested against in its CI matrix.
- Cross-repo work is tracked as GitHub issues on the sandy repo (rappdw/sandy #16–#20, filed from former handoff docs with the full task spec embedded). `sandy-ui/handoffs/` holds standalone paste-into-an-agent task docs only for repos without a reachable issue tracker (e.g., the private dotfiles repo).

In-repo layout:
```
sandy-ui/
  package.json                 # extension manifest (publisher, contributes, scripts)
  src/
    extension.ts               # activate(), command + view registration
    terminal/                  # PTY supervisor, OSC handlers, lock-sweep
    approval/                  # webview modal
    settings/                  # webview, schema-driven form, configIO
    schema/                    # cache invalidation
    state/                     # poll --print-state, status bar
  media/                       # webview HTML/CSS + bundled xterm.js + addons
    webview-ui/                # TypeScript sources for webviews, esbuild-bundled
  handoffs/                    # task prompts for repos w/o a reachable issue tracker
  test/                        # @vscode/test-electron suites
  scripts/                     # copy-xterm, prepare-release
```

## Test coverage

### In the sandy repo

Covered by [SPEC_INTROSPECTION.md](SPEC_INTROSPECTION.md)'s test plan — the schema contract itself.

### In the sandy-ui repo

Unit tests (Jest / Vitest, no VSCode needed):
1. **OSC parsers**: each `parseOsc*` produces the right structured event for canonical inputs and degrades gracefully for malformed ones.
2. **Pattern validation**: each field's `pattern` rejects known-bad values (property-based test generates invalid inputs).
3. **configIO**: scope partitioning routes secrets to `.secrets`, regular keys to `config`; atomic write produces correct file mode; round-trip preserves values.
4. **Lock sweep**: dead PID → cleaned; live PID → preserved; ESRCH vs EPERM distinguished.
5. **Schema cache invalidation**: change sandy version → cache invalidates → re-fetches.

Integration tests (`@vscode/test-electron`, runs in a real VSCode):
6. **Webview xterm.js end-to-end**: spawn a subprocess that emits ANSI + OSC 9 + OSC 52; assert xterm.js renders, OSC events round-trip to host, clipboard receives OSC 52 payload.
7. **PTY supervisor**: stop command escalates SIGINT → wait → SIGTERM → wait → SIGKILL with correct timing; exit-code capture is accurate; stale lock file cleaned before next launch.
8. **Pre-flight modal renders raw `KEY=VALUE` lines verbatim** (assert no HTML entity encoding, no whitespace collapse, no truncation).
9. **Approval flow end-to-end**: mock `sandy --validate-config` returning pending approval → modal shown → approve → subprocess launched with `SANDY_AUTO_APPROVE_PRIVILEGED=1` → env does not leak to next launch.
10. **Settings webview round-trip**: load config → edit → save → reload → edited value present, in both Project and Global scopes; tab switch preserves in-progress edits per scope.
11. **Compatibility refuses unknown schema**: mock `--print-schema` returning `schema_version: 99` → extension shows upgrade prompt, blocks launch.
12. **Docker-unreachable fallback**: mock Docker socket as absent → multi-session dashboard shows "Docker unreachable" state, no crash; project launch still works (sandy itself does the Docker call).

## Open questions

1. **macOS TCC mitigation strategy.** Reassessed from dogfooding — **no longer a distribution blocker.** The prompt cascade only appears with an over-broad `$HOME` workspace, which the no-`$HOME` guardrail already prevents; a normal narrow project produces at most a single, reasonable "VSCode wants Documents access" prompt (and only if the project lives under a protected data folder). Onboarding guidance covers it. A helper binary with its own bundle ID (requires Apple Developer ID + signing) would make attribution read "sandy" instead of "VSCode" — a polish item to revisit post-launch, not a gate. `setsid` / detached spawn probably doesn't help (TCC tracks responsible-process ancestry, not controlling-tty ancestry).

2. **node-pty packaging.** Two viable paths: (a) `electron-rebuild` in `vscode:prepublish`, requires per-Electron-major rebuilds; (b) switch to `node-pty-prebuilt-multiarch` which ships prebuilds. Path (b) is less work but pins us to whatever ABIs the upstream maintainer covers. Pick after measuring how often VSCode's Electron major bumps in practice and how quickly the prebuilds-fork follows.

3. **cmux integration.** cmux is a popular terminal multiplexer that already understands sandy's OSC notification passthrough. If a user is running VSCode inside cmux, do we want to forward notifications outward (so cmux surfaces them to the OS) or intercept them in the extension? Recommended: intercept by default, with a setting to pass them through.

4. **Sandy-side companion changes.** Resolved or tracked as sandy issues (July 2026 audit): (a) stale-lock races — flock(2) was evaluated and rejected upstream (macOS ships no flock CLI); the chosen fix is mkdir-mutex hardening, tracked at [rappdw/sandy#14](https://github.com/rappdw/sandy/issues/14). (b) `set -g allow-passthrough on` + `terminal-features ":RGB"` — **shipped** in sandy's generated tmux.conf. (c) Docker network teardown — partially shipped (lazy proxy-network reaper); the remainder (main `sandy_net_*` reaping, prune-on-startup, `--prune-orphans`) is [rappdw/sandy#20](https://github.com/rappdw/sandy/issues/20). Later dogfooding added [#16](https://github.com/rappdw/sandy/issues/16) (teleport), [#17](https://github.com/rappdw/sandy/issues/17) (daemon-mode), [#18](https://github.com/rappdw/sandy/issues/18) (print-state light), [#19](https://github.com/rappdw/sandy/issues/19) (workspace_path in print-state).

5. **`--remote` mode handling.** sandy's `--remote` flag launches a remote-controlled Claude session (claude agent only). The extension in MVP does **not** handle `--remote` — there's nothing for it to show except the same TUI. In post-MVP, a dedicated "remote session" panel could surface the remote-control plane (pending questions, approval requests from remote triggers) without requiring the user to watch the TUI.

6. **Workspace scope detection.** When the user opens a project that isn't a git repo and isn't obviously a "project" (no `.sandy/`, no package manifest), what's the workspace root? Default to VSCode's first workspace folder; post-MVP offer a "refine workspace" step if sub-directories look more appropriate.

7. **Multi-agent tab splitting.** When `SANDY_AGENT=claude,codex`, sandy renders a two-pane tmux. The webview tab shows it as one terminal (since it's one PTY). Do we split the tab in the extension instead? Rejected for MVP — sandy's tmux handles pane management and it's what the user sees from a plain terminal; the extension shouldn't diverge.

8. **Channels (Telegram/Discord) relay indicator.** When a user has channels configured, a small icon in the tab title or status bar item could show "Telegram relay active, last message 3m ago." Post-MVP. Data source: polling the `channel-relay.sh` process and its state file under `$SANDY_HOME/`.

9. **Settings bootstrap from an existing `~/.claude/`.** First-time users who already have Claude Code set up have credentials at `~/.claude/.credentials.json` but may not have a sandy config. Offer to bootstrap `~/.sandy/config` with sensible defaults inferred from their existing Claude setup (e.g., reuse their `~/.claude/settings.json` model choice). Post-MVP; the wizard is a better home for this.

10. **In-UI log viewer vs. terminal scrollback.** xterm.js has native scrollback. Do we need a separate "logs" panel? Rejected for MVP — xterm.js scrollback is enough. Post-MVP session-history view serves the across-session case.

11. **Headless-mode UI (`-p` / `--print`).** Sandy's one-shot headless mode is a command-line workflow. Does it make sense in the extension? Probably as a "Run one-shot" command per project entry, with a prompt input field and result capture. Post-MVP.

12. **Multi-machine follow-on.** A future sandy-ui could federate across multiple machines with sandy installed (work laptop + home workstation + cloud VM), with a remote-tunnel story. Out of scope indefinitely — too much of sandy's value is in local filesystem and Docker access. Re-evaluate if demand materializes.

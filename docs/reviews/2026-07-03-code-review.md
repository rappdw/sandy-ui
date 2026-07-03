# Code review — 2026-07-03 (full-source sweep)

Complete review of `src/**`, `media/**/src`, `media/approval/*.js`, scripts,
manifests, and tests (~3,700 lines). Findings are ordered by severity within
category. **Disposition** says what happened: `fixed` items were implemented
in the commits referencing this document; `documented` items are deliberate
trade-offs or low-value fixes left as-is (with reasoning).

Verification for every fix: `tsc` (host + webview configs), the Vitest suite,
and an esbuild webview build. (Native toolchain for all three was enabled in
the review sandbox via side-by-side Linux bindings — no lockfile changes.)

## Bugs — correctness

| ID | Sev | Where | Finding | Disposition |
|---|---|---|---|---|
| B1 | **high** | `media/settings/src/settings.ts` `collect()` | Bool fields saved as `1`/`0`, but sandy compares `= "true"` (bash) and `!== 'false'` (node). Unchecking `SANDY_SKIP_PERMISSIONS` wrote `0`, which sandy's node path treats as *not false* → **permission bypass stayed active after the user disabled it**. Checking a bool wrote `1`, which bash `= "true"` treats as false → features silently off. | fixed — emit `true`/`false`; reader already accepted both |
| B2 | **high** | `settings.ts` `collect()` + `configIO.saveScope` | Cleared fields were dropped from the save payload and the host merged over existing values → **clearing any value silently reverted it on save**; unchecking every agent in `agent_combo` likewise kept the old `SANDY_AGENT`. | fixed — webview now sends `""` for cleared non-secret fields; host deletes keys with empty incoming value (secrets unaffected: blank still means "keep") |
| B3 | **high** | `sandyState.sweepStaleLocksIn` | Lock matching by loose prefix `.<basename>-`: workspace `foo` matched `foo-2`'s locks (`.foo-2-<hash>.lock`). A live sibling-project lock could surface the orphan modal for the wrong project and **"Stop existing & launch fresh" would SIGTERM another workspace's live sandy**. Also: raw basename was used while sandy sanitizes (`tr -cd 'a-zA-Z0-9._-'`), so workspaces with spaces/etc. never matched their own locks. | fixed — sanitize basename like sandy does and match `^\.<base>-[0-9a-f]{8}\.lock$` (sandy's hash is exactly 8 lowercase hex); tests updated to the real format + collision cases |
| B4 | **high** | `sandyState.isPidAlive` | `process.kill(pid, 0)` throwing **EPERM** (process alive, owned by another user) was treated as *dead* → live locks eligible for sweeping. CLAUDE.md explicitly claims ESRCH/EPERM are distinguished; the code didn't. | fixed — EPERM now counts as alive |
| B5 | med | `extension.ts` `launchWithWorkspaceSwitch` | Re-attaching to a detached session for a *different* workspace (tree click or status-bar pick) went through `vscode.openFolder` → **window reload kills the extension host and the very PTY being re-attached**; after reload a fresh sandy spawns. | fixed — when the supervisor already has a live session for the target workspace, attach in place (no reload); the session lives in this extension host, so the current VSCode workspace is irrelevant |
| B6 | med | `webviewPanel.openTerminalPanel` | Launching a workspace whose session is already **attached** created a second panel that silently stole the PTY stream; the first tab stayed open, frozen. | fixed — reveal the existing panel instead of creating a duplicate |
| B7 | med | `webviewPanel.handleOsc` | OSC-notification `● ` title badge was never cleared when the user refocused the tab (spec says it should clear). | fixed — strip prefix on visibility-restore |
| B8 | low | `pty.ts` `PtyHandle.write` | Unguarded `proc.write` — typing into a just-exited session could throw inside the message handler. `resize`/`kill` were already guarded. | fixed — same try/catch |
| B9 | low | `extension.ts` status bar | `${sessions.length === 1 ? "" : ""}` — no-op ternary (dead pluralization). | fixed — removed |
| B10 | low | `bridge.ts` CSI intercept | A *mixed* DECSET like `CSI ? 1000;1006 h` (tracking + non-tracking modes in one sequence) fell through untouched → xterm enabled mouse tracking → native selection broke until the next pure sequence. Rare (tmux sends modes separately) but real. | fixed — consume tracking modes, re-inject the remaining modes via `term.write` |
| B11 | low | `bridge.ts` wheel handler | Pure-horizontal wheel events (`deltaY === 0`) reset the vertical accumulator and were swallowed. | fixed — pass them through untouched |
| B12 | low | `settings.ts` "saved" handler | Committed state was re-read from the live DOM on the async `saved` message — switching tabs between click and ack corrupted the other scope's baseline. | fixed — capture the payload at save-click |
| B13 | low | `settings.ts` `bindFormChanges` | An `input` listener was added to `#form` on every render → duplicate handlers accumulated. | fixed — bind once |

## Security

| ID | Sev | Where | Finding | Disposition |
|---|---|---|---|---|
| S1 | med | `settings/webviewPanel.ts` save read-back | Wrote **plaintext values — including secrets — to the "Sandy Settings" output channel** (`ok KEY="sk-ant-…"`). | fixed — log key names + ok/MISMATCH/deleted status only, never values |
| S2 | low | `settings.ts` `saveState` | Typed-but-unsaved secret values were persisted via `webview.setState` (plaintext in VSCode workspace storage). | fixed — secret-typed keys stripped from persisted form state (hide/show loses an unsaved secret entry; acceptable) |
| S3 | info | `approval/webviewModal.ts` + `media/approval/approval.js` | The approval modal — the security gate — was the only webview still in un-typechecked vanilla JS, outside the esbuild/TS pipeline CLAUDE.md documents. Rendering verified correct (`textContent`, never `innerHTML`). | fixed — ported to `media/approval/src/approval.ts`, added to build-webviews targets, host now loads `dist/approval.js` |

## Performance

| ID | Sev | Where | Finding | Disposition |
|---|---|---|---|---|
| P1 | med | `schema/cache.ts` | `getCachedSchema` used `execFileSync` (`--version` 5s timeout, `--print-schema` 10s) — up to ~15s of **extension-host event-loop blocking** on every settings-panel open (5s even on cache hits, worse if sandy/docker wedge). | fixed — converted to async `execFile`; settings panel awaits a shared promise |
| P2 | info | poller / cadence | 5s/60s/paused cadence gating shipped earlier today (see `state/cadence.ts`); per-invocation cost is sandy-side (rappdw/sandy#18). | documented |

## Robustness / quality

| ID | Where | Finding | Disposition |
|---|---|---|---|
| Q1 | `supervisor.stop` | Fixed `sleep(3s)` + `sleep(2s)` even when the process exits instantly — closing a tab held the dispose handler up to 5s. | fixed — exit-aware waits (same escalation ceiling, no fixed floor) |
| Q2 | `webviewPanel.pushScrollSensitivity` | Code fallback default `1` vs package.json default `2`. Only bites if the contribution is missing, but the mismatch is confusing. | fixed — aligned to 2 |
| Q3 | `deleteSandbox.ts` comment | Claimed `path.resolve()` "collapses … symbolic moves" — resolve does **not** follow symlinks. (Behavior is still safe: `rmSync` unlinks a symlink rather than traversing it.) | fixed — comment corrected |
| Q4 | `projectsTree.tooltipFor` | `Workspace: undefined` rendered for sandboxes without workspace_path. | fixed — fallback text |
| Q5 | `pty.launchCandidates` | PATH split on `":"` instead of `path.delimiter` (Windows-hostile; Windows isn't shipped, but the file already uses `path.delimiter` elsewhere). | fixed |
| Q6 | host `FromHost` type | Dead `{ type: "init" }` member — bridge contract has no such message. | fixed — removed |
| Q7 | `pty.ts` | Top-level `import * as node-pty` loads the native module on *any* import — broke unit-testing `augmentPath` off-platform and costs load time when only pure helpers are needed. | fixed — native module now lazy-required inside `spawnPty` |

## Architecture — documented, deliberately not "fixed"

| ID | Observation | Reasoning |
|---|---|---|
| A2 | Host/webview message contracts are duplicated structurally (`ToHost`/`FromHost` in both trees). | Documented choice (CLAUDE.md): host is Node-target, webview is browser-target; duplication is cheap, coupling is not. A shared `.d.ts` would need a third tsconfig surface — not worth it at 2 contracts. |
| A3 | `PtySupervisor.sessions` map never prunes exited entries. | Bounded by distinct workspaces per window lifetime (tiny); `getSession`/`getAllSessions` filter. Pruning adds lifecycle edge cases for no measurable win. |
| A5 | An in-flight `--print-state` child isn't killed on poller dispose/deactivate. | Child exits on its own within its 10s timeout; killing adds signal plumbing for a non-problem. |
| A6 | Multi-root workspaces: only `workspaceFolders[0]` is consulted (launch matching, settings scope). | Single-root is the sandy model today; making multi-root first-class belongs with a real use case, not speculatively. |
| A7 | `sandy.launchCommand` override parses via `split(/\s+/)` — quoted args with spaces break. | Documented limitation; the setting is a power-user escape hatch. A shell-quote parser is more code than the feature warrants right now. |
| A8 | `oscHandler.parseOsc*` host parsers duplicate bridge-side parsing and aren't on the runtime path (bridge parses, host consumes typed events). | They are the *spec + unit-test surface* for the OSC contract (documented in the file header). Keeping them keeps the contract tested without DOM. |
| A9 | Settings save materializes rendered defaults into the config file (untouched fields with schema defaults get written on first save). | Pre-existing; arguably surprising, but "file reflects what the form showed" is also defensible. Changing to dirty-field-only saves alters semantics users may rely on — deferred until it bites someone. |
| A10 | No way to clear a stored **secret** from the UI (blank = keep current). | Needs a deliberate affordance (e.g. explicit "clear" button), not an accidental one — deferred as a feature, noted here so it isn't re-discovered as a bug. |
| A11 | `readKv` keeps a trailing `\r` on CRLF files. | Sandy writes LF; sandy's own parser has the same property. Matching sandy beats diverging. |
| A12 | `SandySandbox.workspace_path` was typed required but is absent until sandy#19 lands (enrichment bridges it). | fixed — now optional in the type; all consumers already guarded |

## Test gaps addressed

- `sandyState` tests rewritten to sandy's real lock format (`.<base>-<8hex>.lock`) plus sibling-collision and sanitized-basename cases (B3) — the old tests encoded the loose prefix behavior.
- `configIO` tests extended for empty-value deletion semantics (B2).
- `pty-augmentPath` tests now run everywhere (Q7 unblocked them off-macOS).

## Known-limitation notes carried forward

- Detach remains bounded to the extension-host lifetime (daemon-mode: rappdw/sandy#17).
- In-app mouse clicks don't reach TUIs by design (v0.4.0 mouse split trade-off).
- Poller data can be up to 60s stale in an unfocused window (cadence gating trade-off; refresh-on-focus covers the interactive case).

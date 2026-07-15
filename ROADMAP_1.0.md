# sandy-ui — Road to 1.0

**Written**: 2026-07-16, at v0.6.0. **1.0 means**: a stranger can install sandy-ui from the
VS Code Marketplace or OpenVSX, get a working first session without reading this repo, and
trust it with the same lifecycle guarantees the author gets. Everything below is judged
against that bar — not against feature-completeness of the original spec (several spec
items are deliberately post-1.0).

## Where we are (0.6.0)

Shipped and verified: the full MVP (webview terminal, schema-driven settings, pre-flight
approval, projects tree), multi-session supervision with status bar + quick-pick,
cadence-gated polling (CPU fix), the 28-finding hardening review (docs/reviews/2026-07-03),
native drag-select + wheel-to-tmux mouse split, live scroll sensitivity, and — the 0.6.0
headline — **daemon-mode session persistence**: sessions survive tab close, VSCode quit,
and host reboot, with reattach from tree/status bar (sandy ≥ 1.1.0, feature-detected).

Of the spike's five "most likely to block shipping" items, three are done (TCC — downgraded
after dogfooding disproved the cascade; tmux config — shipped upstream; webview TS — done
incl. the approval modal), one is production-ready as-is (lock sweep, now with exact-match
hardening). **The two never done are exactly the 1.0 gates: node-pty distribution and the
publishing pipeline.**

## Defect / shortcoming inventory

Carried-forward items, each with a disposition. IDs reference
docs/reviews/2026-07-03-code-review.md where applicable.

| # | Item | Disposition |
|---|---|---|
| D1 | `sandy.launchCommand` override and the daemon path don't compose — with persistSessions on, the override is silently ignored (daemon branch never consults it). Precedence must be: explicit override ⇒ legacy path. | **fix in 0.7.0** |
| D2 | No way to clear a stored secret from the settings UI (blank = keep) — needs an explicit affordance (A10). | **fix in 0.7.0** |
| D3 | Settings panel renders blank while `--print-schema` resolves (up to ~15s if sandy/docker wedge) — needs a loading state. | **fix in 0.7.0** |
| D4 | Idle daemon sessions accumulate invisibly — tab close no longer stops anything, so forgotten sessions pile up. Need session age (`started_at`) surfaced in tree/status-bar tooltips, and optionally a "N sessions running > 24h" nudge. | **fix in 0.7.0** |
| D5 | Daemon lifecycle has zero integration-test coverage in this repo (validated only via sandy's own harness + manual soak). Need a fake-sandy fixture (script emitting the frozen contract: exit codes, --print-state shapes) so @vscode/test-electron can drive launch→detach→reattach→stop without Docker. | **fix in 0.7.0** |
| D6 | Windows CI leg is red on every run (node-pty/integration never Windows-ready; spec defers Windows). `continue-on-error` fix is written but blocked on a gh `workflow` scope. | **land in 0.7.0** |
| D7 | Compatibility gating from SPEC §Compatibility is unimplemented: no `sandy_min_version` floor, no `schema_version` supported-list check, and a broken-but-present sandy silently falls back to the bundled mock schema (looks like it works, mostly doesn't). | **fix in 0.8.0** |
| D8 | First-run experience assumes the author: no guidance when sandy/docker are missing beyond error strings; README is written for the repo owner. | **fix in 0.8.0 / 0.9.0** |
| D9 | The shipped vsix contains node-pty built for the publishing machine only — any other OS/arch/Electron-major gets `posix_spawnp failed.` **The 1.0 distribution gate.** | **fix in 0.9.0** |
| D10 | Releases are hand-cranked (local `npm run release`); no CI packaging, no OpenVSX, no Marketplace. | **fix in 0.9.0** |
| D11 | In-app mouse clicks never reach TUIs (deliberate 0.4.0 trade for native selection). Acceptable default; power users may want a per-session toggle back to tmux mouse mode (⌥-select returns as the cost). | **optional 0.7.0, setting-gated** |
| D12 | No scrollback replay on reattach (inner tmux preserves live screen + its own scrollback via copy-mode; xterm scrollback starts empty). | **accept for 1.0** (revisit with tmux capture-pane replay post-1.0) |
| D13 | Multi-root workspaces: only `workspaceFolders[0]` is consulted (A6). | **accept for 1.0**, document |
| D14 | `launchCommand` parsing breaks on quoted args with spaces (A7). | **accept for 1.0**, document |
| D15 | Settings save materializes rendered schema defaults into the file (A9). | **accept for 1.0** (defensible semantics; revisit on complaint) |
| D16 | xterm 6 + TypeScript 7 migrations parked by dependabot policy (majors are deliberate work; TS 7 empirically broke CI 2026-07-15). | **post-1.0** |

## Milestones

### 0.7.0 — Debt + daily-driver polish (small/medium items, 1–2 sessions)
- D1 launchCommand/daemon precedence (S)
- D2 secret-clear affordance in settings webview (S)
- D3 settings loading state (S)
- D4 session age surfacing + long-runner nudge (M)
- D5 fake-sandy fixture + daemon-flow integration tests — the quality backbone for
  everything after; also finally exercises the orphan/legacy paths in CI (M/L)
- D6 Windows CI non-blocking (one line, blocked on token scope) (S)
- D11 optional `sandy.terminal.mouseMode` toggle (S, if wanted)

### 0.8.0 — Compatibility + first-run (the "stranger-proofing" release)
- D7 compat gate: enforce sandy ≥ 1.0 floor (workspace_path natively; enrich bridge is
  already gone), consult `--print-schema` `compatibility.supported_schema_versions` per
  SPEC §Compatibility (soft-warn newer / refuse major jumps), and make the mock-schema
  fallback loudly visible in the UI instead of silent (M)
- D8a "Sandy: Get Started" — a VS Code Walkthrough contribution (not the spec's full
  wizard): detect sandy/docker, doctor-style checks with fix-it links, first-launch tour
  of tree/status-bar/persistence semantics (M)
- Optional auto-restore: `sandy.restoreSessionsOnStartup` — reattach persisted sessions'
  tabs on window open (S/M)
- Revisit spec §Compatibility declaration block (`sandy_min_version`,
  `sandy_schema_versions_supported`) and pin it in package.json contributes/README (S)

### 0.9.0 — Distribution engineering (the actual 1.0 gate)
- D9 **platform-specific VSIX targets**: CI matrix builds per-target packages
  (`vsce package --target darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64`) with
  node-pty prebuilt per target against the right Electron ABI — no user ever runs
  electron-rebuild again. Evaluate `node-pty` prebuilds vs per-target compile in the
  workflow; either kills D9 (L)
- D10 tag-driven release pipeline: build matrix → GitHub Release with all targets →
  `vsce publish` (pre-release channel first) → `ovsx publish` (M)
- Marketplace assets: 128px icon, categories/keywords, gallery banner, public-facing
  README top section, privacy note ("no telemetry, ever" — make it a commitment, not an
  omission) (S/M)
- Security once-over for public exposure: webview CSP audit, message-validation review
  (openExternal scheme guard pattern everywhere), supply-chain check (S)
- **Publish 0.9.x to Marketplace as pre-release** — public beta while 1.0 bakes

### 1.0.0 — Public launch
- Beta feedback burn-down (scope TBD by feedback)
- Stable publish to Marketplace + OpenVSX
- README/SPEC status flip from "dogfooding for the author"; compat matrix documented
- Close out this roadmap file with a retrospective note

### Post-1.0 parking lot (explicitly NOT gating)
- **Windows support** — node-pty/conpty + integration harness + the currently-red CI leg
  turned real; a milestone of its own
- **Teleport UI** — "Sandy: Teleport to Server…" + breadcrumb surfacing; gated on sandy
  1.2.0 (rappdw/sandy#16)
- **xterm 6 migration** (with the terminal regression checklist) and **TypeScript 7**
- Session history / transcript capture; observer mode for legacy bare-CLI sessions
  (daemon sessions are already attachable regardless of who started them)
- Workspace `.sandy/` creator; skill-pack browser; full onboarding wizard
- Scrollback replay on reattach (tmux capture-pane seeding)
- Multi-root workspace awareness

## Tracker

Actionable items are filed as milestoned GitHub issues (2026-07-16):
**0.7.0** → #24 (D1), #25 (D2+D3), #26 (D4), #27 (D5 fixture), #28 (D6), #29 (D11, optional) ·
**0.8.0** → #30 (D7 compat gate), #31 (D8a walkthrough), #32 (auto-restore) ·
**0.9.0** → #33 (D9 platform VSIX), #34 (D10 pipeline), #35 (marketplace readiness).
D12–D15 (accepted-for-1.0) and D16 (parked migrations) are deliberately NOT issues —
they're decisions recorded here and in docs/reviews/2026-07-03-code-review.md; they
graduate to issues only if scheduled.

## Sequencing rationale

0.7 before 0.8 because the fake-sandy fixture (D5) is what lets the compat gate and
first-run flows in 0.8 be integration-tested rather than hand-verified. 0.8 before 0.9
because publishing a beta to strangers without compat gating and a first-run path
generates support noise that drowns real feedback. 0.9's platform-vsix work is the only
genuinely *hard* engineering left and has no dependencies on 0.7/0.8 — if it proves
harder than expected, it can start in parallel any time.

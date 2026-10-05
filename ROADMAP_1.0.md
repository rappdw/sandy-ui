# sandy-ui — Road to 1.0

**Revised** 2026-10-05 at v0.8.3, against sandy v2.7.1 (main 2.8.0-dev), worked out with the
sandy maintainer session — which checked every claim below about sandy against sandy's own
code. The original roadmap was written 2026-07-16 at v0.6.0 (see git history); its 0.7.0
and 0.8.0 milestones shipped as planned. This revision replaces its milestone plan.

**1.0 means:** a stranger installs sandy-ui from the VS Code Marketplace or OpenVSX, gets a
working first session without reading either repo, and gets the same lifecycle guarantees the
author does. Everything below is judged against that bar.

## Where things stand

0.7.0 and 0.8.x shipped everything the old roadmap scheduled for them (debt, compat gate,
walkthrough, auto-restore, daemon correctness, clamshell resilience, window sorting).

Meanwhile **sandy went 1.8 → 2.7.1 in about three weeks**, through three
`schema_version` bumps (1→2 in 2.0.0, →3 in 2.2.0, →4 in 2.6.0). Two consequences:

1. **Every upstream issue sandy-ui was blocked on is closed** — #156, #158, #159, #160,
   #161. Nothing we need from sandy is outstanding.
2. **sandy-ui has two live bugs against current sandy**, verified by running the real
   v2.7.1 `--print-schema` through our parser and gate:
   - **An error popup on every window activation.** Our gate supports schema `[1]`; schema
     4 lands on `schema-unsupported-major` → `showErrorMessage("…update the sandy-ui
     extension before continuing")`. There is no newer sandy-ui to update to.
   - **The settings panel silently drops 74% of fields** (46 of 62). Schema 4 introduced a
     `path` field type; the renderer's type switch has no `default`, so the first `path`
     field (`SANDY_SCREENSHOT_DIR`, #17) throws and aborts the whole form. TypeScript can't
     catch it — `FieldType` lists six types and all six have cases, so the switch looks
     exhaustive. The error is silent (output channel only).

   The good news underneath: **our parser renders schema 4 correctly.** The bumps removed
   only handoff/relay fields, none of which sandy-ui reads. Only the gate and one renderer
   are wrong.

## Milestones

### 0.8.3 — Hotfix ✅

Shipped first; both bugs hit every current user. **Settings shipped read-only:** fixing the
render exposed older defects in how the panel *saves* — it wrote every rendered field, and it
routed 16 non-secret privileged keys into `.secrets` (0.8.2 already did this on every Save).
Rather than rush a fix to code that writes users' config, the host refuses every save and the
panel says which file to edit. Re-enabling is #53, in 0.9.0.

- **Compat gate**: accept `[2, 3, 4]` (identical for our purposes — confirmed by sandy that
  2→3→4 only removed fields we never read), raise `SANDY_MIN_VERSION` to the 1.0 floor
  (decision A below).
- **Gate severity**: an unknown schema becomes a **warning while sandy's major is unchanged**,
  and escalates to an error on a **new sandy major**. That mirrors sandy's written policy:
  within a major, a bump requires a `## Deprecated` entry announced at that major's .0 or the
  consumer-boundary exception (every known consumer — sandy-ui is one — named and migrated
  first); a new major may change a field's meaning without notice, as 2.0.0 did with
  `sandboxes[].features`. An error whose only instruction can't be followed is the worst
  outcome, which is exactly what users get today. Too-old sandy stays an error.
- **Settings robustness**: add `path` (render as a text input), add a `default` branch that
  renders any unknown type as a plain text input with a "type not recognized" hint, and
  guard each field's render in try/catch so one bad field can never take down the form.
  Tests: a schema fixture containing an unknown type must render every other field.
- Regression fixture: check in real v2.7.1 `--print-schema` output as a test fixture, and
  assert the parser + gate verdict against it.

### 0.9.0 — Stranger-ready: contract alignment + the approval experience (~2–3 sessions)

Everything sandy unblocked, plus the sandy maintainer's critique of how we use the contract.
Nothing here needs sandy changes.

- **Re-enable Settings Save** (#53) — the 0.8.3 hotfix turned it off. Route keys by
  `type === "secret"` instead of by where sandy *reads* them from; migrate the non-secret keys
  older builds wrote into `.secrets` (after confirming sandy's precedence between the two
  files); preserve comments on write; fix the edit-during-save and secret-in-config edges; and
  extract the ack/restore state transitions into pure, tested functions. The change-only save
  model and write-only-on-change host behavior are already in place, dormant.
- **Delete the last private-layout dependency** (#158). Our `sandyState.ts` globs
  `~/.sandy/sandboxes/.<base>-<8hex>.lock` to *remove* stale locks. sandy now does this
  itself — every launch (including `--start`) clears a provably-stale lock for its own
  workspace, and `--stop` reaps a dead session's. ("Provably stale" means the holder pid is
  dead; if the pid was reused by an unrelated live process, sandy refuses rather than
  guesses and says so — rare, user clears it by hand.) So: delete the sweep and the legacy
  orphan-lock modal's dependence on it; if a "clear stale locks" UI action is wanted, run
  `sandy --doctor --fix --yes` and refresh. sandy's host-side path contract (2.7, #386)
  says that layout may change in any release — this has to go before 1.0. Likely subsumes
  **#50** (orphan modal after a timeout).
- **`--print-version`** (#44): key the schema cache on `full_version` **plus the sandy
  binary's mtime and size**. `full_version` only changes per commit when sandy knows its
  commit — a curl install reports `commit: ""`, so `full_version == version`, identical
  across every `-dev` commit. Never trust a cached schema across a `-dev` version on
  `full_version` alone. Drops the regex scrape.
- **`--workspace`** (#43): with a 2.6.0 floor it is always present in `cli_flags` — close
  #43 as resolved by the floor rather than building a version-aware gate.
- **Make exit 6 legible** (sandy: "today that 6 is the most confusing thing a stranger will
  hit"). Exit 6 means *refused before launch, fixable in one step*, and it has seven causes,
  only one of which is an approval: a declined or new escaping symlink; a pre-2.0 sandbox
  (`sandy --reset-sandbox --workspace P --keep-history`); an expired Claude OAuth token
  (#261 — `claude auth login` on the host); an unreadable feature manifest; a retired key
  still set; a `.git` gitdir line pointing nowhere; Linux iptables isolation that can't be
  applied. Every cause prints its own one-step fix just above *"Daemon startup was
  refused"*, so the message points at the streamed log tail first, and additionally runs
  `sandy --approvals --workspace <path>` (read-only JSON; exit 0 resolved / 2 something
  withheld or refused / 1 no report) to name the gate when it *is* one.
- **Warn about the silent case — arguably the more valuable change.** Two of the three
  approval gates never produce exit 6: declined privileged keys are **dropped** and a
  declined `.sandy/Dockerfile` falls back to the standard image, and `--start` returns **0**
  either way. A stranger gets a quietly tighter session with no explanation. After a
  successful start, run `--approvals` and, if it reports something withheld, say which keys
  were dropped or that the project image was skipped.
- **The pre-flight approval path** (decision C — hybrid). Our pre-flight modal sets
  `SANDY_AUTO_APPROVE_PRIVILEGED=1` for the launch after the user approves in *our* webview;
  sandy's guidance is to never set it on the user's behalf (it's the CI escape hatch, and it
  approves whatever config sandy reads at spawn time, not necessarily what the user saw). The
  modal's original reason is gone: with a 2.6 floor, `--start`'s client-side pre-pass prompts
  on our pty for all three gates — privileged keys, symlinks (#221), the project Dockerfile
  (#296). **Keep the modal as a read-only preview that shows keys *and their values*, remove
  the auto-approve, and let sandy ask in the terminal and record the decision.** The values
  matter: sandy's prompt prints key names only (values are credentials, and in daemon mode the
  prompt goes to a log on disk), so a hostile repo setting `SANDY_ALLOW_HOSTS` to an attacker's
  domain looks like just `SANDY_ALLOW_HOSTS` there. `--approvals` is names-only too, so the
  preview keeps reading values from the workspace config itself (as today, via configIO); use
  `--approvals` to decide *whether* a preview is needed and which gates are pending. (The
  pre-pass requires `[ -t 0 ]` — node-pty satisfies it; a `child_process` spawn would not.
  The expired-OAuth refresh is not in the pre-pass and still ends in exit 6.)
- **`--update-sessions` cooperation** (#36 — contract stable since sandy 1.2.0): sticky
  reconnect after an update restart (treat `--attach` exit 4 shortly after an `updated_at`
  change as *retry*, not *gone*, and reconcile against `--print-state`); restart-safe
  discovery; an `image_stale` surface (agent image only, full-mode only — no per-session
  proxy-stale bit exists).
- **First run**: link sandy's stranger-facing walkthrough (https://rappdw.github.io/sandy/)
  from our walkthrough; set expectations that the first launch builds images and can take
  several minutes, and show progress for the full `--start` window (sandy allows 600s).
- **Types**: `workspace_path: string | null` (it can be `null` for legacy/orphaned
  sandboxes); bring `fake-sandy` to schema 4 so integration tests exercise the current
  shape.

### 0.10.0 — Distribution + public pre-release (the hard gate; ~3+ sessions)

The original 0.9.0 content, renumbered so stranger-readiness lands first. **Can start in
parallel with 0.9.0** — no dependency between them.

- **#33 Platform VSIX** with prebuilt node-pty, targets **darwin-arm64, linux-x64,
  linux-arm64** — the platforms sandy *exercises* (its own word; nothing more formal than
  "exercised" exists, so we say the same). Decision B for darwin-x64. Key
  technical question to spike first: whether node-pty's prebuilds are N-API (ABI-stable).
  If yes, one binary per platform serves both desktop Electron *and* the Remote-SSH VS Code
  Server's Node — which is otherwise the second ABI this has to solve, since under
  Remote-SSH the extension host is not Electron.
- **#34 Tag-driven pipeline**: CI matrix → GitHub Release with every target → `vsce publish
  --pre-release` → `ovsx publish`.
- **#35 Marketplace readiness**: icon, categories, public-facing README top section, a
  "no telemetry, ever" commitment, a security once-over (CSP, message validation,
  `openExternal` scheme guard everywhere, supply chain).
- **Publish 0.10.x as a Marketplace pre-release** — the public beta.

### 1.0.0 — Stable

- Beta feedback burn-down.
- Stable publish to Marketplace + OpenVSX.
- README/SPEC flip from "dogfooding for the author"; publish the compatibility statement
  (sandy floor + supported `schema_version`s).
- Retire `ROADMAP_1.0.md` with a short retrospective.

### Still post-1.0 (unchanged)

Windows-native and WSL (sandy claims neither), teleport UI, xterm 6 / TS 7, scrollback
replay on reattach, multi-root workspaces.

## Does sandy need to change?

**Nothing is required for sandy-ui's code.** Everything we were blocked on has shipped. One
item matters for the 1.0 *experience*, and the rest are optional or policy:

0. **Recommended before sandy-ui 1.0 — maintainer's decision, being raised now.** Both
   `install.sh` and `sandy --upgrade` download `main`'s HEAD, not the latest release tag. So a
   stranger following our walkthrough's first instruction today gets **2.8.0-dev — unreleased
   code** — not v2.7.1, and that install reports `commit: ""`, defeating version-keyed caches.
   For a 1.0 whose bar is "a stranger gets a working first session", handing strangers
   unreleased code is a real risk. If sandy keeps tracking main, our first-run screen should
   say so plainly.

1. **Optional:** a per-session proxy-stale bit, if we want to show proxy staleness per
   session (sandy says ask rather than derive). Not needed for 1.0.
2. **Policy, maintainer's call:** how much advance notice sandy promises a consumer before
   a `schema_version` bump. The written rule already protects us — an emitted field is
   removed only after appearing in README's `## Deprecated` table; additions to that table
   happen only in an X.0.0, except via a consumer-boundary exception that requires every
   known consumer be named *and have migrated first*; and the table currently lists no
   remaining introspection fields. A stated notice period would be nice for a public 1.0;
   it isn't a blocker.
3. **Process:** we watch rappdw/sandy releases as the reliable channel (the 2.0
   announcement never arrived); sandy will also message us on tags.

What sandy would value **from us**:

- File consumer breakage upstream as a rappdw/sandy issue tagged with the sandy version and
  the field/flag, rather than a quiet workaround — sandy's ratchets only protect what it knows
  is load-bearing.
- **An offer we can make cheaply:** publish sandy-ui's parser + gate as a runnable
  consumer-contract check sandy could run in its CI against real `--print-schema` /
  `--print-state` output. Our `path`-type bug is exactly what it would have caught before
  sandy released. Pending the maintainer's interest.
- sandy will propose publishing the config-key type vocabulary (today: `agent_combo`, `bool`,
  `enum`, `flag`, `int`, `path`, `secret`, `string`) as a closed set in SPEC_INTROSPECTION.
  Our default branch makes that defence in depth, not a dependency.

## Decisions (made 2026-10-05)

| | Decision | Outcome |
|---|---|---|
| A | sandy floor for 1.0 | **sandy ≥ 2.6.0, schema 4**; schemas 2/3 (sandy 2.0–2.5) best-effort. Shipped in 0.8.3. |
| B | Ship a darwin-x64 VSIX? | **No.** Targets are darwin-arm64, linux-x64, linux-arm64. |
| C | Pre-flight modal + `SANDY_AUTO_APPROVE_PRIVILEGED` | **Hybrid:** the modal becomes a read-only preview that still shows keys *and values* (sandy's own prompt shows names only — values are credentials, and in daemon mode the prompt goes to a log on disk — so our preview is the only place a user can judge e.g. what `SANDY_ALLOW_HOSTS` points at); remove the auto-approve; sandy asks in the terminal and records the decision. 0.9.0. |
| D | Reaction to an unknown future schema | **Warning within sandy major 2; error on a new major; once per sandy version.** Shipped in 0.8.3. |

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
| D15 | Settings save materializes rendered schema defaults into the file (A9). | **fixed in code in 0.8.3, shipped dormant** — stopped being defensible once the full sandy 2.x schema rendered (a Save would have written `SANDY_RELAY=false`, which sandy ≥ 2.6.0 refuses). The change-only save path is in place; Save itself is off pending #53. |
| D16 | xterm 6 + TypeScript 7 migrations parked by dependabot policy (majors are deliberate work; TS 7 empirically broke CI 2026-07-15). | **post-1.0** |

D1–D8 shipped in 0.7.0/0.8.0. D9/D10 are 0.10.0 (#33/#34). D11 shipped as
`sandy.terminal.mouseMode`. D15 addressed in 0.8.3 (dormant, #53). D12–D14 and D16 remain accepted for 1.0 / post-1.0 as recorded.

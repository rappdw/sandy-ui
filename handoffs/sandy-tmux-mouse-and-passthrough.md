# Handoff: tmux mouse mode + OSC passthrough in sandy

> **Purpose**: paste the body of this file as the prompt to a Claude (or other
> coding agent) running in a clone of `github.com/rappdw/sandy`. Surfaced from
> sandy-ui dogfooding.

> **Status (July 2026): OBSOLETE — verified shipped/moot against sandy main;
> no issue filed.** Both halves are resolved:
> - **OSC passthrough**: sandy's generated tmux.conf now sets
>   `set -g allow-passthrough on` (and `terminal-features ":RGB"`) — the
>   passthrough ask below shipped upstream.
> - **Mouse/selection**: solved host-side in sandy-ui v0.4.0 (webview splits
>   tmux's mouse switch: drag selects natively, wheel still reaches tmux).
>   The env-var mouse-off gate below is unneeded — no consumer wants it.
> Kept for historical context only.

---

## Task: stop sandy's inner tmux from breaking native selection and silently dropping OSC sequences

### Context

Sandy runs an inner tmux (`new-session -A -s ...`) inside its container. That
tmux's default config:

1. **Has mouse mode on** (`set -g mouse on`, or inherited from the user's
   `~/.tmux.conf` since sandy doesn't pin it off). This means click-drag
   inside the terminal is consumed by tmux for pane resize / copy-mode
   entry. The host terminal emulator's native selection is suppressed —
   the user sees no highlight.
2. **Does not enable OSC passthrough** (`set -g allow-passthrough off` is the
   tmux default since 3.3). OSC 9 / 52 / 777 sequences emitted by programs
   running *inside* tmux are stripped by tmux before they reach the outer
   terminal emulator.

These are fine on a bare CLI where the user is also running a tmux client and
expects tmux-native mouse + tmux-native clipboard. They are **bad defaults
when sandy is the sole user of tmux** (which is the case in sandy-ui's
webview, in `code-server` SSH'd from a phone, in any single-purpose terminal
emulator hosting sandy as its only program).

### Symptoms in sandy-ui

- **Click-drag in the Sandy webview tab does nothing visible.** Cmd+C
  doesn't copy because nothing is highlighted. Users assume selection is
  broken; sandy-ui's workaround is `macOptionClickForcesSelection: true`
  in xterm.js, requiring users to discover ⌥-drag.
- **OSC 9 / 52 / 777 emitted from `claude`, `aider`, or any other CLI running
  inside sandy's tmux are silently dropped** before they reach xterm.js's
  OSC handlers — so VSCode notifications and clipboard writes from inside
  sandy don't fire, even though they round-trip fine from a bare zsh inside
  the same container.

### Proposed fix

#### Option A — environment-aware tmux config (recommended)

Sandy emits a tmux config that conditionally toggles mouse mode based on
an environment variable from the host (the program that launched sandy).
sandy-ui sets `SANDY_HOST_OWNS_SELECTION=1` (or similar); sandy's tmux
inheriting it via `update-environment` flips the right knobs.

```tmux
# inside sandy's bundled tmux.conf
%if "#{e:SANDY_HOST_OWNS_SELECTION}"
  set -g mouse off
%else
  set -g mouse on
%endif

# always — OSC passthrough has no downside in either context
set -g allow-passthrough on
set -ga terminal-features ":RGB"
```

Bare-CLI sandy users keep tmux-native mouse + clipboard. sandy-ui (and any
GUI host that opts in via the env var) gets native click-drag selection
back, and the host emulator's OSC handlers fire.

#### Option B — flip both defaults off, document opt-in

Simpler: sandy's tmux config sets mouse off and passthrough on,
unconditionally. Document for tmux-power-users how to re-enable mouse mode
via `~/.tmux.conf` overrides if desired.

Pro: no env-var contract, zero coordination with sandy-ui or any other host.
Con: surprises users who relied on `set -g mouse on` working out of the
box.

#### Option C — leave alone, let host workaround

Status quo. sandy-ui keeps `macOptionClickForcesSelection`, every GUI host
needs the same workaround, and OSC events from inside sandy stay broken.

**Recommendation: Option A.** Cheapest fix that doesn't surprise existing
users and gives sandy-ui (and future GUI hosts) a clean opt-in.

### What to deliver

1. **Bundled tmux.conf update**:
   - `set -g allow-passthrough on` unconditionally
   - `set -ga terminal-features ":RGB"` unconditionally (already implicit on
     most modern terminals, but explicit lets sandy promise truecolor regardless
     of the outer `$TERM`)
   - Conditional `set -g mouse off` when `SANDY_HOST_OWNS_SELECTION` is set
2. **`update-environment` includes `SANDY_HOST_OWNS_SELECTION`** so the env
   var propagates from sandy's spawn into the tmux session.
3. **Document the env var** in sandy's README and `--help` — "Hosts running
   sandy in a single-purpose terminal where they want native host-emulator
   selection should set `SANDY_HOST_OWNS_SELECTION=1`."
4. **Tests**:
   - Spawn `sandy --start` with env var set, confirm `tmux show-options -g mouse`
     reports `off` inside the session.
   - Spawn without env var, confirm `tmux show-options -g mouse` reports `on`.
   - From inside sandy with env var set, emit `printf '\e]9;hello\a'` —
     confirm the bytes reach the parent terminal (capture via `script(1)` or
     a wrapping pty harness).
5. **No CLI flag needed** — the env var is the contract. CLI flags can be
   added later if it turns out terminal users want this knob too.

### What sandy-ui will do once this lands

1. Set `SANDY_HOST_OWNS_SELECTION=1` in the spawn env in
   `src/terminal/supervisor.ts`.
2. Remove the `macOptionClickForcesSelection: true` workaround in
   `media/terminal/src/bridge.ts` (or keep it as belt-and-suspenders; it's
   unobtrusive).
3. Verify that an OSC 9 emitted from inside sandy's tmux now triggers a
   VSCode notification (currently this only works from a bare zsh inside
   the container, not from inside sandy's tmux).

Both changes are tiny once sandy's side is done. Currently sandy-ui's
spike validation has the OSC test marked as "passes from zsh, fails from
inside sandy due to tmux passthrough" — this handoff fixes that.

### Verification (from sandy's side)

```bash
# A. With env var: mouse off, passthrough on
SANDY_HOST_OWNS_SELECTION=1 ./sandy --start /tmp/sandy-host-owns-test &
sleep 3
docker exec -it sandy-host-owns-test tmux show-options -g mouse
# Expected: mouse off
docker exec -it sandy-host-owns-test tmux show-options -g allow-passthrough
# Expected: allow-passthrough on

# B. Without env var: mouse on, passthrough on
./sandy --start /tmp/sandy-bare-test &
sleep 3
docker exec -it sandy-bare-test tmux show-options -g mouse
# Expected: mouse on
docker exec -it sandy-bare-test tmux show-options -g allow-passthrough
# Expected: allow-passthrough on

# C. OSC round-trip from inside sandy's tmux
# Run with a wrapping script(1) to capture what reaches the outer pty:
script -q /tmp/sandy-osc.log ./sandy --start /tmp/sandy-osc-test
# Inside the sandy session:
#   printf '\e]9;test-notification\a'
# Then exit sandy and grep the log:
grep -aP '\x1b\]9;test-notification' /tmp/sandy-osc.log
# Expected: a hit (the OSC bytes reached the outer pty)
```

### Why this matters for sandy-ui

This is the only remaining piece preventing OSC notifications from
inside sandy's actual workflow. Today the spec promises OSC 9 / 52 / 777
support and the wire-up is correct on both ends, but tmux's default
allowlist eats those sequences before they reach the webview. Users running
`claude` inside sandy don't get notification toasts when long-running tools
finish; they don't get host-clipboard sync from terminal-side OSC 52
operations.

Native selection is the second piece — required for the "this just works
like a normal editor terminal" experience users expect from a GUI-hosted
terminal. The `macOptionClickForcesSelection` workaround is non-discoverable
and inconsistent with every other macOS GUI text widget.

Both fixes live in the same `tmux.conf` so they ship together.

### Out of scope

- Don't introduce a separate "headless mode" / "GUI mode" CLI flag — the env
  var is enough. Adding flags multiplies surface for no benefit.
- Don't change `default-terminal` or `default-shell` — those are user-config
  territory.
- Don't add tmux clipboard integration via OSC 52 from tmux itself
  (`set -s set-clipboard on`). Sandy's tmux has no path to the host
  clipboard except via passthrough; the host emulator (xterm.js, in
  sandy-ui's case) is the right place to handle OSC 52 → clipboard, and
  sandy-ui already does. Enabling tmux's own clipboard would create a
  second, conflicting path.

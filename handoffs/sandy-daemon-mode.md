# Handoff: daemon-mode for sandy (decouple session lifecycle from client lifetime)

> **Purpose**: paste the body of this file as the prompt to a Claude (or other
> coding agent) running in a clone of `github.com/rappdw/sandy`. Surfaced from
> sandy-ui dogfooding.

---

## Task: add a daemon mode that decouples sandy session lifetime from any one client's lifetime

### Context

Today, every `sandy` invocation owns a session end-to-end. The pattern is:

1. `sandy` (interactively) launches the container, attaches to the inner tmux,
   blocks until the user exits, then runs the cleanup trap (`docker stop`,
   `docker network rm`).
2. If the controlling client (terminal, VSCode extension host, mosh-client)
   dies, the trap fires and the container is torn down.

This is fine for "open one terminal, work, close terminal" — the assumed use
case when sandy was designed. But it's painful in three real scenarios that
have come up during dogfooding:

1. **VSCode extension** (`sandy-ui`) hosts sandy as a webview-tab PTY. When
   the user closes the tab, the PTY dies and sandy's container goes with it.
   sandy-ui has its own "detach" (close tab, keep PTY alive in extension
   host) but that detach is bounded by the extension host's lifetime — quit
   VSCode and the session dies anyway.
2. **Long-running agent jobs** (overnight builds, long Claude sessions). User
   wants to be able to close their laptop, come back the next day, reconnect.
   Today they have to leave the terminal/VSCode open and the laptop awake.
3. **Multi-client access**. User starts sandy from terminal, later wants to
   bring it into VSCode (or vice versa). Today, no way — one client owns
   the session.

Compare the [`dgx` zsh function](https://github.com/anywhere/that-pattern):

```zsh
dgx () {
    if [[ "$1" == "list" ]]; then
        ssh dgx tmux ls
    elif [[ "$1" == "clean" ]]; then
        ssh dgx 'pkill -u $USER mosh-server'
    else
        local session="${1:-main}"
        mosh dgx -- tmux new-session -A -s "$session"
    fi
}
```

The session daemon is `tmux` on the dgx host. `mosh` is just transport. The
user can disconnect, reconnect from any machine, the session persists across
laptop reboots. Same model belongs in sandy.

### Solution: add daemon-mode CLI

Three new commands, plus `--list` / `--stop` operating on named sessions
keyed by workspace:

| Command | Behavior |
|---|---|
| `sandy --start [--workspace PATH]` | Start the container, register the session, return immediately (or block until the container is ready then return). No interactive attach. Idempotent: if a session for this workspace is already running, return success and print the session name. |
| `sandy --attach [--workspace PATH]` | Attach (interactively) to a running session for the workspace. Same UX as bare `sandy` today — drops you into the inner tmux. Disconnecting (Ctrl-D, kill client) does NOT tear down the container. |
| `sandy --stop [--workspace PATH]` | Stop a running session for the workspace. Runs the existing cleanup trap (`docker stop`, `docker network rm`). Idempotent: no-op if no session. |
| `sandy --list` | Already exists as `--print-state`'s `sandboxes[]` / `running_containers[]` — verify the running set is correctly populated; no new command needed if already complete. |

Bare `sandy` (today's interactive flow) becomes `sandy --start && sandy --attach`
internally for the common case, with the existing semantic that disconnecting
DOES tear down (preserves backwards compatibility for users invoking from a
terminal who expect "close terminal = stop sandy"). The new daemon semantics
require explicit `--start` / `--attach` / `--stop`.

Alternative: bare `sandy` could ALWAYS use the daemon flow, with a new
`--ephemeral` flag (or `SANDY_EPHEMERAL=1` env) for the legacy
"disconnect-tears-down" semantics. Pick whichever feels cleaner — see your
existing user base.

### Why this is the right shape

- **Matches the introspection model already in sandy.** `--print-schema` /
  `--print-state` / `--validate-config` are sandy's machine-readable surface
  for sandy-ui. `--start` / `--attach` / `--stop` are the lifecycle
  counterpart. Same UNIX-philosophy "single binary with subcommand-flags"
  shape.
- **No new daemon process.** The container IS the daemon. Sandy-ui just
  invokes `sandy --attach` as its PTY command instead of bare `sandy`.
  When the PTY dies (tab close, VSCode quit, crash), the container keeps
  running until explicit `sandy --stop`.
- **Sandy-ui side is small.** Today sandy-ui has a `PtySupervisor` that
  spawns/tracks PTYs. Once `--attach` exists, the supervisor's `spawn` becomes
  `sandy --start` + `sandy --attach`, and `stop` becomes `sandy --stop`.
  Detach across VSCode restarts is then a re-attach to a still-running session.

### What to deliver

1. **Implementation**: the three new flags. `--start` does what current
   sandy does up to the `docker exec ... tmux attach` line, then exits. New
   sessions are tracked somewhere — either in a sidecar state file under
   `$SANDY_HOME/sessions/<workspace-hash>.json` or by querying docker's
   container labels. `--attach` does the `docker exec ... tmux attach`
   to an existing container. `--stop` invokes the cleanup trap path.
2. **State file or label scheme**: how `--list` / `--print-state` enumerates
   running sessions. Recommend container labels (`sandy.workspace_path`,
   `sandy.started_at`) over a state file, since they survive sandy upgrades
   and can't drift from docker reality.
3. **Backwards compatibility**: bare `sandy` keeps working as today (or
   becomes the daemon flow with `--ephemeral` for legacy — your call). Don't
   break existing terminal users.
4. **Tests**:
   - `sandy --start` then `sandy --list`: session shows as running
   - `sandy --attach` then disconnect (kill client): session still shows in `--list`
   - Re-attach after disconnect: working terminal, tmux state preserved
   - `sandy --stop`: session removed from `--list`, container gone, network gone
   - `sandy --start` twice: second is no-op (idempotent)
   - `sandy --start` after `sandy --stop`: fresh container
5. **`--print-state` sanity**: ensure `running_containers[].sandbox` correctly
   matches `sandboxes[].name` after `--start`. Recent sandy-ui dogfooding hit
   a case where the container ran but `--print-state` reported the sandbox as
   `lock_held=true` without populating `running_containers` correctly. The
   daemon work is a good time to audit that path.

### Out of scope

- Don't add a TCP/socket server. The container IS the daemon. `sandy --attach`
  works via `docker exec`.
- Don't redesign sandy's container/network/volume layout — `--start` should
  use exactly the same launch path as today's interactive sandy, just stopping
  before the attach phase.
- Don't add multi-session-per-workspace support. One sandy per workspace is
  the existing model and that's still right.
- Don't touch the per-workspace lock format here — that's a separate handoff
  (`sandy-flock-locking.md`).

### Verification

```bash
# Start a daemon session in a workspace
./sandy --start --workspace /tmp/sandy-daemon-test
sleep 5

# Confirm it shows in --print-state
./sandy --print-state | jq '.sandboxes[] | select(.workspace_path | test("daemon-test")) | { name, lock_held }'
./sandy --print-state | jq '.running_containers[] | select(.sandbox | test("daemon-test"))'
# Expected: lock_held=true, running_containers entry exists with matching .sandbox name

# Attach interactively, type something, detach (Ctrl-B D for tmux, then close client)
./sandy --attach --workspace /tmp/sandy-daemon-test
# (in tmux: type "echo hello", Ctrl-B D)

# Re-attach — terminal should pick up where you left off
./sandy --attach --workspace /tmp/sandy-daemon-test
# Expected: see the "hello" output preserved

# Confirm session survives a client crash
./sandy --attach --workspace /tmp/sandy-daemon-test &
SANDY_PID=$!
sleep 3
kill -9 $SANDY_PID  # simulate hard crash
sleep 2
./sandy --print-state | jq '.running_containers[] | select(.sandbox | test("daemon-test"))'
# Expected: container still running

# Clean up
./sandy --stop --workspace /tmp/sandy-daemon-test
./sandy --print-state | jq '.running_containers[] | select(.sandbox | test("daemon-test"))'
# Expected: no entry
```

### Why this matters for sandy-ui

Once daemon mode lands, sandy-ui's `PtySupervisor.spawn()` becomes:

```ts
// 1. Ensure session exists (idempotent)
await execFileAsync(sandyBin, ["--start", "--workspace", ws]);
// 2. Open a PTY attached to the session
return spawnPty({ command: sandyBin, args: ["--attach", "--workspace", ws], ... });
```

And `PtySupervisor.stop()` becomes `execFileAsync(sandyBin, ["--stop", "--workspace", ws])`.
Detach is just dropping the PTY without calling `--stop`. Re-attach is just
spawning a new PTY pointed at the still-running session.

Three concrete benefits land in sandy-ui:

1. **VSCode-quit no longer kills sessions.** `extension.deactivate()`'s
   parallel-SIGINT becomes optional; the user can quit and reopen VSCode
   without losing sandy state.
2. **Cross-client access.** User can start sandy from the terminal, later
   open VSCode and re-attach via the projects tree.
3. **True crash recovery.** If VSCode crashes (or the user force-quits),
   sandy keeps running. Reopening VSCode and clicking the workspace
   re-attaches cleanly. Today, crashes leak Docker resources.

The sandy-ui tracking issue for switching to this lives at TBD; mention this
handoff in the sandy commit so we can find each other when both sides ship.

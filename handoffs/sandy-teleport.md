# Handoff: `sandy teleport` — move a workspace + live session state to another machine

> **Purpose**: paste the body of this file as the prompt to a Claude (or other
> coding agent) running in a clone of `github.com/rappdw/sandy`. Surfaced from
> sandy-ui dogfooding. Companion sandy-ui work is listed at the bottom — it
> happens in the sandy-ui repo *after* this lands; the "Interface contract"
> section is what sandy-ui will build against, so changes to it should be
> deliberate.

---

## Task: add `sandy teleport <host>` — checkpoint a project's sandy state and resume it on a remote machine

### Motivation

The owner works on a laptop but has always-on servers (a DGX Spark, others)
reachable over SSH on the LAN. The want: move an in-progress workload —
workspace files **plus the agent's accumulated context and memory** — to a
server so the agent keeps grinding when the laptop sleeps or disconnects.
Today that means manually re-cloning, losing the Claude conversation, and
re-explaining context to a fresh agent.

Sandy's own architecture already makes this *almost* a file-copy: everything
that constitutes "the session" lives in host directories. Teleport is the
missing orchestration plus three or four sharp edges that must be handled
exactly right.

### What "the session" physically is (verified against the sandy script)

| State | Location | Notes |
|---|---|---|
| Agent context/memory/transcripts/plugins | `$SANDY_HOME/sandboxes/<SANDBOX_NAME>/claude/` | mounted at `~/.claude` in-container |
| Claude setup sidecar | `$SANDY_HOME/sandboxes/<SANDBOX_NAME>.claude.json` | seeded from host `~/.claude.json`, `projects` key stripped |
| Per-project package installs | `$SANDY_HOME/sandboxes/<SANDBOX_NAME>/` (pip/npm/go/cargo/uv subdirs) | arch-specific binaries — see edge cases |
| Workspace (incl. uncommitted/untracked, `.sandy/` config+secrets) | the project dir itself | |
| Credentials | **nowhere in the sandbox** — seeded fresh from host each launch | deliberately not transferred; remote provisions its own |
| Approvals | `$SANDY_HOME/approvals/` | do NOT transfer — re-approval on the new host is correct behavior |

Two facts make transferred state *resumable* rather than just copied:

1. **`SANDBOX_NAME = basename + "-" + sha256(canonical workspace path)[0:8]`**
   (`SHORT_HASH` / `DIR_BASE` assembly, currently ~line 3351). The hash is of
   the **absolute host path**, so the same project at `/Users/rappdw/dev/foo`
   and `/home/rappdw/dev/foo` gets *different* sandbox names. Teleport must
   recompute the destination hash and rename the sandbox dir + sidecar +
   any lock remnants during transfer, or remote sandy silently creates a
   fresh sandbox and the transferred context is orphaned.
2. **The in-container workspace path is host-independent when the
   home-relative path matches.** For workspaces under `$HOME`, sandy mounts at
   `/home/claude/<path-relative-to-home>` (the `SANDY_WORKSPACE` computation,
   ~line 3413). Mac `~/dev/foo` and Linux `~/dev/foo` both become
   `/home/claude/dev/foo` inside the container, so Claude Code's project slug
   (derived from in-container cwd) is identical across machines —
   `claude --continue` resumes the transferred transcripts with **zero path
   rewriting**. v1 should *require* this symmetry (refuse + explain when the
   workspace is outside `$HOME`); a slug-rename transform for asymmetric
   paths is possible but not worth v1 complexity.

### CLI surface

```
sandy teleport <host>                # checkpoint + push to <host>, resume there in tmux
sandy teleport <host> --back        # reverse: pull state back from <host>
sandy teleport <host> --dry-run     # print every check + rsync/ssh command, execute nothing
sandy teleport <host> --no-resume   # transfer only; don't start sandy on the remote
sandy teleport <host> --fresh-packages  # skip per-project package storage (arch mismatch)
sandy teleport --status             # show teleport marker for this workspace, if any
```

`<host>` is an SSH alias from `~/.ssh/config` (same convention as the
owner's existing mosh/tmux helper functions — see "remote-tmux-session-helper"
pattern: `dgx`, `alice`).

### Forward flow (`sandy teleport dgx`)

1. **Quiesce check (hard gate).** Refuse if the workspace mutex
   (`$SANDY_HOME/sandboxes/.<SANDBOX_NAME>.lock`) is held by a live PID or the
   `sandy-<SANDBOX_NAME>` container is running. Message: exit sandy first
   (Ctrl-C / `exit`), let the cleanup trap run. Never copy live state — a
   mid-write transcript or half-flushed package dir is corruption shipped at
   rsync speed. Mid-turn agent work that hasn't been persisted to the
   transcript is lost by design; say so in the output ("teleport checkpoints
   at the last completed message").
2. **Preflight the remote (fail fast, before any bytes move):**
   - `ssh <host> true` works.
   - Remote `sandy --version` exists; v1 requires **exact version match**
     with local (warn-and-confirm on minor skew is acceptable; refuse when
     either side is below the other's `SANDY_SANDBOX_MIN_COMPAT`).
   - Docker reachable on the remote.
   - Arch comparison (`uname -m` / docker engine arch both sides). On
     mismatch, require `--fresh-packages` (compiled wheels/native modules in
     the package store won't run; everything else transfers fine).
   - Credentials present remotely (`~/.sandy/.secrets` or env has
     `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`; `gh auth status` for
     `SANDY_SSH=token` flows). Teleport never copies host-level
     `~/.sandy/.secrets` — point at the provision step instead.
   - No live lock for the destination sandbox name on the remote.
3. **Transfer workspace**: `rsync -a --delete` to the same home-relative path
   (`~/dev/foo` → `<host>:~/dev/foo`), with `--backup --backup-dir` pointed at
   a timestamped dir under `~/.sandy/teleport-backups/` on the destination so
   `--delete` is never irreversible. Includes uncommitted + untracked files
   and workspace `.sandy/` (config + project-scoped secrets) — git alone is
   not sufficient, that's the point of teleport.
4. **Transfer session state**: rsync the sandbox dir and `.claude.json`
   sidecar, **renamed to the destination's recomputed hash** (compute via
   `ssh <host> 'printf %s "$PWD-expanded-path" | sha256sum'` or replicate the
   3-line hash locally from the remote `$HOME`; mind `shasum -a 256` vs
   `sha256sum` portability — sandy already has a `sha256` helper).
5. **Drop the teleport marker** on the source (see Interface contract).
6. **Resume remotely** (unless `--no-resume`):
   `ssh <host> 'tmux new-session -d -s sandy-<DIR_BASE> "cd <ws> && sandy --continue"'`
   — `--continue` passes through to claude (the arg-passthrough already
   handles it) and picks the conversation up from the last persisted message,
   now on a machine that never sleeps. Print the attach hint
   (`mosh <host> -- tmux attach -t sandy-<DIR_BASE>`, or the owner's `<host>`
   zsh function).
7. **Source-side launch guard**: while a marker is present for a workspace,
   `sandy` launch in that workspace refuses with the marker contents and a
   pointer to `sandy teleport <host> --back` (override: `--force`). This is
   the split-brain defense — the #1 operational risk of the whole feature is
   absent-mindedly resuming the stale local copy a week later.

`--back` is the same flow with source/destination swapped, plus: clears the
marker on success, and refuses if the *remote* still has a live session
(quiesce applies symmetrically — `tmux kill-session` guidance in the error).

### Interface contract (sandy-ui builds against this — keep stable)

1. **Marker file**: `$SANDY_HOME/sandboxes/<SANDBOX_NAME>.teleported.json` on
   the **source** machine only (sidecar position, like `.claude.json` — NOT
   inside the workspace, so it never travels with the workspace rsync):
   ```json
   {
     "host": "dgx",
     "remote_workspace": "/home/rappdw/dev/foo",
     "remote_sandbox": "foo-9f8e7d6c",
     "teleported_at": "2026-06-11T17:40:00Z",
     "sandy_version": "0.9.3"
   }
   ```
2. **`--print-state` surfaces it**: each sandbox entry gains an optional
   `"teleported_to": {host, remote_workspace, teleported_at}` field when a
   marker exists. This is how sandy-ui learns about teleports for free
   through its existing 5s poller — no new IPC.
3. **Exit codes**: 0 success; distinct non-zero codes for quiesce-refusal,
   preflight failure, transfer failure, resume failure (sandy-ui will map
   these to actionable error messages).

### Edge cases / review findings (from the sandy-ui-side design review)

- **Mid-turn is not migratable.** Transcripts persist per message; in-flight
  tool processes die with the container. Teleport is checkpoint-and-resume at
  a turn boundary. The quiesce gate makes this explicit rather than silent.
- **Nested tmux prefix collision.** Sandy's inner tmux uses the default `C-b`
  prefix (generated tmux.conf); the outer survival tmux on the remote also
  defaults to `C-b`. The resume step should create the outer session with a
  distinct prefix (`tmux new -d -s ... \; set-option prefix C-a` or a
  dedicated `-f` conf), or the attach hint should document `C-b C-b`
  passthrough. Without this, day-one attach is confusing.
- **Stale locks on the remote** after a server reboot (cleanup trap never
  ran): the resume step should clear dead-PID locks for the destination
  sandbox before launching (same dead-PID logic sandy already has; flock(2)
  from the `sandy-flock-locking` handoff would subsume this).
- **`--delete` direction mistakes**: the `--backup-dir` safety net exists so
  a teleport pointed at the wrong host/path is recoverable. Never rsync
  `--delete` without it.
- **Don't transfer**: `$SANDY_HOME/approvals/` (re-approval on a new host is
  correct, not a bug), host-level `~/.sandy/config` + `.secrets` (the remote
  was provisioned with its own), Docker images (rebuilt/cached remotely —
  provision pre-warms them).

### Provision (one-time per server, can be a separate subcommand or doc)

`sandy teleport --provision <host>` (or documented manual steps): run
doctor-equivalent checks remotely (docker, git, gh, tmux, mosh-server, disk),
guide `CLAUDE_CODE_OAUTH_TOKEN` setup (`claude setup-token` → remote
`~/.sandy/.secrets` — already the README-recommended headless path), `gh auth
login`, then pre-build sandy's images (`sandy --rebuild` in a throwaway dir or
an image-build-only invocation) so the first teleport doesn't stall on a
10-minute Docker build.

### Acceptance criteria

- Round-trip test: start a session locally, exchange a few messages, exit,
  `sandy teleport <host>`, attach remotely → `claude --continue` shows the
  same conversation; `teleport --back` → same again locally.
- Sandbox dir on the destination is named with the **destination-path hash**
  and `--print-state` on the destination lists it as a normal sandbox.
- Launch-refusal with marker present (and `--force` override) works.
- `--dry-run` executes nothing and prints every command.
- Version/arch/credential preflight failures produce actionable messages and
  distinct exit codes.
- Quiesce gate: teleport refuses while sandy runs locally.

### Out of scope here — companion sandy-ui work (tracked in the sandy-ui repo)

For context only; do not implement in the sandy repo:

1. **Attach override fix** (independent of this handoff): when
   `sandy.launchCommand` is an explicit attach override (e.g.
   `tmux attach -t sandy-foo` on a Remote-SSH window into the server),
   sandy-ui's orphan-lock modal should skip or offer "Attach" instead of only
   "Stop existing & launch fresh / Cancel".
2. **Breadcrumb surfacing** (depends on the `teleported_to` field in
   `--print-state`): tree item badge + "this workspace teleported to dgx on
   <date>" with [Open remote window] / [Teleport back] actions.
3. **`Sandy: Teleport to Server…` command** (depends on the CLI landing):
   shells out to `sandy teleport`, then opens the workspace remotely via a
   `vscode-remote://ssh-remote+<host><remote_workspace>` URI so the editor
   follows the workload. Remote-SSH note: sandy-ui must be installed
   from source on the remote (the vsix ships node-pty built for the
   publishing machine's ABI; the remote extension host runs vscode-server's
   own Node on Linux).
